#!/usr/bin/env python3
"""
rescue-failures.py — 把 LLM 加标点失败段尽可能用非 LLM 方法救回。

已知失败模式 + 修复方法（详见 mingshilu-pipeline/docs/failure-modes.md）：

  A. 模型加字          → drift autofix V1 (difflib + PUA 检测)
  A2. 加字 + 繁简差异   → drift autofix V2 (OpenCC t2s 归一化做 diff，
                          输出用 raw 的原字)
  B. 模型砍掉真重复    → 验证 raw 同字串出现 ≥ 2 次后接受模型版本
  C. OCR 括号被剥      → 扫 raw 的 [X]/＜X＞/〈X〉 → 在 la 对应位置补回
  D. partial_failed    → 按 chunks_map 拆 chunk，每个失败 chunk 套 A/B/C
  E. Header 残渣       → raw 起头 `[\$#@%^*]+\d+[\$#@%^*&]+` → 剥掉
  F. Item marker 漏字  → 「一/二/三...」+「是/在/仍/曰...」启发式补回
  G. 繁简/异体字差异    → normalize_punct_to_raw：OpenCC + yitizi 等价
                          替换成 raw 的原字

用法：
  python3 rescue-failures.py \\
    --still-failed PATH/mingshilu-retry-still-failed.jsonl \\
    --merged PATH/mingshilu-retry-merged.jsonl \\
    --chunks-map PATH/mingshilu-retry-chunks.json \\
    --kaggle-punct PATH/mingshilu-retry-input-punctuated.jsonl \\
    --kaggle-fail  PATH/mingshilu-retry-input-failures.jsonl \\
    --out-rescued  PATH/rescued.jsonl
"""
import os, sys, json, re, difflib, argparse
from pathlib import Path
from collections import defaultdict, Counter

PUNCT_RE = re.compile(r'[，。：；？！「」『』、《》()（）\[\]【】〈〉,.:;?!"\'\s·‧・•‥…—–]')

# 外部等价库（可选）
try:
    from opencc import OpenCC
    _T2S = OpenCC('t2s')
except ImportError:
    _T2S = None
try:
    import yitizi
    _HAS_YITIZI = True
except ImportError:
    _HAS_YITIZI = False


# ============================================================
# 基础工具
# ============================================================
def is_pua(c):
    return (0xE000 <= ord(c) <= 0xF8FF) or c in '■□▢▣◆◇○●'

def is_ocr_marker(c):
    return c in '<>＜＞〈〉⿰⿱⿲⿳⿴⿵⿶⿷⿸⿹⿺⿻'

def normalize(c):
    return _T2S.convert(c) if _T2S else c

def char_eq(rc, pc):
    """繁简 + 异体字 + PUA 等价判断"""
    if rc == pc: return True
    if is_pua(rc): return True
    if _T2S and _T2S.convert(rc) == _T2S.convert(pc): return True
    if _HAS_YITIZI:
        try:
            if pc in (yitizi.get(rc) or []): return True
            if rc in (yitizi.get(pc) or []): return True
        except: pass
    return False

def strip_to_clean_with_pos(s):
    """去 punct，返回 (clean 字符串, [clean 索引 → 原索引])"""
    clean = []; orig = []
    for i, c in enumerate(s):
        if not PUNCT_RE.match(c):
            clean.append(c); orig.append(i)
    return ''.join(clean), orig

def load_jsonl(path):
    if not path or not Path(path).exists(): return []
    return [json.loads(l) for l in open(path, 'r', encoding='utf-8') if l.strip()]


# ============================================================
# 模式 A / A2: drift autofix
# ============================================================
def autofix_drift(raw: str, punct: str, use_normalize=True):
    """
    模式 A / A2 修复：删掉模型多加的字，输出还原 raw 的繁简体。

    use_normalize=True 时（V2）用 OpenCC 归一化做 diff，能识别繁简等价。
    """
    sr, _ = strip_to_clean_with_pos(raw)
    sp, sp_pos = strip_to_clean_with_pos(punct)
    a = ''.join(normalize(c) for c in sr) if use_normalize else sr
    b = ''.join(normalize(c) for c in sp) if use_normalize else sp

    matcher = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
    to_delete = set()
    char_replace = {}  # punct 原索引 → raw 中的字
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == 'equal':
            for i, j in zip(range(i1, i2), range(j1, j2)):
                if sr[i] != sp[j]:
                    char_replace[sp_pos[j]] = sr[i]
        elif tag == 'insert':
            ctx = a[max(0, i1-2):min(len(a), i1+2)]
            if not any(is_pua(c) or is_ocr_marker(c) for c in ctx):
                for j in range(j1, j2): to_delete.add(sp_pos[j])
        elif tag == 'replace':
            ctx = a[i1:i2]
            if not any(is_pua(c) or is_ocr_marker(c) for c in ctx):
                keep = i2 - i1
                for k, j in enumerate(range(j1, j2)):
                    if k < keep:
                        char_replace[sp_pos[j]] = sr[i1 + k]
                    else:
                        to_delete.add(sp_pos[j])
    return ''.join(char_replace.get(i, c) for i, c in enumerate(punct) if i not in to_delete)


