#!/usr/bin/env python3
"""
retry-rescue.py — 只在 retry 时启用的额外修复规则。

四条新规则（详见 mingshilu-pipeline/docs/failure-modes.md）：

  Rule 1: 单字替换/漏字 → 句级 LLM OCR 修正确认
          对 raw 与 la 差异 ≤3 字、且每处差异都是单字增/减/换的情况，
          把差异所在的句子（句末标点切分）拆出来，问 Qwen 判断这是
          OCR 错字 fix 还是模型乱改。
          - 判 yes_fix → 接受 la 的版本
          - 判 no_keep → 把 la 里的字换回 raw 原字
          - 判 uncertain → 保留为 still-failed
          两种 conclusive 答案都算"修复成功"。

  Rule 2: ≥5 字错漏 → 标记为必须 LLM 重跑（路由进 batch）

  Rule 3: 超长段（raw ≥ 1500 字）→ 递归再切，一次切不开就用 max_chunk
          逐档缩小（500 → 350 → 250 → 150）。结果加进 retry batch。

  Rule 4: 新 prompt 强调"绝不改字"——附加 STRICT_NO_EDIT_INSTRUCTION
          作为 Kaggle/Colab notebook 的 few-shot prompt 前缀使用。

用法：
  # 阶段 A: 对当前 still-failed 跑 Rule 1（要 .env 里的 AI_API_KEY）
  python3 retry-rescue.py rule1 \\
    --still-failed PATH/xxx.jsonl \\
    --merged       PATH/yyy-merged.jsonl

  # 阶段 B: 跑 Rule 2/3 路由 + 生成 retry batch
  python3 retry-rescue.py prepare-batch \\
    --still-failed PATH/xxx-still-failed.jsonl \\
    --out-input    PATH/retry-batch-input.jsonl \\
    --out-prompt   PATH/retry-prompt.md
"""
import argparse
import json
import os
import re
import sys
import time
import difflib
from pathlib import Path
from collections import defaultdict, Counter

PUNCT_RE = re.compile(r'[，。：；？！「」『』、《》()（）\[\]【】〈〉,.:;?!"\'\s·‧・•‥…—–]')
SENT_END = re.compile(r'[。？！；」』）)]')


# ============================================================
# Rule 4: 强保留指令（追加到 retry prompt 前缀）
# ============================================================
STRICT_NO_EDIT_INSTRUCTION = """
**严格保字规则（违反则整段任务作废）**：
1. 绝对不要添加、删除、修改任何一个汉字。
2. 即使原文有看似是 OCR 错字的字（例如「垦」可能本应是「恳」），也**不要修改**——保留原字。
3. 即使原文有看似缺漏的字（例如缺一个连接字），也**不要补字**。
4. 即使原文有看似重复的字串（例如同一句话连写两次），也**不要去重**——按原样保留。
5. 你只能在原文的汉字之间插入标点符号（，。：；？！「」、《》等）。
6. 你的输出去掉所有标点后必须与原文一字一致——不多、不少、不变。
""".strip()


# ============================================================
# 辅助工具
# ============================================================
def load_jsonl(path):
    if not path or not Path(path).exists(): return []
    return [json.loads(l) for l in open(path, 'r', encoding='utf-8') if l.strip()]


def split_sentences(text):
    """按句末标点 (。？！；」』）) 切句，保留分隔符。返回 [(start,end,sentence_text)]"""
    out = []
    last = 0
    for m in SENT_END.finditer(text):
        end = m.end()
        sent = text[last:end]
        if sent.strip():
            out.append((last, end, sent))
        last = end
    if last < len(text):
        out.append((last, len(text), text[last:]))
    return out


