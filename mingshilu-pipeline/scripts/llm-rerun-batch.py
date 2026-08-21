#!/usr/bin/env python3
"""
llm-rerun-batch.py — 把 still-failed 里的失败段批量喂 LLM 重跑。

策略：
  - 主模型 (默认) qwen3.6-plus-2026-04-02
  - 配额用尽自动 fallback 到 qwen3.5-plus-2026-04-20
  - 每条段构造 Rule 4 强保留 prompt（STRICT_NO_EDIT_INSTRUCTION + few-shot）
  - 每跑完一条立刻写 checkpoint 支持 Ctrl+C 续跑
  - 输出 LLM 结果 jsonl，后续喂回 rescue-failures.py 二轮清洗

待跑数据范围：
  1. partial_failed 的失败 chunk（通过 chunks_map + kaggle_fail 提取）
  2. gave_up 短段 (<1500 字)
  3. gave_up 长段 (≥1500 字) 自动切到 ≤500 字一块

用法：
  python3 llm-rerun-batch.py prepare \\
    --datasets p5,retry,p6 \\
    --out /Users/lch/Downloads/0610/1/llm-rerun-input.jsonl

  python3 llm-rerun-batch.py run \\
    --input /Users/lch/Downloads/0610/1/llm-rerun-input.jsonl \\
    --output /Users/lch/Downloads/0610/1/llm-rerun-output.jsonl
"""
import argparse, json, os, sys, re, time, signal
from pathlib import Path
from collections import defaultdict

PUNCT_RE = re.compile(r'[，。：；？！「」『』、《》()（）\[\]【】〈〉,.:;?!"\'\s·‧・•‥…—–]')

# ============================================================
# 路径配置
# ============================================================
DATASETS = {
    'p3': {
        'still': '/Users/lch/Downloads/0610/1/merged-p3/mingshilu-p3-still-failed.jsonl',
        'chunks_map': '/Users/lch/Downloads/mingshilu-p3/mingshilu-p3-chunks.json',
        'punct': '/Users/lch/Downloads/results-4/mingshilu-p3-prechunked-punctuated.jsonl',
        'fail':  '/Users/lch/Downloads/results-4/mingshilu-p3-prechunked-failures.jsonl',
    },
    'p4': {
        'still': '/Users/lch/Downloads/0610/1/merged-p4/mingshilu-p4-still-failed.jsonl',
        'chunks_map': '/Users/lch/Downloads/mingshilu-p4/mingshilu-p4-chunks.json',
        'punct': '/Users/lch/Downloads/0610/1/p4-colab/mingshilu-p4-prechunked-punctuated.jsonl',
        'fail':  '/Users/lch/Downloads/0610/1/p4-colab/mingshilu-p4-prechunked-failures.jsonl',
    },
    'p5': {
        'still': '/Users/lch/Downloads/0610/1/merged/mingshilu-p5-still-failed.jsonl',
        'chunks_map': '/Users/lch/Downloads/mingshilu-p5/mingshilu-p5-chunks.json',
        'punct': '/Users/lch/Downloads/0610/1/p5-colab/mingshilu-p5-prechunked-punctuated.jsonl',
        'fail':  '/Users/lch/Downloads/0610/1/p5-colab/mingshilu-p5-prechunked-failures.jsonl',
    },
    'retry': {
        'still': '/Users/lch/Downloads/0610/1/merged-retry/mingshilu-retry-still-failed.jsonl',
        'chunks_map': '/Users/lch/Downloads/mingshilu-retry/mingshilu-retry-chunks.json',
        'punct': '/Users/lch/Downloads/results-3/mingshilu-retry-input-punctuated.jsonl',
        'fail':  '/Users/lch/Downloads/results-3/mingshilu-retry-input-failures.jsonl',
    },
    'p6': {
        'still': '/Users/lch/Downloads/0610/1/merged-p6/mingshilu-p6-still-failed.jsonl',
        'chunks_map': '/Users/lch/Downloads/mingshilu-p6/mingshilu-p6-chunks.json',
        'punct': '/Users/lch/Downloads/0610/1/p6-colab/mingshilu-p6-prechunked-punctuated.jsonl',
        'fail':  '/Users/lch/Downloads/0610/1/p6-colab/mingshilu-p6-prechunked-failures.jsonl',
    },
    'p7': {
        'still': '/Users/lch/Downloads/0610/1/merged-p7/mingshilu-p7-still-failed.jsonl',
        'chunks_map': '/Users/lch/Downloads/mingshilu-p7/mingshilu-p7-chunks.json',
        'punct': '/Users/lch/Downloads/0610/1/p7-colab/mingshilu-p7-prechunked-punctuated.jsonl',
        'fail':  '/Users/lch/Downloads/0610/1/p7-colab/mingshilu-p7-prechunked-failures.jsonl',
    },
    'p8': {
        'still': '/Users/lch/Downloads/0610/1/merged-p8/mingshilu-p8-still-failed.jsonl',
        'chunks_map': '/Users/lch/Downloads/mingshilu-p8/mingshilu-p8-chunks.json',
        'punct': '/Users/lch/Downloads/0610/1/p8-colab/mingshilu-p8-prechunked-punctuated.jsonl',
        'fail':  '/Users/lch/Downloads/0610/1/p8-colab/mingshilu-p8-prechunked-failures.jsonl',
    },
}

