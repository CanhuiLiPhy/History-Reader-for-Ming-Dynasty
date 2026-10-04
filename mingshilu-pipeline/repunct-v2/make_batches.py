#!/usr/bin/env python3
"""
中文：把新旧两版的分歧压成「合并视图」批次文件，供人工（或会话内）逐槽位裁定。

Emit compact adjudication batches for the v1/v2 disagreements.

Rather than printing both punctuated versions of a paragraph — which repeats the
same characters twice — this writes one merged rendering in which the marks the
two versions agree on appear inline, and every disagreement becomes a numbered
slot showing both candidates. A reader can then judge the passage in its natural
reading order and answer with one token per slot.

Usage:
    python3 make_batches.py --db donotpack/repunct-v2/repunct.sqlite \
        --out donotpack/repunct-v2/exports/adjudicate --size 300
"""
import argparse
import json
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C

SCHEMA = """
CREATE TABLE IF NOT EXISTS adjudication (
  para_id  INTEGER PRIMARY KEY,
  slug     TEXT NOT NULL,
  slots    TEXT NOT NULL,   -- JSON: [[raw_index, v1_mark, v2_mark], ...]
  batch    TEXT NOT NULL,
  seq      INTEGER NOT NULL DEFAULT 0,  -- position within the batch file; row
                                        -- order in SQLite is not the file order
  verdict  TEXT,            -- JSON: one entry per slot, filled in by apply_verdicts
  final    TEXT,            -- resolved text, woven onto the template
  decided  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_adj_batch ON adjudication(batch, decided);
"""


def merged_view(raw, pa, pb):
    """
    中文：把一段的两版标点压成一行合并视图，分歧处编号成槽位。

    Render one paragraph as a single line carrying both readings.

    Marks the two versions agree on are emitted inline exactly where they sit.
    Each disagreement becomes ``⟨n:A|B⟩`` immediately before the character it
    precedes, where ``n`` is the 1-based slot number, ``A`` is version 1's mark
    and ``B`` is version 2's, with ``-`` standing for "no mark here".

    Args:
        raw (str): Bare source characters of the paragraph, length N.
        pa (dict[int, str]): Version 1 marks, raw-index -> mark string.
        pb (dict[int, str]): Version 2 marks, same convention.

    Returns:
        tuple[str, list[tuple[int, str, str]]]:
            - the merged line;
            - the slot table, ordered by raw index: (index, v1_mark, v2_mark).
    """
    slots = []
    out = []
    keys = sorted(set(pa) | set(pb))
    diff_idx = {k for k in keys if pa.get(k, '') != pb.get(k, '')}
    for i in range(len(raw) + 1):
        if i in diff_idx:
            slots.append((i, pa.get(i, ''), pb.get(i, '')))
            n = len(slots)
            out.append(f"⟨{n}:{pa.get(i,'') or '-'}|{pb.get(i,'') or '-'}⟩")
        elif i in pa:
            out.append(pa[i])
        if i < len(raw):
            out.append(raw[i])
    return ''.join(out), slots


def main():
    """
    中文：命令行入口，按优先级导出待裁定批次。

    Entry point. Writes one ``.txt`` batch per ``--size`` paragraphs, highest
    priority first, plus a registry row per paragraph in the working database.

    Args:
        None (arguments are read from sys.argv).

    Returns:
        None.
    """
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--size', type=int, default=300,
                    help='max paragraphs per batch')
    ap.add_argument('--slot-budget', type=int, default=600,
                    help='max disagreement slots per batch; batches are cut on\n'
                         'whichever limit binds first so每批 reading cost is even')
    ap.add_argument('--books', default='')
    ap.add_argument('--max-batches', type=int, default=0)
    ap.add_argument('--tier', type=int, default=0, choices=[0, 1, 2, 3],
                    help='only emit paragraphs at this triage tier (0 = all): '
                         '1 structural (enumeration/quote/title marks), '
                         '2 sentence boundaries, 3 comma rhythm')
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    db = sqlite3.connect(args.db, timeout=120)
    db.executescript(SCHEMA)

    where, params = '', []
    if args.books:
        slugs = [s.strip() for s in args.books.split(',') if s.strip()]
        where = ' AND w.slug IN (%s)' % ','.join('?' * len(slugs))
        params = slugs

    rows = db.execute(
        'SELECT w.para_id, w.slug, u.template, u.raw, w.v2, w.priority, u.chapter '
        'FROM units_v2 w JOIN units u ON u.para_id = w.para_id '
        'LEFT JOIN adjudication a ON a.para_id = w.para_id '
        'WHERE w.review = 1 AND a.para_id IS NULL' + where +
        ' ORDER BY w.priority DESC, u.seq', params).fetchall()

    batch, reg, written, nslots, cur_slots = [], [], 0, 0, 0
    def flush(idx):
        name = f'batch-{idx:04d}'
        path = os.path.join(args.out, name + '.txt')
        with open(path, 'w', encoding='utf-8') as f:
            f.write(f'# {name}  共 {len(batch)} 段\n')
            f.write('# 槽位写作 ⟨编号:甲|乙⟩，- 表示该处无标点。\n')
            f.write('# 回复格式：每段一行 "#序号 槽1/槽2/..."，\n'
                    '#   a=采甲  b=采乙  0=此处不加标点  或直接写要用的标点（如 。 、 「）\n')
            f.write('#   整段重点用 "#序号 !<完整带标点正文>"\n\n')
            if args.tier:
                f.write(f'# 本批仅含第 {args.tier} 层分歧段。\n\n')
            for line in batch:
                f.write(line + '\n')
        return path

    idx = 0
    for pid, slug, tpl, raw, v2, prio, chapter in rows:
        pa, pb = C.mark_positions(tpl), C.mark_positions(v2)
        view, slots = merged_view(raw, pa, pb)
        if not slots:
            continue
        if args.tier and C.paragraph_tier(slots) != args.tier:
            continue
        batch.append(f'#{len(batch)+1} [{pid}] {view}')
        reg.append((pid, slug, json.dumps(slots, ensure_ascii=False), len(batch)))
        nslots += len(slots)
        cur_slots += len(slots)
        if len(batch) >= args.size or cur_slots >= args.slot_budget:
            idx += 1
            name = f'batch-{idx:04d}'
            flush(idx)
            db.executemany(
                'INSERT OR REPLACE INTO adjudication(para_id,slug,slots,batch,seq) '
                'VALUES (?,?,?,?,?)',
                [(p, s, j, name, q) for p, s, j, q in reg])
            db.commit()
            written += len(batch)
            batch, reg, cur_slots = [], [], 0
            if args.max_batches and idx >= args.max_batches:
                break
    if batch and not (args.max_batches and idx >= args.max_batches):
        idx += 1
        name = f'batch-{idx:04d}'
        flush(idx)
        db.executemany(
            'INSERT OR REPLACE INTO adjudication(para_id,slug,slots,batch,seq) '
            'VALUES (?,?,?,?,?)',
            [(p, s, j, name, q) for p, s, j, q in reg])
        db.commit()
        written += len(batch)

    print(f'batches={idx} paragraphs={written} slots={nslots} -> {args.out}')


if __name__ == '__main__':
    main()