def diff_content_chars(raw, la):
    """返回 raw 内容字符序列 vs la 内容字符序列的 diff 块（只看非标点）。
    每个差异块是 (tag, raw_clean_start, raw_clean_end, la_clean_start, la_clean_end,
                  raw_frag, la_frag, raw_orig_indices, la_orig_indices)"""
    raw_clean = []; raw_orig = []
    for i, c in enumerate(raw):
        if not PUNCT_RE.match(c): raw_clean.append(c); raw_orig.append(i)
    la_clean = []; la_orig = []
    for i, c in enumerate(la):
        if not PUNCT_RE.match(c): la_clean.append(c); la_orig.append(i)
    sr = ''.join(raw_clean); sl = ''.join(la_clean)
    matcher = difflib.SequenceMatcher(a=sr, b=sl, autojunk=False)
    out = []
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == 'equal': continue
        out.append({
            'tag': tag,
            'raw_clean_span': (i1, i2),
            'la_clean_span': (j1, j2),
            'raw_frag': sr[i1:i2],
            'la_frag': sl[j1:j2],
            'raw_orig_span': (raw_orig[i1] if i1 < len(raw_orig) else len(raw),
                              raw_orig[i2-1]+1 if i2 > 0 and i2 <= len(raw_orig) else len(raw)),
            'la_orig_span':  (la_orig[j1] if j1 < len(la_orig) else len(la),
                              la_orig[j2-1]+1 if j2 > 0 and j2 <= len(la_orig) else len(la)),
        })
    return out


def is_small_single_char_issue(diff_blocks):
    """判断这条记录是否只是 1-3 处单字增/减/换。"""
    if not diff_blocks: return False
    if len(diff_blocks) > 3: return False
    for d in diff_blocks:
        if max(d['raw_clean_span'][1]-d['raw_clean_span'][0],
               d['la_clean_span'][1]-d['la_clean_span'][0]) > 1:
            return False
    return True


# ============================================================
# Rule 1: LLM OCR 校验
# ============================================================
RULE1_PROMPT_REPLACE = """古籍 OCR 校对任务。

句子：{sentence}

原书原字：「{raw_char}」
AI 改成的字：「{la_char}」

判断 AI 这一改动：
- yes_fix: 原书有 OCR 错字，AI 改对了
- no_keep: 原书是对的，AI 错改了，应保留原字
- uncertain: 不确定

只输出选项 ID（yes_fix/no_keep/uncertain），不要解释。"""

RULE1_PROMPT_DROP = """古籍 OCR 校对任务。

句子（原书）：{sentence_raw}
句子（AI 输出，漏字版）：{sentence_la}

原书在此处有字：「{raw_char}」
AI 输出没这个字。

判断：
- yes_keep: 原书是对的，AI 漏字错了，应补回
- no_drop: 原书是错的（OCR 重复/赘字），AI 删得对
- uncertain: 不确定

只输出选项 ID（yes_keep/no_drop/uncertain），不要解释。"""

RULE1_PROMPT_INSERT = """古籍 OCR 校对任务。

句子（原书）：{sentence_raw}
句子（AI 输出，加字版）：{sentence_la}

AI 在此处多加了字：「{la_char}」
原书没这个字。

判断：
- yes_remove: AI 自作主张加字，应该删掉
- no_keep: 原书漏字，AI 补对了
- uncertain: 不确定

只输出选项 ID（yes_remove/no_keep/uncertain），不要解释。"""


QUOTA_ERROR_KEYWORDS = (
    'InsufficientBalance', 'insufficient_quota', 'RateLimit', 'Throttling',
    'quota exceeded', 'free allocated quota', 'token quota',
    'arrearage', '余额不足', '配额', '限流', 'rate_limit',
)

def is_quota_error(err_text):
    s = str(err_text).lower()
    return any(k.lower() in s for k in QUOTA_ERROR_KEYWORDS)

