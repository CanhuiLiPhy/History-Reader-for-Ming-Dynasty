#!/usr/bin/env python3
"""
中文：主跑——用 Qwen3.8-27B 非思考模式给全部批次加标点，投影回原字序后落盘，可断点续跑。

Main (non-thinking) punctuation pass.

Pulls pending batches out of the working database, sends each as one chat
completion to the self-hosted Qwen3.8-27B endpoint with thinking disabled,
projects the returned punctuation back onto the untouched raw characters, and
records per-chunk results together with token-level confidence. Every batch is
committed as soon as it lands, so the run resumes cleanly after an interrupt.

Usage:
    set -a; . ~/.keys/qwen3_8_27b.env; set +a
    python3 run_base.py --db donotpack/repunct-v2/repunct.sqlite \
        --books donglin-liezhuan,shu-yuan-zaji --concurrency 28
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
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C

SYSTEM_PROMPT = """你是古籍点校专家，为下列古文加现代中文标点。

严格保字规则（违反即作废）：
1. 一个汉字都不许增、删、改。看似 OCR 错字、缺字、重复字，一律按原样保留。
2. 原文中的 ○ △ □ ■ ● ＜＞ 〈〉 【】 （） [] - 及生僻异体字，原样照抄，不要改写、不要在其前后强行断句。
3. 你只能在字与字之间插入标点。输出去掉标点后必须与输入逐字一致。

标点规范：
- 只用这些标点：，。：；？！、「」『』《》·
- 对话和引文用「」，引文中再引用用『』。禁止使用 “” ‘’ 和半角标点。
- 书名、篇名用《》，书名与篇名之间用·，如《明史·河渠志》。
- 并列的人名、官名、地名、物名之间用、。
- 每段必须以 。？！」』 之一结尾。
- 句意为重：宁可句子长一些，也不要把人名、官职、地名、书名切断。
- 不要连用两个标点（「。」「？」这类引号闭合除外）。

输出格式：逐行输出，每行以 #编号 开头并与输入编号一一对应，顺序不变，数量不变。不要输出任何解释、标题或空行。"""

SEG_RE = re.compile(r'#(\d+)[ \t　]*')


def load_env():
    """
    中文：读取自建端点的三个环境变量。

    Read the endpoint configuration from the environment.

    Args:
        None.

    Returns:
        tuple[str, str, str]: (base_url, api_key, model_id).

    Raises:
        SystemExit: If any of BASE_URL / API_KEY / MODEL is unset.
    """
    base, key, model = os.environ.get('BASE_URL'), os.environ.get('API_KEY'), os.environ.get('MODEL')
    if not (base and key and model):
        sys.exit('BASE_URL / API_KEY / MODEL must be set '
                 '(set -a; . ~/.keys/qwen3_8_27b.env; set +a)')
    return base.rstrip('/'), key, model


def stream_chat(base, key, payload, timeout):
    """
    中文：发一次流式请求，收集正文、逐 token 对数概率和用量。

    Issue one streaming chat completion and accumulate the response.

    Streaming is mandatory here: the endpoint sits behind a Cloudflare tunnel
    whose origin read timeout is ~100 s, and a non-streamed long generation
    trips it with HTTP 524.

    Args:
        base (str): Endpoint base URL, no trailing slash.
        key (str): Bearer token.
        payload (dict): OpenAI-compatible request body; ``stream`` is forced on.
        timeout (float): Socket timeout in seconds.

    Returns:
        tuple[str, list[tuple[str, float]], dict]:
            - concatenated assistant content;
            - list of (token_text, logprob) pairs in generation order, empty when
              logprobs were not requested;
            - usage dict (may be empty if the server omitted it).

    Raises:
        RuntimeError: On HTTP errors or transport failures, with a short reason.
    """
    payload = dict(payload, stream=True, stream_options={'include_usage': True})
    req = urllib.request.Request(
        base + '/chat/completions', data=json.dumps(payload).encode('utf-8'),
        headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f'HTTP {e.code}') from None
    except Exception as e:
        raise RuntimeError(type(e).__name__) from None

    content, lps, usage = [], [], {}
    try:
        for line in resp:
            line = line.decode('utf-8', 'replace').strip()
            if not line.startswith('data:'):
                continue
            body = line[5:].strip()
            if body == '[DONE]':
                break
            obj = json.loads(body)
            if obj.get('usage'):
                usage = obj['usage']
            for ch in obj.get('choices', []):
                piece = ch.get('delta', {}).get('content')
                if piece:
                    content.append(piece)
                lp = ch.get('logprobs')
                if lp and lp.get('content'):
                    for t in lp['content']:
                        lps.append((t.get('token', ''), t.get('logprob', 0.0)))
    except Exception as e:
        raise RuntimeError('stream/' + type(e).__name__) from None
    return ''.join(content), lps, usage


