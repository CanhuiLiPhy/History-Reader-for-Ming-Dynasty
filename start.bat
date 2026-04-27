@echo off
chcp 65001 >/dev/null
title 明史阅读器 v0.2
cd /d "%~dp0"

echo.
echo   明史阅读器 v0.2
echo   正在启动...
echo.

where node >/dev/null 2>/dev/null
if %errorlevel% neq 0 (
    echo 未找到 Node.js，请先安装: https://nodejs.org/
    pause
    exit /b 1
)

if not exist "backend\node_modules" (
    echo 首次运行，安装后端依赖...
    cd backend && call npm install --omit=dev && cd ..
)

if not exist "frontend\node_modules" (
    echo 首次运行，安装前端依赖...
    cd frontend && call npm install && cd ..
)

if not exist "frontend\dist" (
    echo 构建前端界面...
    cd frontend && call npm run build && cd ..
)

if not exist "backend\.env" (
    echo.
    echo 未找到 backend\.env 配置文件！
    echo 请复制 backend\.env.example 为 backend\.env 并填入配置。
    pause
    exit /b 1
)

echo 启动服务器...
start "" http://127.0.0.1:3100
cd backend
node src\server.js