# ============================================================
# Rule 4 prompt
# ============================================================
STRICT_NO_EDIT = """**严格保字规则（违反则整段任务作废）**：
1. 绝对不要添加、删除、修改任何一个汉字。
2. 即使原文有看似是 OCR 错字的字（例如「垦」可能本应是「恳」），也不要修改——保留原字。
3. 即使原文有看似缺漏的字（例如缺一个连接字），也不要补字。
4. 即使原文有看似重复的字串（例如同一句话连写两次），也不要去重——按原样保留。
5. 你只能在原文的汉字之间插入标点符号（，。：；？！「」、《》等）。
6. 你的输出去掉所有标点后必须与原文一字一致——不多、不少、不变。"""

FEWSHOT_PROMPT = """下面是给古文加中文标点的任务。

""" + STRICT_NO_EDIT + """

规则补充：
- 段落必须以句末符号结尾（。 ？ ！ 」 』 ）之一）。
- 不要连续两个标点（除了 。」 ？」 ！」 这类引号闭合）。
- 「」必须成对出现，《》必须成对出现。
- 句意为重，宁可让句子稍长一点，也不要把名字、官职、书名硬切成多段。

无标点：自古帝王之有天下其言行政治必有史臣纪载以垂鉴戒此古今之盛典朝廷之先务也
有标点：自古帝王之有天下，其言行政治，必有史臣纪载，以垂鉴戒，此古今之盛典，朝廷之先务也。

无标点：奉天门常朝御座后内官持一小扇金黄绢以裹之尝闻一老将军云非扇也其名卓影辟邪永乐间外国所进
有标点：奉天门常朝，御座后内官持一小扇，金黄绢以裹之。尝闻一老将军云：「非扇也，其名卓影辟邪，永乐间外国所进。」

无标点：吾乡布衣沈先生名璵字孟温洪武中其家坐累谪戍云南之金齒宣徳初归省坟墓乡人以其经学该愽留教子弟
有标点：吾乡布衣沈先生，名璵，字孟温。洪武中，其家坐累，谪戍云南之金齒。宣徳初，归省坟墓，乡人以其经学该愽，留教子弟。

无标点：{raw}
有标点："""

# ============================================================
# 长段再切
# ============================================================
def resplit_long(raw, max_chunks=(500, 350, 250, 180)):
    END_PARTICLES = set('也矣焉哉')
    START_WORDS = set('又初后然按凡一')

    def find_split_positions(text):
        positions = set()
        for m in re.finditer(r'○', text):
            if m.start() > 50: positions.add(m.start())
        for i in range(1, len(text)-1):
            if text[i-1] in END_PARTICLES and text[i] in START_WORDS:
                positions.add(i)
        return sorted(positions)

    chunks = [raw]
    for limit in max_chunks:
        new_chunks = []
        for c in chunks:
            if len(c) <= limit:
                new_chunks.append(c); continue
            splits = find_split_positions(c)
            valid = [p for p in splits if 50 < p < limit and (len(c)-p) > 50]
            if not valid:
                new_chunks.append(c); continue
            split_at = max(valid)
            new_chunks.append(c[:split_at])
            new_chunks.append(c[split_at:])
        chunks = new_chunks
        if all(len(c) <= max_chunks[-1] for c in chunks): break
    return chunks


