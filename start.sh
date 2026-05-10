#!/bin/bash
set -e
cd "$(dirname "$0")"

echo ""
echo "  MingShiReader v1.1  |  Ming History AI Reader"
echo "  Starting..."
echo ""

if ! command -v node &> /dev/null; then
    echo "[ERROR] Node.js not found. Install from: https://nodejs.org/ (v18+)"
    exit 1
fi

if [ ! -d "backend/node_modules" ]; then
    echo "[Setup] Installing backend dependencies..."
    npm --prefix backend install --omit=dev 2>&1 | tail -3
fi

if [ ! -d "frontend/node_modules" ]; then
    echo "[Setup] Installing frontend dependencies..."
    npm --prefix frontend install 2>&1 | tail -3
fi

if [ ! -d "frontend/dist" ]; then
    echo "[Setup] Building frontend..."
    npm --prefix frontend run build 2>&1 | tail -3
fi

if [ ! -f "backend/.env" ]; then
    echo ""
    echo "[ERROR] backend/.env not found."
    echo "Copy backend/.env.example to backend/.env and fill in your API key."
    exit 1
fi

# 引导：把 git 里固化的 timeline 分类导入空 DB（首次启动用）
if [ -f "backend/src/data/timeline-events.json" ] && [ -f "backend/.cache/library.sqlite" ]; then
    node backend/scripts/load-timeline-from-json.mjs >/dev/null 2>&1 || true
fi

echo "[OK] Starting server..."
cd backend
node src/server.js &
PID=$!
cd ..
sleep 2
echo ""
echo "  Running at: http://127.0.0.1:3100"
echo "  Press Ctrl+C to stop"
echo ""
command -v open &>/dev/null && open "http://127.0.0.1:3100"
trap "kill $PID 2>/dev/null; exit 0" INT TERM
wait $PID
