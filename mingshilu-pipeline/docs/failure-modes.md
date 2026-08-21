# 古籍自动标点失败段的纠错模式

> 适用场景：Qwen 系列 LLM 给古文加标点时，rescue cascade 全通道（strict / count / dp_c0..15 / truncraw_dp / startshift_dp）都过不了，被判为 `gave_up` 或 `partial_failed` 的段落。
>
> 整理时间：2026-06-06。来源：`mingshilu-retry` 145 仍失败段 + P5 86 仍失败段的人工 + 启发式分析。

---

## 失败段的总体分布（retry 145 例为例）

```
145 仍失败 ┬─ partial_failed: 79  (长段切片，部分块挂)
          └─ gave_up:        66  (整段没过)
              ├─ 模型加字 (+1..+20):   22
              ├─ 模型漏字 (-1..-N):    42
              └─ 字数同但字不同:        1
```

`partial_failed` 拆到 chunk 级再分类（108 个失败块）：A 加字 75 + B 真重复 2 + C 括号 2 + 真漏字 20 + 其他 9。

---

## 五种纠错模式

### 模式 A — 模型自作主张加字（**可救**，drift autofix）

**特征**：`strip_punct(la)` 比 `strip_punct(raw)` 多出 N 个字。多为模型把官方文书的缩写展开了。

例：

```
raw:  ○升冯露礼科王继先刑科俱左给事中田畴吏科唐尧钦兵科常居敬刑科俱右给事中  (35 字)
la:   ○升冯露为礼科给事中，王继先为刑科给事中。俱左给事中。
      田畴为吏科给事中，唐尧钦为兵科给事中，常居敬为刑科给事中。俱右给事中。  (55 字)
                ↑ 添了「为...给事中」之类
```

**纠错算法**：`difflib.SequenceMatcher` 对齐 `sr` (raw 去标点) 和 `sp` (punct 去标点)，对每个 `insert` 块 / `replace` 块多出的部分：

- 若 raw 在对应位置 ±2 字内含 PUA / OCR 残缺字符（`■` `□` `⿰⻊` `＜...＞` 等）→ 视为 AI 主动补全替换，**保留**
- 否则 → AI 凭空加字，**从 punct 原串里删掉** 对应位置的字（用 `sp_pos` 把 clean 索引映射回 punct 原索引）

**已实现**：`drift autofix`（写在临时脚本里，对 P5+Retry 的 87 条 drift 全 1 次通过，删 219 字，0 条 PUA 替代）。
**适用范围**：drift（rescue 过了但字数不对）+ partial_failed 里 A 类块。
**当前 A 类整段 gave_up 22 条 + partial chunks 75 条**：strict 校验过不了时无 sr→sp 对齐基础，drift autofix 救不了，**仍归为失败**，下一轮换更稳的模型重跑（如 DeepSeek-v4 / Doubao-pro）。

### 模式 B — 模型砍掉了 raw 里的重复段（**可救**，接受模型版本）

**特征**：`strip_punct(la)` 比 `strip_punct(raw)` 短，且短掉的字符串在 raw 邻近位置出现 ≥ 2 次——属"原文有 OCR/录入复制错误，模型识别后纠正"。

例：

```
raw:  ...无所惩矣按律有做工摆站瞭哨发充仪从煎盐炒铁各条例自今请斟酌并行情轻者仍拟工役情重者
      无所惩矣按律有做工摆站瞭哨发充仪从煎盐炒铁各条例自今请斟酌并行情轻者仍拟工役情重者
      自炒铁百名之外...
                       ↑ 同一句话连续重复 2 次
la:   只保留 1 次
```

**纠错算法**：`difflib` 找出每个 `delete` 块，若该块字符串长度 ≥ 3 且在 raw 全文出现 ≥ 2 次 → **真重复**，**保留模型版本**；否则 → 真漏字，仍失败。

**注意事项**：长度 < 3 的删除块默认判为"非重复"（避免把虚词漏字误判成重复）。
**风险**：极少数情况下，正文本来就有合规的重复表达（如四字格、对偶），可能误救。**抽检率 ≥ 5%**。

**当前 B 类整段 4 条 + partial chunks 2 条 = 6 条**：已应用，写到 `mode_bc_rescued.jsonl`，并入 retry-merged。

### 模式 C — 模型去掉了原文的 OCR 不确定标记（**可救**，补回括号）

**特征**：raw 有 `[X]` / `＜X＞` / `〈X〉` 等 1-8 字括号包裹的 OCR 标记，模型直接吃掉括号、保留候选字。

例：

```
raw:  ...司礼监大监各[谷]大用韦霦张锦...     ([谷] 是 OCR 不确定)
la:   ...司礼监大监各谷大用，韦霦、张锦...     (模型相信"谷"是对的)
```

**纠错算法**：