# ============================================================
# 阶段 1: 准备 batch
# ============================================================
def cmd_prepare(args):
    items = []
    datasets = args.datasets.split(',')

    for ds_name in datasets:
        cfg = DATASETS[ds_name]
        still = [json.loads(l) for l in open(cfg['still'], 'r', encoding='utf-8') if l.strip()]
        chunks_map = json.load(open(cfg['chunks_map'])) if cfg['chunks_map'] else {}
        kpunct = {str(r['id']): r for r in (json.loads(l) for l in open(cfg['punct'], 'r', encoding='utf-8') if l.strip())}
        kfail  = {str(r['id']): r for r in (json.loads(l) for l in open(cfg['fail'],  'r', encoding='utf-8') if l.strip())}

        orig_to_chunks = defaultdict(list)
        for nid, meta in chunks_map.items():
            orig_to_chunks[meta['orig_id']].append((meta['chunk_idx'], nid))

        for r in still:
            status = r.get('status','?')
            oid = r.get('orig_id') or r.get('id')
            if oid is None: continue
            if status == 'partial_failed':
                try: oid_int = int(oid)
                except: oid_int = oid
                pairs = sorted(orig_to_chunks.get(oid_int, []))
                for idx, nid in pairs:
                    nid_s = str(nid)
                    if nid_s in kfail and nid_s not in kpunct:
                        items.append({
                            'item_id': f'{ds_name}::{nid_s}',
                            'dataset': ds_name, 'kind': 'chunk',
                            'orig_id': oid, 'chunk_new_id': nid_s, 'chunk_idx': idx,
                            'raw': kfail[nid_s]['raw'],
                            'previous_la': kfail[nid_s].get('last_attempt',''),
                        })
            elif status == 'gave_up':
                raw = r.get('raw','')
                if not raw: continue
                if len(raw) >= 1500:
                    sub = resplit_long(raw)
                    for i, c in enumerate(sub):
                        items.append({
                            'item_id': f'{ds_name}::{oid}_resplit_{i}of{len(sub)}',
                            'dataset': ds_name, 'kind': 'long_resplit',
                            'orig_id': oid, 'resplit_idx': i, 'resplit_total': len(sub),
                            'raw': c,
                            'previous_la': r.get('last_attempt','')[:200],
                        })
                else:
                    items.append({
                        'item_id': f'{ds_name}::{oid}',
                        'dataset': ds_name, 'kind': 'short',
                        'orig_id': oid,
                        'raw': raw,
                        'previous_la': r.get('last_attempt',''),
                    })

    with open(args.out, 'w', encoding='utf-8') as f:
        for it in items: f.write(json.dumps(it, ensure_ascii=False) + '\n')

    print(f'写入 {len(items)} 条 → {args.out}')
    from collections import Counter
    print(f'按 dataset: {Counter(it["dataset"] for it in items)}')
    print(f'按 kind:    {Counter(it["kind"] for it in items)}')
    total_chars = sum(len(it['raw']) for it in items)
    print(f'总字数: {total_chars}, 平均 {total_chars/len(items):.0f} 字/条')