def call_llm(prompt, api_key, base_url, model, timeout=30, attempts=3, retry_sleep=5):
    """带网络重试。4xx 状态直接返回（配额错误由上层判断切换 fallback model）。"""
    import requests
    last_err = None
    for attempt in range(attempts):
        try:
            r = requests.post(
                f'{base_url}/chat/completions',
                headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'},
                json={
                    'model': model,
                    'messages': [{'role':'user','content': prompt}],
                    'temperature': 0,
                    'max_tokens': 20,
                },
                timeout=timeout,
            )
            if r.status_code >= 400:
                # 4xx 状态不重试（配额错误用 fallback model）
                return f'__error__ HTTP {r.status_code}: {r.text[:200]}'
            return r.json()['choices'][0]['message']['content'].strip().lower()
        except Exception as e:
            last_err = e
            if attempt < attempts - 1:
                time.sleep(retry_sleep)
    return f'__error__ {last_err}'


def get_sentence_around(text, char_pos):
    """找 char_pos 所在的句子（句末标点之间）"""
    sents = split_sentences(text)
    for s, e, sent in sents:
        if s <= char_pos < e:
            return sent.strip()
    return text[:200]


def cmd_rule1(args):
    """对 still-failed 跑 Rule 1.

    --no-llm 模式: 单字差异 ≤3 处 → 直接按 raw 原字补回（不区分 OCR 错字）
    默认 (LLM 模式): 每个差异点都问 LLM "是 raw 的 OCR 错字还是 AI 乱改"，
      - yes_fix / no_drop / no_keep_la (LLM 确认 raw 有 OCR 错) → 接受 la
      - no_keep / yes_keep / yes_remove (LLM 确认 raw 是对的)   → 用 raw 字
      - uncertain → 该条不救
    """
    still = load_jsonl(args.still_failed)
    merged = load_jsonl(args.merged) if args.merged else []
    print(f'载入 still-failed: {len(still)}  模式: {"无 LLM" if args.no_llm else "LLM 校验"}')

    if not args.no_llm:
        api_key = os.environ.get('AI_API_KEY') or os.environ.get('DASHSCOPE_API_KEY')
        if not api_key:
            env = Path('/Users/lch/mingshi-reader-ai/backend/.env')
            if env.exists():
                for line in env.read_text().splitlines():
                    if line.startswith('AI_API_KEY='):
                        api_key = line.split('=', 1)[1].strip(); break
        if not api_key:
            print('❌ 找不到 AI_API_KEY，加 --no-llm 跳过或在 backend/.env 设置', file=sys.stderr)
            sys.exit(1)

    candidates = []
    for r in still:
        if r.get('status') != 'gave_up': continue
        raw = r.get('raw',''); la = r.get('last_attempt','')
        if not raw or not la: continue
        diffs = diff_content_chars(raw, la)
        if not is_small_single_char_issue(diffs): continue
        candidates.append((r, diffs))
    print(f'Rule 1 候选（单字差异 ≤3 处）: {len(candidates)} 条')

    # 模型降级机制：优先 args.model（默认 plus），quota 错误就切换到 args.fallback_model
    current_model = args.model
    fallback_model = args.fallback_model
    def llm_call(prompt):
        nonlocal current_model
        resp = call_llm(prompt, api_key, args.base_url, current_model)
        if resp.startswith('__error__') and is_quota_error(resp) and current_model != fallback_model:
            print(f'  ⚠️  {current_model} 配额用尽，切换到 {fallback_model}')
            current_model = fallback_model
            resp = call_llm(prompt, api_key, args.base_url, current_model)
        return resp

    rescued = []; need_human = []; api_calls = 0
    for r, diffs in candidates:
        raw = r['raw']; la = r['last_attempt']
        ops = []  # (la_pos, kind, char) 从后往前执行
        all_decided = True; decisions = []
        trust_llm_at = set()  # 跟踪 LLM 判 "信 AI" 的差异位置（raw_clean_span 起点）

        for d in diffs:
            tag = d['tag']
            la_pos = d['la_orig_span'][0]
            raw_pos = d['raw_orig_span'][0]

            if tag == 'replace' and len(d['raw_frag']) == 1 and len(d['la_frag']) == 1:
                if args.no_llm:
                    accept_la = False
                else:
                    sent = get_sentence_around(raw, raw_pos)[:200]
                    prompt = RULE1_PROMPT_REPLACE.format(
                        sentence=sent, raw_char=d['raw_frag'], la_char=d['la_frag'])
                    resp = llm_call(prompt)
                    api_calls += 1
                    decisions.append({'tag':'replace','raw':d['raw_frag'],
                                      'la':d['la_frag'],'llm':resp[:30]})
                    if 'yes_fix' in resp: accept_la = True
                    elif 'no_keep' in resp: accept_la = False
                    else: all_decided = False; break
                if not accept_la:
                    ops.append((la_pos, 'replace', d['raw_frag']))
                else:
                    trust_llm_at.add(d['raw_clean_span'][0])  # 信 AI 改字，跳过该处 strict check

            elif tag == 'delete' and len(d['raw_frag']) == 1:
                if args.no_llm:
                    keep_raw = True
                else:
                    sent_raw = get_sentence_around(raw, raw_pos)[:200]
                    sent_la = get_sentence_around(la, min(la_pos, len(la)-1))[:200]
                    prompt = RULE1_PROMPT_DROP.format(
                        sentence_raw=sent_raw, sentence_la=sent_la,
                        raw_char=d['raw_frag'])
                    resp = llm_call(prompt)
                    api_calls += 1
                    decisions.append({'tag':'delete','raw':d['raw_frag'],'llm':resp[:30]})
                    if 'yes_keep' in resp: keep_raw = True
                    elif 'no_drop' in resp: keep_raw = False
                    else: all_decided = False; break
                if keep_raw:
                    ops.append((la_pos, 'insert', d['raw_frag']))
                else:
                    trust_llm_at.add(d['raw_clean_span'][0])  # 信 AI 漏字（raw 是 OCR 重复/赘字）

            elif tag == 'insert' and len(d['la_frag']) == 1:
                if args.no_llm:
                    remove_la = True
                else:
                    sent_raw = get_sentence_around(raw, min(raw_pos, len(raw)-1))[:200]
                    sent_la = get_sentence_around(la, la_pos)[:200]
                    prompt = RULE1_PROMPT_INSERT.format(
                        sentence_raw=sent_raw, sentence_la=sent_la,
                        la_char=d['la_frag'])
                    resp = llm_call(prompt)
                    api_calls += 1
                    decisions.append({'tag':'insert','la':d['la_frag'],'llm':resp[:30]})
                    if 'yes_remove' in resp: remove_la = True
                    elif 'no_keep' in resp: remove_la = False
                    else: all_decided = False; break
                if remove_la:
                    ops.append((la_pos, 'delete_la', d['la_frag']))
                else:
                    trust_llm_at.add(d['raw_clean_span'][0])  # 信 AI 补字（raw 漏字）
            else:
                all_decided = False; break

        if not all_decided:
            need_human.append({**r, 'rule1_uncertain': True, 'decisions': decisions})
            continue

        # 执行所有 ops（从后往前避免错位）
        new_la = list(la)
        for la_pos, kind, ch in sorted(ops, key=lambda x: -x[0]):
            if kind == 'replace':
                if la_pos < len(new_la): new_la[la_pos] = ch
            elif kind == 'insert':
                new_la.insert(la_pos, ch)
            elif kind == 'delete_la':
                if la_pos < len(new_la) and new_la[la_pos] == ch:
                    new_la.pop(la_pos)
        new_la_str = ''.join(new_la)

        # Post check: 如果有 yes_fix / no_drop / no_keep_insert 判定（信 AI），那些位置
        # 故意跟 raw 不一致，strict 检查会失败但其实是预期；只在没有"信 AI"判定时做严检
        new_sp = PUNCT_RE.sub('', new_la_str)
        new_sr = PUNCT_RE.sub('', raw)
        if not trust_llm_at:
            ok = (new_sp == new_sr)
        else:
            # 有信 AI 决策，长度可能差异但不一定 — 验证长度合理（每个 yes_fix
            # 改字不影响长度，但 yes_keep_drop 信 AI 漏字会让 punct 短 1 字）
            # 简化：信 AI 时不做 strict 等价，跳过 post check
            ok = True

        if ok:
            rescued.append({
                'id': r.get('orig_id') or r['id'],
                'raw': raw, 'punct': new_la_str,
                'source': 'rescue:rule1_' + ('no_llm' if args.no_llm else 'llm_ocr_check'),
                'origin': r.get('origin','?'),
                'rule1_ops_count': len(ops),
                'rule1_trust_llm_count': len(trust_llm_at),
                'rule1_decisions': decisions if not args.no_llm else None,
            })
        else:
            need_human.append({**r, 'rule1_post_check_failed': True, 'decisions': decisions})

        if api_calls and api_calls % 10 == 0:
            print(f'  已调用 {api_calls} 次 LLM ...')

    print(f'\nRule 1 结果:')
    if not args.no_llm: print(f'  LLM API 调用: {api_calls}')
    print(f'  ✅ 自动救回: {len(rescued)}')
    print(f'  ⚠️  仍需人工: {len(need_human)}')

    if args.dry_run:
        print('[--dry-run] 不写文件'); return

    # 应用救援
    if merged and rescued:
        merged_ids = {str(r['id']) for r in merged}
        added = 0
        for r in rescued:
            if str(r['id']) not in merged_ids:
                merged.append(r); added += 1
        with open(args.merged, 'w', encoding='utf-8') as f:
            for r in merged: f.write(json.dumps(r, ensure_ascii=False) + '\n')
        print(f'  merged 新增 {added} 条')

    # 从 still-failed 移除已救回的
    rescued_ids = {str(r['id']) for r in rescued}
    new_still = [r for r in still
                 if str(r.get('orig_id') or r.get('id')) not in rescued_ids]
    with open(args.still_failed, 'w', encoding='utf-8') as f:
        for r in new_still: f.write(json.dumps(r, ensure_ascii=False) + '\n')
    print(f'  still-failed: {len(still)} → {len(new_still)}')

    # 详情
    out_detail = str(Path(args.still_failed).parent / 'rule1-rescued.jsonl')
    with open(out_detail, 'w', encoding='utf-8') as f:
        for r in rescued + need_human:
            f.write(json.dumps(r, ensure_ascii=False) + '\n')
    print(f'  详情: {out_detail}')


