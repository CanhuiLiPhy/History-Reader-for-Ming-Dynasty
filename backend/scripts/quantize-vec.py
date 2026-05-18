#!/usr/bin/env python3
"""
Convert paragraphs-vec.sqlite (FLOAT[512] BGE vectors) to
paragraphs-vec-int8.sqlite (INT8[512]). Saves ~75% disk space.

BGE outputs are L2-normalized so values lie in [-1, 1]. Linear map
float [-1, 1] → int8 [-127, 127]: int8 = round(float * 127). KNN ranking
with cosine distance is preserved because BGE used unit vectors —
dot product on quantized integers still ranks identically up to small
quantization noise, which doesn't affect top-K retrieval.
"""
import os, sys, io, sqlite3, sqlite_vec, time
import numpy as np

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', line_buffering=True)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.environ.get("VEC_SRC", os.path.join(ROOT, ".cache", "paragraphs-vec.sqlite"))
DST = os.environ.get("VEC_DST", os.path.join(ROOT, ".cache", "paragraphs-vec-int8.sqlite"))

os.environ.setdefault("SQLITE_TMPDIR", os.path.dirname(SRC))

print(f"src: {SRC}")
print(f"dst: {DST}")
if os.path.exists(DST):
    print(f"removing existing {DST}")
    os.remove(DST)

src = sqlite3.connect(f"file:{SRC}?mode=ro", uri=True)
src.execute("PRAGMA temp_store=MEMORY")
src.enable_load_extension(True); sqlite_vec.load(src); src.enable_load_extension(False)

dst = sqlite3.connect(DST)
dst.execute("PRAGMA journal_mode=WAL")
dst.execute("PRAGMA temp_store=MEMORY")
dst.enable_load_extension(True); sqlite_vec.load(dst); dst.enable_load_extension(False)
dst.execute("CREATE VIRTUAL TABLE paragraph_vec USING vec0(embedding INT8[512])")

total = src.execute("SELECT COUNT(rowid) FROM paragraph_vec").fetchone()[0]
print(f"rows to convert: {total}")

BATCH = 2000
last_rowid = 0
done = 0
clipped_max = 0.0
t0 = time.time()

while True:
    rows = src.execute(
        "SELECT rowid, embedding FROM paragraph_vec WHERE rowid > ? ORDER BY rowid LIMIT ?",
        (last_rowid, BATCH),
    ).fetchall()
    if not rows:
        break
    out = []
    for rowid, emb_bytes in rows:
        f = np.frombuffer(emb_bytes, dtype=np.float32)
        ma = float(np.max(np.abs(f)))
        if ma > clipped_max:
            clipped_max = ma
        q = np.clip(np.round(f * 127.0), -127, 127).astype(np.int8)
        out.append((rowid, q.tobytes()))
    dst.executemany("INSERT INTO paragraph_vec(rowid, embedding) VALUES (?, vec_int8(?))", out)
    dst.commit()
    last_rowid = rows[-1][0]
    done += len(rows)
    elapsed = time.time() - t0
    rate = done / max(elapsed, 0.001)
    eta = (total - done) / max(rate, 0.001) / 60
    print(f"  {done}/{total} ({100*done/total:.1f}%) rate={rate:.0f}/s eta={eta:.1f}min max_abs={clipped_max:.4f}")

dst.commit()
final = dst.execute("SELECT COUNT(rowid) FROM paragraph_vec").fetchone()[0]
src_sz = os.path.getsize(SRC) / 1024 / 1024
dst_sz = os.path.getsize(DST) / 1024 / 1024
print(f"\nDone: {final} rows, output={dst_sz:.1f} MB (max_abs={clipped_max:.4f})")
print(f"Source was {src_sz:.1f} MB → {dst_sz/src_sz:.1%} of original")