1. 用 `re.compile(r'\[[^\[\]]{1,5}\]|＜[^＜＞]{1,8}＞|〈[^〈〉]{1,5}〉')` 扫 raw 抽出所有括号 token
2. 对每个 token `[X]`，在 la 里搜首次出现的 `X`（要求左右不已是括号）→ 在该位置外包回去
3. 多个 token 顺序处理（已包过的不重复处理）

**风险**：若 X 在 la 里出现多次，可能包错位置。**抽检率 ≥ 10%**。

**当前 C 类**：整段 gave_up 在 retry 里没有；partial chunks 2 条已修复。

### 模式 D — partial_failed 长段（**部分可救**，先拆块再分类）

**特征**：长段在标点前已按本地启发式（○ / 也矣焉哉 / 又/初/后/然/按 等）切成 ≤350 字带 marker 的块，跑完后**部分块挂了**，整段最后是「成功块的 punct 拼接 + 失败块原文兜底」。

**纠错算法**：

1. 用 `chunks_map.json` 把 orig_id 反查出全部 new_id 列表（`{orig_id}_{idx}of{total}`）
2. 对每个 new_id：
   - 在 kaggle 的 punctuated.jsonl → 成功
   - 在 kaggle 的 failures.jsonl → 失败块，拿 `last_attempt`
3. 对每个失败块的 (raw, last_attempt) 跑 A/B/C 分类器
4. **当一个 orig_id 的所有失败块都属 B/C 时**，按 B/C 算法各自修复块的 punct → 整段重新拼回 → 加入 merged
5. 若有任何块属 A / real_drop / other → 整段保持 partial_failed

**当前 79 partial_failed → 拆出 108 失败块**：
- 75 A + 20 真漏字 + 9 其他：保持失败
- 2 B + 2 C：合并到 4 个 orig_id 全部救回，写到 `mode_bc_rescued.jsonl`

### 真漏字 / 其他 — **不可救**

模型确实丢了字（不是重复纠错），或字数同但具体字差异不在 OCR 括号范围。**下一轮 retry 必须换通道**——更强的模型、或人工。

---

## 调用入口（脚本所在）

- `mingshilu-pipeline/scripts/merge-mingshilu-retry.py` — 合并 + 自动算 drift（已加双边对称 strip 校验）
- `mingshilu-pipeline/scripts/rechunk-mingshilu-part.py` — 给指定 part 做本地预切
- `mingshilu-pipeline/scripts/rechunk-mingshilu-failures.py` — 给失败段做按 marker 重切

drift autofix / mode B 验证 / mode C 括号补回 / mode D 拆块这四步的实现目前还是临时脚本（写在 `/Users/lch/Downloads/0610/1/` 的临时跑批里），下次重用时**应该提取到 `mingshilu-pipeline/scripts/rescue-failures.py`**，结构：

```python
def autofix_drift(raw, punct) -> (fixed, removed, kept_pua)
def classify_drop_mode(raw, last_attempt) -> 'B_dup' | 'C_bracket' | 'C_charsame' | 'real_drop'
def classify_add_mode(raw, last_attempt) -> 'A_add'
def restore_brackets(raw, la) -> (fixed, inserted_positions)
def rescue_orig_id(orig_id, chunks_map, kaggle_punct, kaggle_fail) -> (final_punct, status, sources)
```

---

## 决策矩阵（人脑速查）

| 模型行为 | 模式 | raw 特征 | 救法 | 抽检率 |
|---|---|---|---|---|
| 加字 (`+N`) 但通过 strict | drift A | 任意 | autofix 删多余 | 0 (确定性) |
| 加字未通过 strict | A | — | 不救，重跑 | — |
| 漏字 (`-N`) | B / real_drop | raw 含相同长字串 ≥ 2 次 → B；否则 real_drop | B 接受模型；real_drop 失败 | B ≥ 5% |
| 字数同但字不同 | C / 繁简差异 | raw 含 `[X]` / `＜X＞` → C；否则视为繁简（rescue 应该已处理） | C 补回括号 | C ≥ 10% |
| 任意 | partial_failed | 长段切片，部分块挂 | 拆 chunk → 套上 A/B/C/real_drop | 同上 |

---

## 后续 retry 时把方法引入进去的方式

1. **kaggle/colab notebook 不变**——它们只负责单段 `_punct_one_core` 跑模型
2. **本地合并阶段**用 `merge-mingshilu-retry.py` 加 drift autofix（已经在 2026-06-06 改好了，drift 自动导出到 `*-drift.jsonl`）
3. **drift / still-failed 文件**喂给 `rescue-failures.py`（待提取），输出：
   - `*-mode-bc-rescued.jsonl` —— 自动救回的
   - `*-still-failed-A.jsonl` —— A 类加字，留作下一轮高质量模型 retry
   - `*-still-failed-real-drop.jsonl` —— 真漏字，留作人工
4. 救回的并入 merged 即可

> 估计 P3/P4/P6/P7/P8 跑完后，按这套流程能再省 5-10% 的人工处理量。
