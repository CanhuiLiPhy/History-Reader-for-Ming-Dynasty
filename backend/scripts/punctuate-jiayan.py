#!/usr/bin/env python3
"""
本地古文自动标点（jiayan 离线方案）— 对应 punctuate-batch.mjs 的免费替代。

用法：
  python punctuate-jiayan.py \
      --input <file_or_dir> \
      --output <out_dir> \
      --lm <path-to-jiayan.klm> \
      --cut-model <path-to-cut_model> \
      --punc-model <path-to-punc_model> \
      [--chunk 5000]
      [--limit N]                  # 仅处理前 N 个文件
      [--dry-run]

输入文件可为 GB18030 / UTF-8（自动检测）；输出统一 UTF-8。
进度写 <out_dir>/.state.json，支持 Ctrl+C 续跑。
"""
import argparse
import json
import os
import sys
import time
from pathlib import Path

try:
    import chardet
except ImportError:
    chardet = None


def detect_encoding(buf: bytes) -> str:
    """优先尝试 UTF-8；失败回落 GB18030（明实录原文）。"""
    head = buf[:4096]
    try:
        head.decode("utf-8")
        return "utf-8"
    except UnicodeDecodeError:
        pass
    if chardet:
        result = chardet.detect(head)
        if result and result.get("encoding") and result.get("confidence", 0) > 0.7:
            enc = result["encoding"].lower()
            # chardet 把 GB2312 当作 GB18030 的子集，统一用 gb18030 更宽
            if enc in ("gb2312", "gbk", "gb18030"):
                return "gb18030"
            return enc
    return "gb18030"


def chunk_text(text: str, max_len: int):
    """按 max_len 切片，尽量在换行/空白边界。"""
    out = []
    pos = 0
    while pos < len(text):
        end = min(pos + max_len, len(text))
        if end < len(text):
            for sep in ("\n", "　", " "):
                last = text.rfind(sep, pos + max_len // 2, end)
                if last != -1:
                    end = last + 1
                    break
        out.append(text[pos:end])
        pos = end
    return out


def list_inputs(input_path: Path):
    if input_path.is_file():
        return [input_path]
    return sorted([p for p in input_path.iterdir() if p.is_file() and p.suffix.lower() == ".txt"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--lm", required=True, help="path to jiayan.klm")
    ap.add_argument("--cut-model", required=True, help="path to cut_model")
    ap.add_argument("--punc-model", required=True, help="path to punc_model")
    ap.add_argument("--chunk", type=int, default=5000)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    input_path = Path(args.input)
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    files = list_inputs(input_path)
    if args.limit:
        files = files[: args.limit]

    state_path = output_dir / ".state.json"
    state = {"completed": {}, "total_chars": 0}
    if state_path.exists():
        try:
            state = json.loads(state_path.read_text(encoding="utf-8"))
        except Exception:
            pass

    print(f"input:        {input_path}")
    print(f"output:       {output_dir}")
    print(f"lm:           {args.lm}")
    print(f"cut_model:    {args.cut_model}")
    print(f"punc_model:   {args.punc_model}")
    print(f"chunk:        {args.chunk} chars")
    print(f"files:        {len(files)}")
    print(f"resumed:      {len(state['completed'])} done, {state['total_chars']:,} chars so far")
    print()

    if args.dry_run:
        for f in files:
            buf = f.read_bytes()
            enc = detect_encoding(buf)
            try:
                text = buf.decode(enc)
            except Exception as e:
                print(f"  [skip-decode] {f.name}: {e}")
                continue
            chunks = chunk_text(text, args.chunk)
            print(f"  {f.name}: {len(text):,} chars ({enc}) → {len(chunks)} chunks")
        return

    print("loading jiayan models (≈ 30 s)...")
    t0 = time.time()
    from jiayan import load_lm, CRFPunctuator  # type: ignore
    lm = load_lm(args.lm)
    punctuator = CRFPunctuator(lm, args.cut_model)
    punctuator.load(args.punc_model)
    print(f"loaded in {time.time() - t0:.1f}s")
    print()

    for f in files:
        key = str(f)
        if key in state["completed"]:
            print(f"[skip]  {f.name} — already done")
            continue

        buf = f.read_bytes()
        enc = detect_encoding(buf)
        try:
            text = buf.decode(enc).replace("\r\n", "\n").replace("\r", "\n")
        except Exception as e:
            print(f"[fail]  {f.name}: decode error ({e})")
            continue

        chunks = chunk_text(text, args.chunk)
        print(f"[file]  {f.name}: {len(text):,} chars ({enc}) → {len(chunks)} chunks")

        out_parts = []
        for i, chunk in enumerate(chunks):
            t_chunk = time.time()
            # jiayan punctuator 不喜欢空白/换行，剥掉再喂
            cleaned = chunk.replace("\n", "").replace("　", "").strip()
            if not cleaned:
                continue
            try:
                result = punctuator.punctuate(cleaned)
            except Exception as e:
                print(f"  chunk {i + 1}/{len(chunks)} FAILED: {e}")
                continue
            out_parts.append(result)
            dt = time.time() - t_chunk
            rate = len(cleaned) / dt if dt > 0 else 0
            sys.stdout.write(
                f"\r  chunk {i + 1}/{len(chunks)} ({len(cleaned)} chars, {dt:.1f}s, {rate:.0f} ch/s)   "
            )
            sys.stdout.flush()
        print()

        out_path = output_dir / f"{f.stem}.txt"
        out_path.write_text("\n".join(out_parts), encoding="utf-8")
        state["completed"][key] = {
            "out": str(out_path),
            "chars": len(text),
            "chunks": len(chunks),
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
        }
        state["total_chars"] += len(text)
        state_path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[ok]    -> {out_path.name}  (cumulative: {state['total_chars']:,} chars)")

    print()
    print(f"=== DONE === processed {len(state['completed'])} files, {state['total_chars']:,} chars total")


if __name__ == "__main__":
    main()