# ============================================================
# 模式 G: 繁简/异体字归一化（对已经 merged 但内容字符不同的）
# ============================================================
def normalize_punct_to_raw(raw: str, punct: str) -> str:
    """对 punct 的每个内容字符，若 char_eq 等价但字符不同，替换成 raw 的原字。"""
    sr, _ = strip_to_clean_with_pos(raw)
    sp, sp_pos = strip_to_clean_with_pos(punct)
    if len(sr) != len(sp): return punct
    out = list(punct)
    for i, (rc, pc) in enumerate(zip(sr, sp)):
        if rc != pc and char_eq(rc, pc):
            out[sp_pos[i]] = rc
    return ''.join(out)


# ============================================================
# 模式 B: raw 真重复检测
# ============================================================
def detect_duplicate_drop(raw: str, last_attempt: str):
    """
    raw 漏掉的字符串在 raw 全文出现 ≥ 2 次 → 真重复，可接受模型版本。
    返回 (is_dup, evidence)
    """
    sr = PUNCT_RE.sub('', raw)
    sl = PUNCT_RE.sub('', last_attempt)
    if len(sl) >= len(sr): return False, None
    matcher = difflib.SequenceMatcher(a=sr, b=sl, autojunk=False)
    dels = [(i1, i2, sr[i1:i2]) for tag, i1, i2, j1, j2 in matcher.get_opcodes() if tag == 'delete']
    if not dels: return False, None
    proofs = []
    for i1, i2, frag in dels:
        if len(frag) < 3:
            return False, f'frag too short: {frag}'
        if sr.count(frag) < 2:
            return False, f'frag「{frag[:20]}」 only 1 in raw'
        proofs.append(f'frag「{frag[:20]}」 ×{sr.count(frag)}')
    return True, proofs


# ============================================================
# 模式 C: OCR 括号补回
# ============================================================
BRACKET_RE = re.compile(r'\[[^\[\]]{1,5}\]|＜[^＜＞]{1,8}＞|〈[^〈〉]{1,5}〉')

def restore_brackets(raw: str, la: str):
    matches = list(BRACKET_RE.finditer(raw))
    if not matches: return la, []
    fixed = la
    inserted = []
    for m in matches:
        full = m.group(0)
        if full.startswith('['):   inner, lb, rb = full[1:-1], '[', ']'
        elif full.startswith('＜'): inner, lb, rb = full[1:-1], '＜', '＞'
        elif full.startswith('〈'): inner, lb, rb = full[1:-1], '〈', '〉'
        else: continue
        idx = fixed.find(inner)
        if idx >= 0 and idx + len(inner) <= len(fixed):
            if not (idx > 0 and fixed[idx-1] == lb):
                fixed = fixed[:idx] + lb + inner + rb + fixed[idx+len(inner):]
                inserted.append((idx, full))
    return fixed, inserted


# ============================================================
# 模式 E: header 残渣剥离
# ============================================================
HEADER_RE = re.compile(r'^[\$#@%\^\*]+\d+[\$#@%\^\*&]+\s*')

def strip_header_garbage(raw: str, la: str):
    m = HEADER_RE.match(raw)
    if not m: return None
    stripped_raw = raw[m.end():].lstrip()
    sr = PUNCT_RE.sub('', stripped_raw)
    sl = PUNCT_RE.sub('', la)
    if sr == sl: return stripped_raw
    return None


# ============================================================
# 模式 F: 「一/二」item marker 补回
# ============================================================
ITEM_RE = re.compile(r'(一|二|三|四|五|六|七|八|九|十)(?=是|在|仍|乞|以|凡|有|令|乃|曰|凡|依|遵|查|今)')

