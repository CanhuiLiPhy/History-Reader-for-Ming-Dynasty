#!/usr/bin/env python3
"""
中文：导出终版文本、新旧对照差异报告，以及重审后仍不放心的低置信段清单。

Export the finished v2 text, the v1↔v2 comparison report, and the leftover pile.

Produces, per book:
  ``<slug>-v2.txt``        final punctuation, one paragraph per line
  ``<slug>-v1.txt``        the existing punctuation, line-aligned with the above
  ``<slug>-diff.md``       a readable report: counts, trigger breakdown, samples
  ``<slug>-lowconf.jsonl`` paragraphs still unresolved, ready for a stronger model

Usage:
    python3 export_report.py --db donotpack/repunct-v2/repunct.sqlite \
        --out donotpack/repunct-v2/exports --books shu-yuan-zaji
"""
import argparse
import json
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C

TITLES = {
    'ming-shi-lu': '明实录',
    'donglin-liezhuan': '东林列传',
    'shu-yuan-zaji': '菽园杂记',
    'siku-mingshi': '明史（四库全书本）',
}


def render_diff(v1, v2, width=44):
    """
    中文：把同一段的两版标点并排渲染，只在有差异的窗口处展开。

    Render the punctuation differences between two versions of one paragraph.

    Both strings carry the same raw characters, so the comparison is purely
    about where marks sit and which mark was chosen. Only the neighbourhoods of
    actual disagreements are shown, so a long paragraph with one changed mark
    produces one short pair of lines rather than two walls of text.

    Args:
        v1 (str): Old punctuation.
        v2 (str): New punctuation.
        width (int): Raw characters of context to show around each disagreement.

    Returns:
        list[tuple[str, str]]: (old_excerpt, new_excerpt) pairs, one per
            disagreement cluster, already trimmed to ``width`` characters.
    """
    pa, pb = C.mark_positions(v1), C.mark_positions(v2)
    raw = C.to_raw(v1)
    diffs = sorted(k for k in set(pa) | set(pb) if pa.get(k, '') != pb.get(k, ''))
    if not diffs:
        return []
    clusters, cur = [], [diffs[0]]
    for k in diffs[1:]:
        if k - cur[-1] <= width // 2:
            cur.append(k)
        else:
            clusters.append(cur)
            cur = [k]
    clusters.append(cur)

    def excerpt(pos, lo, hi):
        buf = []
        for i in range(lo, hi):
            if i in pos:
                buf.append(pos[i])
            buf.append(raw[i])
        if hi in pos and hi >= len(raw):
            buf.append(pos[hi])
        return ''.join(buf)

    out = []
    for cl in clusters:
        lo = max(0, cl[0] - width // 3)
        hi = min(len(raw), cl[-1] + width // 3)
        out.append((excerpt(pa, lo, hi), excerpt(pb, lo, hi)))
    return out


def main():
    """
    中文：命令行入口，按书导出终版、对照报告与低置信清单。

    Entry point. Merges base and review results into one final text per
    paragraph, writes the exports, and prints a summary for each book.

    Args:
        None (arguments are read from sys.argv).

    Returns:
        None.
    """
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--books', default='')
    ap.add_argument('--samples', type=int, default=40)
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    db = sqlite3.connect(args.db, timeout=120)

    slugs = [s.strip() for s in args.books.split(',') if s.strip()] or \
        [r[0] for r in db.execute('SELECT DISTINCT slug FROM units_v2')]

    for slug in slugs:
        rows = db.execute(
            'SELECT u.para_id, u.chapter, u.seq, u.template, u.raw, u.n_raw, '
            '       w.v2, w.review, w.reasons, w.flags_v1, w.flags_v2, '
            '       w.pos_dis, w.type_dis, w.identical, w.min_ratio, w.minlp, '
            '       r.final, r.chose, r.conf, r.flags, r.status '
            'FROM units u JOIN units_v2 w ON w.para_id = u.para_id '
            'LEFT JOIN review r ON r.para_id = u.para_id '
            'WHERE u.slug = ? ORDER BY u.seq', (slug,)).fetchall()
        if not rows:
            continue

        title = TITLES.get(slug, slug)
        v1_lines, v2_lines, lowconf = [], [], []
        stats = {'n': 0, 'reviewed': 0, 'identical': 0, 'changed': 0,
                 'chose': {}, 'conf': {}, 'reasons': {},
                 'flags_v1': {}, 'flags_v2': {}, 'flags_final': {}}
        samples = []

        for (pid, chapter, seq, tpl, raw, n_raw, v2, review, reasons, f1, f2,
             pos_dis, type_dis, identical, min_ratio, minlp,
             final, chose, conf, rflags, rstatus) in rows:
            use = final if (final and rstatus == 'ok') else v2
            stats['n'] += 1
            v1_lines.append(tpl.replace('\n', ' '))
            v2_lines.append(use.replace('\n', ' '))
            for f in json.loads(f1):
                stats['flags_v1'][f] = stats['flags_v1'].get(f, 0) + 1
            for f in json.loads(f2):
                stats['flags_v2'][f] = stats['flags_v2'].get(f, 0) + 1
            for f in C.quality_flags(use):
                stats['flags_final'][f] = stats['flags_final'].get(f, 0) + 1
            if C.mark_positions(tpl) == C.mark_positions(use):
                stats['identical'] += 1
            else:
                stats['changed'] += 1
            if review:
                for r in json.loads(reasons):
                    stats['reasons'][r] = stats['reasons'].get(r, 0) + 1
            if final is not None:
                stats['reviewed'] += 1
                stats['chose'][chose] = stats['chose'].get(chose, 0) + 1
                stats['conf'][conf] = stats['conf'].get(conf, 0) + 1

            unresolved = (review and final is None) or conf == 'low' or rstatus == 'failed'
            if unresolved:
                lowconf.append({
                    'para_id': pid, 'slug': slug, 'chapter': chapter, 'seq': seq,
                    'n_raw': n_raw, 'raw': raw,
                    'v1': tpl, 'v2': v2, 'reviewed': use if final else None,
                    'reason': json.loads(reasons) if review else [],
                    'review_conf': conf, 'review_status': rstatus,
                    'review_flags': json.loads(rflags) if rflags else [],
                    'final_flags': C.quality_flags(use),
                    'min_ratio': min_ratio, 'minlp': minlp,
                })
            if len(samples) < args.samples and n_raw >= 40:
                d = render_diff(tpl, use)
                if d:
                    samples.append((pid, chapter, conf or '-', chose or '-', d[:3]))

        base = os.path.join(args.out, slug)
        with open(base + '-v1.txt', 'w', encoding='utf-8') as f:
            f.write('\n'.join(v1_lines) + '\n')
        with open(base + '-v2.txt', 'w', encoding='utf-8') as f:
            f.write('\n'.join(v2_lines) + '\n')
        with open(base + '-lowconf.jsonl', 'w', encoding='utf-8') as f:
            for item in lowconf:
                f.write(json.dumps(item, ensure_ascii=False) + '\n')

        def table(d):
            if not d:
                return '（无）'
            return '，'.join(f'{k} {v}' for k, v in sorted(d.items(), key=lambda x: -x[1]))

        with open(base + '-diff.md', 'w', encoding='utf-8') as f:
            w = f.write
            w(f'# {title} — 重点校 v1 → v2 对照报告\n\n')
            w(f'- 段落总数：**{stats["n"]}**\n')
            w(f'- 标点有变动：**{stats["changed"]}**（{100*stats["changed"]/stats["n"]:.1f}%），'
              f'完全一致：{stats["identical"]}\n')
            w(f'- 进入思考模式重审：**{stats["reviewed"]}**'
              f'（{100*stats["reviewed"]/stats["n"]:.1f}%）\n')
            w(f'- 重审裁定来源：{table(stats["chose"])}　（v1 = 采旧版，v2 = 采新版，new = 重点）\n')
            w(f'- 重审把握度：{table(stats["conf"])}\n')
            w(f'- 仍需更强模型处理：**{len(lowconf)}** 段 → `{slug}-lowconf.jsonl`\n\n')
            w('## 触发重审的原因\n\n')
            w(f'{table(stats["reasons"])}\n\n')
            w('## 硬错误信号对比（触发段数，越低越好）\n\n')
            w('| 信号 | v1 旧版 | v2 主跑 | 终版 |\n|---|---:|---:|---:|\n')
            keys = sorted(set(stats['flags_v1']) | set(stats['flags_v2']) | set(stats['flags_final']))
            for k in keys:
                w(f'| {k} | {stats["flags_v1"].get(k,0)} | {stats["flags_v2"].get(k,0)} '
                  f'| {stats["flags_final"].get(k,0)} |\n')
            w('\n> no_final = 段尾无句末符；unpaired_quote/title = 引号或书名号不配对；\n'
              '> adjacent = 标点连用；shatter = 四个相邻分句挤在 6 字内；\n'
              '> long_run = 超过 60 字无任何标点；lead_mark = 段首出现禁起首标点。\n\n')
            w('## 差异样例\n\n')
            for pid, chapter, conf, chose, d in samples:
                w(f'### #{pid}　{chapter}　（重审把握 {conf}，采信 {chose}）\n\n')
                for old, new in d:
                    w(f'- 旧：{old}\n- 新：{new}\n\n')

        print(f'{slug}: n={stats["n"]} changed={stats["changed"]} '
              f'reviewed={stats["reviewed"]} lowconf={len(lowconf)} '
              f'conf={stats["conf"]} chose={stats["chose"]}')


if __name__ == '__main__':
    main()
