#!/usr/bin/env python3
"""
rechunk-mingshilu-part.py

给指定 part（按 ORDER BY id 跨步切片到 8 份）准备 Kaggle 预切输入：
  对 part 内所有段：长度 > MAX_CHUNK 的按本地启发式（○ / 也矣焉哉 等）切成 ≤MAX_CHUNK 字的块
  每块打 marker id (orig_id + idx) 以便跑完合回原段。

用法：
  python3 donotpack/scripts/rechunk-mingshilu-part.py --parts 3
  python3 donotpack/scripts/rechunk-mingshilu-part.py --parts 3,4 --max-chunk 350

输出：
  /Users/lch/Downloads/mingshilu-pN/mingshilu-pN-prechunked.jsonl   Kaggle 输入
  /Users/lch/Downloads/mingshilu-pN/mingshilu-pN-chunks.json        切片映射
  /Users/lch/Downloads/mingshilu-pN/mingshilu-pN-stats.json         统计

跑完 Kaggle 后用 merge-mingshilu-retry.py（同一份 merge 脚本）按 orig_id 合回。
"""

import os, json, argparse, sqlite3
from pathlib import Path
from typing import List, Tuple, Dict

# 复用 failures 脚本里的启发式
import sys
sys.path.insert(0, str(Path(__file__).parent))
from importlib.util import spec_from_file_location, module_from_spec
_src = Path(__file__).parent / 'rechunk-mingshilu-failures.py'
spec = spec_from_file_location('rechunk_failures', _src)
_mod = module_from_spec(spec)
spec.loader.exec_module(_mod)

DB_PATH = '/Users/lch/mingshi-reader-ai/backend/.cache/library.sqlite'
DEFAULT_OUT_BASE = '/Users/lch/Downloads'
PART_OF = 8  # 总份数与原 notebook 一致


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--parts', default='3',
                    help='要预切的 part 编号，逗号分隔，例如 "3" 或 "3,4,5"')
    ap.add_argument('--max-chunk', type=int, default=350)
    ap.add_argument('--out-base', default=DEFAULT_OUT_BASE)
    args = ap.parse_args()

    parts = [int(s) for s in args.parts.split(',')]

    db = sqlite3.connect(DB_PATH)
    all_ids = sorted(r[0] for r in db.execute(
        "SELECT id FROM paragraphs WHERE book_id=6").fetchall())
    print(f'明实录总段落: {len(all_ids)}, 分 {PART_OF} 份')

    for part in parts:
        assert 1 <= part <= PART_OF
        part_ids = all_ids[part-1::PART_OF]
        print(f'\n[part {part}/{PART_OF}] 共 {len(part_ids)} 段')

        # 从 DB 拿 raw（剥掉标点，复用 failures 脚本里的 strip_punct）
        id_to_raw: Dict[int, str] = _mod.fetch_raw_for_ids(DB_PATH, part_ids)
        # 确保顺序与 part_ids 一致
        records = [{'id': pid, 'raw': id_to_raw[pid]} for pid in part_ids]

        # 长度分布
        lens = [len(r['raw']) for r in records]
        long_cnt = sum(1 for L in lens if L > args.max_chunk)
        print(f'  长度: min={min(lens)} 中位={sorted(lens)[len(lens)//2]} '
              f'max={max(lens)} (>{args.max_chunk} 的: {long_cnt} 段)')

        # 切片：长段切，短段原样
        out_dir = f'{args.out_base}/mingshilu-p{part}'
        os.makedirs(out_dir, exist_ok=True)
        out_input  = f'{out_dir}/mingshilu-p{part}-prechunked.jsonl'
        out_chunks = f'{out_dir}/mingshilu-p{part}-chunks.json'
        out_stats  = f'{out_dir}/mingshilu-p{part}-stats.json'

        out_records = []
        chunks_map = {}
        stats = {'short_passthrough': 0, 'chunked_segments': 0, 'total_chunks': 0,
                 'qwen_calls': 0, 'qwen_input_chars': 0, 'heuristic_only': 0, 'qwen_used': 0}

        for i, rec in enumerate(records, 1):
            raw = rec['raw']
            orig_id = rec['id']
            if len(raw) <= args.max_chunk:
                out_records.append({'id': orig_id, 'raw': raw})
                stats['short_passthrough'] += 1
            else:
                spans = _mod.smart_split(raw, args.max_chunk, '', '', 'none', stats)
                if len(spans) == 1:
                    out_records.append({'id': orig_id, 'raw': raw})
                    stats['short_passthrough'] += 1
                else:
                    stats['chunked_segments'] += 1
                    stats['heuristic_only'] += 1
                    for j, (s, e) in enumerate(spans):
                        new_id = f'{orig_id}_{j}of{len(spans)}'
                        out_records.append({'id': new_id, 'raw': raw[s:e]})
                        chunks_map[new_id] = {
                            'orig_id': orig_id, 'chunk_idx': j, 'chunk_total': len(spans),
                            'origin': f'p{part}',
                        }
                        stats['total_chunks'] += 1
            if i % 2000 == 0:
                print(f'    ... {i}/{len(records)} 已处理')

        with open(out_input, 'w', encoding='utf-8') as f:
            for r in out_records:
                f.write(json.dumps(r, ensure_ascii=False) + '\n')
        with open(out_chunks, 'w', encoding='utf-8') as f:
            json.dump(chunks_map, f, ensure_ascii=False, indent=2)
        with open(out_stats, 'w', encoding='utf-8') as f:
            json.dump(stats, f, ensure_ascii=False, indent=2)

        # 输出统计
        chunk_lens = sorted(len(out_records[k]['raw']) for k in range(len(out_records))
                            if str(out_records[k]['id']) in chunks_map)
        print(f'  → {len(out_records)} 行（短段 {stats["short_passthrough"]} + '
              f'切片 {stats["total_chunks"]} 来自 {stats["chunked_segments"]} 段）')
        if chunk_lens:
            print(f'  切片长度: min={chunk_lens[0]} 中位={chunk_lens[len(chunk_lens)//2]} max={chunk_lens[-1]}')
        print(f'  Kaggle 输入: {out_input}')
        print(f'  切片映射:    {out_chunks}')

    db.close()


if __name__ == '__main__':
    main()
