#!/usr/bin/env python3
"""
中文：读入逐槽位的裁定，重建终版文本并写回工作库，同时校验零字符漂移。

Apply slot-level adjudications back onto the paragraphs.

Reads a verdict file whose lines pair a batch sequence number with one decision
per disagreement slot, rebuilds each paragraph's punctuation from those
decisions, weaves it onto the stored template so original whitespace survives,
and verifies that the raw character stream is still byte-for-byte unchanged.

Usage:
    python3 apply_verdicts.py --db donotpack/repunct-v2/repunct.sqlite \
        --batch batch-0001 --verdicts /path/to/verdicts-0001.txt
"""
import argparse
import json
import os
import re
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C

LINE_RE = re.compile(r'^#(\d+)\s+(.*)$')


def resolve(raw, slots, decisions, pa, pb):
    """
    中文：按逐槽位裁定重建一段的标点。

    Rebuild one paragraph's punctuation from per-slot decisions.

    Args:
        raw (str): Bare source characters, length N.
        slots (list[tuple[int, str, str]]): (raw_index, v1_mark, v2_mark) in
            ascending index order.
        decisions (list[str]): One decision per slot — ``a`` take v1, ``b`` take
            v2, ``0`` no mark, or a literal mark string to use instead.
        pa (dict[int, str]): Version 1 marks (supplies the agreed positions).
        pb (dict[int, str]): Version 2 marks, used only for validation.

    Returns:
        str: Punctuated text whose ``to_raw`` equals ``raw`` exactly.

    Raises:
        ValueError: If the decision count does not match the slot count.
    """
    if len(decisions) != len(slots):
        raise ValueError(f'expected {len(slots)} decisions, got {len(decisions)}')
    chosen = {}
    for (idx, m1, m2), d in zip(slots, decisions):
        d = d.strip()
        if d == 'a':
            mark = m1
        elif d == 'b':
            mark = m2
        elif d in ('0', '-', ''):
            mark = ''
        else:
            mark = ''.join(c for c in d if c in C.ADDED_PUNCT)
        if mark:
            chosen[idx] = mark
    diff_idx = {i for i, _, _ in slots}
    out = []
    for i in range(len(raw) + 1):
        if i in diff_idx:
            if i in chosen:
                out.append(chosen[i])
        elif i in pa:
            out.append(pa[i])
        if i < len(raw):
            out.append(raw[i])
    return ''.join(out)


def main():
    """
    中文：命令行入口，套用一个批次的裁定并报告统计。

    Entry point. Applies a verdict file to one batch and reports how many
    paragraphs resolved, how each slot was decided, and any drift failures.

    Args:
        None (arguments are read from sys.argv).

    Returns:
        None.
    """
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', required=True)
    ap.add_argument('--batch', required=True)
    ap.add_argument('--verdicts', required=True)
    args = ap.parse_args()

    db = sqlite3.connect(args.db, timeout=120)
    rows = db.execute(
        'SELECT a.seq, a.para_id, a.slots, u.template, u.raw, w.v2 FROM adjudication a '
        'JOIN units u ON u.para_id = a.para_id '
        'JOIN units_v2 w ON w.para_id = a.para_id '
        'WHERE a.batch = ? ORDER BY a.seq', (args.batch,)).fetchall()
    if not rows:
        sys.exit(f'no paragraphs registered for batch {args.batch}')

    verdicts = {}
    for line in open(args.verdicts, encoding='utf-8'):
        line = line.strip()
        if not line or line.startswith('#') is False:
            if not line.startswith('#'):
                continue
        m = LINE_RE.match(line)
        if m:
            verdicts[int(m.group(1))] = m.group(2).strip()

    stats = {'a': 0, 'b': 0, '0': 0, 'lit': 0}
    updates, bad, missing = [], [], []
    for seq, pid, slots_json, tpl, raw, v2 in rows:
        v = verdicts.get(seq)
        if v is None:
            missing.append(seq)
            continue
        slots = [tuple(s) for s in json.loads(slots_json)]
        pa, pb = C.mark_positions(tpl), C.mark_positions(v2)
        try:
            if v.startswith('!'):
                text = C.normalise_output(v[1:].strip())
                text, ratio, _ = C.project(raw, text)
                decisions = ['!'] * len(slots)
            else:
                decisions = [d for d in v.split('/')]
                text = resolve(raw, slots, decisions, pa, pb)
            woven = C.weave(tpl, text)
        except ValueError as e:
            bad.append((seq, pid, str(e)))
            continue
        if C.to_raw(woven) != raw:
            bad.append((seq, pid, 'raw drift'))
            continue
        for d in decisions:
            d = d.strip()
            if d in stats:
                stats[d] += 1
            elif d != '!':
                stats['lit'] += 1
        updates.append((json.dumps(decisions, ensure_ascii=False), woven, pid))

    db.executemany('UPDATE adjudication SET verdict=?, final=?, decided=1 WHERE para_id=?',
                   updates)
    db.commit()
    print(f'batch={args.batch} applied={len(updates)}/{len(rows)} '
          f'slots: 采甲={stats["a"]} 采乙={stats["b"]} 不加={stats["0"]} 改写={stats["lit"]}')
    if missing:
        print(f'  未裁定 {len(missing)} 段: {missing[:15]}{"..." if len(missing) > 15 else ""}')
    if bad:
        print(f'  失败 {len(bad)} 段:')
        for seq, pid, why in bad[:10]:
            print(f'    #{seq} [{pid}] {why}')


if __name__ == '__main__':
    main()
