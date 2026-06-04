#!/usr/bin/env python3
"""
将 jiayan 标点版重新对齐到原文行结构。

核心思路：
  - 原文和 jiayan 标点版的内容字符（去标点、去空白、去 \n）完全一致
  - 用「内容字符」做主索引：第 k 个内容字符在原文和标点版中是同一个汉字
  - 输出 = 原文逐 char 走：结构字符（空格/换行/校勘符）照搬，内容字符之间插入 jiayan 的标点

算法保证：
  - 原文有多少行，输出就有多少行（除非有完全空白的尾行）
  - 每一行的非标点字符数与原文该行完全相同
  - 加入的标点 100% 来自 jiayan 输出，不丢不重
"""
import argparse
import sys
from pathlib import Path

# 真正的「标点字符」—— 在内容比对时要剔除
JIAYAN_PUNCT = set("，。：；？！「」、")
# jiayan 输出里我自己在 chunk 间加的换行 + 偶尔 CRLF
JIAYAN_LINEBREAK = set("\n\r")
# 把以上都视为"标点+空白"，但内容字符比对时只看汉字/西文
# 「内容字符」= 非以下集合中的任何字符
NON_CONTENT = JIAYAN_PUNCT | JIAYAN_LINEBREAK | set("　 \xa0\t")

def load_orig(path: str) -> str:
    raw = Path(path).read_bytes()
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("gb18030", errors="replace")

def is_content(ch: str) -> bool:
    return ch not in NON_CONTENT

def build_punct_index(punct_text: str):
    """返回：每个内容字符在 punct_text 中的索引列表"""
    return [i for i, ch in enumerate(punct_text) if is_content(ch)]

def reconstruct(orig_text: str, punct_text: str):
    orig_text = orig_text.replace("\r\n", "\n").replace("\r", "\n").replace("\x85", "\n")
    punct_idx = build_punct_index(punct_text)
    out = []
    content_no = 0      # 走到原文第 k 个内容字符
    mismatches = []     # (line_no, char_idx, orig_char, punct_char)

    # 先把 orig 整体走一遍，逐 char 决定输出
    line_no = 1
    char_in_line = 0
    for i, ch in enumerate(orig_text):
        if ch == "\n":
            # 行尾换行 —— 行末已在最后一个内容字符之后吃掉了 trailing punct，这里只输出 \r\n
            out.append("\r\n")
            line_no += 1
            char_in_line = 0
            continue

        if not is_content(ch):
            # 结构字符（空格 / 全角空格 / `○` / `〇` / 校勘符等）—— 原样输出，不消费 punct
            # 但若是共享标点 `、` 且 jiayan 已经吐出 `、`，就跳过避免重复
            if ch == "、" and out and out[-1] == "、":
                char_in_line += 1
                continue
            out.append(ch)
            char_in_line += 1
            continue

        # 内容字符：必须等于 punct 第 content_no 个内容字符
        if content_no >= len(punct_idx):
            # 标点版用尽（罕见），把原文字符照搬
            out.append(ch)
            mismatches.append((line_no, char_in_line, ch, "(EOF)"))
            char_in_line += 1
            continue

        target_pos = punct_idx[content_no]
        target_ch = punct_text[target_pos]

        if ch != target_ch:
            # 字不对 — jiayan 改字了（如繁简切换误差），用 jiayan 的字
            mismatches.append((line_no, char_in_line, ch, target_ch))

        out.append(target_ch)

        # 看下一个内容字符之前的 jiayan 标点（不含空白/换行），全部追加到当前位置后面
        next_pos = punct_idx[content_no + 1] if content_no + 1 < len(punct_idx) else len(punct_text)
        for j in range(target_pos + 1, next_pos):
            c = punct_text[j]
            if c in JIAYAN_PUNCT:
                # 去重：连续相同标点不重复（包括 jiayan 自己吐重 + 与 orig 共享）
                if out and out[-1] == c:
                    continue
                out.append(c)
        content_no += 1
        char_in_line += 1

    return "".join(out), mismatches, len(punct_idx) - content_no

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--orig", required=True)
    ap.add_argument("--punct", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    orig_p = Path(args.orig)
    punct_p = Path(args.punct)

    if orig_p.is_file() and punct_p.is_file():
        pairs = [(orig_p, punct_p)]
    else:
        orig_files = {f.stem: f for f in orig_p.iterdir() if f.suffix == ".txt"}
        punct_files = {f.stem: f for f in punct_p.iterdir() if f.suffix == ".txt"}
        common = sorted(set(orig_files) & set(punct_files))
        pairs = [(orig_files[k], punct_files[k]) for k in common]
        for k in set(orig_files) - set(punct_files):
            print(f"[skip] no punct version for {orig_files[k].name}")

    summary = []
    for orig_path, punct_path in pairs:
        orig = load_orig(str(orig_path))
        punct = punct_path.read_text(encoding="utf-8")
        out_text, mismatches, unused_punct_chars = reconstruct(orig, punct)
        out_file = out_dir / orig_path.name
        out_file.write_text(out_text, encoding="utf-8")
        orig_chars_total = sum(1 for c in orig if is_content(c))
        out_lines_n = out_text.count("\r\n") + (0 if out_text.endswith("\r\n") else 1)
        orig_lines_n = orig.replace("\r\n", "\n").replace("\r", "\n").count("\n") + 1
        summary.append((orig_path.name, orig_lines_n, out_lines_n, orig_chars_total, len(mismatches), unused_punct_chars))
        print(f"[ok]  {orig_path.name}: lines {orig_lines_n} → {out_lines_n} | mismatches: {len(mismatches)} | unused punct chars: {unused_punct_chars}")
        if 0 < len(mismatches) <= 12:
            for m in mismatches:
                print(f"      L{m[0]} char{m[1]}: orig{repr(m[2])} vs punct{repr(m[3])}")
        elif len(mismatches) > 12:
            for m in mismatches[:5]:
                print(f"      L{m[0]} char{m[1]}: orig{repr(m[2])} vs punct{repr(m[3])}")
            print(f"      ... (+{len(mismatches) - 5} more)")

    print()
    print("=" * 80)
    print(f"  {'file':<35s} {'orig-L':>7s} {'out-L':>7s} {'orig-ch':>9s} {'mis':>5s} {'unused':>6s}")
    for s in summary:
        print(f"  {s[0]:<35s} {s[1]:>7d} {s[2]:>7d} {s[3]:>9d} {s[4]:>5d} {s[5]:>6d}")

if __name__ == "__main__":
    main()
