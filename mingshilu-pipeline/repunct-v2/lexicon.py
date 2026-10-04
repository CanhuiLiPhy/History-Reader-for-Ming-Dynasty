#!/usr/bin/env python3
"""
中文：装配项目自带的人名、官职、衙门、地名、年号词表，用来判定标点是否切断了专名。

Assemble the project's own gazetteers into a boundary oracle.

Two punctuations of the same sentence can only be compared by argument, not by
preference — unless one of them can be shown to cut through a name. This module
collects every proper noun the repository already knows about (biographies,
office titles, bureaus, princely names, regions, reign names) so that claim can
be checked mechanically instead of asserted.

A hit is evidence, not proof: a two-character office title like 主事 also occurs
as ordinary prose, so the caller must weigh length and specificity. Everything
here is tuned to favour precision — a shorter list that is right — over recall.
"""
import json
import os
import re

DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..',
                    'backend', 'src', 'data')

_CJK = re.compile(r'^[一-鿿㐀-䶿]+$')
#: Words that look like names but are ordinary prose in the Veritable Records,
#: so a mark falling inside them proves nothing.
STOP = {
    '知府', '知县', '知州', '主事', '郎中', '御史', '都司', '卫所', '千户', '百户',
    '尚书', '侍郎', '参政', '参议', '佥事', '经历', '照磨', '教授', '训导', '典史',
    '同知', '通判', '推官', '巡检', '驿丞', '仓大使', '大使', '副使', '指挥', '总兵',
    '太监', '内官', '舍人', '力士', '校尉', '余丁', '军士', '官军', '人民', '百姓',
}


def _add(bucket, word, kind):
    """
    中文：把一个词收进词表，过滤掉太短、非汉字、以及常见普通词。

    Add one entry to the lexicon if it can carry evidential weight.

    Args:
        bucket (dict[str, str]): word -> kind, mutated in place.
        word (str): candidate proper noun.
        kind (str): which gazetteer it came from.

    Returns:
        None.
    """
    w = (word or '').strip()
    if not (2 <= len(w) <= 6):
        return
    if not _CJK.match(w) or w in STOP:
        return
    bucket.setdefault(w, kind)


def load_lexicon():
    """
    中文：读入全部词表，返回 词→类别 的映射。

    Load every gazetteer the repository ships.

    Args:
        None.

    Returns:
        dict[str, str]: proper noun -> one of 'person', 'office', 'bureau',
            'prince', 'place', 'emperor', 'reign'.
    """
    lex = {}

    path = os.path.join(DATA, 'biography-index.json')
    if os.path.exists(path):
        for k in json.load(open(path, encoding='utf-8'))['index']:
            if not any(x in k for x in '传第卷列后妃诸王公主外戚宦官列女土司'):
                _add(lex, k, 'person')

    path = os.path.join(DATA, 'characters.json')
    if os.path.exists(path):
        for c in json.load(open(path, encoding='utf-8'))['characters']:
            _add(lex, c.get('name'), 'person')
            for a in c.get('aliases') or []:
                _add(lex, a, 'person')

    path = os.path.join(DATA, 'officials-extended.json')
    if os.path.exists(path):
        d = json.load(open(path, encoding='utf-8'))
        for o in d.get('offices') or []:
            _add(lex, o.get('name'), 'office')
        for s in d.get('sections') or []:
            _add(lex, s.get('name'), 'bureau')
        for p in d.get('princes') or []:
            _add(lex, p.get('name'), 'prince')
        for c in d.get('chronology') or []:
            _add(lex, c.get('person'), 'person')

    path = os.path.join(DATA, 'officials.json')
    if os.path.exists(path):
        for i in json.load(open(path, encoding='utf-8'))['institutions']:
            _add(lex, i.get('name'), 'bureau')
            for a in i.get('aliases') or []:
                _add(lex, a, 'bureau')

    path = os.path.join(DATA, 'geography.json')
    if os.path.exists(path):
        for r in json.load(open(path, encoding='utf-8'))['regions']:
            _add(lex, r.get('name'), 'place')
            for a in r.get('aliases') or []:
                _add(lex, a, 'place')

    path = os.path.join(DATA, 'emperors.json')
    if os.path.exists(path):
        for e in json.load(open(path, encoding='utf-8'))['timeline']:
            _add(lex, e.get('name'), 'emperor')
            _add(lex, e.get('templeName'), 'emperor')
            for r in e.get('reignTitles') or []:
                _add(lex, r if isinstance(r, str) else r.get('title'), 'reign')

    path = os.path.join(DATA, 'reign-map.js')
    if os.path.exists(path):
        for m in re.finditer(r'reign:\s*"([^"]+)"', open(path, encoding='utf-8').read()):
            _add(lex, m.group(1), 'reign')

    return lex


def cuts(text, lex, to_raw, mark_positions, min_len=3):
    """
    中文：找出文中被标点从内部切断的专名。

    Find proper nouns that a punctuation mark splits from the inside.

    Args:
        text (str): punctuated text.
        lex (dict[str, str]): the lexicon from ``load_lexicon``.
        to_raw (callable): strips punctuation and whitespace.
        mark_positions (callable): returns raw-index -> mark.
        min_len (int): shortest entry that counts. Two-character hits are far
            too common by chance in classical Chinese to be evidence.

    Returns:
        list[tuple[str, str]]: (word, kind) for each split, longest match first
            at each position so 「林庭机」 is preferred over 「林庭」.
    """
    raw = to_raw(text)
    inner = {k for k in mark_positions(text) if 0 < k < len(raw)}
    if not inner:
        return []
    found = []
    i = 0
    while i < len(raw):
        for L in range(6, min_len - 1, -1):
            w = raw[i:i + L]
            if len(w) == L and w in lex:
                if any(i < c < i + L for c in inner):
                    found.append((w, lex[w]))
                i += L - 1
                break
        i += 1
    return found
