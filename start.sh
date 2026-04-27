#!/bin/bash
set -e
cd "$(dirname "$0")"

echo ""
echo "  明史阅读器 v0.2"
echo "  正在启动..."
echo ""

if ! command -v node &> /dev/null; then
    echo "未找到 Node.js，请先安装: https://nodejs.org/ (v18+)"
    exit 1
fi

if [ ! -d "backend/node_modules" ]; then
    echo "首次运行，安装后端依赖..."
    npm --prefix backend install --omit=dev 2>&1 | tail -3
fi

if [ ! -d "frontend/node_modules" ]; then
    echo "首次运行，安装前端依赖..."
    npm --prefix frontend install 2>&1 | tail -3
fi

if [ ! -d "frontend/dist" ]; then
    echo "构建前端界面..."
    npm --prefix frontend run build 2>&1 | tail -3
fi

if [ ! -f "backend/.env" ]; then
    echo ""
    echo "未找到 backend/.env 配置文件！"
    echo "请复制 backend/.env.example 为 backend/.env 并填入配置。"
    exit 1
fi

echo "启动服务器..."
cd backend
node src/server.js &
PID=$!
cd ..
sleep 2
echo ""
echo "  已启动: http://127.0.0.1:3100"
echo "  按 Ctrl+C 停止"
echo ""
command -v open &>/dev/null && open "http://127.0.0.1:3100"
trap "kill $PID 2>/dev/null; exit 0" INT TERM
wait $PID
