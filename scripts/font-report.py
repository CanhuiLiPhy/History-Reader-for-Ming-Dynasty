#!/usr/bin/env python3
"""
中文：汇总报告——每个字体的真实名称、体积、字符集档次、对《明史》的 fallback 率。

Per-font summary: real family name, file size, character-set tier, and measured
fallback rate against 明史.

The "tier" is the useful column. A CJK font's usefulness for classical Chinese
is decided almost entirely by which standard's character repertoire it was cut
to, and that is directly measurable from the cmap: GB2312 stops at 6,763 hanzi,
GBK/Big5 reach ~21,000, and only fonts carrying Extension A/B can render the
rare personal and place-name characters that 明史 is full of.

Usage:
    python3 scripts/font-report.py <fonts-dir> <chapter-sample> <allchars-sample>
"""
import importlib.util
import os
import struct
import sys
from collections import Counter

_spec = importlib.util.spec_from_file_location(
    "font_coverage", os.path.join(os.path.dirname(os.path.abspath(__file__)), "font-coverage.py")
)
_fc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_fc)


def font_names(path):
    """
    中文：从 name 表读出字体的英文名和中文名。

    Read the family names out of the sfnt `name` table.

    Fonts from Chinese foundries usually carry both an ASCII family name and a
    localised one; the localised name is what a reader would recognise, so both
    are returned.

    Args:
        path (str): path to a .ttf/.otf file.

    Returns:
        tuple[str, str]: (latin name, localised name); either may be "".
    """
    with open(path, "rb") as handle:
        data = handle.read()
    tables = _fc._read_table_directory(data)
    if "name" not in tables:
        return "", ""
    base = tables["name"][0]
    count, string_off = struct.unpack(">HH", data[base + 2:base + 6])
    strings = base + string_off
    latin, local = "", ""
    for i in range(count):
        rec = base + 6 + i * 12
        plat, enc, lang, name_id, length, off = struct.unpack(">HHHHHH", data[rec:rec + 12])
        if name_id not in (1, 16):
            continue
        raw = data[strings + off:strings + off + length]
        try:
            if plat == 3:  # Windows: UTF-16BE
                text = raw.decode("utf-16-be", errors="ignore")
            elif plat == 1:
                # Macintosh. Encoding 25 is Simplified Chinese and 2 is
                # Traditional — decoding those as mac-roman is what turns a
                # Chinese family name into mojibake like "∑Ω'˝ ›Ω ÈºÚ∑±".
                if enc == 25:
                    text = raw.decode("gb18030", errors="ignore")
                elif enc == 2:
                    text = raw.decode("big5", errors="ignore")
                else:
                    text = raw.decode("mac-roman", errors="ignore")
            else:
                continue
        except Exception:
            continue
        text = text.strip("\x00").strip()
        if not text:
            continue
        if any(ord(ch) > 0x2E7F for ch in text):
            local = local or text
        else:
            latin = latin or text
    return latin, local


def tier(covered):
    """
    中文：按覆盖的汉字数量归入字符集档次。

    Classify a font by how many hanzi its cmap actually maps.

    Thresholds follow the standards' own repertoire sizes rather than round
    numbers: GB2312 defines 6,763 hanzi, GBK 20,902, and anything materially
    beyond the 20,992-codepoint CJK base block must be drawing on Extension A
    or B.

    Args:
        covered (set[int]): code points the font maps.

    Returns:
        str: a short human-readable tier label.
    """
    base = sum(1 for c in covered if 0x4E00 <= c <= 0x9FFF)
    ext_a = sum(1 for c in covered if 0x3400 <= c <= 0x4DBF)
    ext_b = sum(1 for c in covered if 0x20000 <= c <= 0x2A6DF)
    if ext_b > 1000:
        return "扩展B级（最全）"
    if ext_a > 500:
        return "扩展A级"
    if base >= 20000:
        return "GBK 级"
    if base >= 12000:
        return "GBK 不全"
    if base >= 6000:
        return "GB2312 级"
    return "低于 GB2312"


