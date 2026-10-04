#!/usr/bin/env python3
"""
中文：把切块结果拼回段落、编织回原模板，并与旧版逐段比对，标出需要重审的段落。

Assemble chunk results into paragraph-level v2 text and decide what to review.

For every paragraph this stage concatenates its chunks in order, weaves the new
punctuation back into the stored template so original whitespace survives,
compares the result against the v1 punctuation already in ``library.sqlite``, and
records the quality signals that drive the thinking-mode review pass.

Usage:
    python3 assemble.py --db donotpack/repunct-v2/repunct.sqlite
"""
import argparse
import json
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C

SCHEMA = """
CREATE TABLE IF NOT EXISTS units_v2 (
  para_id    INTEGER PRIMARY KEY,
  slug       TEXT NOT NULL,
  v2         TEXT NOT NULL,   -- new punctuation, woven back onto the template
  n_chunk    INTEGER NOT NULL,
  min_ratio  REAL NOT NULL,
  n_failed   INTEGER NOT NULL, -- chunks that never passed projection
  minlp      REAL,
  meanlp     REAL,
  flags_v1   TEXT NOT NULL,
  flags_v2   TEXT NOT NULL,
  pos_dis    REAL NOT NULL,   -- share of mark positions the versions disagree on
  type_dis   REAL NOT NULL,   -- share of shared positions with a different mark
  identical  INTEGER NOT NULL,
  review     INTEGER NOT NULL,
  priority   INTEGER NOT NULL DEFAULT 0,  -- higher = more suspicious, reviewed first
  reasons    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_units_v2_review ON units_v2(review, priority DESC);
CREATE INDEX IF NOT EXISTS idx_units_v2_slug ON units_v2(slug);
"""

# shatter 不在其中，是刻意的。实录里的仪注赞唱（「四拜，举哀，兴，哀止」）
# 和祭器清单（「犢一，羊三，豕三」）通篇一字一顿，和「被过度切碎的清单」在
# 任何纯节奏指标上都无法区分 —— 区别是语义的。与其用一个必然大量误报或漏报
# 的阈值去驱动人工复核，不如把它降级成报表里的参考指标。
#
# shatter is deliberately absent. In the Veritable Records, liturgical
# call-and-response and offering inventories are uniformly terse by genre, and
# no purely rhythmic measure separates them from a genuinely over-chopped list —
# the distinction is semantic. A gate that must either over-fire on a whole
# genre or miss the real cases is worse than no gate; it stays a reported
# statistic instead of a review trigger.
HARD_FLAGS = {'no_final', 'unpaired_quote', 'unpaired_title', 'adjacent',
              'long_run', 'lead_mark'}


