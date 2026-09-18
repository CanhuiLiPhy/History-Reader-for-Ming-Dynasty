#!/usr/bin/env python3
"""
llm-rerun-integrate.py — 把 llm-rerun-batch 的输出回写到各 dataset 的 merged。

策略：
  - strict_ok 的整段：直接进 merged
  - strict_ok 的 chunk：替换 partial_failed orig 里的对应 chunk，
    如果该 orig 的所有失败 chunk 都救回（无剩余 raw fallback）→ orig 升级到 merged
    否则继续 partial_failed（但 punct 质量提升）
  - long_resplit：把所有切片拼起来，整体 strict 检查通过才算救活
  - fail_strict / err：留作下一轮（写到 llm-rerun-still-failed.jsonl）
"""
import argparse, json, re, sys
from collections import defaultdict
from pathlib import Path

PUNCT_RE = re.compile(r'[，。：；？！「」『』、《》()（）\[\]【】〈〉,.:;?!"\'\s·‧・•‥…—–]')


DATASETS = {
    'p3': {
        'still': '/Users/lch/Downloads/0610/1/merged-p3/mingshilu-p3-still-failed.jsonl',
        'merged': '/Users/lch/Downloads/0610/1/merged-p3/mingshilu-p3-merged.jsonl',
        'chunks_map': '/Users/lch/Downloads/mingshilu-p3/mingshilu-p3-chunks.json',
        'punct': '/Users/lch/Downloads/results-4/mingshilu-p3-prechunked-punctuated.jsonl',
        'fail':  '/Users/lch/Downloads/results-4/mingshilu-p3-prechunked-failures.jsonl',
    },
    'p4': {
        'still': '/Users/lch/Downloads/0610/1/merged-p4/mingshilu-p4-still-failed.jsonl',
        'merged': '/Users/lch/Downloads/0610/1/merged-p4/mingshilu-p4-merged.jsonl',
        'chunks_map': '/Users/lch/Downloads/mingshilu-p4/mingshilu-p4-chunks.json',
        'punct': '/Users/lch/Downloads/0610/1/p4-colab/mingshilu-p4-prechunked-punctuated.jsonl',
        'fail':  '/Users/lch/Downloads/0610/1/p4-colab/mingshilu-p4-prechunked-failures.jsonl',
    },
    'p5': {
        'still': '/Users/lch/Downloads/0610/1/merged/mingshilu-p5-still-failed.jsonl',
        'merged': '/Users/lch/Downloads/0610/1/merged/mingshilu-p5-merged.jsonl',
        'chunks_map': '/Users/lch/Downloads/mingshilu-p5/mingshilu-p5-chunks.json',
        'punct': '/Users/lch/Downloads/0610/1/p5-colab/mingshilu-p5-prechunked-punctuated.jsonl',
        'fail':  '/Users/lch/Downloads/0610/1/p5-colab/mingshilu-p5-prechunked-failures.jsonl',
    },
    'retry': {
        'still': '/Users/lch/Downloads/0610/1/merged-retry/mingshilu-retry-still-failed.jsonl',
        'merged': '/Users/lch/Downloads/0610/1/merged-retry/mingshilu-retry-merged.jsonl',
        'chunks_map': '/Users/lch/Downloads/mingshilu-retry/mingshilu-retry-chunks.json',
        'punct': '/Users/lch/Downloads/results-3/mingshilu-retry-input-punctuated.jsonl',
        'fail':  '/Users/lch/Downloads/results-3/mingshilu-retry-input-failures.jsonl',
    },
    'p6': {
        'still': '/Users/lch/Downloads/0610/1/merged-p6/mingshilu-p6-still-failed.jsonl',
        'merged': '/Users/lch/Downloads/0610/1/merged-p6/mingshilu-p6-merged.jsonl',
        'chunks_map': '/Users/lch/Downloads/mingshilu-p6/mingshilu-p6-chunks.json',
        'punct': '/Users/lch/Downloads/0610/1/p6-colab/mingshilu-p6-prechunked-punctuated.jsonl',
        'fail':  '/Users/lch/Downloads/0610/1/p6-colab/mingshilu-p6-prechunked-failures.jsonl',
    },
    'p7': {
        'still': '/Users/lch/Downloads/0610/1/merged-p7/mingshilu-p7-still-failed.jsonl',
        'merged': '/Users/lch/Downloads/0610/1/merged-p7/mingshilu-p7-merged.jsonl',
        'chunks_map': '/Users/lch/Downloads/mingshilu-p7/mingshilu-p7-chunks.json',
        'punct': '/Users/lch/Downloads/0610/1/p7-colab/mingshilu-p7-prechunked-punctuated.jsonl',
        'fail':  '/Users/lch/Downloads/0610/1/p7-colab/mingshilu-p7-prechunked-failures.jsonl',
    },
    'p8': {
        'still': '/Users/lch/Downloads/0610/1/merged-p8/mingshilu-p8-still-failed.jsonl',
        'merged': '/Users/lch/Downloads/0610/1/merged-p8/mingshilu-p8-merged.jsonl',
        'chunks_map': '/Users/lch/Downloads/mingshilu-p8/mingshilu-p8-chunks.json',
        'punct': '/Users/lch/Downloads/0610/1/p8-colab/mingshilu-p8-prechunked-punctuated.jsonl',
        'fail':  '/Users/lch/Downloads/0610/1/p8-colab/mingshilu-p8-prechunked-failures.jsonl',
    },
}