def restore_item_markers(raw: str, la: str):
    sr, _ = strip_to_clean_with_pos(raw)
    sl, sl_pos = strip_to_clean_with_pos(la)
    a = ''.join(normalize(c) for c in sr)
    b = ''.join(normalize(c) for c in sl)
    matcher = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
    fixed = list(la)
    inserts = []
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag != 'delete': continue
        window = sr[max(0, i1-2):min(len(sr), i2+5)]
        if not ITEM_RE.search(window): continue
        for k, c in enumerate(sr[i1:i2]):
            if c not in '一二三四五六七八九十': continue
            following = sr[i1+k+1:i1+k+3]
            if following[:1] not in '是在仍乞以凡有令乃曰凡依遵查今': continue
            if j1 < len(sl_pos):
                ins_at = sl_pos[j1]
            elif sl_pos:
                ins_at = sl_pos[-1] + 1
            else:
                ins_at = len(la)
            inserts.append((ins_at, c))
    inserts.sort(reverse=True)
    for ins_at, c in inserts:
        fixed.insert(ins_at, c)
    return ''.join(fixed), len(inserts)


# ============================================================
# 模式 H: 纯漏字救援
# ============================================================
def autofix_pure_missing(raw: str, la: str):
    """纯漏字救援：
       - la 的字都在 raw 里且顺序完全正确（即 SequenceMatcher 只产生 equal + delete）
       - 漏掉的不是 raw OCR 重复（避开 Mode B 已处理的）
       - 漏掉的 frag 不全是 PUA / OCR marker（PUA 跳过）
       → 直接把 raw 漏的字插回 la 对应位置
    """
    sr, _ = strip_to_clean_with_pos(raw)
    sp, sp_pos = strip_to_clean_with_pos(la)
    matcher = difflib.SequenceMatcher(a=sr, b=sp, autojunk=False)

    has_insert = False; has_replace = False
    deletes = []
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == 'insert': has_insert = True
        elif tag == 'replace': has_replace = True
        elif tag == 'delete':
            deletes.append({'sr_start': i1, 'sr_end': i2, 'sp_start': j1,
                            'frag': sr[i1:i2]})

    if has_insert or has_replace: return None     # 不"纯"
    if not deletes: return None                    # 没漏字

    # 排除 Mode B 重复（raw 全文 ≥2 次出现该 frag）
    for d in deletes:
        if len(d['frag']) >= 3 and sr.count(d['frag']) >= 2:
            return None

    # 从后往前插入到 la
    ops = []
    for d in deletes:
        # frag 是 raw 漏掉的 ≥1 字串；按字符逐个插入
        # la 的插入位置 = sp[j1] 对应的 la 原索引
        la_pos = sp_pos[d['sp_start']] if d['sp_start'] < len(sp_pos) else len(la)
        # 跳过纯 PUA frag（漏 PUA 占位符往往是合理的）
        if all(is_pua(c) or is_ocr_marker(c) for c in d['frag']):
            continue
        ops.append((la_pos, d['frag']))

    if not ops: return None  # 全是 PUA，没东西可插

    ops.sort(key=lambda x: -x[0])
    new_la = list(la)
    for la_pos, frag in ops:
        for k, c in enumerate(frag):
            new_la.insert(la_pos + k, c)
    return ''.join(new_la)


# ============================================================
# 主修复器：尝试每种模式，返回第一个成功的
# ============================================================
def try_rescue_one(raw: str, la: str):
    """
    对单条 (raw, la) 跑所有修复策略，返回 (fixed_punct, mode) 或 (None, None)。
    """
    if not raw or not la: return None, None
    sr = PUNCT_RE.sub('', raw)

    # 1. drift autofix V2 (含繁简归一化)
    fixed = autofix_drift(raw, la, use_normalize=True)
    if PUNCT_RE.sub('', fixed) == sr:
        return fixed, 'A2_drift_autofix_v2'

    # 2. drift autofix V1 (纯字符)
    fixed = autofix_drift(raw, la, use_normalize=False)
    if PUNCT_RE.sub('', fixed) == sr:
        return fixed, 'A_drift_autofix_v1'

    # 3. B: 真重复，直接接受 la
    is_dup, evidence = detect_duplicate_drop(raw, la)
    if is_dup:
        return la, 'B_accept_dup_removed'

    # 4. C: 括号补回（针对漏字类）
    fixed_la, ins = restore_brackets(raw, la)
    if ins and PUNCT_RE.sub('', fixed_la) == sr:
        return fixed_la, 'C_restore_brackets'

    # 5. E: header 垃圾剥离（注意：返回的是新 raw，不是新 punct）
    new_raw = strip_header_garbage(raw, la)
    if new_raw is not None:
        return la, 'E_strip_header'  # 调用者要记得用 new_raw 而不是原 raw

    # 6. F: item marker 补回
    fixed, n_ins = restore_item_markers(raw, la)
    if n_ins > 0 and PUNCT_RE.sub('', fixed) == sr:
        return fixed, 'F_restore_item_marker'

    # 7. H: 纯漏字救援（最后一关）
    fixed = autofix_pure_missing(raw, la)
    if fixed is not None and PUNCT_RE.sub('', fixed) == sr:
        return fixed, 'H_pure_missing_restore'

    return None, None


