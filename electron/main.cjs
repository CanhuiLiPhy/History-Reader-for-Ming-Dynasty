/**
 * Electron entry point for 明史阅读器.
 *
 * Forks the Express backend as a child process at app launch, polls
 * /api/health until ready, then loads it into a BrowserWindow. Kills the
 * backend when the app quits so there are no orphan node processes.
 *
 * Path resolution differs between dev and packaged:
 *  - dev (electron from repo root):  __dirname = /repo/electron
 *  - packaged (.app):                __dirname = .../Resources/app/electron
 *                                    extraResources at process.resourcesPath
 */
const { app, BrowserWindow, shell, dialog, Menu } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const http = require("node:http");

const PORT = Number(process.env.MINGSHI_READER_PORT || 3100);
const READY_URL = `http://127.0.0.1:${PORT}/api/health`;
const APP_URL = process.env.MINGSHI_READER_URL || `http://127.0.0.1:${PORT}`;

let backendProcess = null;
let mainWindow = null;
let splashWindow = null;

// Resolve project layout. In dev: app root is one level up from /electron.
// When packaged via electron-builder with asar, backend code is inside
// app.asar but native modules + .cache + books are in extraResources.
function resolvePaths() {
  const isPackaged = app.isPackaged;
  const appRoot = isPackaged ? path.dirname(app.getAppPath()) : path.resolve(__dirname, "..");
  const resources = isPackaged ? process.resourcesPath : appRoot;

  // In packaged builds the entire backend tree is unpacked to app.asar.unpacked
  // so child processes can spawn from real disk paths (asar isn't visible to
  // subprocesses spawned with execve).
  const unpackedRoot = isPackaged
    ? path.join(resources, "app.asar.unpacked")
    : appRoot;

  const backendEntry = path.join(unpackedRoot, "backend", "src", "server.js");
  const frontendDist = path.join(unpackedRoot, "frontend", "dist");

  // Writable data lives in extraResources (always outside asar).
  const dataRoot = isPackaged ? path.join(resources, "backend-data") : path.join(appRoot, "backend");
  const mingshiEpub = path.join(dataRoot, "mingshi.epub");

  return { isPackaged, appRoot, resources, unpackedRoot, backendEntry, frontendDist, dataRoot, mingshiEpub };
}

