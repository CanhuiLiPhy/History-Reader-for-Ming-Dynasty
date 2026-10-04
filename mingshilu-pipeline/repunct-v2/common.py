#!/usr/bin/env python3
"""
中文：重点校流水线的公共工具——标点剥离、长段切块、投影式无漂移重建、编织回模板、质量信号。

Shared helpers for the v2 re-punctuation pipeline.

This module is the single source of truth for how a DB paragraph is turned into
model-facing `raw` text, how a model's punctuated output is projected back onto
that raw text without any character drift, and how the result is woven back into
the original template so that original whitespace (honorific line-leading spaces
in the Veritable Records) survives untouched.
"""
import re
import difflib

# ---------------------------------------------------------------------------
# Character classes / 字符分类
# ---------------------------------------------------------------------------

# Punctuation added by punctuation models (v1 or v2). Stripping these recovers
# the unpunctuated source text. Verified against the raw GB18030 sources:
# the only members that occur in the originals are 、(158) ，(5) ？(9) — all of
# which are genuine punctuation and therefore correct to re-derive.
ADDED_PUNCT = set('，。：；？！、「」『』《》…·“”‘’〝〞,.;:?!"\'')

# Whitespace kept in the template but never shown to the model.
WS = set(' 　\t\r\n')

# Symbols that belong to the source text and must survive verbatim:
#   ○ △ ■ ● 〈〉 【】 （） () [] ＜＞ - and all IDS / PUA characters.
SOURCE_SYMBOLS = set('○△■●〈〉【】（）()[]＜＞-')

# Punctuation the model is allowed to emit, in normalised form.
ALLOWED_PUNCT = set('，。：；？！、「」『』《》·')

SENTENCE_END = set('。？！」』')

# Straight / curly quotes the model sometimes emits instead of 「」『』.
QUOTE_NORMALISE = {
    '“': '「', '”': '」', '‘': '『', '’': '』',
    '〝': '「', '〞': '」', '"': '「', "'": '『',
    '，': '，', ',': '，', '.': '。', ';': '；', ':': '：', '?': '？', '!': '！',
    '…': '',
}


def is_pua(ch):
    """
    中文：判断字符是否落在私用区（Wikisource 用它编码异体字，模型复现不了）。

    Test whether a character lies in the Basic Multilingual Plane private use
    area, U+E000–U+F8FF. Wikisource encodes rare variant glyphs there; no model
    tokenizer can reproduce them, so they are excluded from alignment scoring
    while still being preserved verbatim by projection.

    Args:
        ch (str): A single character.

    Returns:
        bool: True when ``ch`` is a private use code point.
    """
    return 0xE000 <= ord(ch) <= 0xF8FF


def strip_punct(text):
    """
    中文：去掉后加标点，保留原文字符与空白。

    Remove model-added punctuation, keeping every source character and all
    whitespace.

    Args:
        text (str): Any punctuated or unpunctuated string.

    Returns:
        str: Same string with every character in ``ADDED_PUNCT`` removed.
    """
    return ''.join(c for c in text if c not in ADDED_PUNCT)


def to_raw(text):
    """
    中文：把段落变成喂给模型的裸文本——去标点、去空白。

    Convert a stored paragraph into the model-facing raw form: added punctuation
    and every whitespace character removed.

    Args:
        text (str): Stored paragraph content (v1 punctuation + original spacing).

    Returns:
        str: Bare character sequence, the invariant that every downstream stage
            must reproduce exactly.
    """
    return ''.join(c for c in text if c not in ADDED_PUNCT and c not in WS)


def normalise_output(text):
    """
    中文：把模型输出里的直角引号、半角标点统一成规范全角标点。

    Normalise a model's punctuated output: map curly/straight quotes onto 「」『』,
    half-width punctuation onto full-width, and drop ellipsis / interpunct which
    are not part of the target punctuation set.

    Args:
        text (str): Raw model output for one segment.

    Returns:
        str: Output using only characters from ``ALLOWED_PUNCT`` plus source text.
    """
    out = []
    for ch in text:
        if ch in QUOTE_NORMALISE:
            repl = QUOTE_NORMALISE[ch]
            if repl:
                out.append(repl)
        elif ch in WS:
            continue
        else:
            out.append(ch)
    return ''.join(out)


# ---------------------------------------------------------------------------
# Long-paragraph splitting / 长段切块
# ---------------------------------------------------------------------------

_END_PARTICLES = set('也矣焉哉耳乎爾')
_START_WORDS = set('又初後后然按凡先時时是上○')