# ============================================================
# Rule 3: 递归再切
# ============================================================
def resplit_long(raw, max_chunks=(500, 350, 250, 180)):
    """对超长段递归再切。raw 是无标点的古文，启发式：
       1. ○ (新段起始符) 100% 是切点
       2. 末尾助词「也/矣/焉/哉」+ 后接段首词「又/初/后/然/按/凡/一」
       3. 句末模式「曰/云」前 + 「○」开头新事件
       逐档缩小 chunk 上限直到切到 ≤max_chunks[-1]。
    """
    END_PARTICLES = set('也矣焉哉')
    START_WORDS = set('又初后然按凡一')

    def find_split_positions(text):
        positions = set()
        for m in re.finditer(r'○', text):
            if m.start() > 50: positions.add(m.start())
        for i in range(1, len(text)-1):
            if text[i-1] in END_PARTICLES and text[i] in START_WORDS:
                positions.add(i)
        return sorted(positions)

    chunks = [raw]
    for limit in max_chunks:
        new_chunks = []
        for c in chunks:
            if len(c) <= limit:
                new_chunks.append(c); continue
            splits = find_split_positions(c)
            valid = [p for p in splits if 50 < p < limit and (len(c)-p) > 50]
            if not valid:
                new_chunks.append(c); continue
            split_at = max(valid)
            new_chunks.append(c[:split_at])
            new_chunks.append(c[split_at:])
        chunks = new_chunks
        if all(len(c) <= max_chunks[-1] for c in chunks): break
    return chunks


