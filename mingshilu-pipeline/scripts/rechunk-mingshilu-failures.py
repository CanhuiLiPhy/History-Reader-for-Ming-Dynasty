#!/usr/bin/env python3
"""
rechunk-mingshilu-failures.py

为下一轮 Kaggle 跑准备输入：
  1. 把 P1/P2 已失败 / refuse / needs-review 的段落切成 ~MAX_CHUNK 字的小块
  2. 把 P1/P2 尚未跑到的段落原样取出
  3. 合并输出一个 Kaggle 输入 JSONL，外加一份切片映射 JSON

切片策略（自上而下，省 token 优先）：
  A. 本地启发式：在 ○ 标志 / 也矣焉哉 等自然句末后切
  B. 启发式给不出合理切点时，调 Bailian Qwen3.6-plus 做"切点位置判断"
     —— 仅返回数字下标，不要求模型输出标点，最大化省 token
  C. 启发式 + Qwen 都不行才退回机械等距切

输出：
  ./mingshilu-retry-input.jsonl     —— Kaggle 输入（每行 {id, raw}）
  ./mingshilu-retry-chunks.json     —— 切片映射 {new_id: {orig_id, chunk_idx, chunk_total}}
  ./mingshilu-retry-stats.json      —— 统计（块数、Qwen 调用次数、估算 token 量）

跑完 Kaggle 后用 merge-mingshilu-retry.py 把切片合回原段。
"""

import os
import re
import sys
import json
import time
import sqlite3
import argparse
from pathlib import Path
from typing import List, Tuple, Dict, Optional

# ---------------- 路径 ----------------
DB_PATH    = '/Users/lch/mingshi-reader-ai/backend/.cache/library.sqlite'
P1_DONE    = '/Users/lch/Downloads/results-2/mingshilu-p1of8-punctuated.jsonl'
P1_FAIL    = '/Users/lch/Downloads/results-2/mingshilu-failures.jsonl'
P2_DONE    = '/Users/lch/Downloads/results/mingshilu-p2of8-punctuated.jsonl'
P2_FAIL    = '/Users/lch/Downloads/results/mingshilu-p2of8-failures.jsonl'
P2_REVIEW  = '/Users/lch/Downloads/results/mingshilu-p2of8-needs-review.jsonl'
DEFAULT_OUT_DIR = '/Users/lch/Downloads/mingshilu-retry'

# ---------------- 切片参数 ----------------
MAX_CHUNK = 350     # 目标块长（字）
SOFT_MIN  = 60      # 块下限：避免切出过短碎块
HARD_MAX  = 600     # 超过这个就一定要切；启发式拆不开就上 Qwen
WINDOW_OK = 1.5     # 切点搜索窗口：[pos, pos+MAX_CHUNK*WINDOW_OK]

# ---------------- 切点启发式 ----------------
# 句末助词（参考 notebook 用法）+ 实录常见判断后置词
END_PARTICLES = set('也矣焉哉乎耳爾')
# 实录章节惯用断点：○ 表示一条新事件
EVENT_MARK    = '○'
# 用于判断 raw 已剥过标点（剥过则一定不会出现下列字符）—— 仅做 sanity check
RESIDUAL_PUNCT = set('，。：；？！「」、,.:;?!"\'《》〈〉（）()')

# ---------------- Bailian Qwen 配置 ----------------
BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
DEFAULT_KEY = os.environ.get('AI_API_KEY', '')
MODEL = 'qwen3.6-plus-2026-04-02'


def find_candidate_cuts(raw: str) -> List[int]:
    """找到所有候选切点位置。
    返回 i 表示：raw[:i] 是前一块、raw[i:] 是后一块。
    规则：
      - raw[i] == '○'     → 新事件起首，i 处可切
      - raw[i-1] ∈ END_PARTICLES → 句末助词后，i 处可切
    """
    cuts = []
    for i in range(1, len(raw)):
        if raw[i] == EVENT_MARK:
            cuts.append(i)
        elif raw[i-1] in END_PARTICLES:
            cuts.append(i)
    return cuts