def load_jsonl(p):
    if not Path(p).exists(): return []
    return [json.loads(l) for l in open(p, 'r', encoding='utf-8') if l.strip()]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--llm-output', required=True, action='append',
                    help='LLM 输出 jsonl，可多次指定（按 R1 R2 R3 顺序）')
    ap.add_argument('--out-still-failed', required=True,
                    help='导出 LLM 跑完后仍然 strict 失败的，留下一轮')
    args = ap.parse_args()

    llm_recs = []
    seen_items = {}  # item_id → 最新一条记录（后者覆盖前者，体现"最新一轮"语义）
    for p in args.llm_output:
        for r in load_jsonl(p):
            seen_items[r['item_id']] = r
    # 同时处理 resplit 拼回
    resplit_groups = defaultdict(dict)  # parent_item_id → {idx: rec}
    resplit_totals = {}
    final_recs = []
    for it_id, r in seen_items.items():
        if 'resplit_parent_item' in r and r.get('kind','').endswith('_resplit'):
            parent = r['resplit_parent_item']
            resplit_groups[parent][r['resplit_idx']] = r
            resplit_totals[parent] = r['resplit_total']
        else:
            final_recs.append(r)
    # 拼回 resplit
    for parent, pieces in resplit_groups.items():
        total = resplit_totals[parent]
        if len(pieces) < total:
            # 不全，留 partial 当作 fail
            for r in pieces.values():
                final_recs.append({**r, 'strict_ok': False, '_resplit_partial': True})
            continue
        # 检查每片是否 strict_ok
        all_ok = all(pieces[i].get('strict_ok') for i in range(total))
        # 取第一片继承元信息
        head = pieces[0]
        if all_ok:
            combined_out = ''.join(pieces[i]['output'] for i in range(total))
            combined_raw = ''.join(pieces[i]['raw'] for i in range(total))
            sr = PUNCT_RE.sub('', combined_raw); sp = PUNCT_RE.sub('', combined_out)
            final_recs.append({
                'item_id': parent,
                'dataset': head['dataset'],
                'kind': head['kind'].replace('_resplit',''),
                'orig_id': head.get('orig_id'),
                'chunk_new_id': head.get('chunk_new_id'),
                'raw': combined_raw,
                'output': combined_out,
                'strict_ok': sr == sp,
                'len_raw': len(sr), 'len_out': len(sp),
                '_resplit_reassembled': True,
            })
        else:
            # 至少一片 fail，整体 fail
            combined_raw = ''.join(pieces.get(i,{'raw':''})['raw'] for i in range(total))
            final_recs.append({
                'item_id': parent,
                'dataset': head['dataset'],
                'kind': head['kind'].replace('_resplit',''),
                'orig_id': head.get('orig_id'),
                'chunk_new_id': head.get('chunk_new_id'),
                'raw': combined_raw,
                'output': None,
                'strict_ok': False,
                '_resplit_some_pieces_failed': True,
            })
    llm_recs = final_recs
    print(f'读 LLM 输出 (合并 {len(args.llm_output)} 个文件): {len(seen_items)} 条记录, '
          f'拼回 {len(resplit_groups)} 个 resplit 组, 最终 {len(llm_recs)} 条要 integrate')

    # 按 (dataset, item_id) 分组
    by_dataset = defaultdict(list)
    for r in llm_recs:
        by_dataset[r['dataset']].append(r)

    print(f'\n按 dataset:')
    for ds, recs in by_dataset.items():
        ok = sum(1 for r in recs if r.get('strict_ok'))
        print(f'  {ds:8} 总 {len(recs)} (strict OK={ok})')

    still_failed_global = []

    for ds_name, llm_items in by_dataset.items():
        cfg = DATASETS[ds_name]
        merged = load_jsonl(cfg['merged'])
        still   = load_jsonl(cfg['still'])
        chunks_map = json.load(open(cfg['chunks_map'])) if Path(cfg['chunks_map']).exists() else {}
        kpunct = {str(r['id']): r for r in load_jsonl(cfg['punct'])}
        kfail  = {str(r['id']): r for r in load_jsonl(cfg['fail'])}

        orig_to_chunks = defaultdict(list)
        for nid, meta in chunks_map.items():
            orig_to_chunks[meta['orig_id']].append((meta['chunk_idx'], nid))

        # ===== 1) 整理 LLM 结果 =====
        # 1a. short 整段救援：直接进 merged
        # 1b. chunk 救援：保存 fix_map[new_id] = punct
        # 1c. long_resplit：按 orig_id 收集，全部 strict_ok 才算救活
        chunk_fix_map = {}      # new_id → fixed punct (strict_ok)
        short_rescued = {}      # orig_id → punct
        long_groups = defaultdict(dict)  # orig_id → {resplit_idx: punct (strict_ok)}
        long_totals = {}        # orig_id → total resplit count
        n_short_pass = 0; n_chunk_pass = 0; n_long_pass = 0; n_failed = 0

        for it in llm_items:
            if not it.get('strict_ok'):
                n_failed += 1
                still_failed_global.append({**it, 'dataset': ds_name})
                continue
            kind = it['kind']
            if kind == 'short':
                short_rescued[str(it['orig_id'])] = it['output']
                n_short_pass += 1
            elif kind == 'chunk':
                chunk_fix_map[str(it['chunk_new_id'])] = it['output']
                n_chunk_pass += 1
            elif kind == 'long_resplit':
                long_groups[str(it['orig_id'])][it['resplit_idx']] = it['output']
                long_totals[str(it['orig_id'])] = it['resplit_total']
                n_long_pass += 1

        # ===== 2) 处理 short 救援：直接加 merged =====
        new_rescued = []
        for oid, punct in short_rescued.items():
            try: oid_i = int(oid)
            except: oid_i = oid
            # 找 raw
            r_in_still = next((r for r in still if str(r.get('orig_id') or r.get('id')) == oid), None)
            raw = r_in_still['raw'] if r_in_still else ''
            new_rescued.append({
                'id': oid_i, 'raw': raw, 'punct': punct,
                'source': 'rescue:llm_rerun_short',
                'origin': r_in_still.get('origin','?') if r_in_still else '?',
                'rescue_reason': 'llm_rerun strict OK',
            })

        # ===== 3) 处理 long_resplit：所有 sub 都 strict_ok 才算 =====
        for oid, subs in long_groups.items():
            total = long_totals[oid]
            if len(subs) != total: continue
            # 拼接
            full_punct = ''.join(subs[i] for i in range(total))
            r_in_still = next((r for r in still if str(r.get('orig_id') or r.get('id')) == oid), None)
            raw = r_in_still['raw'] if r_in_still else ''
            if PUNCT_RE.sub('', full_punct) != PUNCT_RE.sub('', raw):
                # 拼接后不等价，可能 split 边界出问题
                still_failed_global.append({
                    'dataset': ds_name, 'item_id': f'{ds_name}::{oid}',
                    'kind': 'long_resplit_join_failed', 'orig_id': oid,
                    'raw': raw, 'output': full_punct, 'strict_ok': False,
                })
                continue
            try: oid_i = int(oid)
            except: oid_i = oid
            new_rescued.append({
                'id': oid_i, 'raw': raw, 'punct': full_punct,
                'source': f'rescue:llm_rerun_long_resplit_{total}',
                'origin': r_in_still.get('origin','?') if r_in_still else '?',
                'rescue_reason': f'llm_rerun strict OK on {total} resplit pieces',
            })

        # ===== 4) 处理 chunk 救援：影响 partial_failed orig =====
        n_partial_upgraded = 0; n_partial_improved = 0
        new_still = []
        rescued_orig_ids = set()  # 既要从 still 移除的 orig（含 short/long 和升级的 partial）

        for r in still:
            oid = r.get('orig_id') or r.get('id')
            oid_s = str(oid)
            status = r.get('status','?')
            # short rescued
            if oid_s in short_rescued or oid_s in {n['id'] if isinstance(n['id'],str) else str(n['id']) for n in new_rescued}:
                rescued_orig_ids.add(oid_s)
                continue
            if status != 'partial_failed':
                new_still.append(r); continue
            try: oid_i = int(oid)
            except: oid_i = oid
            pairs = sorted(orig_to_chunks.get(oid_i, []))
            if not pairs:
                new_still.append(r); continue

            parts_punct = []; parts_raw = []; sub_modes = []
            still_failed_chunks = 0; rescued_chunks = 0
            for idx, nid in pairs:
                nid_s = str(nid)
                if nid_s in chunk_fix_map:
                    parts_punct.append(chunk_fix_map[nid_s])
                    parts_raw.append(kfail.get(nid_s, kpunct.get(nid_s,{})).get('raw',''))
                    rescued_chunks += 1
                    sub_modes.append('llm_rerun_chunk')
                elif nid_s in kpunct and 'punct' in kpunct[nid_s]:
                    parts_punct.append(kpunct[nid_s]['punct'] or kpunct[nid_s]['raw'])
                    parts_raw.append(kpunct[nid_s]['raw'])
                    sub_modes.append(kpunct[nid_s].get('source','ok'))
                elif nid_s in kfail:
                    # 还是失败 chunk，用 last_attempt 或 raw 兜底
                    parts_punct.append(kfail[nid_s].get('last_attempt') or kfail[nid_s].get('raw',''))
                    parts_raw.append(kfail[nid_s].get('raw',''))
                    still_failed_chunks += 1
                    sub_modes.append('still_fail_fallback')
                else:
                    parts_punct.append(''); parts_raw.append('')
                    still_failed_chunks += 1

            if rescued_chunks == 0:
                new_still.append(r); continue

            new_punct = ''.join(parts_punct)
            new_raw = ''.join(parts_raw)

            if still_failed_chunks == 0 and PUNCT_RE.sub('', new_punct) == PUNCT_RE.sub('', new_raw):
                # 整段升级
                new_rescued.append({
                    'id': oid_i, 'raw': new_raw, 'punct': new_punct,
                    'source': 'rescue:llm_rerun_partial_full+' + '+'.join(set(sub_modes)),
                    'origin': r.get('origin','?'),
                    'rescue_reason': f'all {rescued_chunks} failed chunks rescued via llm_rerun',
                })
                n_partial_upgraded += 1
                rescued_orig_ids.add(oid_s)
            else:
                # 仍 partial，但 punct 质量提升
                r2 = dict(r); r2['punct'] = new_punct
                r2['_llm_rerun_partial_rescued'] = rescued_chunks
                new_still.append(r2)
                n_partial_improved += 1

        # ===== 写回 merged + still-failed =====
        merged_ids = {str(r['id']) for r in merged}
        n_added = 0
        for r in new_rescued:
            if str(r['id']) not in merged_ids:
                merged.append(r); n_added += 1
        with open(cfg['merged'], 'w', encoding='utf-8') as f:
            for r in merged: f.write(json.dumps(r, ensure_ascii=False) + '\n')

        # still: 去掉已升级的 orig
        new_still_clean = [r for r in new_still
                           if str(r.get('orig_id') or r.get('id')) not in rescued_orig_ids]
        with open(cfg['still'], 'w', encoding='utf-8') as f:
            for r in new_still_clean: f.write(json.dumps(r, ensure_ascii=False) + '\n')

        print(f'\n{ds_name}:')
        print(f'  LLM strict_ok: short={n_short_pass}, chunk={n_chunk_pass}, long={n_long_pass} | fail={n_failed}')
        print(f'  → merged 新增 {n_added} 条 (short + long + partial_upgraded {n_partial_upgraded})')
        print(f'  → partial 部分救援但仍 still_failed: {n_partial_improved} 条')
        print(f'  → still-failed 现 {len(new_still_clean)} 条')

    # 全局 still-failed
    with open(args.out_still_failed, 'w', encoding='utf-8') as f:
        for r in still_failed_global:
            f.write(json.dumps(r, ensure_ascii=False) + '\n')
    print(f'\n全局 llm_rerun 仍失败 (留下一轮): {len(still_failed_global)} 条 → {args.out_still_failed}')


if __name__ == '__main__':
    main()