def decide(n_raw, min_ratio, n_failed, minlp, meanlp, flags_v2, pos_dis, type_dis, args):
    """
    中文：判定一段是否进入思考模式重审，并给出触发原因。

    Decide whether a paragraph goes to the thinking-mode review pass.

    Args:
        n_raw (int): Raw character count of the paragraph.
        min_ratio (float): Worst projection alignment ratio among its chunks.
        n_failed (int): Chunks that never produced a usable projection.
        minlp (float | None): Weakest punctuation-token log-probability.
        meanlp (float | None): Mean punctuation-token log-probability.
        flags_v2 (list[str]): Hard defects detected in the new punctuation.
        pos_dis (float): Mark-position disagreement against v1, in [0, 1].
        type_dis (float): Mark-type disagreement on shared positions, in [0, 1].
        args (argparse.Namespace): Thresholds.

    Returns:
        tuple[int, list[str], int]: 1/0 review decision, the reasons that fired,
            and a priority score. Review capacity is finite — thinking at xhigh
            costs roughly 1,300 reasoning tokens per paragraph — so the score
            decides who gets adjudicated first when a budget caps the pass.

    Math:
        priority = Σ weight(reason), where a broken character stream outranks a
        broken mark, which outranks a mere disagreement with the old reading.
    """
    weights = {
        'projection_failed': 100, 'low_alignment': 60,
        'flag_unpaired_quote': 50, 'flag_unpaired_title': 45,
        'flag_adjacent': 40, 'flag_lead_mark': 40,
        'flag_no_final': 35, 'flag_long_run': 30, 'flag_shatter': 25,
        'low_confidence': 30, 'low_confidence_mean': 15,
        'diverges_position': 20, 'diverges_type': 12,
    }
    reasons = []
    if n_failed:
        reasons.append('projection_failed')
    if min_ratio < args.ratio_gate:
        reasons.append('low_alignment')
    hard = sorted(set(flags_v2) & HARD_FLAGS)
    reasons.extend('flag_' + f for f in hard)
    if n_raw >= args.min_len:
        if pos_dis > args.pos_gate:
            reasons.append('diverges_position')
        elif type_dis > args.type_gate:
            reasons.append('diverges_type')
    if minlp is not None and minlp < args.minlp_gate:
        reasons.append('low_confidence')
    elif meanlp is not None and meanlp < args.meanlp_gate:
        reasons.append('low_confidence_mean')
    score = sum(weights.get(r, 10) for r in reasons)
    # Longer paragraphs carry more at stake per adjudication.
    score += min(20, n_raw // 40)
    return (1 if reasons else 0), reasons, score


def main():
    """
    中文：命令行入口，重建 units_v2 并打印触发统计。

    Entry point. Rebuilds ``units_v2`` for every paragraph whose chunks are all
    present, then prints how many paragraphs each review trigger caught.

    Args:
        None (arguments are read from sys.argv).

    Returns:
        None.
    """
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', required=True)
    ap.add_argument('--books', default='')
    ap.add_argument('--ratio-gate', type=float, default=0.99)
    # Style-level disagreement counts as a review trigger too: a different
    # clause boundary changes how the passage reads even when neither version
    # trips a hard defect.
    ap.add_argument('--pos-gate', type=float, default=0.20)
    ap.add_argument('--type-gate', type=float, default=0.30)
    ap.add_argument('--minlp-gate', type=float, default=-2.5)
    ap.add_argument('--meanlp-gate', type=float, default=-1.0)
    ap.add_argument('--min-len', type=int, default=20)
    args = ap.parse_args()

    db = sqlite3.connect(args.db, timeout=60)
    db.executescript(SCHEMA)

    where, params = '', []
    if args.books:
        slugs = [s.strip() for s in args.books.split(',') if s.strip()]
        where = ' WHERE u.slug IN (%s)' % ','.join('?' * len(slugs))
        params = slugs

    rows = db.execute(
        'SELECT u.para_id, u.slug, u.template, u.raw, u.n_raw, c.chunk_id, c.idx, c.total, '
        '       r.punct, r.ratio, r.minlp, r.meanlp, r.source '
        'FROM units u JOIN chunks c ON c.para_id = u.para_id '
        'LEFT JOIN chunk_results r ON r.chunk_id = c.chunk_id' + where +
        ' ORDER BY u.para_id, c.idx', params).fetchall()

    by_unit = {}
    for (pid, slug, tpl, raw, n_raw, cid, idx, total, punct, ratio, mn, mean, src) in rows:
        by_unit.setdefault(pid, {'slug': slug, 'tpl': tpl, 'raw': raw, 'n': n_raw,
                                 'total': total, 'parts': []})['parts'].append(
            (idx, punct, ratio, mn, mean, src))

    out, skipped, counts = [], 0, {}
    for pid, u in by_unit.items():
        parts = sorted(u['parts'])
        if len(parts) != u['total'] or any(p[1] is None for p in parts):
            skipped += 1
            continue
        v2_flat = ''.join(p[1] for p in parts)
        try:
            v2 = C.weave(u['tpl'], v2_flat)
        except ValueError:
            skipped += 1
            continue
        min_ratio = min(p[2] for p in parts)
        n_failed = sum(1 for p in parts if p[5] == 'failed')
        lps = [p[3] for p in parts if p[3] is not None]
        means = [p[4] for p in parts if p[4] is not None]
        minlp = min(lps) if lps else None
        meanlp = sum(means) / len(means) if means else None
        flags_v1 = C.quality_flags(u['tpl'])
        flags_v2 = C.quality_flags(v2)
        pos_dis, type_dis = C.boundary_disagreement(u['tpl'], v2)
        identical = 1 if C.mark_positions(u['tpl']) == C.mark_positions(v2) else 0
        review, reasons, prio = decide(u['n'], min_ratio, n_failed, minlp, meanlp,
                                       flags_v2, pos_dis, type_dis, args)
        for r in reasons:
            counts[r] = counts.get(r, 0) + 1
        out.append((pid, u['slug'], v2, len(parts), min_ratio, n_failed, minlp, meanlp,
                    json.dumps(flags_v1, ensure_ascii=False),
                    json.dumps(flags_v2, ensure_ascii=False),
                    pos_dis, type_dis, identical, review, prio,
                    json.dumps(reasons, ensure_ascii=False)))

    db.executemany('INSERT OR REPLACE INTO units_v2 VALUES '
                   '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', out)
    db.commit()

    n = len(out)
    rev = sum(1 for r in out if r[13])
    ident = sum(1 for r in out if r[12])
    print(f'assembled={n} incomplete={skipped} identical_to_v1={ident} '
          f'review={rev} ({100.0*rev/n if n else 0:.1f}%)')
    for k, v in sorted(counts.items(), key=lambda x: -x[1]):
        print(f'  {k}: {v}')


if __name__ == '__main__':
    main()