def heuristic_split(raw: str, target: int = MAX_CHUNK) -> List[Tuple[int, int]]:
    """贪心切片：从位置 0 出发，每次在 [pos+SOFT_MIN, pos+target] 范围内挑最远的候选切点。
    返回 [(start, end), ...] 覆盖整个 raw，且严格按顺序、不重叠、不丢字。
    """
    n = len(raw)
    if n <= target:
        return [(0, n)]
    candidates = find_candidate_cuts(raw)
    if not candidates:
        spans = [(i, min(i + target, n)) for i in range(0, n, target)]
        return _merge_short_tail(spans)

    spans: List[Tuple[int, int]] = []
    pos = 0
    while pos < n:
        if n - pos <= target:
            spans.append((pos, n))
            break
        window_hi = pos + target
        in_range = [c for c in candidates if pos + SOFT_MIN <= c <= window_hi]
        if not in_range:
            window_hi = pos + int(target * WINDOW_OK)
            in_range = [c for c in candidates if pos + SOFT_MIN <= c <= window_hi]
        if not in_range:
            cut = pos + target
            spans.append((pos, cut))
            pos = cut
        else:
            cut = max(in_range)
            spans.append((pos, cut))
            pos = cut
    return _merge_short_tail(spans)


def _split_oversized(spans: List[Tuple[int, int]], raw: str, target: int, hard_max: int) -> List[Tuple[int, int]]:
    """把仍 > hard_max 的块就地等距再切。"""
    out = []
    for (s, e) in spans:
        if e - s <= hard_max:
            out.append((s, e))
            continue
        for k in range(s, e, target):
            out.append((k, min(k + target, e)))
    return out


def _merge_short_tail(spans: List[Tuple[int, int]]) -> List[Tuple[int, int]]:
    """把末尾 < SOFT_MIN 的小块并回前一块；再把开头 < SOFT_MIN 的小块并到下一块。"""
    if len(spans) <= 1:
        return spans
    out = list(spans)
    while len(out) > 1 and (out[-1][1] - out[-1][0]) < SOFT_MIN:
        sp, _ = out[-2]
        _, el = out[-1]
        out[-2] = (sp, el)
        out.pop()
    while len(out) > 1 and (out[0][1] - out[0][0]) < SOFT_MIN:
        _, ep = out[0]
        sn, en = out[1]
        out[1] = (out[0][0], en)
        out.pop(0)
    return out