# ============================================================
# 二/三轮: 把上一轮 fail_strict 整理成下一轮 batch，长段再切
# ============================================================
def cmd_prepare_rerun(args):
    """读上一轮 still-failed jsonl，输出下一轮 batch 输入。
    长段 (raw > max_chars) 用 resplit_long 切成 ≤180 字一片，
    新 item_id = {原 item_id}_re{i}of{N}，便于 integrate 时按 base 分组拼回。"""
    items_in = [json.loads(l) for l in open(args.input_path, 'r', encoding='utf-8') if l.strip()]
    out_items = []
    n_passthrough = 0; n_split = 0; n_pieces_total = 0
    for it in items_in:
        raw = it.get('raw','')
        if not raw: continue
        if len(raw) <= args.max_chars:
            # 原 item_id 保留（基于 dataset+chunk_new_id 或 dataset+orig_id）
            out = {**it}
            out.pop('output', None); out.pop('strict_ok', None)
            out.pop('err', None); out.pop('model', None)
            out.pop('len_raw', None); out.pop('len_out', None)
            out_items.append(out)
            n_passthrough += 1
        else:
            pieces = resplit_long(raw)
            if len(pieces) == 1:
                # 切不开 → 原样跑（max-preview 长 context 顶得住）
                out = {**it}
                out.pop('output', None); out.pop('strict_ok', None)
                out.pop('err', None); out.pop('model', None)
                out_items.append(out); n_passthrough += 1
                continue
            base_id = it['item_id']
            for i, p in enumerate(pieces):
                out_items.append({
                    'item_id': f'{base_id}_re{i}of{len(pieces)}',
                    'dataset': it['dataset'],
                    'kind': it['kind'] + '_resplit',
                    'orig_id': it.get('orig_id'),
                    'chunk_new_id': it.get('chunk_new_id'),
                    'resplit_idx': i, 'resplit_total': len(pieces),
                    'resplit_parent_item': base_id,
                    'raw': p,
                })
            n_split += 1; n_pieces_total += len(pieces)
    with open(args.out, 'w', encoding='utf-8') as f:
        for it in out_items: f.write(json.dumps(it, ensure_ascii=False) + '\n')
    print(f'写入 {len(out_items)} 条 → {args.out}')
    print(f'  原样: {n_passthrough}')
    print(f'  被切: {n_split} 条 → {n_pieces_total} 片')


# ============================================================
# 阶段 2: 跑 LLM
# ============================================================
QUOTA_KEYWORDS = (
    'InsufficientBalance', 'insufficient_quota', 'RateLimit', 'Throttling',
    'quota exceeded', 'free allocated quota', 'token quota', 'free tier',
    'arrearage', '余额不足', '配额', '限流', 'rate_limit',
    'has been exhausted',
)

def is_quota_error(s):
    s = str(s).lower()
    return any(k.lower() in s for k in QUOTA_KEYWORDS)

def call_llm(prompt, api_key, base_url, model, max_tokens, timeout=60, attempts=3,
             retry_sleep=10, enable_thinking=False):
    """qwen 系列默认开 reasoning（每条 20s+），enable_thinking=False 禁用 → 1s 一条。"""
    import requests
    last_err = None
    body = {
        'model': model,
        'messages': [{'role':'user','content': prompt}],
        'temperature': 0,
        'max_tokens': max_tokens,
        'enable_thinking': enable_thinking,
        'extra_body': {'enable_thinking': enable_thinking},
    }
    for attempt in range(attempts):
        try:
            r = requests.post(
                f'{base_url}/chat/completions',
                headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'},
                json=body,
                timeout=timeout,
            )
            if r.status_code >= 400:
                return None, f'HTTP {r.status_code}: {r.text[:300]}'
            return r.json()['choices'][0]['message']['content'].strip(), None
        except Exception as e:
            last_err = e
            if attempt < attempts - 1:
                time.sleep(retry_sleep)
    return None, str(last_err)


