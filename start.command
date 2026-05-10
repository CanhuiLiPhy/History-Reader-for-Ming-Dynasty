#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo "  MingShiReader v1.1  |  Ming History AI Reader"
echo "  Starting..."
echo ""

# Find node: prefer system (v18+), fall back to bundled
RUNTIME="$SCRIPT_DIR/runtime/darwin-arm64"
NODE=""
if command -v node &>/dev/null; then
    MAJOR=$(node -e "process.stdout.write(String(process.version.match(/\d+/)[0]))")
    if [ "$MAJOR" -ge 18 ]; then
        NODE=node
        NPM="npm"
    fi
fi

if [ -z "$NODE" ]; then
    if [ ! -f "$RUNTIME/bin/node" ]; then
        echo "[ERROR] Node.js runtime not found. Contact the distributor."
        read -n 1 -s -r -p "Press any key to exit..."
        exit 1
    fi
    xattr -dr com.apple.quarantine "$RUNTIME" 2>/dev/null || true
    NODE="$RUNTIME/bin/node"
    NPM_CLI="$RUNTIME/lib/node_modules/npm/bin/npm-cli.js"
    NPM="$NODE $NPM_CLI"
fi

# First-run: install backend dependencies
if [ ! -d "backend/node_modules" ]; then
    echo "[Setup] Installing backend dependencies (~30s)..."
    cd "$SCRIPT_DIR/backend"
    $NPM install --omit=dev 2>&1 | tail -3
    cd "$SCRIPT_DIR"
fi

if [ ! -f "backend/.env" ]; then
    cp "backend/.env.example" "backend/.env"
fi

# Bootstrap timeline classifications from packaged JSON
if [ -f "backend/src/data/timeline-events.json" ]; then
    "$NODE" backend/scripts/load-timeline-from-json.mjs >/dev/null 2>&1 || true
fi

# Open browser after 1s
(sleep 1 && open "http://127.0.0.1:3100" 2>/dev/null) &

echo "[OK] Running at: http://127.0.0.1:3100"
echo "[OK] Close this window to stop."
echo ""
cd "$SCRIPT_DIR/backend"
"$NODE" src/server.js
