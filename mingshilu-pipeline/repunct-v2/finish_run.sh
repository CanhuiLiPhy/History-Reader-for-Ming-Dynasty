#!/usr/bin/env bash
# 中文：等主跑结束，然后依次跑汇总、思考模式重审、导出报告，全程无人值守。
#
# Drive the remaining v2 re-punctuation stages unattended.
#
# The base pass and the review pass must not overlap: they share one vLLM server,
# and running both halves the throughput of each. This script therefore waits for
# the base pass to drain before starting the review.
#
# Usage:
#   set -a; . ~/.keys/qwen3_8_27b.env; set +a
#   nohup bash mingshilu-pipeline/repunct-v2/finish_run.sh > donotpack/repunct-v2/logs/finish.out 2>&1 &

set -u
cd "$(dirname "$0")/../.."

DB=donotpack/repunct-v2/repunct.sqlite
OUT=donotpack/repunct-v2/exports
LOGS=donotpack/repunct-v2/logs
BOOKS=ming-shi-lu,donglin-liezhuan,shu-yuan-zaji
PY=python3
# The vLLM server is capped at 16 concurrent sequences (--max-num-seqs 16).
# Run at two thirds of that so at least five slots are always free: another
# user's request is then scheduled on arrival instead of queueing behind this
# job. Throughput scales down proportionally, which is the intended trade.
BASE_CONC=${BASE_CONC:-10}
REVIEW_CONC=${REVIEW_CONC:-10}

say() { echo "[$(date '+%F %T')] $*"; }

# macOS suspends this process the moment the machine sleeps, and the run then
# looks like a throughput collapse rather than a pause. Hold a power assertion
# for as long as this script lives. Note the assertion cannot defeat clamshell
# sleep on battery — the machine must stay plugged in, or the lid must stay open.
if command -v caffeinate >/dev/null 2>&1; then
  caffeinate -dimsu -w $$ >/dev/null 2>&1 &
  say "caffeinate attached to pid $$"
fi

# The driver owns the base pass outright rather than polling for someone else's
# process: a pgrep on the script name also matches any shell whose command line
# mentions it, which silently wedges the wait loop.
say "running the base pass to completion"
while true; do
  left=$(sqlite3 "$DB" "SELECT COUNT(*) FROM batches WHERE status='pending';" 2>/dev/null || echo 1)
  if [ "$left" = "0" ]; then break; fi
  say "base pass: $left batches left"
  $PY mingshilu-pipeline/repunct-v2/run_base.py --db "$DB" --books "$BOOKS" \
      --concurrency "$BASE_CONC" --report-every 300 --sweeps 30 \
      --log "$LOGS/base-mingshilu.log" >> "$LOGS/base-mingshilu.out" 2>&1
  sleep 30
done
say "base pass complete"

say "assembling paragraph-level results"
$PY mingshilu-pipeline/repunct-v2/assemble.py --db "$DB" --books "$BOOKS" \
    2>&1 | tee -a "$LOGS/assemble.log"

# The thinking-mode review pass is deliberately not run here: adjudication of
# the v1/v2 disagreements is done directly in the working session instead, which
# is both faster and leaves the whole server to the base pass.
say "skipping model review — adjudication happens out of band"

say "building adjudication batches"
$PY mingshilu-pipeline/repunct-v2/make_batches.py --db "$DB" --out "$OUT/adjudicate" \
    2>&1 | tee -a "$LOGS/batches.log"

say "exporting reports"
$PY mingshilu-pipeline/repunct-v2/export_report.py --db "$DB" --out "$OUT" --books "$BOOKS" \
    2>&1 | tee -a "$LOGS/export.log"

say "ALL DONE — see $OUT"
