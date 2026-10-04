#!/usr/bin/env python3
"""
中文：从全部分歧段里挑出「真正难」的那批——两版都不可信的，而不是体量最大的。

Rank the disputed paragraphs by how hard they actually are to settle.

Volume and difficulty are different things. A long entry where the two versions
merely disagree about comma density is bulky but easy; a short one where both
versions leave a quotation unclosed, or where the model could not reproduce the
character stream, is where a human reading is worth most. This scores the latter
above the former.
"""
import argparse
import collections
import json
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C

HARD = {'no_final', 'unpaired_quote', 'unpaired_title', 'adjacent',
        'shatter', 'long_run', 'lead_mark'}


def difficulty(row):
    """
    中文：给一段分歧算难度分，越高越该由人来读。

    Score how much a paragraph needs a human reading.

    Args:
        row (dict): One assembled paragraph carrying its quality signals.

    Returns:
        tuple[int, list[str]]: the score and the reasons that contributed.

    Math:
        Weights encode a single ordering principle — a defect that survives in
        BOTH readings outranks one that only one reading has, which outranks a
        disagreement where each reading is internally sound. A broken character
        stream outranks everything, because there the punctuation is not even
        the question yet.
    """
    why = []
    s = 0
    f1, f2 = set(row['flags_v1']), set(row['flags_v2'])
    both = (f1 & f2) & HARD
    only2 = (f2 - f1) & HARD
    only1 = (f1 - f2) & HARD

    if row['n_failed']:
        s += 200; why.append('字符流断裂')
    if row['min_ratio'] < 0.99:
        s += 120; why.append('低对齐')
    if both:
        s += 90 * len(both); why.append('两版同错:' + ','.join(sorted(both)))
    if only2:
        s += 45 * len(only2); why.append('新版错:' + ','.join(sorted(only2)))
    if only1:
        s += 30 * len(only1); why.append('旧版错:' + ','.join(sorted(only1)))
    # 分歧率越高，两版对这段的读法差别越大。
    if row['n_raw'] >= 30:
        if row['pos_dis'] >= 0.60:
            s += 70; why.append(f"断句读法迥异 {row['pos_dis']:.0%}")
        elif row['pos_dis'] >= 0.40:
            s += 35; why.append(f"断句分歧大 {row['pos_dis']:.0%}")
    if row['minlp'] is not None and row['minlp'] < -4.0:
        s += 40; why.append(f"模型自身没把握 {row['minlp']:.1f}")
    return s, why


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', required=True)
    ap.add_argument('--top', type=int, default=400)
    ap.add_argument('--out', default='')
    args = ap.parse_args()

    db = sqlite3.connect(args.db, timeout=120)
    rows = []
    for (pid, slug, chapter, n_raw, v2, f1, f2, pos, typ, mr, nf, mlp) in db.execute(
            'SELECT w.para_id, w.slug, u.chapter, u.n_raw, w.v2, w.flags_v1, w.flags_v2, '
            '       w.pos_dis, w.type_dis, w.min_ratio, w.n_failed, w.minlp '
            'FROM units_v2 w JOIN units u ON u.para_id = w.para_id WHERE w.review = 1'):
        r = {'para_id': pid, 'slug': slug, 'chapter': chapter, 'n_raw': n_raw,
             'flags_v1': json.loads(f1), 'flags_v2': json.loads(f2),
             'pos_dis': pos, 'type_dis': typ, 'min_ratio': mr,
             'n_failed': nf, 'minlp': mlp}
        r['score'], r['why'] = difficulty(r)
        rows.append(r)

    rows.sort(key=lambda r: (-r['score'], r['n_raw']))
    tally = collections.Counter(w.split(':')[0].split(' ')[0] for r in rows for w in r['why'])
    print(f"有分歧 {len(rows)} 段；难度分 >0 的 {sum(1 for r in rows if r['score'])} 段")
    print("难点分布：")
    for k, v in tally.most_common():
        print(f"  {k:<16}{v:>7}")
    print(f"\n取前 {args.top} 段，难度分 {rows[0]['score']} … {rows[min(args.top, len(rows)) - 1]['score']}，"
          f"合计 {sum(r['n_raw'] for r in rows[:args.top])} 字")
    if args.out:
        with open(args.out, 'w', encoding='utf-8') as f:
            for r in rows[:args.top]:
                f.write(json.dumps(r, ensure_ascii=False) + '\n')
        print(f"→ {args.out}")


if __name__ == '__main__':
    main()
