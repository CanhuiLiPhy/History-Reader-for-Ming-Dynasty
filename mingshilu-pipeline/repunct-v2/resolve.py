#!/usr/bin/env python3
"""
中文：把会话里人工裁定的结果直接落盘，记录采信来源和理由，带零漂移校验。

Record a human adjudication for specific paragraphs.

The batch pipeline in ``make_batches.py`` / ``apply_verdicts.py`` is built for
sweeping through slot-level disagreements. Some paragraphs are settled by a
single sentence of reasoning instead — "the new reading is empty, keep the old
one" — and forcing those through a slot file costs more than it clarifies. This
writes such decisions straight to a ``resolved`` table, alongside the reason, so
the provenance of every finished paragraph stays legible.

Usage:
    python3 resolve.py --db <db> --take v1 --reason "新版投影失败" --ids 1,2,3
    python3 resolve.py --db <db> --take v1 --reason "..." --ids-from file.txt
"""
import argparse
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C

SCHEMA = """
CREATE TABLE IF NOT EXISTS resolved (
  para_id  INTEGER PRIMARY KEY,
  slug     TEXT NOT NULL,
  final    TEXT NOT NULL,   -- the settled punctuation, woven onto the template
  chose    TEXT NOT NULL,   -- v1 | v2 | manual
  reason   TEXT NOT NULL,   -- why, in one line, for later audit
  flags    TEXT NOT NULL DEFAULT '',
  decided_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"""


def main():
    """
    中文：命令行入口，按 --take 把指定段落裁定为旧版或新版。

    Entry point. Settles the named paragraphs on one of the two existing
    readings and records the reason.

    Args:
        None (arguments are read from sys.argv).

    Returns:
        None. Rows land in the ``resolved`` table; drift is verified first and
        any paragraph whose raw stream would change is refused.
    """
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', required=True)
    ap.add_argument('--take', required=True, choices=['v1', 'v2'])
    ap.add_argument('--reason', required=True)
    ap.add_argument('--ids', default='')
    ap.add_argument('--ids-from', default='')
    ap.add_argument('--where', default='',
                    help='raw SQL predicate over units_v2 w / units u, instead of --ids')
    args = ap.parse_args()

    db = sqlite3.connect(args.db, timeout=120)
    db.executescript(SCHEMA)

    ids = []
    if args.ids:
        ids = [int(x) for x in args.ids.replace(',', ' ').split()]
    elif args.ids_from:
        ids = [int(line.split()[0]) for line in open(args.ids_from) if line.strip()]

    if args.where:
        rows = db.execute(
            'SELECT w.para_id, w.slug, u.raw, u.template, w.v2 FROM units_v2 w '
            'JOIN units u ON u.para_id = w.para_id WHERE ' + args.where).fetchall()
    else:
        if not ids:
            sys.exit('need --ids, --ids-from or --where')
        q = ','.join('?' * len(ids))
        rows = db.execute(
            'SELECT w.para_id, w.slug, u.raw, u.template, w.v2 FROM units_v2 w '
            'JOIN units u ON u.para_id = w.para_id WHERE w.para_id IN (%s)' % q, ids).fetchall()

    out, bad = [], []
    for pid, slug, raw, tpl, v2 in rows:
        text = tpl if args.take == 'v1' else v2
        if C.to_raw(text) != raw:
            bad.append(pid)
            continue
        import json
        out.append((pid, slug, text, args.take, args.reason,
                    json.dumps(C.quality_flags(text), ensure_ascii=False)))

    db.executemany(
        'INSERT OR REPLACE INTO resolved(para_id,slug,final,chose,reason,flags) '
        'VALUES (?,?,?,?,?,?)', out)
    db.commit()
    print(f'已裁定 {len(out)} 段 → {args.take}（{args.reason}）')
    if bad:
        print(f'  拒绝 {len(bad)} 段（字符流不一致）: {bad[:10]}')
    total = db.execute('SELECT COUNT(*) FROM resolved').fetchone()[0]
    print(f'  resolved 表累计 {total} 段')


if __name__ == '__main__':
    main()
