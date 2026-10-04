#!/usr/bin/env python3
"""
中文：重审——把新旧两版一起交给 Qwen3.8-27B 思考模式（xhigh）裁决，产出终版并自报把握度。

Thinking-mode adjudication pass.

Every paragraph that ``assemble.py`` flagged — hard punctuation defect, weak
alignment, low token confidence, or a substantive disagreement with the old
punctuation — is shown to the model together with both existing versions and the
bare source text. The model returns its own final punctuation plus a self-rated
confidence, which is then projected back onto the raw characters so the result
still cannot drift. Paragraphs the model itself is unsure about end up in the
leftover list for a stronger model later.

Usage:
    set -a; . ~/.keys/qwen3_8_27b.env; set +a
    python3 run_review.py --db donotpack/repunct-v2/repunct.sqlite \
        --books shu-yuan-zaji --concurrency 16
"""
import argparse
import json
import os
import queue
import re
import signal
import sqlite3
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C
from run_base import load_env, stream_chat

SCHEMA = """
CREATE TABLE IF NOT EXISTS review (
  para_id    INTEGER PRIMARY KEY,
  slug       TEXT NOT NULL,
  final      TEXT NOT NULL,   -- adjudicated punctuation, woven onto the template
  chose      TEXT NOT NULL,   -- v1 | v2 | new  (which reading the model landed on)
  conf       TEXT NOT NULL,   -- high | medium | low
  ratio      REAL NOT NULL,
  flags      TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL    -- ok | failed
);
CREATE INDEX IF NOT EXISTS idx_review_conf ON review(conf);

CREATE TABLE IF NOT EXISTS review_batches (
  rb_id    INTEGER PRIMARY KEY,
  slug     TEXT NOT NULL,
  para_ids TEXT NOT NULL,
  n_chars  INTEGER NOT NULL,
  status   TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  ptok     INTEGER NOT NULL DEFAULT 0,
  ctok     INTEGER NOT NULL DEFAULT 0,
  rtok     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_rb_status ON review_batches(status);
"""

SYSTEM_PROMPT = """你是资深古籍点校专家。下面每一条给出同一段古文的两种已有标点方案（甲、乙）以及不含标点的原文，请你裁定最终标点。

严格保字规则（违反即作废）：
1. 一个汉字都不许增、删、改。看似 OCR 错字、缺字、重复字，一律照原文保留。
2. 原文中的 ○ △ □ ■ ● ＜＞ 〈〉 【】 （） [] - 及生僻异体字，原样照抄。
3. 你只能在字与字之间插入标点。输出去掉标点后必须与原文逐字一致。

标点规范：
- 只用这些标点：，。：；？！、「」『』《》·
- 对话和引文用「」，引文中再引用用『』；专称、印文、俗语等需要标示的短语也用「」。禁止使用 “” ‘’ 和半角标点。
- 书名、篇名用《》，书名与篇名之间用·。
- 并列的人名、官名、地名、物名之间用、。
- 每段必须以 。？！」』 之一结尾。
- 句意为重：宁可句子长一些，也不要把人名、官职、地名、书名切断。

裁定要求：
- 甲、乙哪个更合文意就采哪个；两个都不妥就自己重点。
- 判断依据是文意与史实，不要为了改而改。

输出格式，每条严格三行，不要有任何多余文字：
#编号|采信=甲|把握=高
#编号文=<最终带标点的全文>
（把握只能是 高 / 中 / 低；采信只能是 甲 / 乙 / 新。对文意有实质疑问、或有难以判定的人名官名断法时必须给「低」。）"""

HEAD_RE = re.compile(r'^#(\d+)\s*\|\s*采信\s*=\s*([甲乙新])\s*\|\s*把握\s*=\s*([高中低])', re.M)
TEXT_RE = re.compile(r'^#(\d+)\s*文\s*=\s*(.*)$', re.M)
CHOSE = {'甲': 'v1', '乙': 'v2', '新': 'new'}
CONF = {'高': 'high', '中': 'medium', '低': 'low'}


def build_prompt(items):
    """
    中文：把若干待审段落拼成一次请求的正文。

    Render the user message for one review batch.

    Args:
        items (list[tuple[int, str, str, str]]): (para_id, raw, v1_flat, v2_flat)
            where the two version strings carry punctuation but no whitespace.

    Returns:
        str: The user message, one numbered block per paragraph.
    """
    blocks = []
    for i, (_, raw, v1, v2) in enumerate(items, 1):
        blocks.append(f'#{i}原文={raw}\n#{i}甲={v1}\n#{i}乙={v2}')
    return '\n\n'.join(blocks)