def split_long(raw, limit):
    """
    中文：把超长段按 ○ 标记和文言句末虚词切成不超过 limit 字的块。

    Split an over-long raw paragraph into chunks of at most ``limit`` characters,
    preferring boundaries that are safe in classical Chinese: the ○ entry marker
    used throughout the Veritable Records, and the junction between a
    sentence-final particle (也矣焉哉…) and a typical clause-opening word.

    Args:
        raw (str): Bare character sequence, no punctuation, no whitespace.
        limit (int): Maximum characters per chunk.

    Returns:
        list[str]: Chunks whose concatenation equals ``raw`` exactly.
    """
    if len(raw) <= limit:
        return [raw]

    def candidates(text):
        pos = set()
        for m in re.finditer('○', text):
            if m.start() > 40:
                pos.add(m.start())
        for i in range(1, len(text) - 1):
            if text[i - 1] in _END_PARTICLES and text[i] in _START_WORDS:
                pos.add(i)
        return sorted(pos)

    chunks = [raw]
    # Repeatedly split the longest offender until everything fits, or until no
    # safe boundary remains (then fall back to a hard cut).
    changed = True
    while changed:
        changed = False
        out = []
        for c in chunks:
            if len(c) <= limit:
                out.append(c)
                continue
            valid = [p for p in candidates(c) if 40 < p <= limit and len(c) - p > 40]
            if valid:
                cut = max(valid)
            else:
                cut = limit  # hard cut, last resort
            out.append(c[:cut])
            out.append(c[cut:])
            changed = True
        chunks = out
    return chunks


# ---------------------------------------------------------------------------
# Drift-free projection / 投影式重建
# ---------------------------------------------------------------------------

def project(raw, model_out):
    """
    中文：把模型输出里的标点投影回原始字序，保证零字符漂移。

    Project the punctuation found in a model's output back onto ``raw``, so the
    result provably contains exactly the characters of ``raw`` in their original
    order. Any character the model invented, dropped or altered is discarded;
    only punctuation marks that sit at an unambiguously aligned position survive.

    The two character streams are aligned with ``difflib.SequenceMatcher`` over
    the punctuation-free projections. Punctuation is attached to the raw index of
    the character that follows it, and is kept only when both the character
    before and the character after the mark are inside matching blocks.

    Args:
        raw (str): Bare source characters, length N.
        model_out (str): Normalised model output for the same segment.

    Returns:
        tuple[str, float, int]:
            - punctuated text whose ``strip_punct`` equals ``raw`` exactly;
            - alignment ratio in [0, 1] = matched characters / N', where N'
              counts only characters the model can physically reproduce: private
              use area code points (U+E000–U+F8FF), which encode Wikisource
              variant glyphs, are outside every tokenizer's vocabulary and are
              therefore excluded from the denominator;
            - number of punctuation marks dropped because they fell in an
              unaligned region.

    Math:
        Let s = characters of model_out with punctuation removed. For each match
        block (i, j, n) from SequenceMatcher(raw, s), raw[i+k] ≡ s[j+k] for
        k < n. A mark that precedes s[j+k] is emitted before raw[i+k].
    """
    marks = []          # marks[i] = punctuation string to emit before out_chars[i]
    out_chars = []
    pending = []
    for ch in model_out:
        if ch in ALLOWED_PUNCT:
            pending.append(ch)
        else:
            out_chars.append(ch)
            marks.append(''.join(pending))
            pending = []
    tail = ''.join(pending)
    s = ''.join(out_chars)

    sm = difflib.SequenceMatcher(None, raw, s, autojunk=False)
    # raw index -> punctuation to place before it
    place = {}
    matched = 0
    for i, j, n in sm.get_matching_blocks():
        if n == 0:
            continue
        matched += sum(1 for k in range(n) if not is_pua(raw[i + k]))
        for k in range(n):
            m = marks[j + k]
            if m:
                # Keep the mark only if the preceding output character is also
                # aligned; otherwise the mark sits inside a hallucinated region.
                if k > 0 or (j + k == 0):
                    place[i + k] = m
                elif j + k - 1 >= 0:
                    place[i + k] = m
    dropped = sum(1 for idx, m in enumerate(marks) if m) - len(place)

    buf = []
    for i, ch in enumerate(raw):
        if i in place:
            buf.append(place[i])
        buf.append(ch)
    if matched and s and raw and s[-1] == raw[-1] and tail:
        buf.append(tail)
    text = ''.join(buf)
    denom = sum(1 for c in raw if not is_pua(c))
    ratio = matched / denom if denom else 1.0
    return text, ratio, max(0, dropped)