# ============================================================
# Rule 2/3/4: 准备 retry batch
# ============================================================
def cmd_prepare_batch(args):
    """生成下一轮 LLM 重跑的 input.jsonl 与 prompt。
    partial_failed 只重跑失败块（需要 chunks_map + kaggle_fail）。
    gave_up 重跑整段（含 Rule 2/3 路由）。"""
    still = load_jsonl(args.still_failed)
    print(f'still-failed: {len(still)}')

    chunks_map = json.load(open(args.chunks_map, 'r', encoding='utf-8')) if args.chunks_map else {}
    kaggle_fail = {str(r['id']): r for r in load_jsonl(args.kaggle_fail)} if args.kaggle_fail else {}
    kaggle_punct = {str(r['id']): r for r in load_jsonl(args.kaggle_punct)} if args.kaggle_punct else {}

    orig_to_chunks = defaultdict(list)
    for nid, meta in chunks_map.items():
        orig_to_chunks[meta['orig_id']].append((meta['chunk_idx'], nid))

    batch = []
    routing = Counter()
    for r in still:
        raw = r.get('raw','')
        oid = r.get('orig_id') or r.get('id')
        status = r.get('status','?')
        if not raw and status != 'partial_failed': continue

        # partial_failed: 只拿失败的子块
        if status == 'partial_failed' and chunks_map:
            try: oid_int = int(oid)
            except: oid_int = oid
            pairs = sorted(orig_to_chunks.get(oid_int, []))
            fail_pairs = [(idx, nid) for idx, nid in pairs
                          if str(nid) in kaggle_fail and str(nid) not in kaggle_punct]
            if not fail_pairs:
                routing['partial_no_failed_chunk'] += 1; continue
            for idx, nid in fail_pairs:
                chunk_raw = kaggle_fail[str(nid)]['raw']
                chunk_la = kaggle_fail[str(nid)].get('last_attempt','')
                # 对失败块再判 Rule 3 是否需要再切
                if len(chunk_raw) >= 1500:
                    sub_chunks = resplit_long(chunk_raw)
                    if len(sub_chunks) > 1:
                        routing['rule3_partial_chunk_resplit'] += 1
                        for j, c in enumerate(sub_chunks):
                            batch.append({'id': f'{nid}_re{j}of{len(sub_chunks)}',
                                          'raw': c, 'orig_id': oid, 'parent_chunk': nid,
                                          'retry_reason': 'rule3_partial_resplit'})
                        continue
                # Rule 2: chunk 的 |diff| ≥5
                if chunk_la:
                    cdiff = len(PUNCT_RE.sub('', chunk_la)) - len(PUNCT_RE.sub('', chunk_raw))
                    if abs(cdiff) >= 5:
                        routing['rule2_partial_chunk_rerun'] += 1
                    else:
                        routing['partial_chunk_fallback'] += 1
                else:
                    routing['partial_chunk_no_la'] += 1
                batch.append({'id': nid, 'raw': chunk_raw, 'orig_id': oid,
                              'parent_chunk': nid,
                              'retry_reason': 'partial_failed_chunk_rerun'})
            continue

        # gave_up 整段
        # Rule 3: 超长段 → 再切
        if len(raw) >= 1500:
            sub_chunks = resplit_long(raw)
            if len(sub_chunks) > 1:
                routing['rule3_long_resplit'] += 1
                for i, c in enumerate(sub_chunks):
                    batch.append({'id': f'{oid}_re{i}of{len(sub_chunks)}',
                                  'raw': c, 'orig_id': oid,
                                  'retry_reason': 'rule3_resplit_from_long'})
                continue

        # Rule 2: ≥5 字错漏
        la = r.get('last_attempt','')
        if la:
            sr_len = len(PUNCT_RE.sub('', raw))
            sl_len = len(PUNCT_RE.sub('', la))
            if abs(sl_len - sr_len) >= 5:
                routing['rule2_big_drift_rerun'] += 1
                batch.append({'id': oid, 'raw': raw, 'orig_id': oid,
                              'retry_reason': 'rule2_big_drift_rerun'})
                continue

        routing['fallback_rerun'] += 1
        batch.append({'id': oid, 'raw': raw, 'orig_id': oid,
                      'retry_reason': 'fallback'})

    print(f'\nbatch 路由分布:')
    for k, v in routing.most_common(): print(f'  {k:30}: {v}')
    print(f'总 batch 行数: {len(batch)}')

    if args.dry_run:
        print('[--dry-run] 不写文件'); return

    with open(args.out_input, 'w', encoding='utf-8') as f:
        for r in batch: f.write(json.dumps(r, ensure_ascii=False) + '\n')
    print(f'写入 retry batch: {args.out_input}')

    # 写 Rule 4 prompt 模板
    prompt_md = f"""# 古文加标点 retry 任务

## 任务说明
对每段古文加上现代标点（，。：；？！「」、《》）。

## 严格保字规则（违反则整段任务作废）

{STRICT_NO_EDIT_INSTRUCTION}

## 示例

无标点：自古帝王之有天下其言行政治必有史臣纪载以垂鉴戒此古今之盛典朝廷之先务也
有标点：自古帝王之有天下，其言行政治，必有史臣纪载，以垂鉴戒，此古今之盛典，朝廷之先务也。

## 使用方式

把上述 `STRICT_NO_EDIT_INSTRUCTION` 段嵌入 Kaggle/Colab notebook 的 `FEWSHOT_PROMPT`
（cell 13/16），追加到现有规则 1-5 之后即可。
"""
    with open(args.out_prompt, 'w', encoding='utf-8') as f:
        f.write(prompt_md)
    print(f'写入 prompt 模板: {args.out_prompt}')