def parse_reply(text, n):
    """
    中文：解析裁定回复，取出每段的采信、把握与最终文本。

    Parse the adjudication reply.

    Args:
        text (str): Full assistant content.
        n (int): Number of paragraphs sent in this batch.

    Returns:
        dict[int, dict]: 1-based index -> ``{'chose', 'conf', 'text'}`` for every
            entry that produced both a header line and a text line.
    """
    heads = {}
    for m in HEAD_RE.finditer(text):
        idx = int(m.group(1))
        if 1 <= idx <= n:
            heads[idx] = {'chose': CHOSE.get(m.group(2), 'new'),
                          'conf': CONF.get(m.group(3), 'low')}
    out = {}
    for m in TEXT_RE.finditer(text):
        idx = int(m.group(1))
        if 1 <= idx <= n and idx in heads:
            out[idx] = dict(heads[idx], text=m.group(2).strip())
    return out


class Reviewer:
    """
    中文：重审调度器——组批、并发请求、投影落盘，支持断点续跑。

    Drives the thinking-mode review: builds review batches from the flagged
    paragraphs, runs them concurrently, and commits adjudicated results.
    """

    def __init__(self, args):
        """
        中文：初始化并打开工作库。

        Args:
            args (argparse.Namespace): Parsed command-line options.

        Returns:
            None.
        """
        self.args = args
        self.base, self.key, self.model = load_env()
        self.db = sqlite3.connect(args.db, timeout=120)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.executescript(SCHEMA)
        self.stop = threading.Event()
        self.t0 = time.time()
        self.done = 0
        self.ptok = self.ctok = self.rtok = 0
        self.errors = {}
        self.conf_counts = {}
        self.cache = {}
        self.v2_of = {}
        self.sweep = 0
        self.log = open(args.log, 'a', encoding='utf-8') if args.log else None

    def note(self, msg):
        """
        中文：写终端与日志。

        Emit one progress line to stdout and the log file.

        Args:
            msg (str): Message text.

        Returns:
            None.
        """
        line = f'[{time.strftime("%H:%M:%S")}] {msg}'
        print(line, flush=True)
        if self.log:
            self.log.write(line + '\n')
            self.log.flush()

    def plan(self):
        """
        中文：把待审段落按字数打包成重审批次，写入 review_batches。

        Group flagged paragraphs into review batches, skipping any that already
        have a result. Batches stay small: the model is reasoning about each
        paragraph individually, and a long reply risks truncation.

        Args:
            None.

        Returns:
            int: Number of batches now pending.
        """
        where, params = '', []
        if self.args.books:
            slugs = [s.strip() for s in self.args.books.split(',') if s.strip()]
            where = ' AND w.slug IN (%s)' % ','.join('?' * len(slugs))
            params = slugs
        # Highest priority first: review capacity is the scarce resource, so a
        # budget cut must drop the least suspicious paragraphs, not a random tail.
        # 已由规则判据裁定的段落（resolved 表）不再送模型：那些是有证据的
        # 结论，让模型重判只会用它的猜测覆盖掉可复核的判断。
        # Paragraphs already settled on evidence are excluded. Sending them to
        # the model would replace a checkable conclusion with a guess.
        rows = self.db.execute(
            'SELECT w.para_id, w.slug, u.n_raw FROM units_v2 w '
            'JOIN units u ON u.para_id = w.para_id '
            'LEFT JOIN review r ON r.para_id = w.para_id '
            'LEFT JOIN resolved d ON d.para_id = w.para_id '
            'WHERE w.review = 1 AND r.para_id IS NULL AND d.para_id IS NULL' + where +
            ' ORDER BY w.priority DESC, w.slug, u.seq', params).fetchall()
        # 超长段落不送模型重审：xhigh 对一段三千字要生成上万 token、持续十几分钟，
        # 隧道会在中途断开（实测 URLError），重试也只是再断一次。它们占段数 3.4%
        # 却占字数 32%，留给规则判据和逐段处理更划算。
        #
        # Over-long paragraphs are held back. At xhigh, a 3,000-character entry
        # generates tens of thousands of tokens over many minutes and the tunnel
        # drops mid-stream; retrying just drops again. They are 3.4% of entries
        # but 32% of characters, and are better served by the rule-based
        # criteria and hand reading.
        if self.args.max_chars:
            rows = [r for r in rows if r[2] <= self.args.max_chars]
        if self.args.max_items:
            rows = rows[:self.args.max_items]
        already = {r[0] for r in self.db.execute(
            "SELECT para_ids FROM review_batches WHERE status='pending'")}
        if already:
            return self.db.execute(
                "SELECT COUNT(*) FROM review_batches WHERE status='pending'").fetchone()[0]

        rb = self.db.execute('SELECT COALESCE(MAX(rb_id),0) FROM review_batches').fetchone()[0]
        cur, n, slug, out = [], 0, None, []
        for pid, s, nraw in sorted(rows, key=lambda r: (r[1],)):
            if cur and (s != slug or n + nraw > self.args.batch_chars
                        or len(cur) >= self.args.batch_items):
                rb += 1
                out.append((rb, slug, json.dumps(cur), n))
                cur, n = [], 0
            slug = s
            cur.append(pid)
            n += nraw
        if cur:
            rb += 1
            out.append((rb, slug, json.dumps(cur), n))
        self.db.executemany(
            'INSERT INTO review_batches(rb_id,slug,para_ids,n_chars) VALUES (?,?,?,?)', out)
        self.db.commit()
        return len(out)

    def load(self, rb_ids):
        """
        中文：把重审批次要用的原文与两版标点一次性读进内存。

        Preload every batch's paragraphs so worker threads never touch SQLite.

        Args:
            rb_ids (list[int]): Review batch ids about to run.

        Returns:
            dict[int, list[tuple]]: rb_id -> list of
                (para_id, raw, v1_flat, v2_flat, template).
        """
        want = set(rb_ids)
        plans = {r[0]: json.loads(r[1]) for r in self.db.execute(
            'SELECT rb_id, para_ids FROM review_batches') if r[0] in want}
        need = {p for ids in plans.values() for p in ids}
        data = {}
        for pid, tpl, raw, v2 in self.db.execute(
                'SELECT u.para_id, u.template, u.raw, w.v2 FROM units u '
                'JOIN units_v2 w ON w.para_id = u.para_id'):
            if pid in need:
                data[pid] = (raw, C.strip_punct(tpl).strip(), tpl, v2)
        self.v2_of = {pid: data[pid][3] for pid in data}
        out = {}
        for rb, ids in plans.items():
            items = []
            for pid in ids:
                if pid not in data:
                    continue
                raw, _, tpl, v2 = data[pid]
                v1_flat = ''.join(c for c in tpl if c not in C.WS)
                v2_flat = ''.join(c for c in v2 if c not in C.WS)
                items.append((pid, raw, v1_flat, v2_flat, tpl))
            out[rb] = items
        return out

    def call(self, items, max_tokens):
        """
        中文：发一次思考模式请求并解析裁定结果。

        Issue one thinking-mode request for a review batch.

        Args:
            items (list[tuple]): Batch entries from ``load``.
            max_tokens (int): Generation cap covering reasoning plus answer.

        Returns:
            tuple[dict[int, dict], dict]: parsed per-index results and usage.

        Raises:
            RuntimeError: Propagated from ``stream_chat``.
        """
        payload = {
            'model': self.model,
            'messages': [
                {'role': 'system', 'content': SYSTEM_PROMPT},
                {'role': 'user', 'content': build_prompt([(a, b, c, d) for a, b, c, d, _ in items])},
            ],
            'temperature': self.args.temperature,
            'top_p': 0.9,
            'max_tokens': max_tokens,
            'chat_template_kwargs': {'enable_thinking': True,
                                     'reasoning_effort': self.args.effort},
        }
        text, _lps, usage = stream_chat(self.base, self.key, payload, self.args.timeout)
        return parse_reply(text, len(items)), usage

    def work(self, rb_id):
        """
        中文：处理一个重审批次，失败的段单独重审。

        Adjudicate one review batch, falling back to one-at-a-time requests for
        entries the batch reply missed or mangled.

        Args:
            rb_id (int): Review batch id.

        Returns:
            tuple[int, list, dict, str | None]: batch id, rows for ``review``,
                usage totals, and an error string when the batch failed outright.
        """
        items = self.cache.get(rb_id, [])
        if not items:
            return rb_id, [], {}, 'empty'
        budget = min(self.args.max_tokens,
                     max(2048, int(sum(len(i[1]) for i in items) * 2.6) + self.args.think_budget))
        got, usage, last_err = {}, {}, None
        for attempt in range(self.args.retries):
            if self.stop.is_set():
                return rb_id, [], {}, 'stopped'
            try:
                got, usage = self.call(items, budget)
                last_err = None
                break
            except RuntimeError as e:
                last_err = str(e)
                time.sleep(min(20, 2.0 * (attempt + 1) ** 2))
        if last_err:
            return rb_id, [], {}, last_err

        rows, redo = [], []
        for i, (pid, raw, v1f, v2f, tpl) in enumerate(items, 1):
            r = got.get(i)
            if not r or not r.get('text'):
                redo.append((i, pid, raw, v1f, v2f, tpl))
                continue
            rows.append(self.finish(pid, raw, tpl, r))

        for _, pid, raw, v1f, v2f, tpl in redo:
            single = [(pid, raw, v1f, v2f, tpl)]
            done = None
            for attempt in range(self.args.retries):
                try:
                    g2, u2 = self.call(single, min(self.args.max_tokens,
                                                   max(2048, int(len(raw) * 2.8) + self.args.think_budget)))
                except RuntimeError:
                    time.sleep(1.5 * (attempt + 1))
                    continue
                for k in ('prompt_tokens', 'completion_tokens'):
                    usage[k] = usage.get(k, 0) + u2.get(k, 0)
                r = g2.get(1)
                if r and r.get('text'):
                    done = self.finish(pid, raw, tpl, r)
                    break
            if done:
                rows.append(done)
            else:
                # Review could not be obtained: keep the v2 reading and mark the
                # paragraph low-confidence so it lands in the leftover list.
                v2_woven = self.v2_of.get(pid, '')
                rows.append((pid, '', v2_woven, 'v2', 'low', 0.0, '[]',
                             'review unavailable', 'failed'))
        return rb_id, rows, usage, None

    def finish(self, pid, raw, tpl, r):
        """
        中文：把模型裁定的文本投影回原字序并编织回模板。

        Turn one adjudication into a storable row: project the model's text onto
        the raw characters so nothing can drift, then weave it back onto the
        template to restore original whitespace.

        Args:
            pid (int): Paragraph id.
            raw (str): Bare source characters.
            tpl (str): Stored paragraph template (v1 punctuation + whitespace).
            r (dict): Parsed adjudication with ``chose``, ``conf``, ``text``.

        Returns:
            tuple: Row matching the ``review`` table layout.
        """
        text, ratio, _dropped = C.project(raw, C.normalise_output(r['text']))
        try:
            woven = C.weave(tpl, text)
        except ValueError:
            woven = text
        flags = C.quality_flags(woven)
        conf = r['conf']
        # A low alignment ratio or a surviving hard defect overrides the model's
        # own optimism: those paragraphs must stay in the leftover pile.
        if ratio < self.args.ratio_gate or flags:
            conf = 'low'
        return (pid, '', woven, r['chose'], conf, ratio,
                json.dumps(flags, ensure_ascii=False), '', 'ok')

    def run(self):
        """
        中文：主循环——并发跑完全部重审批次并播报进度。

        Run the review pass to completion over all pending review batches.

        Args:
            None.

        Returns:
            None.
        """
        npend = self.plan()
        todo = [r[0] for r in self.db.execute(
            "SELECT rb_id FROM review_batches WHERE status='pending' ORDER BY rb_id")]
        if self.args.limit:
            todo = todo[:self.args.limit]
        self.note(f'review batches pending={len(todo)} (planned {npend}) '
                  f'effort={self.args.effort} concurrency={self.args.concurrency}')
        if not todo:
            return
        self.cache = self.load(todo)
        slug_of = {r[0]: r[1] for r in self.db.execute('SELECT rb_id, slug FROM review_batches')}

        work_q = queue.Queue()
        for b in todo:
            work_q.put(b)
        out_q = queue.Queue()

        def worker():
            while not self.stop.is_set():
                try:
                    b = work_q.get_nowait()
                except queue.Empty:
                    return
                try:
                    out_q.put(self.work(b))
                except Exception as e:
                    out_q.put((b, [], {}, 'worker/' + type(e).__name__))

        threads = [threading.Thread(target=worker, daemon=True)
                   for _ in range(self.args.concurrency)]
        for t in threads:
            t.start()

        remaining, last = len(todo), time.time()
        while remaining > 0:
            try:
                rb_id, rows, usage, err = out_q.get(timeout=5)
            except queue.Empty:
                if all(not t.is_alive() for t in threads):
                    break
                continue
            remaining -= 1
            if err:
                self.errors[err] = self.errors.get(err, 0) + 1
                self.db.execute(
                    "UPDATE review_batches SET status=CASE WHEN attempts>=? THEN 'failed' "
                    "ELSE 'pending' END, attempts=attempts+1 WHERE rb_id=?",
                    (self.args.sweeps, rb_id))
            else:
                slug = slug_of.get(rb_id, '')
                self.db.executemany(
                    'INSERT OR REPLACE INTO review VALUES (?,?,?,?,?,?,?,?,?)',
                    [(r[0], slug) + r[2:] for r in rows])
                self.db.execute(
                    "UPDATE review_batches SET status='done', attempts=attempts+1, ptok=?, ctok=? "
                    'WHERE rb_id=?',
                    (usage.get('prompt_tokens', 0), usage.get('completion_tokens', 0), rb_id))
                self.done += 1
                self.ptok += usage.get('prompt_tokens', 0)
                self.ctok += usage.get('completion_tokens', 0)
                for r in rows:
                    self.conf_counts[r[4]] = self.conf_counts.get(r[4], 0) + 1
            self.db.commit()

            now = time.time()
            if now - last >= self.args.report_every:
                last = now
                el = now - self.t0
                rate = self.done / el * 3600 if el else 0
                eta = (len(todo) - self.done) / rate if rate else 0
                self.note(f'{self.done}/{len(todo)} batches | {rate:.0f} batch/h | '
                          f'eta {eta:.1f} h | tok {self.ptok}/{self.ctok} | '
                          f'conf {self.conf_counts} | err {self.errors}')
            if self.stop.is_set():
                break

        left = self.db.execute(
            "SELECT COUNT(*) FROM review_batches WHERE status='pending'").fetchone()[0]
        if left and not self.stop.is_set() and self.sweep < self.args.sweeps:
            self.sweep += 1
            self.note(f'sweep {self.sweep}: {left} review batches still pending')
            self.run()
            return
        self.note(f'DONE review batches={self.done} tok={self.ptok}/{self.ctok} '
                  f'conf={self.conf_counts} errors={self.errors} '
                  f'elapsed={(time.time()-self.t0)/3600:.2f} h')