def main():
    fonts_dir, chapter_path, allchars_path = sys.argv[1], sys.argv[2], sys.argv[3]

    chapter = [c for c in open(chapter_path, encoding="utf-8").read() if not c.isspace() and ord(c) >= 0x20]
    chapter_freq = Counter(chapter)
    allchars = {c for c in open(allchars_path, encoding="utf-8").read() if not c.isspace() and ord(c) >= 0x20}

    # 私用区码位是源文本的缺字标记，不是真字，任何字体都没有 —— 从分母里剔除，
    # 否则每个字体都会背上一笔它无法负责的缺字。
    # PUA code points are the source text's own "character missing" markers, not
    # real characters; counting them would charge every font for a gap none of
    # them could ever fill.
    def is_pua(ch):
        return 0xE000 <= ord(ch) <= 0xF8FF

    chapter_total = sum(n for c, n in chapter_freq.items() if not is_pua(c))
    allchars_real = {c for c in allchars if not is_pua(c)}

    rows = []
    for name in sorted(os.listdir(fonts_dir)):
        if not name.lower().endswith((".ttf", ".otf")) or name.startswith("."):
            continue
        path = os.path.join(fonts_dir, name)
        covered = _fc.font_coverage(path)
        if not covered:
            print(f"  ⚠️  {name}: cmap 无法解析，跳过")
            continue
        latin, local = font_names(path)
        miss_chapter = sum(n for c, n in chapter_freq.items() if not is_pua(c) and ord(c) not in covered)
        miss_all = {c for c in allchars_real if ord(c) not in covered}
        rows.append({
            "file": name,
            "label": local or latin or name,
            "size": os.path.getsize(os.path.realpath(path)) / 1024 / 1024,
            "hanzi": sum(1 for c in covered if 0x4E00 <= c <= 0x9FFF),
            "ext_a": sum(1 for c in covered if 0x3400 <= c <= 0x4DBF),
            "ext_b": sum(1 for c in covered if 0x20000 <= c <= 0x2A6DF),
            "tier": tier(covered),
            "rate_chapter": miss_chapter / chapter_total * 100 if chapter_total else 0.0,
            "miss_all": len(miss_all),
            "rate_all": len(miss_all) / len(allchars_real) * 100 if allchars_real else 0.0,
            "samples": sorted(miss_all, key=lambda c: -chapter_freq.get(c, 0))[:12],
        })

    rows.sort(key=lambda r: (r["rate_all"], r["size"]))

    w = max(len(r["label"]) for r in rows) + 2
    print(f"样本：单章 {chapter_total} 字（频次加权）／全书唯一字符 {len(allchars_real)} 个，均为繁体（阅读器默认）\n")
    print(f"{'字体':<{w}}{'体积':>8}{'基本区':>9}{'扩展A':>8}{'扩展B':>8}  {'档次':<14}{'单章':>8}{'全书缺字':>9}{'全书':>8}")
    print("-" * (w + 74))
    for r in rows:
        print(f"{r['label']:<{w}}{r['size']:>7.1f}M{r['hanzi']:>9,}{r['ext_a']:>8,}{r['ext_b']:>8,}  "
              f"{r['tier']:<14}{r['rate_chapter']:>7.2f}%{r['miss_all']:>9,}{r['rate_all']:>7.2f}%")

    print("\n文件名对照：")
    for r in rows:
        print(f"  {r['label']:<{w}} ← {r['file']}")

    print("\n各字体在《明史》全书缺失的字（示例）：")
    for r in rows:
        if not r["samples"]:
            print(f"\n  {r['label']}：✅ 全覆盖")
            continue
        print(f"\n  {r['label']}（缺 {r['miss_all']:,} 个）：{'  '.join(r['samples'])}")


if __name__ == "__main__":
    main()