function checkBackendReady() {
  return new Promise((resolve, reject) => {
    const req = http.get(READY_URL, { timeout: 1500 }, (res) => {
      if (res.statusCode === 200) {
        resolve(true);
      } else {
        res.resume();
        reject(new Error(`status ${res.statusCode}`));
      }
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}

async function waitForBackend(maxMs = 60000) {
  const startedAt = Date.now();
  // First request often errors (server not listening yet); poll every 200ms.
  while (Date.now() - startedAt < maxMs) {
    try {
      await checkBackendReady();
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`后端未在 ${maxMs}ms 内启动`);
}

function findBundledNode(paths) {
  // Prefer the bundled portable Node binary when available — its ABI matches
  // the prebuilt better-sqlite3.node we ship. Falls back to system `node` only
  // for dev when neither bundle is present.
  const candidates = [];
  if (process.platform === "darwin") {
    candidates.push(path.join(paths.resources, "runtime", "darwin-arm64", "bin", "node"));
    candidates.push(path.join(paths.appRoot, "runtime", "darwin-arm64", "bin", "node"));
  } else if (process.platform === "win32") {
    candidates.push(path.join(paths.resources, "runtime", "win", "node.exe"));
    candidates.push(path.join(paths.appRoot, "runtime", "win", "node.exe"));
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function spawnBackend() {
  const paths = resolvePaths();
  if (!fs.existsSync(paths.backendEntry)) {
    dialog.showErrorBox("启动失败", `找不到后端入口：${paths.backendEntry}`);
    app.exit(1);
    return null;
  }

  const env = {
    ...process.env,
    PORT: String(PORT),
    BOOK_PATH: paths.mingshiEpub,
    MINGSHI_DATA_ROOT: paths.isPackaged ? paths.dataRoot : "",
    MINGSHI_FRONTEND_DIST: paths.isPackaged ? paths.frontendDist : "",
  };

  // Use bundled Node if found (its ABI matches our prebuilt native modules).
  // Fall back to system `node` for dev convenience, and finally to electron-as-node.
  const bundled = findBundledNode(paths);
  let nodeBin;
  let extraEnv = {};
  if (bundled) {
    nodeBin = bundled;
  } else {
    // Try system node from PATH
    nodeBin = "node";
    // If it's not on PATH we'll fall through to electron-as-node by setting flag
    extraEnv = { ELECTRON_RUN_AS_NODE: "1" };
    nodeBin = process.execPath; // safest fallback in packaged mode
  }

  console.log(`[mingshi] spawning backend with ${nodeBin}`);
  const child = spawn(nodeBin, [paths.backendEntry], {
    cwd: path.dirname(paths.backendEntry),
    env: { ...env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => process.stdout.write(`[backend] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[backend!] ${chunk}`));
  child.on("exit", (code, signal) => {
    console.log(`[backend] exited code=${code} signal=${signal}`);
    backendProcess = null;
    if (code !== 0 && code !== null && !app.isQuitting) {
      dialog.showErrorBox("后端意外退出", `code=${code} signal=${signal || "-"}`);
    }
  });

  return child;
}

function createSplash() {
  splashWindow = new BrowserWindow({
    width: 460,
    height: 220,
    frame: false,
    backgroundColor: "#efe2c7",
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    title: "明史阅读器",
  });
  // Inline splash content via data URL so we don't need an extra HTML file.
  const splashHtml = `
    <!doctype html><html><head><meta charset="utf-8" />
    <style>
      html, body { margin: 0; padding: 0; height: 100%; background: #efe2c7;
        font-family: -apple-system, "PingFang SC", "Microsoft YaHei", serif;
        color: #5b3a1a; display: flex; flex-direction: column;
        align-items: center; justify-content: center; user-select: none; }
      h1 { font-size: 1.4rem; margin: 0 0 0.6rem; letter-spacing: 0.05em; }
      .sub { font-size: 0.85rem; color: #8a6a3e; margin-bottom: 1rem; }
      .bar { width: 240px; height: 3px; background: rgba(91,58,26,0.15);
        border-radius: 999px; overflow: hidden; }
      .fill { width: 35%; height: 100%; background: #8a5519;
        animation: slide 1.4s ease-in-out infinite; border-radius: 999px; }
      @keyframes slide { 0% { transform: translateX(-100%);} 50% { transform: translateX(180%);} 100% { transform: translateX(-100%);} }
    </style></head>
    <body>
      <h1>明史阅读器</h1>
      <div class="sub">正在启动后端服务…</div>
      <div class="bar"><div class="fill"></div></div>
    </body></html>
  `;
  splashWindow.loadURL("data:text/html;charset=UTF-8," + encodeURIComponent(splashHtml));
  splashWindow.on("closed", () => { splashWindow = null; });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1200,
    minHeight: 760,
    backgroundColor: "#efe2c7",
    title: "明史阅读器",
    show: false, // show after ready-to-show to avoid white flash
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
    },
  });

  mainWindow.loadURL(APP_URL);

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => { mainWindow = null; });
}

async function start() {
  createSplash();

  backendProcess = spawnBackend();
  if (!backendProcess) return;

  try {
    await waitForBackend();
  } catch (err) {
    dialog.showErrorBox("后端启动超时", String(err?.message || err));
    app.exit(1);
    return;
  }

  createMainWindow();
}

// macOS application menu (bare minimum so Cmd+Q etc. work)
function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on("before-quit", () => { app.isQuitting = true; });

app.whenReady().then(() => {
  buildMenu();
  void start();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && !backendProcess) {
      void start();
    } else if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", () => {
  if (backendProcess && !backendProcess.killed) {
    backendProcess.kill("SIGTERM");
  }
});
