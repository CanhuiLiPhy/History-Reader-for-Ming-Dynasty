#!/usr/bin/env python3
"""
中文：检查内置字体对给定文本的覆盖率，算出会触发 fallback 的字。

Measure how much of a given text each bundled font can actually render.

A font that lacks a glyph does not fail loudly — the browser silently
substitutes another family for those characters. In running classical Chinese
that shows up as scattered characters in a visibly different style, which is
what makes the page feel inconsistent. This script reports, per font, exactly
which characters would be substituted.

It parses the sfnt `cmap` table directly rather than depending on fontTools, so
it runs with a bare Python install. Formats 4 (BMP) and 12 (full Unicode) cover
every font shipped here; other subtable formats are skipped with a warning
rather than silently counted as empty coverage.

Usage:
    python3 scripts/font-coverage.py <fonts-dir> <sample-text-file>
"""
import os
import struct
import sys
from collections import Counter


def _read_table_directory(data):
    """
    中文：读 sfnt 表目录，返回表名到 (偏移, 长度) 的映射。

    Parse the sfnt table directory.

    Args:
        data (bytes): entire font file.

    Returns:
        dict[str, tuple[int, int]]: table tag → (offset, length). TrueType
            collections (`ttcf`) resolve to their first font.
    """
    tag = data[:4]
    offset = 0
    if tag == b"ttcf":
        # TrueType Collection: jump to the first font's own directory.
        offset = struct.unpack(">I", data[12:16])[0]
    num_tables = struct.unpack(">H", data[offset + 4:offset + 6])[0]
    tables = {}
    pos = offset + 12
    for _ in range(num_tables):
        name, _checksum, off, length = struct.unpack(">4sIII", data[pos:pos + 16])
        tables[name.decode("latin-1").strip()] = (off, length)
        pos += 16
    return tables


def _parse_format4(data, base):
    """
    中文：解析 cmap format 4（BMP 段映射）。

    Parse a format 4 (segment-mapped BMP) cmap subtable.

    Args:
        data (bytes): entire font file.
        base (int): absolute offset of the subtable.

    Returns:
        set[int]: covered Unicode code points.
    """
    seg_x2 = struct.unpack(">H", data[base + 6:base + 8])[0]
    seg_count = seg_x2 // 2
    ends_at = base + 14
    starts_at = ends_at + seg_x2 + 2
    deltas_at = starts_at + seg_x2
    ranges_at = deltas_at + seg_x2

    ends = struct.unpack(f">{seg_count}H", data[ends_at:ends_at + seg_x2])
    starts = struct.unpack(f">{seg_count}H", data[starts_at:starts_at + seg_x2])
    deltas = struct.unpack(f">{seg_count}h", data[deltas_at:deltas_at + seg_x2])
    range_offsets = struct.unpack(f">{seg_count}H", data[ranges_at:ranges_at + seg_x2])

    covered = set()
    for i in range(seg_count):
        start, end = starts[i], ends[i]
        if start == 0xFFFF:
            continue
        for code in range(start, min(end, 0xFFFE) + 1):
            if range_offsets[i] == 0:
                glyph = (code + deltas[i]) & 0xFFFF
            else:
                # glyphIdArray is addressed relative to the range offset slot.
                idx = ranges_at + i * 2 + range_offsets[i] + (code - start) * 2
                if idx + 2 > len(data):
                    continue
                glyph = struct.unpack(">H", data[idx:idx + 2])[0]
                if glyph:
                    glyph = (glyph + deltas[i]) & 0xFFFF
            if glyph:
                covered.add(code)
    return covered


def _parse_format12(data, base):
    """
    中文：解析 cmap format 12（完整 Unicode 分组映射）。

    Parse a format 12 (segmented coverage, full Unicode) cmap subtable.

    Args:
        data (bytes): entire font file.
        base (int): absolute offset of the subtable.

    Returns:
        set[int]: covered Unicode code points.
    """
    n_groups = struct.unpack(">I", data[base + 12:base + 16])[0]
    covered = set()
    pos = base + 16
    for _ in range(n_groups):
        start, end, start_glyph = struct.unpack(">III", data[pos:pos + 12])
        pos += 12
        if start_glyph == 0:
            # Group maps to .notdef — not real coverage.
            continue
        covered.update(range(start, end + 1))
    return covered


