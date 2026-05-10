@echo off
chcp 65001 >nul
title Mingshi Reader AI v1.1
cd /d "%~dp0"

echo.
echo ========================================
echo   Mingshi Reader AI v1.1
echo   Starting...
echo ========================================
echo.

:: ============================================
:: 1. Detect Node.js
:: ============================================
set "NODE_EXE="
set "NPM_CMD="

:: Try system Node.js first
where node >nul 2>&1
if %errorlevel% equ 0 (
    set "NODE_EXE=node"
    set "NPM_CMD=npm"
    echo [OK] Using system Node.js
    goto :check_runtime
)

:: Try bundled Node.js runtime
if exist "%~dp0runtime\win\node.exe" (
    set "NODE_EXE=%~dp0runtime\win\node.exe"
    set "NPM_CMD=%~dp0runtime\win\npm.cmd"
    set "PATH=%~dp0runtime\win;%PATH%"
    echo [OK] Using bundled Node.js runtime
    goto :check_runtime
)

:: No Node.js found, try to download
echo [!] Node.js not detected, downloading portable version...
call :download_node
if errorlevel 1 (
    echo [ERROR] Node.js download failed
    echo Please install Node.js manually: https://nodejs.org/
    pause
    exit /b 1
)

:check_runtime
:: Verify Node.js works
"%NODE_EXE%" --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js cannot run
    pause
    exit /b 1
)

echo.

:: ============================================
:: 2. Install backend dependencies
:: ============================================
:: Detect cross-platform binary mismatch: pre-installed node_modules
:: ships with macOS .node binary; on Windows, wipe and reinstall.
set "BSQL_NODE=backend\node_modules\better-sqlite3\build\Release\better_sqlite3.node"
if exist "%BSQL_NODE%" (
    "%NODE_EXE%" -e "const b=require('fs').readFileSync(process.argv[1]).slice(0,2);process.exit(b[0]===0x4d&&b[1]===0x5a?0:1);" "%BSQL_NODE%" >nul 2>&1
    if errorlevel 1 (
        echo [Setup] Pre-installed binary is non-Windows, rebuilding for this platform...
        rmdir /s /q "backend\node_modules"
    )
)

if not exist "backend\node_modules" (
    echo [1/3] Installing backend dependencies...
    "%NPM_CMD%" --prefix backend install --omit=dev 2>&1
    if errorlevel 1 (
        echo [ERROR] Backend dependencies installation failed
        pause
        exit /b 1
    )
    echo [OK] Backend dependencies installed
) else (
    echo [1/3] Backend dependencies already exist, skipping
)
echo.

:: ============================================
:: 3. Install frontend dependencies and build
:: ============================================
if not exist "frontend\node_modules" (
    echo [2/3] Installing frontend dependencies...
    "%NPM_CMD%" --prefix frontend install 2>&1
    if errorlevel 1 (
        echo [ERROR] Frontend dependencies installation failed
        pause
        exit /b 1
    )
    echo [OK] Frontend dependencies installed
)

if not exist "frontend\dist" (
    echo [2/3] Building frontend...
    "%NPM_CMD%" --prefix frontend run build 2>&1
    if errorlevel 1 (
        echo [WARNING] Frontend build failed, will use existing version
    ) else (
        echo [OK] Frontend built successfully
    )
) else (
    echo [2/3] Frontend already built, skipping
)
echo.

:: ============================================
:: 4. Create .env config file
:: ============================================
if not exist "backend\.env" (
    echo [3/3] Creating default config file...
    copy "backend\.env.example" "backend\.env" >nul
    echo [OK] Config file created
    echo [TIP] Edit backend/.env to set your AI API key
) else (
    echo [3/3] Config file already exists
)
echo.

:: ============================================
:: 5. Start server
:: ============================================
:: 引导：把 git 里固化的 timeline 分类导入空 DB（首次启动用）
if exist "backend\src\data\timeline-events.json" (
    "%NODE_EXE%" backend\scripts\load-timeline-from-json.mjs >nul 2>&1
)

echo ========================================
echo   Starting server...
echo   Access: http://127.0.0.1:3100
echo ========================================
echo.

start "" "http://127.0.0.1:3100"
"%NODE_EXE%" backend\src\server.js

exit /b 0

:: ============================================
:: Function: Download Node.js portable version
:: ============================================
:download_node
setlocal

set "NODE_VERSION=v20.18.0"
set "RUNTIME_DIR=%~dp0runtime\win"

:: Create directory
if not exist "%RUNTIME_DIR%" mkdir "%RUNTIME_DIR%"

:: Try to download from multiple sources
echo Downloading Node.js %NODE_VERSION%...

:: Use PowerShell to download
powershell -Command "^
    $urls = @(^
        'https://nodejs.org/dist/%NODE_VERSION%/node-%NODE_VERSION%-win-x64.zip',^
        'https://npmmirror.com/mirrors/node/%NODE_VERSION%/node-%NODE_VERSION%-win-x64.zip'^
    );^
    $zipFile = '%RUNTIME_DIR%\node.zip';^
    $extractPath = '%RUNTIME_DIR%\temp';^
    ^
    foreach ($url in $urls) {^
        try {^
            Write-Host 'Trying: ' $url;^
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12;^
            Invoke-WebRequest -Uri $url -OutFile $zipFile -UseBasicParsing -TimeoutSec 30;^
            if (Test-Path $zipFile) {^
                Write-Host 'Download successful';^
                Expand-Archive -Path $zipFile -DestinationPath $extractPath -Force;^
                $nodeDir = Get-ChildItem -Path $extractPath -Directory | Select-Object -First 1;^
                if ($nodeDir) {^
                    Copy-Item -Path '$extractPath\*\node.exe' -Destination '%RUNTIME_DIR%\' -Force;^
                    Copy-Item -Path '$extractPath\*\npm.cmd' -Destination '%RUNTIME_DIR%\' -Force;^
                    if (Test-Path '%RUNTIME_DIR%\node.exe') {^
                        Write-Host 'Node.js installed successfully';^
                        Remove-Item -Path $zipFile -Force -ErrorAction SilentlyContinue;^
                        Remove-Item -Path $extractPath -Recurse -Force -ErrorAction SilentlyContinue;^
                        exit 0;^
                    }^
                }^
            }^
        } catch {^
            Write-Host 'Download failed: ' $_.Exception.Message;^
        }^
    }^
    exit 1;^
"

endlocal
exit /b 1