# ============================================================
# 主入口：跑完整 rescue pipeline
# ============================================================
def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd')

    # 默认 rescue 子命令（兼容旧的不带子命令的调用）
    ap_rescue = sub.add_parser('rescue', help='默认：跑两阶段 rescue（drift 清理 + try_rescue_one）')
    for p in (ap, ap_rescue):
        p.add_argument('--still-failed', help='当前 still-failed jsonl')
        p.add_argument('--merged',       help='当前 merged jsonl（in-place 追加 rescue）')
        p.add_argument('--chunks-map',   help='chunks map json')
        p.add_argument('--kaggle-punct', help='kaggle punctuated.jsonl')
        p.add_argument('--kaggle-fail',  help='kaggle failures.jsonl')
        p.add_argument('--out-rescued',  default='', help='rescue 详情 jsonl（默认放在 --still-failed 同目录）')
        p.add_argument('--dry-run', action='store_true', help='只打印统计，不写文件')

    ap_verify = sub.add_parser('verify', help='sanity 审计 merged 字符一致性')
    ap_verify.add_argument('--merged', required=True)

    args = ap.parse_args()
    if args.cmd == 'verify':
        cmd_verify(args); return
    # rescue（默认）
    for required in ('still_failed', 'merged', 'chunks_map', 'kaggle_punct', 'kaggle_fail'):
        if not getattr(args, required, None):
            ap.error(f'rescue 子命令需要 --{required.replace("_","-")}')

    still = load_jsonl(args.still_failed)
    merged = load_jsonl(args.merged)
    chunks_map = json.load(open(args.chunks_map, 'r', encoding='utf-8'))
    kaggle_punct = {str(r['id']): r for r in load_jsonl(args.kaggle_punct)}
    kaggle_fail  = {str(r['id']): r for r in load_jsonl(args.kaggle_fail)}

    orig_to_chunks = defaultdict(list)
    for nid, meta in chunks_map.items():
        orig_to_chunks[meta['orig_id']].append((meta['chunk_idx'], nid))

    # 阶段 1: 对 merged 全表跑 autofix_drift(use_normalize=True)
    # 这一步同时完成 3 件事:
    #   1) 清掉 rescue cascade 留下的 drift 多字（model_extra / pua_sub 路径）
    #   2) 把内容字符里繁简/异体字差异还原成 raw 的写法
    #   3) PUA 上下文里的替代字保留（OCR 残缺字符不被误删）
    # 不发生上述任一情况的记录 → 原样返回，无开销
    stage1_changed = 0
    stage1_drift_cleaned = 0
    for r in merged:
        old_p = r['punct']
        sr_clean = PUNCT_RE.sub('', r['raw'])
        sp_clean = PUNCT_RE.sub('', old_p)
        had_drift = len(sp_clean) > len(sr_clean)
        new_p = autofix_drift(r['raw'], old_p, use_normalize=True)
        if new_p != old_p:
            r['punct'] = new_p
            r['_rescue_g_cleaned'] = True
            stage1_changed += 1
            if had_drift: stage1_drift_cleaned += 1

    # 阶段 2: 对每条 still-failed 跑 try_rescue_one
    rescued = []
    still_remaining = []
    stats = Counter()

    for r in still:
        status = r.get('status', '?')
        raw = r.get('raw', ''); la = r.get('last_attempt', '')

        # gave_up: 直接对 raw + la 跑 rescue
        if status == 'gave_up':
            fixed, mode = try_rescue_one(raw, la)
            if fixed is not None:
                final_raw = raw
                if mode == 'E_strip_header':
                    final_raw = strip_header_garbage(raw, la) or raw
                rescued.append({
                    'id': r.get('orig_id') or r['id'],
                    'raw': final_raw, 'punct': fixed,
                    'source': f'rescue:{mode}', 'origin': r.get('origin', '?'),
                    'rescue_reason': mode,
                })
                stats[mode] += 1
                continue
            still_remaining.append(r)
            stats['gave_up_hard'] += 1

        # partial_failed: 拆 chunk 后逐个 rescue
        elif status == 'partial_failed':
            orig_id = r['id']
            try: oid = int(orig_id)
            except: oid = orig_id
            pairs = sorted(orig_to_chunks.get(oid, []))
            if not pairs:
                still_remaining.append(r); stats['partial_no_chunks'] += 1; continue

            parts = []; can_finalize = True; sub_modes = []
            for idx, nid in pairs:
                if nid in kaggle_punct and 'punct' in kaggle_punct[nid]:
                    parts.append(kaggle_punct[nid]['punct'] or kaggle_punct[nid]['raw'])
                elif nid in kaggle_fail:
                    chunk_raw = kaggle_fail[nid]['raw']
                    chunk_la = kaggle_fail[nid].get('last_attempt', '')
                    chunk_fixed, chunk_mode = try_rescue_one(chunk_raw, chunk_la)
                    if chunk_fixed is None:
                        can_finalize = False; break
                    parts.append(chunk_fixed); sub_modes.append(chunk_mode)
                else:
                    can_finalize = False; break

            if can_finalize:
                rescued.append({
                    'id': orig_id, 'raw': r.get('raw', ''),
                    'punct': ''.join(parts),
                    'source': 'rescue:partial+' + '+'.join(set(sub_modes)),
                    'origin': r.get('origin', '?'),
                    'rescue_reason': f'partial all subchunks rescued: {sub_modes}',
                })
                stats['partial_full_rescue'] += 1
            else:
                still_remaining.append(r)
                stats['partial_hard'] += 1
        else:
            still_remaining.append(r)
            stats[f'skip_status_{status}'] += 1

    # 报告
    print(f'\n========== rescue 报告 ==========')
    print(f'输入 still-failed: {len(still)} 条')
    print(f'merged 已有: {len(merged)} 条')
    print(f'\n阶段 1 (autofix_drift on merged): {stage1_changed} 条调整')
    print(f'  其中清掉 drift 多字: {stage1_drift_cleaned} 条')
    print(f'  其余: 繁简/异体字还原 / PUA 替代保留')
    print(f'\n阶段 2 (rescue still-failed):')
    print(f'  ✅ 救回: {len(rescued)} 条')
    print(f'  ❌ 仍卡: {len(still_remaining)} 条')
    print(f'\n按模式分类:')
    for k, v in stats.most_common():
        print(f'  {k:30}: {v}')

    if args.dry_run:
        print('\n[--dry-run] 不写文件')
        return

    # 写 merged（追加 rescue）
    merged_ids = {str(r['id']) for r in merged}
    new_added = 0
    for r in rescued:
        if str(r['id']) not in merged_ids:
            merged.append(r); new_added += 1
    with open(args.merged, 'w', encoding='utf-8') as f:
        for r in merged: f.write(json.dumps(r, ensure_ascii=False) + '\n')

    # 写 still-failed
    with open(args.still_failed, 'w', encoding='utf-8') as f:
        for r in still_remaining: f.write(json.dumps(r, ensure_ascii=False) + '\n')

    # 写 rescue 详情
    out_rescued = args.out_rescued or str(Path(args.still_failed).parent / 'rescued.jsonl')
    with open(out_rescued, 'w', encoding='utf-8') as f:
        for r in rescued: f.write(json.dumps(r, ensure_ascii=False) + '\n')

    print(f'\nmerged: 追加 {new_added} 条 → 总 {len(merged)} 条')
    print(f'still-failed: 剩 {len(still_remaining)} 条')
    print(f'rescue 详情: {out_rescued}')