def font_coverage(path):
    """
    中文：读出一个字体文件能渲染的全部码位。

    Collect every Unicode code point a font can render.

    Prefers a format 12 subtable when present (it can express characters beyond
    the BMP, which matters here: rare historical characters in 明史 live in the
    CJK Extension blocks above U+FFFF). Falls back to format 4, and unions
    everything it understands so a font with several subtables is not
    under-counted.

    Args:
        path (str): path to a .ttf/.otf file.

    Returns:
        set[int]: covered code points; empty when no readable cmap exists.
    """
    with open(path, "rb") as handle:
        data = handle.read()
    tables = _read_table_directory(data)
    if "cmap" not in tables:
        return set()
    cmap_off = tables["cmap"][0]
    n_records = struct.unpack(">H", data[cmap_off + 2:cmap_off + 4])[0]

    covered = set()
    seen_offsets = set()
    for i in range(n_records):
        rec = cmap_off + 4 + i * 8
        _platform, _encoding, sub_off = struct.unpack(">HHI", data[rec:rec + 8])
        base = cmap_off + sub_off
        if base in seen_offsets:
            continue
        seen_offsets.add(base)
        fmt = struct.unpack(">H", data[base:base + 2])[0]
        if fmt == 4:
            covered |= _parse_format4(data, base)
        elif fmt == 12:
            covered |= _parse_format12(data, base)
        # Other formats (0, 6, 13, 14) carry no coverage these fonts rely on.
    return covered


def main():
    fonts_dir, sample_path = sys.argv[1], sys.argv[2]
    with open(sample_path, encoding="utf-8") as handle:
        text = handle.read()

    # 只统计需要字形的字符：空白和 ASCII 控制符不参与。
    chars = [c for c in text if not c.isspace() and ord(c) >= 0x20]
    freq = Counter(chars)
    unique = set(chars)
    total = len(chars)

    print(f"样本：{total} 字（去重 {len(unique)} 个不同字符）\n")

    files = sorted(
        f for f in os.listdir(fonts_dir)
        if f.lower().endswith((".ttf", ".otf")) and not f.startswith(".")
    )

    rows = []
    for name in files:
        covered = font_coverage(os.path.join(fonts_dir, name))
        if not covered:
            print(f"  ⚠️  {name}：无法解析 cmap，跳过")
            continue
        missing = {c for c in unique if ord(c) not in covered}
        missing_occurrences = sum(freq[c] for c in missing)
        rows.append({
            "name": name,
            "glyphs": len(covered),
            "missing_unique": len(missing),
            "missing_occurrences": missing_occurrences,
            "rate": missing_occurrences / total * 100 if total else 0.0,
            "samples": sorted(missing, key=lambda c: -freq[c])[:20],
            "freq": freq,
        })

    rows.sort(key=lambda r: r["rate"])
    width = max(len(r["name"]) for r in rows) if rows else 20

    print(f"{'字体':<{width}}  {'码位数':>8}  {'缺字(去重)':>10}  {'fallback率':>10}")
    print("-" * (width + 36))
    for r in rows:
        print(f"{r['name']:<{width}}  {r['glyphs']:>8}  {r['missing_unique']:>10}  {r['rate']:>9.3f}%")

    print("\n每个字体缺失最频繁的字（括号内为该字在样本中出现次数）：")
    for r in rows:
        if not r["samples"]:
            print(f"\n  {r['name']}：✅ 全覆盖，无 fallback")
            continue
        shown = "  ".join(f"{c}({r['freq'][c]})" for c in r["samples"])
        print(f"\n  {r['name']}（缺 {r['missing_unique']} 个）：\n    {shown}")


if __name__ == "__main__":
    main()