def cmd_run(args):
    api_key = os.environ.get('AI_API_KEY')
    if not api_key:
        env = Path('/Users/lch/mingshi-reader-ai/backend/.env')
        if env.exists():
            for line in env.read_text().splitlines():
                if line.startswith('AI_API_KEY='):
                    api_key = line.split('=', 1)[1].strip(); break
    assert api_key, 'AI_API_KEY 找不到'

    items = [json.loads(l) for l in open(args.input, 'r', encoding='utf-8') if l.strip()]
    print(f'载入 {len(items)} 条, model={args.model}, thinking={args.enable_thinking}, attempts={args.attempts}, timeout={args.timeout}')

    # 读 checkpoint（已完成的 item_id）
    done = {}
    ckpt_path = args.output + '.ckpt'
    if Path(ckpt_path).exists():
        for l in open(ckpt_path):
            r = json.loads(l)
            done[r['item_id']] = r
        print(f'resume: 已完成 {len(done)} 条')

    out_f = open(args.output, 'a', encoding='utf-8')
    ck_f  = open(ckpt_path,    'a', encoding='utf-8')

    current_model = args.model
    fallback = args.fallback_model
    api_calls = 0; n_pass = 0; n_fail_strict = 0; n_err = 0

    t0 = time.time()
    for i, it in enumerate(items):
        if it['item_id'] in done: continue
        raw = it['raw']
        prompt = FEWSHOT_PROMPT.format(raw=raw)
        max_tok = max(256, min(3000, int(len(raw) * 1.8 + 100)))

        text, err = call_llm(prompt, api_key, args.base_url, current_model, max_tok,
                             timeout=args.timeout, attempts=args.attempts,
                             enable_thinking=args.enable_thinking)
        api_calls += 1

        if text is None:
            if err and is_quota_error(err) and current_model != fallback:
                print(f'  ⚠️  {current_model} 配额用尽，切换到 {fallback}')
                current_model = fallback
                text, err = call_llm(prompt, api_key, args.base_url, current_model, max_tok,
                                     timeout=args.timeout, attempts=args.attempts,
                                     enable_thinking=args.enable_thinking)
                api_calls += 1

        if text is None:
            n_err += 1
            rec = {**it, 'output': None, 'model': current_model, 'err': err}
        else:
            # 移除可能的 "无标点：xxx\n有标点：" 干扰
            text = text.strip()
            if '有标点：' in text:
                text = text.rsplit('有标点：', 1)[-1].strip()
            # 截断到第一个 "无标点："（防止模型自我延伸）
            if '\n无标点：' in text:
                text = text.split('\n无标点：', 1)[0].strip()

            # strict 校验
            sr_clean = PUNCT_RE.sub('', raw)
            sp_clean = PUNCT_RE.sub('', text)
            strict_ok = sr_clean == sp_clean
            if strict_ok: n_pass += 1
            else: n_fail_strict += 1

            rec = {**it, 'output': text, 'model': current_model,
                   'strict_ok': strict_ok,
                   'len_raw': len(sr_clean), 'len_out': len(sp_clean)}

        ck_f.write(json.dumps(rec, ensure_ascii=False) + '\n'); ck_f.flush()
        out_f.write(json.dumps(rec, ensure_ascii=False) + '\n'); out_f.flush()
        done[it['item_id']] = rec

        if (i+1) % 5 == 0 or i == len(items)-1:
            elapsed = time.time() - t0
            rate = api_calls / max(elapsed, 1)
            eta = (len(items) - i - 1) / max(rate, 0.01) / 60
            print(f'  [{i+1}/{len(items)}] OK={n_pass} fail_strict={n_fail_strict} err={n_err} '
                  f'rate={rate:.2f}/s ETA={eta:.1f}m model={current_model}')

    print(f'\nDONE. API={api_calls}, strict_pass={n_pass}, fail_strict={n_fail_strict}, err={n_err}')
    print(f'写入: {args.output}')


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)

    ap_p = sub.add_parser('prepare')
    ap_p.add_argument('--datasets', default='p5,retry,p6')
    ap_p.add_argument('--out', required=True)

    ap_r = sub.add_parser('run')
    ap_r.add_argument('--input', required=True)
    ap_r.add_argument('--output', required=True)
    ap_r.add_argument('--base-url', default='https://dashscope.aliyuncs.com/compatible-mode/v1')
    ap_r.add_argument('--model', default='qwen3.6-plus-2026-04-02')
    ap_r.add_argument('--fallback-model', default='qwen3.5-plus-2026-04-20')
    ap_r.add_argument('--enable-thinking', action='store_true', help='开启思考模式（慢但更准）')
    ap_r.add_argument('--attempts', type=int, default=3, help='单条网络重试次数')
    ap_r.add_argument('--timeout', type=int, default=60, help='单次 HTTP 超时秒')

    ap_pr = sub.add_parser('prepare-rerun',
        help='把上一轮 fail_strict 的整理成下一轮 batch 输入，长段自动再切')
    ap_pr.add_argument('--in', dest='input_path', required=True,
                       help='上一轮 llm_rerun_still_failed jsonl')
    ap_pr.add_argument('--out', required=True)
    ap_pr.add_argument('--max-chars', type=int, default=500,
                       help='超过这个字数就用 resplit_long 切；默认 500')

    args = ap.parse_args()
    if args.cmd == 'prepare': cmd_prepare(args)
    elif args.cmd == 'run': cmd_run(args)
    elif args.cmd == 'prepare-rerun': cmd_prepare_rerun(args)


if __name__ == '__main__':
    main()
