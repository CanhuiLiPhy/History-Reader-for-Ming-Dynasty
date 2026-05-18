#!/usr/bin/env python3
"""
Embedding sidecar for backend hybrid retrieval. Reads JSON requests from
stdin (one per line), writes JSON responses to stdout. Long-lived so the
model only loads once per backend session.

Protocol:
  request:  {"id": "<request-id>", "text": "<query string>"}
  response: {"id": "<request-id>", "embedding": [..512 floats..]}
            or {"id": "<request-id>", "error": "<message>"}

The first stdout line is {"event": "ready"} once the model is loaded.
"""
import sys, json, os
import numpy as np

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

try:
    from fastembed import TextEmbedding
except Exception as exc:
    print(json.dumps({"event": "error", "stage": "import", "error": str(exc)}), flush=True)
    sys.exit(1)

try:
    model = TextEmbedding(
        model_name="BAAI/bge-small-zh-v1.5",
        cache_dir=os.environ.get("FASTEMBED_CACHE_DIR") or None,
        threads=int(os.environ.get("FASTEMBED_THREADS", "4")),
    )
    # Warm up so first real query is fast
    next(iter(model.embed(["init"])))
except Exception as exc:
    print(json.dumps({"event": "error", "stage": "model_load", "error": str(exc)}), flush=True)
    sys.exit(1)

print(json.dumps({"event": "ready"}), flush=True)

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
        rid = req.get("id", "")
        text = req.get("text", "")
        if not text:
            print(json.dumps({"id": rid, "error": "empty text"}), flush=True)
            continue
        emb = next(iter(model.embed([text])))
        print(json.dumps({"id": rid, "embedding": emb.astype(np.float32).tolist()}), flush=True)
    except Exception as exc:
        try:
            obj = json.loads(line)
            rid = obj.get("id", "")
        except Exception:
            rid = ""
        print(json.dumps({"id": rid, "error": str(exc)}), flush=True)