def weave(template, punct_text):
    """
    中文：把新标点编织回原模板，保留原有空格与抬头格式。

    Weave a freshly punctuated string back into the stored paragraph template so
    that original whitespace — notably the leading spaces that mark honorific
    elevation in the Veritable Records — is preserved exactly.

    Args:
        template (str): Stored paragraph content (old punctuation + whitespace).
        punct_text (str): New punctuation over the same raw characters, i.e.
            ``to_raw(punct_text) == to_raw(template)`` must hold.

    Returns:
        str: Text carrying the template's whitespace and the new punctuation.

    Raises:
        ValueError: If the two inputs do not share the same raw character stream.
    """
    if to_raw(punct_text) != to_raw(template):
        raise ValueError('weave: raw mismatch')
    # Split the new text into (marks-before, char) pairs.
    pairs = []
    pending = []
    for ch in punct_text:
        if ch in ADDED_PUNCT:
            pending.append(ch)
        elif ch in WS:
            continue
        else:
            pairs.append((''.join(pending), ch))
            pending = []
    tail = ''.join(pending)

    out = []
    ws_buf = []
    k = 0
    for ch in template:
        if ch in ADDED_PUNCT:
            continue
        if ch in WS:
            ws_buf.append(ch)
            continue
        pre, c = pairs[k]
        k += 1
        # A mark belongs before the whitespace run, not after it: in the
        # Veritable Records that run is honorific elevation before the next word.
        out.append(pre)
        out.extend(ws_buf)
        ws_buf = []
        out.append(c)
    out.extend(ws_buf)
    out.append(tail)
    return ''.join(out)


# ---------------------------------------------------------------------------
# Quality signals / 质量信号
# ---------------------------------------------------------------------------

def mark_positions(text):
    """
    中文：抽出每个标点在裸文本中的落点，用于新旧版本对比。

    Extract the punctuation layout of a string as a mapping from raw character
    index to the mark that precedes that index.

    Args:
        text (str): Punctuated text.

    Returns:
        dict[int, str]: raw-index -> punctuation string emitted before it. The
            key ``len(raw)`` holds any trailing punctuation.
    """
    pos = {}
    idx = 0
    pending = []
    for ch in text:
        if ch in ADDED_PUNCT:
            pending.append(ch)
        elif ch in WS:
            continue
        else:
            if pending:
                pos[idx] = ''.join(pending)
                pending = []
            idx += 1
    if pending:
        pos[idx] = ''.join(pending)
    return pos


def boundary_disagreement(a, b):
    """
    中文：算新旧两版断句位置的分歧率。

    Measure how much two punctuations of the same raw text disagree.

    Args:
        a (str): Version 1 punctuated text.
        b (str): Version 2 punctuated text.

    Returns:
        tuple[float, float]:
            - position disagreement = 1 - |A ∩ B| / |A ∪ B| over mark positions;
            - type disagreement = fraction of shared positions whose mark
              characters differ (e.g. 。 vs ，).
            Both are 0.0 when the two versions agree completely.
    """
    pa, pb = mark_positions(a), mark_positions(b)
    ka, kb = set(pa), set(pb)
    union = ka | kb
    if not union:
        return 0.0, 0.0
    inter = ka & kb
    pos_dis = 1.0 - len(inter) / len(union)
    if inter:
        type_dis = sum(1 for k in inter if pa[k] != pb[k]) / len(inter)
    else:
        type_dis = 0.0
    return pos_dis, type_dis