def parse_segments(text, expected):
    """
    中文：把 `#编号 文本` 形式的回复拆成编号到文本的映射。

    Split a ``#N <text>`` formatted reply into a segment map.

    Args:
        text (str): Full assistant content.
        expected (int): Number of segments that were sent.

    Returns:
        dict[int, str]: 1-based segment index -> punctuated text, containing only
            indices in ``[1, expected]`` that the model actually emitted.
    """
    out = {}
    hits = list(SEG_RE.finditer(text))
    for i, m in enumerate(hits):
        num = int(m.group(1))
        end = hits[i + 1].start() if i + 1 < len(hits) else len(text)
        if 1 <= num <= expected:
            out[num] = text[m.end():end].strip()
    return out


def needs_redo(raw, ratio, args):
    """
    中文：判断一个切块是否值得单独重跑。

    Decide whether a chunk's projection is poor enough to be worth a lone retry.

    A ratio threshold alone is the wrong gate: on a 700-character chunk, 0.995
    means three unmatched characters, and passages dense in IDS variant glyphs
    (＜⿰⻊锍-釒＞ and friends, ~17k occurrences in the Veritable Records) never
    clear it no matter how many times they are resent. Gate on the absolute
    number of unmatched characters as well, so retries go to chunks that are
    actually broken rather than to ones that are merely exotic.

    Args:
        raw (str): Bare source characters of the chunk.
        ratio (float): Projection alignment ratio in [0, 1].
        args (argparse.Namespace): Holds ``min_ratio`` and ``max_unmatched``.

    Returns:
        bool: True when the chunk should be retried on its own.
    """
    denom = sum(1 for c in raw if not C.is_pua(c))
    unmatched = round((1.0 - ratio) * denom)
    return ratio < args.min_ratio and unmatched >= args.max_unmatched


def punct_confidence(lps):
    """
    中文：从 token 对数概率里提取标点决策的置信度。

    Derive a confidence signal from token log-probabilities, looking only at the
    tokens that carry punctuation — those are the decisions this task makes.

    Args:
        lps (list[tuple[str, float]]): (token_text, logprob) in generation order.

    Returns:
        tuple[float | None, float | None, int]:
            - minimum logprob over punctuation-bearing tokens (the weakest single
              decision in the segment);
            - mean logprob over the same tokens;
            - how many such tokens were seen.

    Math:
        minlp = min_{t : t contains punctuation} log P(t | prefix)
        meanlp = (1/|T|) * Σ_{t ∈ T} log P(t | prefix)
    """
    vals = [lp for tok, lp in lps if any(c in C.ALLOWED_PUNCT for c in tok)]
    if not vals:
        return None, None, 0
    return min(vals), sum(vals) / len(vals), len(vals)


def split_logprobs_by_segment(text, lps, nseg):
    """
    中文：按字符区间把整批的 token 序列切给各段。

    Partition a batch's token stream into per-segment slices by character offset.

    The streamed tokens concatenate to exactly ``text``, so each token owns a
    half-open character range. Locating the ``#N`` markers in ``text`` gives each
    segment its own range, and tokens are handed to the segment their range falls
    inside.

    Args:
        text (str): Full assistant content for the batch.
        lps (list[tuple[str, float]]): (token_text, logprob) in generation order.
        nseg (int): Number of segments in the batch.

    Returns:
        dict[int, list[tuple[str, float]]]: segment index -> its token slice.
            Empty when the marker scan found nothing usable.
    """
    hits = list(SEG_RE.finditer(text))
    spans = []
    for i, m in enumerate(hits):
        num = int(m.group(1))
        end = hits[i + 1].start() if i + 1 < len(hits) else len(text)
        if 1 <= num <= nseg:
            spans.append((m.end(), end, num))
    if not spans:
        return {}
    out = {num: [] for _, _, num in spans}
    pos, si = 0, 0
    for tok, lp in lps:
        start = pos
        pos += len(tok)
        while si < len(spans) and start >= spans[si][1]:
            si += 1
        if si >= len(spans):
            break
        s0, s1, num = spans[si]
        if start >= s0:
            out[num].append((tok, lp))
    return out