# ============================================================
# 主入口
# ============================================================
def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)

    a1 = sub.add_parser('rule1', help='Rule 1: LLM OCR 单字校验（默认）/ --no-llm 不调 LLM')
    a1.add_argument('--still-failed', required=True)
    a1.add_argument('--merged', default='')
    a1.add_argument('--base-url', default='https://dashscope.aliyuncs.com/compatible-mode/v1')
    a1.add_argument('--model', default='qwen3.6-plus-2026-04-02',
                    help='默认 plus 模型，配额满后自动降级到 --fallback-model')
    a1.add_argument('--fallback-model', default='qwen3.6-flash',
                    help='plus 配额用尽后切换到的小模型')
    a1.add_argument('--no-llm', action='store_true', help='不调 LLM，直接按 raw 原字补回')
    a1.add_argument('--limit', type=int, default=0)
    a1.add_argument('--dry-run', action='store_true')

    ap2 = sub.add_parser('prepare-batch', help='Rule 2/3/4: 生成下一轮 LLM 重跑 batch')
    ap2.add_argument('--still-failed', required=True)
    ap2.add_argument('--out-input', required=True)
    ap2.add_argument('--out-prompt', required=True)
    ap2.add_argument('--chunks-map', default='', help='切片映射 json，partial_failed 拆失败块用')
    ap2.add_argument('--kaggle-fail',  default='', help='kaggle failures.jsonl')
    ap2.add_argument('--kaggle-punct', default='', help='kaggle punctuated.jsonl')
    ap2.add_argument('--dry-run', action='store_true')

    args = ap.parse_args()
    if args.cmd == 'rule1': cmd_rule1(args)
    elif args.cmd == 'prepare-batch': cmd_prepare_batch(args)


if __name__ == '__main__':
    main()