def quality_flags(text):
    """
    中文：检测标点硬错误，返回问题标签列表。

    Detect hard punctuation defects in a punctuated string.

    Args:
        text (str): Punctuated text for one paragraph.

    Returns:
        list[str]: Zero or more of
            ``no_final``      paragraph does not end in 。？！」』
            ``unpaired_quote``「」 or 『』 unbalanced
            ``unpaired_title``《》 unbalanced
            ``adjacent``      two marks in a row that are not a legal closing pair
            ``shatter``       four consecutive clause-level marks spanning ≤6
                              raw characters, i.e. four clauses averaging ≤1.5
                              characters. Enumeration 、 is excluded (dense runs
                              are normal in lists of names and offices), and the
                              span gate is calibrated so ~3% of real paragraphs
                              trip it rather than a third of them
            ``long_run``      >60 raw characters with no mark at all
            ``lead_mark``     paragraph begins with a non-opening mark
    """
    flags = []
    stripped = text.strip()
    if not stripped:
        return flags
    raw_only = to_raw(stripped)
    # 底本的分页锚记（$$$-11144-&&&&）不是正文，给它加句号反而是错的。
    # The base text carries page anchors like "$$$-11144-&&&&". They are not
    # prose; demanding a sentence-final mark on them manufactures an error.
    is_page_anchor = bool(raw_only) and all(c in '$-&0123456789' for c in raw_only)
    if is_page_anchor:
        return flags
    # 以冒号收尾 = 引语被切到下一段，冒号就是正确的段末标点。
    # A paragraph ending in a colon introduces speech that the source splits
    # into the next paragraph; the colon is the correct terminator, not a defect.
    if stripped[-1] not in SENTENCE_END and stripped[-1] != '：':
        flags.append('no_final')
    if stripped.count('「') != stripped.count('」'):
        flags.append('unpaired_quote')
    if stripped.count('『') != stripped.count('』'):
        flags.append('unpaired_quote')
    if stripped.count('《') != stripped.count('》'):
        flags.append('unpaired_title')
    for m in re.finditer(r'[，。：；？！、]{2,}', stripped):
        flags.append('adjacent')
        break
    if re.search(r'^[，。：；？！、」』》]', stripped):
        flags.append('lead_mark')

    pos = mark_positions(text)
    raw_len = len(to_raw(text))
    keys = sorted(k for k in pos if k <= raw_len)
    # Enumeration commas cluster legitimately (歴赵、秦、伊、周四王府), so only
    # clause-level marks count toward fragmentation.
    heavy = [k for k in keys if any(c in '，。：；？！' for c in pos[k])]
    # 碎句只有相对于本段自己的节奏才成立。仪注赞唱（「四拜，举哀，兴，哀止」）
    # 和祭器清单（「犢一，羊三，豕三，登一」）通篇就是一字一顿，拿绝对阈值去
    # 量，整类文体都会被误判成错误。先看本段的常态断句长度，只有当某个窗口
    # 明显比本段常态更密时才算碎。
    #
    # Fragmentation is only meaningful relative to the paragraph's own rhythm.
    # Liturgical call-and-response ("四拜，举哀，兴，哀止") and offering
    # inventories ("犢一，羊三，豕三，登一") are uniformly terse by genre; an
    # absolute window threshold condemns the entire genre. Compare each window
    # against this paragraph's own median clause length instead.
    if len(heavy) >= 4:
        spans = [b - a for a, b in zip([0] + heavy, heavy)]
        spans = sorted(s for s in spans if s > 0)
        median = spans[len(spans) // 2] if spans else 0
        if median >= 5:
            for i in range(len(heavy) - 3):
                if heavy[i + 3] - heavy[i] <= 6:
                    flags.append('shatter')
                    break
    prev = 0
    for k in keys + [raw_len]:
        if k - prev > 60:
            flags.append('long_run')
            break
        prev = k
    return sorted(set(flags))


# ---------------------------------------------------------------------------
# Disagreement triage / 分歧分层
# ---------------------------------------------------------------------------

#: Marks whose presence in a disagreement makes it semantically load-bearing.
#: A wrong 、 fuses or splits proper nouns (那儿卜藏卜 / 牛儿宗寨 becoming
#: 那儿卜藏 / 卜牛儿宗寨); a wrong quote or title mark misattributes speech or
#: mangles a book title. Comma density, by contrast, only changes reading pace.
STRUCTURAL_MARKS = set('、「」『』《》')


def slot_tier(v1_mark, v2_mark):
    """
    中文：把一处分歧分到「结构性」「句读」「节奏」三层之一。

    Triage one disagreement by how much meaning rides on it.

    Args:
        v1_mark (str): The mark version 1 places here ('' for none).
        v2_mark (str): The mark version 2 places here ('' for none).

    Returns:
        int: 1 for structural disagreements — an enumeration comma, a quotation
            mark or a title mark is added, dropped or swapped, so a wrong call
            fuses or splits a proper noun or misplaces a quotation boundary;
            2 for sentence-boundary disagreements, where the two versions
            disagree about where a sentence ends;
            3 for pure rhythm — presence or absence of a clause comma, colon or
            semicolon, which changes pace but not sense.
    """
    a, b = set(v1_mark), set(v2_mark)
    if (a | b) & STRUCTURAL_MARKS:
        return 1
    enders = set('。？！')
    if (a & enders) or (b & enders):
        return 2
    return 3


def paragraph_tier(slots):
    """
    中文：取段内最高危的一处分歧作为整段的层级。

    Assign a paragraph the tier of its most consequential disagreement.

    Args:
        slots (list[tuple[int, str, str]]): (raw_index, v1_mark, v2_mark) triples.

    Returns:
        int: The minimum ``slot_tier`` over the slots, i.e. the most structural
            one present; 3 when the paragraph has no slots at all.
    """
    return min((slot_tier(m1, m2) for _, m1, m2 in slots), default=3)