class Runner:
    """
    中文：批次调度器——取批、发请求、投影落盘、失败重试，支持中断续跑。

    Orchestrates the punctuation pass: hands pending batches to a worker pool,
    writes every result from a single writer thread, and retries batches whose
    segments failed verification.
    """

    def __init__(self, args):
        """
        中文：初始化调度器，打开工作库并准备统计量。

        Args:
            args (argparse.Namespace): Parsed command-line options.

        Returns:
            None.
        """
        self.args = args
        self.base, self.key, self.model = load_env()
        self.db = sqlite3.connect(args.db, timeout=60)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.t0 = time.time()
        self.done_batches = 0
        self.done_chars = 0
        self.ptok = 0
        self.ctok = 0
        self.errors = {}
        self.log = open(args.log, 'a', encoding='utf-8') if args.log else None
        self.chunk_cache = {}
        self.batch_chars = {}
        self.sweep = 0

    def note(self, msg):
        """
        中文：同时写终端和日志文件。

        Emit one progress line to stdout and, when configured, to the log file.

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

    def pending(self):
        """
        中文：列出待跑批次（可按书目过滤、可限量）。

        List the batches still to run.

        Args:
            None.

        Returns:
            list[int]: Batch ids with status ``pending``, in ascending order,
                filtered by ``--books`` and truncated by ``--limit``.
        """
        sql = "SELECT batch_id FROM batches WHERE status='pending'"
        params = []
        if self.args.books:
            slugs = [s.strip() for s in self.args.books.split(',') if s.strip()]
            sql += ' AND slug IN (%s)' % ','.join('?' * len(slugs))
            params += slugs
        sql += ' ORDER BY batch_id'
        if self.args.limit:
            sql += f' LIMIT {int(self.args.limit)}'
        return [r[0] for r in self.db.execute(sql, params).fetchall()]

    def preload(self, batch_ids):
        """
        中文：在主线程一次性把批次内容读进内存，避免工作线程碰 SQLite 连接。

        Load every batch's chunks into memory up front.

        SQLite connections are bound to the thread that created them, so worker
        threads must never touch ``self.db``; they read from this map instead.

        Args:
            batch_ids (list[int]): Batches about to be processed.

        Returns:
            dict[int, list[tuple[str, str]]]: batch id -> (chunk_id, raw) pairs
                in send order.
        """
        wanted = set(batch_ids)
        out = {}
        for bid, cid, raw in self.db.execute(
                'SELECT batch_id, chunk_id, raw FROM chunks WHERE batch_id IS NOT NULL '
                'ORDER BY batch_id, para_id, idx'):
            if bid in wanted:
                out.setdefault(bid, []).append((cid, raw))
        return out

    def call(self, segments, max_tokens, want_logprobs):
        """
        中文：把若干段打包成一次请求并返回解析后的结果。

        Send one request carrying ``segments`` and return the parsed reply.

        Args:
            segments (list[str]): Raw texts, one per segment.
            max_tokens (int): Generation cap.
            want_logprobs (bool): Whether to request token log-probabilities.

        Returns:
            tuple[dict[int, str], list, dict, str]: segment map, token logprobs,
                usage, and the full assistant text (needed to align logprobs).

        Raises:
            RuntimeError: Propagated from ``stream_chat``.
        """
        user = '\n'.join(f'#{i} {s}' for i, s in enumerate(segments, 1))
        payload = {
            'model': self.model,
            'messages': [{'role': 'system', 'content': SYSTEM_PROMPT},
                         {'role': 'user', 'content': user}],
            'temperature': self.args.temperature,
            'top_p': 0.9,
            'max_tokens': max_tokens,
            'chat_template_kwargs': {'enable_thinking': False},
        }
        if want_logprobs:
            payload['logprobs'] = True
        text, lps, usage = stream_chat(self.base, self.key, payload, self.args.timeout)
        return parse_segments(text, len(segments)), lps, usage, text

    def work(self, batch_id):
        """
        中文：处理一个批次——整批跑，失败的段再单独重跑。

        Process one batch end to end.

        First the whole batch is sent in a single request. Segments that come
        back missing, or whose projection alignment falls below ``--min-ratio``,
        are retried one at a time — an isolated segment gets the model's full
        attention and almost always recovers.

        Args:
            batch_id (int): Batch to process.

        Returns:
            tuple[int, list, dict, str | None]: batch id, list of result rows
                ready for ``chunk_results``, usage totals, and an error string
                when the whole batch failed.
        """
        chunks = self.chunk_cache.get(batch_id, [])
        if not chunks:
            return batch_id, [], {}, 'empty'
        raws = [r for _, r in chunks]
        budget = max(1024, int(sum(len(r) for r in raws) * 2.2) + 256)
        last_err = None
        segs = lps = usage = text = None
        # The endpoint sits behind a Cloudflare quick tunnel that intermittently
        # drops connections under load; a transport error is worth retrying in
        # place rather than bouncing the whole batch back to the queue.
        for attempt in range(self.args.retries):
            if self.stop.is_set():
                return batch_id, [], {}, 'stopped'
            try:
                segs, lps, usage, text = self.call(raws, min(budget, 6144), self.args.logprobs)
                last_err = None
                break
            except RuntimeError as e:
                last_err = str(e)
                # Back off far enough to ride out a server restart: reloading a
                # 27B model with TP=2 and recapturing CUDA graphs takes minutes,
                # and re-queueing every in-flight batch through the sweep loop
                # during that window would burn the retry budget for nothing.
                time.sleep(min(90, 3.0 * (attempt + 1) ** 2))
        if last_err:
            return batch_id, [], {}, last_err

        per_seg_lp = split_logprobs_by_segment(text, lps, len(raws)) if lps else {}
        rows, redo = [], []
        for i, (cid, raw) in enumerate(chunks, 1):
            out = segs.get(i)
            if not out:
                redo.append((i, cid, raw))
                continue
            text, ratio, dropped = C.project(raw, C.normalise_output(out))
            if ratio < self.args.min_ratio:
                redo.append((i, cid, raw))
                continue
            mn, mean, n = punct_confidence(per_seg_lp.get(i, []))
            rows.append((cid, text, ratio, dropped, mn, mean, n, 'batch'))

        for _, cid, raw in redo:
            got = None
            for attempt in range(self.args.retries):
                try:
                    s2, lp2, u2, _t2 = self.call([raw], max(1024, int(len(raw) * 2.4) + 256),
                                                 self.args.logprobs)
                except RuntimeError:
                    time.sleep(1.5 * (attempt + 1))
                    continue
                usage['completion_tokens'] = usage.get('completion_tokens', 0) + u2.get('completion_tokens', 0)
                usage['prompt_tokens'] = usage.get('prompt_tokens', 0) + u2.get('prompt_tokens', 0)
                out = s2.get(1)
                if not out:
                    continue
                text, ratio, dropped = C.project(raw, C.normalise_output(out))
                mn, mean, n = punct_confidence(lp2)
                got = (cid, text, ratio, dropped, mn, mean, n, 'single')
                if ratio >= self.args.min_ratio:
                    break
            if got:
                rows.append(got)
            else:
                # Keep the raw text unpunctuated rather than losing the segment;
                # the review pass will pick it up via ratio = 0.
                rows.append((cid, raw, 0.0, 0, None, None, 0, 'failed'))
        return batch_id, rows, usage, None

    def run(self):
        """
        中文：主循环——并发跑完所有待处理批次并定期播报进度。

        Run the pass to completion over all pending batches.

        Args:
            None.

        Returns:
            None. Results are committed to the working database as they arrive.
        """
        todo = self.pending()
        total_chars = self.db.execute(
            'SELECT COALESCE(SUM(n_chars),0) FROM batches WHERE batch_id IN (%s)'
            % ','.join('?' * len(todo)), todo).fetchone()[0] if todo else 0
        self.note(f'pending batches={len(todo)} rawchars={total_chars} '
                  f'concurrency={self.args.concurrency} model={self.model}')
        if not todo:
            return
        self.chunk_cache = self.preload(todo)
        self.batch_chars = {b: n for b, n in self.db.execute(
            'SELECT batch_id, n_chars FROM batches')}

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
                except Exception as e:  # never let a worker die silently
                    out_q.put((b, [], {}, 'worker/' + type(e).__name__))

        threads = [threading.Thread(target=worker, daemon=True)
                   for _ in range(self.args.concurrency)]
        for t in threads:
            t.start()

        remaining = len(todo)
        last_report = time.time()
        while remaining > 0:
            try:
                batch_id, rows, usage, err = out_q.get(timeout=5)
            except queue.Empty:
                if all(not t.is_alive() for t in threads):
                    break
                continue
            remaining -= 1
            if err:
                self.errors[err] = self.errors.get(err, 0) + 1
                self.db.execute(
                    "UPDATE batches SET status=CASE WHEN attempts>=? THEN 'failed' ELSE 'pending' END,"
                    ' attempts=attempts+1 WHERE batch_id=?',
                    (self.args.sweeps, batch_id))
                self.db.commit()
            else:
                self.db.executemany(
                    'INSERT OR REPLACE INTO chunk_results VALUES (?,?,?,?,?,?,?,?)', rows)
                nch = self.batch_chars.get(batch_id, 0)
                self.db.execute(
                    "UPDATE batches SET status='done', attempts=attempts+1, ptok=?, ctok=?"
                    ' WHERE batch_id=?',
                    (usage.get('prompt_tokens', 0), usage.get('completion_tokens', 0), batch_id))
                self.db.commit()
                self.done_batches += 1
                self.done_chars += nch
                self.ptok += usage.get('prompt_tokens', 0)
                self.ctok += usage.get('completion_tokens', 0)

            now = time.time()
            if now - last_report >= self.args.report_every:
                last_report = now
                el = now - self.t0
                rate = self.done_chars / el if el else 0
                left = (total_chars - self.done_chars) / rate if rate else 0
                self.note(f'{self.done_batches}/{len(todo)} batches | '
                          f'{self.done_chars}/{total_chars} chars | {rate:.0f} ch/s | '
                          f'eta {left/3600:.1f} h | tok {self.ptok}/{self.ctok} | '
                          f'err {self.errors}')
            if self.stop.is_set():
                break

        left = self.pending()
        if left and not self.stop.is_set() and self.sweep < self.args.sweeps:
            self.sweep += 1
            self.note(f'sweep {self.sweep}: {len(left)} batches still pending, retrying')
            self.run()
            return
        self.note(f'DONE batches={self.done_batches} chars={self.done_chars} '
                  f'ptok={self.ptok} ctok={self.ctok} errors={self.errors} '
                  f'elapsed={(time.time()-self.t0)/3600:.2f} h')


def main():
    """
    中文：命令行入口。

    Entry point: parse options, install a SIGINT handler that requests a clean
    stop, and run the pass.

    Args:
        None (arguments are read from sys.argv).

    Returns:
        None.
    """
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', required=True)
    ap.add_argument('--books', default='')
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--concurrency', type=int, default=28)
    ap.add_argument('--timeout', type=float, default=420)
    ap.add_argument('--retries', type=int, default=6)
    ap.add_argument('--temperature', type=float, default=0.1)
    ap.add_argument('--min-ratio', type=float, default=0.97)
    ap.add_argument('--max-unmatched', type=int, default=3,
                    help='retry a chunk only when this many characters failed to align')
    ap.add_argument('--quality-retries', type=int, default=2,
                    help='lone retries for a poorly aligned chunk (separate from\n'
                         'transport retries, which --retries governs)')
    ap.add_argument('--logprobs', action='store_true', default=True)
    ap.add_argument('--no-logprobs', dest='logprobs', action='store_false')
    ap.add_argument('--report-every', type=float, default=60)
    ap.add_argument('--sweeps', type=int, default=6,
                    help='extra passes over batches left pending by transport errors')
    ap.add_argument('--log', default='')
    args = ap.parse_args()

    runner = Runner(args)

    def handler(signum, frame):
        runner.note('interrupt received, finishing in-flight batches...')
        runner.stop.set()

    signal.signal(signal.SIGINT, handler)
    signal.signal(signal.SIGTERM, handler)
    runner.run()


if __name__ == '__main__':
    main()
