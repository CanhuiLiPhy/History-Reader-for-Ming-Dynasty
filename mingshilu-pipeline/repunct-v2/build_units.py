#!/usr/bin/env python3
"""
中文：从 library.sqlite 抽出待重点校的段落，切块、打包成批，写入工作库 repunct.sqlite。

Build the working database for the v2 re-punctuation run.

Reads every paragraph of the target books out of ``library.sqlite`` (which still
holds the v1 punctuation and must not be modified), derives the bare `raw` text,
splits over-long paragraphs into safe chunks, packs consecutive chunks into
request-sized batches, and persists all of it into a standalone SQLite file so
the run is fully resumable.

Usage:
    python3 build_units.py --out donotpack/repunct-v2/repunct.sqlite \
        --books ming-shi-lu,donglin-liezhuan,shu-yuan-zaji
"""
import argparse
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C

LIBRARY = 'backend/.cache/library.sqlite'

SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS units (
  para_id       INTEGER PRIMARY KEY,
  slug          TEXT NOT NULL,
  chapter       TEXT NOT NULL,
  chapter_order INTEGER NOT NULL,
  seq           INTEGER NOT NULL,
  template      TEXT NOT NULL,   -- v1 content: old punctuation + original whitespace
  raw           TEXT NOT NULL,   -- bare characters, the drift-free invariant
  n_raw         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_units_slug ON units(slug, seq);

CREATE TABLE IF NOT EXISTS chunks (
  chunk_id  TEXT PRIMARY KEY,    -- "<para_id>#<idx>of<total>"
  para_id   INTEGER NOT NULL,
  idx       INTEGER NOT NULL,
  total     INTEGER NOT NULL,
  raw       TEXT NOT NULL,
  n         INTEGER NOT NULL,
  batch_id  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_chunks_batch ON chunks(batch_id);
CREATE INDEX IF NOT EXISTS idx_chunks_para  ON chunks(para_id);

CREATE TABLE IF NOT EXISTS batches (
  batch_id  INTEGER PRIMARY KEY,
  slug      TEXT NOT NULL,
  n_seg     INTEGER NOT NULL,
  n_chars   INTEGER NOT NULL,
  status    TEXT NOT NULL DEFAULT 'pending',  -- pending | done | failed
  attempts  INTEGER NOT NULL DEFAULT 0,
  ptok      INTEGER NOT NULL DEFAULT 0,
  ctok      INTEGER NOT NULL DEFAULT 0,
  secs      REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_batches_status ON batches(status);

CREATE TABLE IF NOT EXISTS chunk_results (
  chunk_id  TEXT PRIMARY KEY,
  punct     TEXT NOT NULL,
  ratio     REAL NOT NULL,       -- projection alignment ratio in [0,1]
  dropped   INTEGER NOT NULL,    -- marks discarded as unaligned
  minlp     REAL,                -- min logprob over emitted punctuation tokens
  meanlp    REAL,
  nlp       INTEGER,
  source    TEXT NOT NULL        -- batch | single
);
"""


def main():
    """
    中文：命令行入口，建库并打印每部书的单元、切块与批次统计。

    Entry point. Populates ``units``, ``chunks`` and ``batches`` for the
    requested books and prints per-book counts.

    Args:
        None (arguments are read from sys.argv).

    Returns:
        None. Writes the working SQLite database at ``--out``.
    """
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--books', required=True)
    ap.add_argument('--library', default=LIBRARY)
    ap.add_argument('--chunk-limit', type=int, default=700,
                    help='max raw characters per chunk')
    ap.add_argument('--batch-chars', type=int, default=900,
                    help='max raw characters packed into one request')
    ap.add_argument('--batch-segs', type=int, default=12,
                    help='max segments packed into one request')
    args = ap.parse_args()

    slugs = [s.strip() for s in args.books.split(',') if s.strip()]
    lib = sqlite3.connect(args.library)
    db = sqlite3.connect(args.out)
    db.executescript(SCHEMA)

    batch_id = db.execute('SELECT COALESCE(MAX(batch_id), 0) FROM batches').fetchone()[0]

    for slug in slugs:
        rows = lib.execute(
            'SELECT p.id, p.chapter, p.chapter_order, p.content '
            'FROM paragraphs p JOIN books b ON b.id = p.book_id '
            'WHERE b.slug = ? ORDER BY p.chapter_order, p.id', (slug,)).fetchall()
        units, chunks = [], []
        for seq, (pid, chapter, corder, content) in enumerate(rows):
            raw = C.to_raw(content)
            if not raw:
                continue
            units.append((pid, slug, chapter, corder, seq, content, raw, len(raw)))
            pieces = C.split_long(raw, args.chunk_limit)
            assert ''.join(pieces) == raw, f'split lost characters at {pid}'
            for i, piece in enumerate(pieces):
                chunks.append((f'{pid}#{i}of{len(pieces)}', pid, i, len(pieces),
                               piece, len(piece), None))
        db.executemany('INSERT OR REPLACE INTO units VALUES (?,?,?,?,?,?,?,?)', units)
        db.executemany('INSERT OR REPLACE INTO chunks VALUES (?,?,?,?,?,?,?)', chunks)

        # Pack consecutive chunks into batches. Chunks of one paragraph always
        # stay together in reading order, so surrounding context helps the model.
        cur, n, assigned = [], 0, []
        batch_rows = []
        for cid, pid, i, tot, piece, ln, _ in chunks:
            if cur and (n + ln > args.batch_chars or len(cur) >= args.batch_segs):
                batch_id += 1
                batch_rows.append((batch_id, slug, len(cur), n))
                assigned.extend((batch_id, c) for c in cur)
                cur, n = [], 0
            cur.append(cid)
            n += ln
        if cur:
            batch_id += 1
            batch_rows.append((batch_id, slug, len(cur), n))
            assigned.extend((batch_id, c) for c in cur)
        db.executemany('INSERT OR REPLACE INTO batches(batch_id,slug,n_seg,n_chars) '
                       'VALUES (?,?,?,?)', batch_rows)
        db.executemany('UPDATE chunks SET batch_id=? WHERE chunk_id=?', assigned)
        db.commit()
        print(f'{slug}: units={len(units)} chunks={len(chunks)} '
              f'batches={len(batch_rows)} rawchars={sum(u[7] for u in units)}', flush=True)

    tot = db.execute('SELECT COUNT(*), SUM(n_chars) FROM batches').fetchone()
    print(f'TOTAL batches={tot[0]} rawchars={tot[1]}')
    db.close()


if __name__ == '__main__':
    main()