def cmd_verify(args):
    """sanity 审计：扫 merged 文件，统计 punct 去标点 vs raw 的差异类型。

    四档：
      - 繁简差异      : char_eq 等价但具体字不同（应该 = 0，否则阶段 1 未跑全）
      - PUA 替换      : raw 是 PUA/OCR 残缺，punct 用了合理字（预期内，不算 bug）
      - 其他字符差异  : 模型对 OCR 修正（可能合理也可能误改，需要人工）
      - 字数不等      : 漏字/加字未清干净（含 rescue:mode_b_accept_model 类的有意行为）
    """
    merged = load_jsonl(args.merged)
    print(f'扫 merged: {len(merged)} 条\n')

    cnt = Counter()
    samples = defaultdict(list)
    # 走过 Mode B（接受模型去重）的，长度短是预期
    # 支持多种来源命名：rescue:mode_b_accept_model / rescue:B_accept_dup_removed /
    #                  rescue:partial_strict_ok+rescue_b 等
    def is_intentional_len_diff(src):
        return ('mode_b' in src or 'rescue_b' in src or 'accept_dup' in src
                or 'B_accept' in src)

    def is_rule1_llm_approved(r):
        """rule1 LLM 校验里只要走过 trust_llm（yes_fix/no_drop/no_keep_insert），
        长度差异/字符差异都是预期内的"""
        return (r.get('source','').startswith('rescue:rule1_llm_ocr_check')
                and (r.get('rule1_trust_llm_count') or 0) > 0)

    for r in merged:
        raw = r.get('raw',''); punct = r.get('punct','')
        if not raw or not punct: continue
        sr = PUNCT_RE.sub('', raw); sp = PUNCT_RE.sub('', punct)
        src = r.get('source','')

        if len(sr) != len(sp):
            if is_intentional_len_diff(src) or is_rule1_llm_approved(r):
                key = '字数不等(rescue 故意)'
            else:
                key = '字数不等(异常)'
            cnt[key] += 1
            if len(samples[key]) < 3:
                samples[key].append((r['id'], src[:50], len(sr), len(sp)))
            continue

        has_trad = has_pua = has_other = False
        diff_chars = []
        for rc, pc in zip(sr, sp):
            if rc == pc: continue
            if is_pua(rc): has_pua = True
            elif char_eq(rc, pc): has_trad = True
            else: has_other = True; diff_chars.append((rc, pc))
        if has_trad:
            cnt['繁简/异体字差异'] += 1
            if len(samples['繁简/异体字差异']) < 3:
                samples['繁简/异体字差异'].append((r['id'], src[:50]))
        if has_pua:
            cnt['PUA 替换(合规)'] += 1
        if has_other:
            # rule1 LLM 信 AI 改字（yes_fix）也是合规的，不算 OCR 修正
            if is_rule1_llm_approved(r):
                cnt['rule1 LLM 信 AI 改字'] += 1
                if len(samples['rule1 LLM 信 AI 改字']) < 3:
                    samples['rule1 LLM 信 AI 改字'].append((r['id'], src[:50], diff_chars[:5]))
            else:
                cnt['其他字符差异'] += 1
                if len(samples['其他字符差异']) < 3:
                    samples['其他字符差异'].append((r['id'], src[:50], diff_chars[:5]))

    print('=== 审计结果 ===')
    health = {'繁简/异体字差异': '✅ 阶段 1 跑完应该 = 0',
              'PUA 替换(合规)': '🟢 合规，不需要修',
              '其他字符差异':   '🟡 模型 OCR 修正，按需人工 review',
              'rule1 LLM 信 AI 改字': '🟢 rule1 LLM 判 yes_fix 接受 AI OCR 修正',
              '字数不等(rescue 故意)': '🟢 设计内（Mode B 接受模型去重 / rule1 信 AI）',
              '字数不等(异常)': '❌ 异常，pipeline 有 bug'}
    for k in ['繁简/异体字差异','字数不等(异常)','其他字符差异','rule1 LLM 信 AI 改字','PUA 替换(合规)','字数不等(rescue 故意)']:
        v = cnt.get(k, 0)
        status = health.get(k, '')
        print(f'  {k:25} : {v:5d}  {status}')
        for s in samples.get(k, []):
            print(f'    样本: {s}')

    # 总评
    print()
    bad = cnt.get('繁简/异体字差异', 0) + cnt.get('字数不等(异常)', 0)
    if bad == 0:
        print('🎉 审计通过')
    else:
        print(f'⚠️  有 {bad} 条异常，建议跑一遍 rescue-failures.py 修复')


if __name__ == '__main__':
    main()
