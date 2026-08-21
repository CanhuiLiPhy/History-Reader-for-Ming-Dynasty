#!/usr/bin/env python3
"""
merge-mingshilu-retry.py

把 Kaggle 跑完的切片输出按 chunk marker 合回原段。

输入：
  --kaggle-out  Kaggle 输出的 -punctuated.jsonl（含切片 + 未切原段）
  --chunks-map  rechunk 时输出的 mingshilu-retry-chunks.json
  --kaggle-fail Kaggle 输出的 -failures.jsonl（可选）

输出：
  ./mingshilu-retry-merged.jsonl   —— 按 orig_id 合并后的 {id, raw, punct, source, parts}
  ./mingshilu-retry-still-failed.jsonl —— 任何切片仍失败的原 orig_id
"""

import os
import sys
import json
import argparse
from collections import defaultdict
from pathlib import Path


def load_jsonl(path):
    if not path or not Path(path).exists():
        return []
    out = []
    for line in open(path, 'r', encoding='utf-8'):
        line = line.strip()
        if not line: continue
        out.append(json.loads(line))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--kaggle-out', required=True, help='Kaggle 输出 punctuated.jsonl')
    ap.add_argument('--chunks-map', required=True, help='rechunk 输出的 chunks.json')
    ap.add_argument('--kaggle-fail', default='', help='Kaggle 输出 failures.jsonl（可选）')
    ap.add_argument('--out-dir', default='/Users/lch/Downloads/mingshilu-retry')
    args = ap.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)
    out_merged = f'{args.out_dir}/mingshilu-retry-merged.jsonl'
    out_failed = f'{args.out_dir}/mingshilu-retry-still-failed.jsonl'

    chunks_map = json.load(open(args.chunks_map, 'r', encoding='utf-8'))
    kaggle_out  = load_jsonl(args.kaggle_out)
    kaggle_fail = load_jsonl(args.kaggle_fail) if args.kaggle_fail else []

    # 索引：new_id → record
    out_by_id   = {str(r['id']): r for r in kaggle_out}
    fail_by_id  = {str(r['id']): r for r in kaggle_fail}

    # 把切片分组到 orig_id
    chunks_by_orig = defaultdict(dict)  # orig_id -> {chunk_idx: kaggle_rec}
    chunk_totals   = {}
    chunk_origins  = {}
    for new_id, meta in chunks_map.items():
        chunks_by_orig[meta['orig_id']][meta['chunk_idx']] = new_id
        chunk_totals[meta['orig_id']] = meta['chunk_total']
        chunk_origins[meta['orig_id']] = meta.get('origin', '')

    merged_records = []
    failed_records = []

    # 1) 处理切片：拼回 orig_id
    for orig_id, idx_to_newid in chunks_by_orig.items():
        total = chunk_totals[orig_id]
        parts_punct = []
        parts_raw = []
        sources = []
        tries_sum = 0
        any_fail = False
        any_missing = False
        missing_idxs = []
        for idx in range(total):
            new_id = idx_to_newid.get(idx)
            if not new_id:
                any_missing = True
                missing_idxs.append(idx)
                continue
            if new_id in out_by_id:
                rec = out_by_id[new_id]
                parts_punct.append(rec.get('punct', rec.get('raw', '')))
                parts_raw.append(rec.get('raw', ''))
                sources.append(rec.get('source', '?'))
                tries_sum += rec.get('tries', 1)
            elif new_id in fail_by_id:
                any_fail = True
                rec = fail_by_id[new_id]
                parts_raw.append(rec.get('raw', ''))
                parts_punct.append(rec.get('last_attempt') or rec.get('raw', ''))
                sources.append(rec.get('status', 'failed'))
            else:
                any_missing = True
                missing_idxs.append(idx)

        if any_missing:
            failed_records.append({
                'orig_id': orig_id, 'reason': 'missing_chunks',
                'missing_idx': missing_idxs, 'origin': chunk_origins.get(orig_id, ''),
            })
            continue

        merged = {
            'id': orig_id,
            'raw': ''.join(parts_raw),
            'punct': ''.join(parts_punct),
            'source': '|'.join(set(sources)) if any_fail else f'rechunk:{"+".join(set(sources))}',
            'tries': tries_sum,
            'chunk_total': total,
            'origin': chunk_origins.get(orig_id, ''),
        }
        if any_fail:
            merged['status'] = 'partial_failed'
            failed_records.append(merged)
        else:
            merged_records.append(merged)

    # 2) 处理未切原段（直接是原 orig_id）：直接复制
    chunk_new_ids = set(chunks_map.keys())
    for new_id, rec in out_by_id.items():
        if new_id in chunk_new_ids:
            continue
        try: pid = int(new_id)
        except: pid = new_id
        merged_records.append({
            'id': pid,
            'raw': rec.get('raw', ''),
            'punct': rec.get('punct', ''),
            'source': rec.get('source', '?'),
            'tries': rec.get('tries', 1),
            'chunk_total': 1,
            'origin': 'remainder',
        })

    for new_id, rec in fail_by_id.items():
        if new_id in chunk_new_ids:
            continue
        try: pid = int(new_id)
        except: pid = new_id
        failed_records.append({
            'orig_id': pid,
            'raw': rec.get('raw', ''),
            'last_attempt': rec.get('last_attempt', ''),
            'status': rec.get('status', 'failed'),
            'origin': 'remainder',
        })

    # 3) 输出
    with open(out_merged, 'w', encoding='utf-8') as f:
        for r in merged_records:
            f.write(json.dumps(r, ensure_ascii=False) + '\n')
    with open(out_failed, 'w', encoding='utf-8') as f:
        for r in failed_records:
            f.write(json.dumps(r, ensure_ascii=False) + '\n')

    # 校验：所有 merged 的 raw 拼起来 == 原 raw（去标点等价）
    # 双边对称 strip + 完整标点集合（含 ·‧・•‥…—– 等书名分隔符 / 间隔号）
    import re
    PUNCT_RE = re.compile(r'[，。：；？！「」『』、《》()（）\[\]【】〈〉,.:;?!"\'\s·‧・•‥…—–]')
    drift_records = []
    for r in merged_records:
        if r.get('chunk_total', 1) > 1:
            sr = PUNCT_RE.sub('', r['raw'])
            sp = PUNCT_RE.sub('', r['punct'])
            if sr != sp:
                drift_records.append({
                    'id': r['id'],
                    'raw_clean_len': len(sr),
                    'punct_clean_len': len(sp),
                    'diff': len(sp) - len(sr),
                    'source': r.get('source', '?'),
                    'origin': r.get('origin', ''),
                    'raw': r['raw'],
                    'punct': r['punct'],
                })
    if drift_records:
        out_drift = f'{args.out_dir}/mingshilu-retry-drift.jsonl'
        with open(out_drift, 'w', encoding='utf-8') as f:
            for r in drift_records:
                f.write(json.dumps(r, ensure_ascii=False) + '\n')
        print(f'⚠️ 真字符漂移: {len(drift_records)} 条 → {out_drift}（建议人工抽检）')

    print(f'合并输出: {out_merged} ({len(merged_records)} 条)')
    print(f'仍失败:   {out_failed} ({len(failed_records)} 条)')


if __name__ == '__main__':
    main()