def qwen_pick_cuts(raw: str, target: int, api_key: str, model: str,
                   candidates: Optional[List[int]] = None) -> Optional[List[int]]:
    """让 Qwen 从启发式候选位置里挑出 N 个最好的切点。
    LLM 数字符位置不准，但很会做语义判断 —— 所以把"找位置"留给本地、"挑哪些"交给模型。

    Returns: sorted list of chosen cut positions, or None on error.
    """
    try:
        import requests
    except ImportError:
        print('  [qwen err] requests 未安装；pip install requests', file=sys.stderr)
        return None

    if candidates is None:
        candidates = find_candidate_cuts(raw)
    if not candidates:
        return None

    n_chunks = max(2, (len(raw) + target - 1) // target)
    n_cuts = min(n_chunks - 1, len(candidates))
    if n_cuts < 1:
        return None

    # 给每个候选位置附 8 字上下文（紧凑表达，token 友好）
    lines = []
    for pos in candidates:
        before = raw[max(0, pos-8):pos]
        after  = raw[pos:min(len(raw), pos+8)]
        lines.append(f'{pos}|{before}>{after}')

    prompt = (
        f"古文切片，文本共 {len(raw)} 字，目标切成 {n_chunks} 块，每块约 {target} 字。\n"
        f"以下是 {len(candidates)} 个候选切点。每行格式：位置|前 8 字>后 8 字。\n"
        f"请从中挑 {n_cuts} 个最好的切点：\n"
        f"  · 优先 ○ 开头处（新事件起首）\n"
        f"  · 次选完整事件 / 句意结束（也矣焉哉乎耳 之后）\n"
        f"  · 让各块长度尽量均匀\n"
        f"只输出选中的位置数字，逗号分隔，从小到大。\n\n"
        + '\n'.join(lines) + '\n\n选中的切点位置：'
    )
    body = {
        'model': model,
        'messages': [{'role': 'user', 'content': prompt}],
        'temperature': 0,
        'max_tokens': 128,
        'stream': False,
        # 关 thinking 模式；qwen3.6 默认开启 thinking 会让 60s 都未必返回
        'enable_thinking': False,
    }
    try:
        resp = requests.post(
            f'{BASE_URL}/chat/completions',
            headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'},
            json=body, timeout=60,
        )
        resp.raise_for_status()
        data = resp.json()
        out = data['choices'][0]['message']['content']
        chosen = sorted({int(s) for s in re.findall(r'\d+', out)})
        # 仅保留落在 candidates 集合内的（防模型胡编位置）
        cand_set = set(candidates)
        chosen = [c for c in chosen if c in cand_set]
        return chosen or None
    except Exception as e:
        print(f'  [qwen err] {e}', file=sys.stderr)
        return None


def smart_split(raw: str, target: int, api_key: str, model: str, qwen_mode: str,
                stats: dict) -> List[Tuple[int, int]]:
    """启发式 + Qwen 兜底。
    qwen_mode:
      - 'none'      : 只用启发式，最省（默认）
      - 'fallback'  : 启发式跑完后，启发式产出 >HARD_MAX 的块再让 Qwen 重挑切点
      - 'all'       : 每个 >target 的段落都先让 Qwen 从启发式候选里挑切点
    """
    n = len(raw)
    if n <= target:
        return [(0, n)]

    if qwen_mode == 'all':
        candidates = find_candidate_cuts(raw)
        if candidates and len(candidates) >= (n // target):
            cuts = qwen_pick_cuts(raw, target, api_key, model, candidates)
            stats['qwen_calls'] += 1
            stats['qwen_input_chars'] += sum(20 for _ in candidates) + 200
            if cuts:
                spans = []
                prev = 0
                for c in cuts:
                    spans.append((prev, c))
                    prev = c
                spans.append((prev, n))
                # Qwen 留下来的过长块用等距补切
                spans = _split_oversized(spans, raw, target, HARD_MAX)
                return _merge_short_tail(spans)
        # Qwen 拒绝/失败/候选不足 → 落回启发式

    spans = heuristic_split(raw, target)
    if qwen_mode == 'none':
        return spans

    # fallback：找出 >HARD_MAX 的块，让 Qwen 在 sub-raw 上再挑切点
    out_spans: List[Tuple[int, int]] = []
    for (s, e) in spans:
        if e - s <= HARD_MAX:
            out_spans.append((s, e))
            continue
        sub = raw[s:e]
        candidates = find_candidate_cuts(sub)
        cuts = qwen_pick_cuts(sub, target, api_key, model, candidates) if candidates else None
        stats['qwen_calls'] += 1
        stats['qwen_input_chars'] += sum(20 for _ in (candidates or [])) + 200
        if not cuts:
            for k in range(0, len(sub), target):
                out_spans.append((s + k, min(s + k + target, e)))
        else:
            prev = 0
            for c in cuts:
                out_spans.append((s + prev, s + c))
                prev = c
            out_spans.append((s + prev, e))
    return _merge_short_tail(out_spans)


def strip_punct(s: str) -> str:
    """与 dump-mingshilu-for-qwen.mjs 中 stripPunct 一致。"""
    drop = set("，。：；？！「」、,.:;?!\"'《》〈〉（）()—…—-")
    return ''.join(c for c in s if c not in drop)


def load_ids_only(path: str) -> set:
    s = set()
    if not Path(path).exists():
        return s
    for line in open(path, 'r', encoding='utf-8'):
        line = line.strip()
        if not line: continue
        try: s.add(json.loads(line)['id'])
        except: pass
    return s


def load_records(path: str) -> List[dict]:
    out = []
    if not Path(path).exists():
        return out
    for line in open(path, 'r', encoding='utf-8'):
        line = line.strip()
        if not line: continue
        out.append(json.loads(line))
    return out


def fetch_raw_for_ids(db_path: str, ids: List[int]) -> Dict[int, str]:
    """从 DB 取 content 并剥掉标点 → raw"""
    db = sqlite3.connect(db_path)
    out = {}
    for i in range(0, len(ids), 500):
        batch = ids[i:i+500]
        ph = ','.join('?' * len(batch))
        rows = db.execute(f"SELECT id, content FROM paragraphs WHERE id IN ({ph})", batch).fetchall()
        for pid, content in rows:
            out[pid] = strip_punct(content)
    db.close()
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out-dir', default=DEFAULT_OUT_DIR)
    ap.add_argument('--max-chunk', type=int, default=MAX_CHUNK)
    ap.add_argument('--qwen-mode', choices=['none', 'fallback', 'all'], default='fallback',
                    help='none=启发式; fallback=启发式+Qwen 兜底; all=全走 Qwen')
    ap.add_argument('--api-key', default=os.environ.get('DASHSCOPE_API_KEY', DEFAULT_KEY))
    ap.add_argument('--model', default=MODEL)
    ap.add_argument('--dry-run', action='store_true',
                    help='不实际调 Qwen；估算 token 量并报告启发式结果')
    args = ap.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)
    out_input  = f'{args.out_dir}/mingshilu-retry-input.jsonl'
    out_chunks = f'{args.out_dir}/mingshilu-retry-chunks.json'
    out_stats  = f'{args.out_dir}/mingshilu-retry-stats.json'

    qwen_mode = 'none' if args.dry_run else args.qwen_mode

    # ---------- 1. 失败段（323 + 3 = 326） ----------
    failures: List[dict] = []
    for path, label in [(P1_FAIL, 'P1-fail'), (P2_FAIL, 'P2-fail'), (P2_REVIEW, 'P2-review')]:
        for r in load_records(path):
            failures.append({'id': int(r['id']), 'raw': r['raw'], 'origin': label})
    print(f'[1] 失败/refuse/review 段: {len(failures)} 条')

    # ---------- 2. 未跑段（P1 + P2） ----------
    p1_proc = load_ids_only(P1_DONE) | load_ids_only(P1_FAIL)
    p2_proc = load_ids_only(P2_DONE) | load_ids_only(P2_FAIL) | load_ids_only(P2_REVIEW)

    db = sqlite3.connect(DB_PATH)
    all_ids = sorted(r[0] for r in db.execute("SELECT id FROM paragraphs WHERE book_id=6"))
    db.close()
    expected_p1 = all_ids[0::8]
    expected_p2 = all_ids[1::8]
    p1_remaining = [i for i in expected_p1 if i not in p1_proc]
    p2_remaining = [i for i in expected_p2 if i not in p2_proc]
    print(f'[2] P1 未跑 {len(p1_remaining)} + P2 未跑 {len(p2_remaining)} = {len(p1_remaining)+len(p2_remaining)} 条')

    raws_p1 = fetch_raw_for_ids(DB_PATH, p1_remaining)
    raws_p2 = fetch_raw_for_ids(DB_PATH, p2_remaining)

    # ---------- 3. 切片 ----------
    stats = {'qwen_calls': 0, 'qwen_input_chars': 0, 'heuristic_only': 0, 'qwen_used': 0,
             'chunk_total': 0, 'remainder_total': 0}
    out_records: List[dict] = []
    chunks_map: Dict[str, dict] = {}

    print(f'[3] 开始切片 (qwen_mode={qwen_mode}, max_chunk={args.max_chunk}, hard_max={HARD_MAX})')
    for idx, rec in enumerate(failures, 1):
        raw = rec['raw']
        orig_id = rec['id']
        # 健全性检查
        residual = [c for c in raw if c in RESIDUAL_PUNCT]
        if residual:
            print(f'  [warn] id={orig_id} raw 残留标点 {residual[:5]}（流水线会自动剥；继续）')

        before_qwen = stats['qwen_calls']
        spans = smart_split(raw, args.max_chunk, args.api_key, args.model, qwen_mode, stats)
        used_qwen = stats['qwen_calls'] > before_qwen
        stats['heuristic_only' if not used_qwen else 'qwen_used'] += 1

        if len(spans) == 1:
            # 没切 —— 当作原段塞回
            out_records.append({'id': orig_id, 'raw': raw})
            stats['remainder_total'] += 1
        else:
            for j, (s, e) in enumerate(spans):
                new_id = f"{orig_id}_{j}of{len(spans)}"
                out_records.append({'id': new_id, 'raw': raw[s:e]})
                chunks_map[new_id] = {
                    'orig_id': orig_id, 'chunk_idx': j, 'chunk_total': len(spans),
                    'origin': rec['origin'],
                }
                stats['chunk_total'] += 1

        if idx % 50 == 0:
            print(f'  ... {idx}/{len(failures)} 失败段已切 (Qwen 用了 {stats["qwen_calls"]} 次)')

    # ---------- 4. 未跑段原样附上 ----------
    for raws in (raws_p1, raws_p2):
        for pid, raw in raws.items():
            out_records.append({'id': pid, 'raw': raw})
            stats['remainder_total'] += 1

    # ---------- 5. 输出 ----------
    with open(out_input, 'w', encoding='utf-8') as f:
        for r in out_records:
            f.write(json.dumps(r, ensure_ascii=False) + '\n')
    with open(out_chunks, 'w', encoding='utf-8') as f:
        json.dump(chunks_map, f, ensure_ascii=False, indent=2)
    with open(out_stats, 'w', encoding='utf-8') as f:
        json.dump(stats, f, ensure_ascii=False, indent=2)

    print()
    print('=' * 56)
    print(f'  Kaggle 输入:  {out_input}')
    print(f'  切片映射:    {out_chunks}')
    print(f'  统计:        {out_stats}')
    print('=' * 56)
    n_fail_chunked = stats["heuristic_only"] + stats["qwen_used"]
    n_fail_unchunked = len(failures) - n_fail_chunked + (n_fail_chunked - sum(1 for r in chunks_map.values() if r["chunk_idx"] == 0))
    n_fail_actually_chunked = sum(1 for r in chunks_map.values() if r["chunk_idx"] == 0)
    print(f'  失败段切片:        {stats["chunk_total"]:>6} 个 (从 {n_fail_actually_chunked} 段切出)')
    print(f'  未切原段:          {stats["remainder_total"]:>6} 个（失败段未切 + P1/P2 未跑）')
    print(f'  ── 总行数:         {len(out_records):>6}')
    print(f'  启发式独立完成:    {stats["heuristic_only"]:>6} 段')
    print(f'  调用 Qwen:         {stats["qwen_used"]:>6} 段, 共 {stats["qwen_calls"]} 次 API')
    if stats['qwen_calls']:
        est_in_tok = int(stats['qwen_input_chars'] * 1.4) + stats['qwen_calls'] * 120
        est_out_tok = stats['qwen_calls'] * 50
        print(f'  Qwen 估算 token:   输入 ~{est_in_tok:,}, 输出 ~{est_out_tok:,}')

    if args.dry_run:
        print('\n  [dry-run] 未调任何 Qwen API。重跑去掉 --dry-run。')


if __name__ == '__main__':
    main()