def main():
    """
    中文：命令行入口。

    Entry point: parse options, install a clean-stop signal handler, run.

    Args:
        None (arguments are read from sys.argv).

    Returns:
        None.
    """
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', required=True)
    ap.add_argument('--books', default='')
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--concurrency', type=int, default=10)
    ap.add_argument('--effort', default='xhigh', choices=['low', 'medium', 'xhigh'])
    ap.add_argument('--batch-chars', type=int, default=300)
    ap.add_argument('--batch-items', type=int, default=4)
    ap.add_argument('--max-chars', type=int, default=300,
                    help='skip paragraphs longer than this (0 = no limit)')
    ap.add_argument('--max-items', type=int, default=0,
                    help='cap total paragraphs adjudicated this run (0 = no cap)')
    ap.add_argument('--think-budget', type=int, default=6000)
    ap.add_argument('--max-tokens', type=int, default=20480)
    ap.add_argument('--temperature', type=float, default=0.3)
    ap.add_argument('--ratio-gate', type=float, default=0.99)
    ap.add_argument('--timeout', type=float, default=900)
    ap.add_argument('--retries', type=int, default=3)
    ap.add_argument('--sweeps', type=int, default=6)
    ap.add_argument('--report-every', type=float, default=60)
    ap.add_argument('--log', default='')
    args = ap.parse_args()

    rv = Reviewer(args)

    def handler(signum, frame):
        rv.note('interrupt received, finishing in-flight batches...')
        rv.stop.set()

    signal.signal(signal.SIGINT, handler)
    signal.signal(signal.SIGTERM, handler)
    rv.run()


if __name__ == '__main__':
    main()
