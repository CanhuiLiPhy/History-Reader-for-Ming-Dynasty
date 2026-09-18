/**
 * 中文：登录、注册、改密码、后台管理四个页面，全部由后端直接吐 HTML。
 *
 * Server-rendered HTML pages for the web deployment: sign-in, registration,
 * self-service password change, and the administration console.
 *
 * These are deliberately plain HTML + inline CSS/JS rather than React screens.
 * The reader frontend is a single 7000-line App.tsx bundle; keeping the auth
 * surface outside it means the account system can ship, and later change,
 * without rebuilding or risking the reader. The pages talk to the same JSON
 * APIs (/api/auth/*, /api/admin/*) that any future React screen would use.
 *
 * Visual language follows the reader's 古籍米黄 theme so the boundary between
 * sign-in and the app does not feel like two different products.
 */
import fs from "node:fs";
import path from "node:path";
import express from "express";
import { FRONTEND_DIST } from "../config/defaults.js";
import { ROLES, ROLE_LABELS } from "./auth-db.js";
import { requireRole } from "./middleware.js";

/**
 * 中文：默认字体文件——登录页预取用。
 *
 * The two faces a fresh account renders with: 明體（汇文明朝）for body text and
 * 正楷（汇文正楷）for the interface. Together they are the bulk of a cold start,
 * so they are the ones worth warming while the user types a password.
 *
 * 顺序有意为之：界面字体排在前面。它决定了登录后第一眼看到的框架文字，而正文
 * 字体要等书打开才用得上，所以先小后大，让首屏更早成形。
 *
 * Order matters: the interface face is listed first. It governs the chrome the
 * reader sees the instant the app paints, whereas the body face is not needed
 * until a book opens — and it is the larger download of the two (22.1 MB vs
 * 8.2 MB), so fetching the smaller one first gets the first screen right sooner.
 *
 * 2026-08-18：界面默认从 楷體（方正永樂大典）改为 正楷（汇文正楷）。前者只有
 * GB2312 档的 9,615 个汉字，实测《明史》全书缺 1,248 字。
 *
 * Changed on 2026-08-18 from 楷體（方正永樂大典）: that face carries only 9,615
 * hanzi and was measured missing 1,248 of the distinct characters in 明史.
 */
const DEFAULT_FONT_FILES = [
  "正楷（汇文正楷）.woff2",
  "明體（汇文明朝）.woff2",
];

let prefetchUrlsCache = null;

/**
 * 中文：列出登录页要提前拉取的资源 —— 只有字体。
 *
 * URLs the sign-in page warms while the visitor types a password.
 *
 * 为什么放在登录页：进阅读器必须登录，所以「浏览器没有缓存」和「用户还没登录」
 * 几乎总是同时成立。输密码的那几秒是纯空等，正好用来把字体拉下来。
 *
 * 为什么**只有字体、不含 JS 包**：预取发生在登录之前，被预取的东西就必须在
 * 未登录时可取。字体是纯字形数据，泄露出去不暴露任何信息；而 JS 包里有内部
 * API 路径、提示词、历史汇率数据表等不该匿名可见的内容，所以它留在登录门禁
 * 后面，登录后再下（约 2.3 MB）。
 *
 * Why here: the reader requires sign-in, so "no cache" and "not signed in yet"
 * almost always coincide, and the seconds spent typing are otherwise dead.
 *
 * Why fonts ONLY, and not the JS bundle: anything prefetched before sign-in
 * must be reachable before sign-in. Fonts are pure glyph data and disclose
 * nothing. The bundle is different — it carries internal API routes, prompt
 * text and the historical exchange-rate tables — so it stays behind the gate
 * and is fetched after login (~2.3 MB) rather than exposed to warm a cache.
 *
 * Returns:
 *   Array<string>: absolute same-origin URLs, possibly empty.
 */
function prefetchUrls() {
  if (prefetchUrlsCache !== null) return prefetchUrlsCache;
  const urls = [];
  for (const file of DEFAULT_FONT_FILES) {
    try {
      if (!fs.existsSync(path.join(FRONTEND_DIST, "fonts", file))) continue;
    } catch {
      continue;
    }
    urls.push(`/fonts/${encodeURIComponent(file)}`);
  }
  prefetchUrlsCache = urls;
  return prefetchUrlsCache;
}

/**
 * 中文：生成登录页的预取脚本。用 fetch 而不是 <link rel="prefetch">。
 *
 * Build the warm-up script for the sign-in page.
 *
 * 必须用 fetch：Safari 至今不支持 `<link rel="prefetch">` —— 实测 WebKit 在
 * 登录页发起的预取请求数为 0，Chromium 为 6。所以原来那套标签对 Safari 用户
 * 完全无效，他们的冷启动一点没被优化到。fetch() 在所有浏览器里都能把响应写进
 * HTTP 缓存。
 *
 * Uses fetch() rather than `<link rel="prefetch">` because Safari still does
 * not implement prefetch: measured against the live site, WebKit issued zero
 * prefetch requests on the sign-in page where Chromium issued six. The link
 * tags therefore did nothing at all for Safari and iOS users. A same-origin
 * fetch() populates the HTTP cache everywhere.
 *
 * Returns:
 *   string: JavaScript source, or "" when there is nothing to warm.
 */
function buildPrefetchScript() {
  const urls = prefetchUrls();
  if (!urls.length) return "";
  return `
  // 预热字体缓存；失败无所谓，登录流程完全不依赖它。
  // Warm the font cache. Best-effort: sign-in never waits on this.
  (function () {
    var urls = ${JSON.stringify(urls)};
    var start = function () {
      urls.forEach(function (u) {
        try { fetch(u, { credentials: 'omit' }).catch(function () {}); } catch (e) {}
      });
    };
    if (document.readyState === 'complete') start();
    else window.addEventListener('load', start);
  })();`;
}

/**
 * 中文：HTML 转义，防止注入。
 *
 * Escape a value for safe interpolation into HTML text or a quoted attribute.
 *
 * Args:
 *   value (any): value to escape; coerced with String().
 *
 * Returns:
 *   string: the escaped text.
 */
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Shared stylesheet for every auth page. / 各页面共用样式。 */
const BASE_CSS = `
  :root {
    --paper: #f6f0e2; --paper-deep: #efe6d2; --ink: #2b2418; --ink-soft: #6b5f4a;
    --line: #d8cbb0; --accent: #7a4a2b; --accent-soft: #a8724b;
    --ok: #3f6b46; --warn: #9a6410; --danger: #97372c;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; background: var(--paper); color: var(--ink);
    font-family: "Songti SC", "STSong", "SimSun", "Noto Serif CJK SC", serif;
    font-size: 16px; line-height: 1.75;
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .wrap { max-width: 420px; margin: 0 auto; padding: 4rem 1.25rem 3rem; }
  .wrap-wide { max-width: 1080px; }
  .brand { text-align: center; margin-bottom: 2rem; }
  .brand h1 { margin: 0; font-size: 1.9rem; font-weight: 600; letter-spacing: 0.18em; }
  .brand p { margin: 0.4rem 0 0; color: var(--ink-soft); font-size: 0.9rem; letter-spacing: 0.05em; }
  .card {
    background: #fffdf7; border: 1px solid var(--line); border-radius: 4px;
    padding: 1.75rem; box-shadow: 0 1px 3px rgba(80,60,30,0.07);
  }
  .card + .card { margin-top: 1.25rem; }
  .card h2 { margin: 0 0 1rem; font-size: 1.15rem; font-weight: 600; }
  .card h2 .sub { font-weight: 400; font-size: 0.85rem; color: var(--ink-soft); margin-left: 0.6rem; }
  label { display: block; margin-bottom: 1rem; font-size: 0.9rem; color: var(--ink-soft); }
  label span { display: block; margin-bottom: 0.35rem; }
  input, textarea, select {
    width: 100%; padding: 0.55rem 0.7rem; font-size: 1rem; font-family: inherit;
    color: var(--ink); background: var(--paper); border: 1px solid var(--line);
    border-radius: 3px; outline: none;
  }
  input:focus, textarea:focus, select:focus { border-color: var(--accent-soft); background: #fffdf7; }
  textarea { min-height: 8rem; resize: vertical; line-height: 1.7; }
  button {
    font-family: inherit; font-size: 0.95rem; padding: 0.55rem 1.1rem; cursor: pointer;
    color: #fffdf7; background: var(--accent); border: 1px solid var(--accent);
    border-radius: 3px; letter-spacing: 0.08em;
  }
  button:hover { background: var(--accent-soft); }
  button:disabled { opacity: 0.55; cursor: default; }
  button.ghost { color: var(--accent); background: transparent; }
  button.ghost:hover { background: var(--paper-deep); }
  button.danger { color: var(--danger); background: transparent; border-color: var(--danger); }
  button.danger:hover { color: #fffdf7; background: var(--danger); }
  button.small { padding: 0.28rem 0.6rem; font-size: 0.82rem; }
  .row { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
  .grow { flex: 1; }
  .msg { margin: 0 0 1rem; padding: 0.6rem 0.8rem; border-radius: 3px; font-size: 0.9rem; display: none; }
  .msg.show { display: block; }
  .msg.error { color: var(--danger); background: #f7e7e3; border: 1px solid #e0bdb5; }
  .msg.ok { color: var(--ok); background: #e7efe6; border: 1px solid #bcd2bd; }
  .foot { margin-top: 1.5rem; text-align: center; font-size: 0.86rem; color: var(--ink-soft); }
  .topbar {
    display: flex; align-items: center; justify-content: space-between; gap: 1rem;
    padding-bottom: 1rem; margin-bottom: 1.5rem; border-bottom: 1px solid var(--line);
  }
  .topbar h1 { margin: 0; font-size: 1.35rem; font-weight: 600; letter-spacing: 0.12em; }
  .who { font-size: 0.88rem; color: var(--ink-soft); }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th, td { padding: 0.55rem 0.5rem; text-align: left; border-bottom: 1px solid var(--line); vertical-align: middle; }
  th { font-weight: 600; color: var(--ink-soft); font-size: 0.82rem; letter-spacing: 0.06em; }
  tbody tr:hover { background: var(--paper-deep); }
  .tag {
    display: inline-block; padding: 0.08rem 0.5rem; border-radius: 2px;
    font-size: 0.78rem; letter-spacing: 0.05em; border: 1px solid currentColor;
  }
  .tag.pending { color: var(--warn); }
  .tag.active { color: var(--ok); }
  .tag.rejected, .tag.disabled { color: var(--danger); }
  .tag.role-admin { color: var(--accent); }
  .tag.role-manager { color: var(--ink-soft); }
  .tag.role-visitor { color: #8a8272; }
  .tabs { display: flex; gap: 0.4rem; margin-bottom: 1.25rem; flex-wrap: wrap; }
  .tabs button {
    background: transparent; color: var(--ink-soft); border-color: var(--line);
  }
  .tabs button.on { color: #fffdf7; background: var(--accent); border-color: var(--accent); }
  .panel { display: none; }
  .panel.on { display: block; }
  .hint { font-size: 0.84rem; color: var(--ink-soft); margin: 0.4rem 0 0; }
  .empty { padding: 2rem 0; text-align: center; color: var(--ink-soft); font-size: 0.9rem; }
  .scroll-x { overflow-x: auto; }
  @media (max-width: 640px) { .wrap { padding-top: 2rem; } }
`;

/**
 * 中文：套一层完整的 HTML 骨架。
 *
 * Wrap page content in a complete HTML document.
 *
 * Args:
 *   title (string): document title, rendered into <title>.
 *   body (string): trusted HTML for the <body>.
 *   extraScript (string): optional trusted JS appended before </body>.
 *
 * Returns:
 *   string: the full HTML document.
 */
function layout(title, body, extraScript = "", headExtra = "") {
  return `<!doctype html>
<html lang="zh-Hans">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)} · 明史阅读器</title>
${headExtra}
<style>${BASE_CSS}</style>
</head>
<body>
${body}
${extraScript ? `<script>${extraScript}</script>` : ""}
</body>
</html>`;
}

/** Shared client helper: POST JSON and surface the error message. / 前端公用请求helper。 */
const CLIENT_HELPERS = `
  function el(id) { return document.getElementById(id); }
  function show(id, kind, text) {
    var box = el(id);
    box.className = 'msg show ' + kind;
    box.textContent = text;
  }
  function hide(id) { el(id).className = 'msg'; }
  async function api(method, url, body) {
    var options = { method: method, headers: {} };
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    var response = await fetch(url, options);
    var data = null;
    try { data = await response.json(); } catch (e) { data = {}; }
    if (!response.ok) throw new Error(data.error || ('请求失败 (' + response.status + ')'));
    return data;
  }
`;

/**
 * 中文：创建登录/注册/改密码/后台四个页面的路由。
 *
 * Build the router serving the server-rendered auth pages.
 *
 * Routes:
 *   GET /login    — sign-in form (public)
 *   GET /register — application form (public)
 *   GET /account  — change own password (any signed-in user)
 *   GET /admin    — administration console (manager and above)
 *
 * Returns:
 *   express.Router: the router to mount at the application root.
 */
export function createAuthPagesRouter() {
  const router = express.Router();

  // ---- GET /login -----------------------------------------------------------
  router.get("/login", (req, res) => {
    if (req.user) { res.redirect(302, "/"); return; }
    const next = String(req.query.next || "/");
    const body = `
<div class="wrap">
  <div class="brand">
    <h1>明史阅读器</h1>
    <p>以《明史》为底本的交互式研读工具</p>
  </div>
  <div class="card">
    <div id="msg" class="msg"></div>
    <form id="form">
      <label><span>用户名</span><input id="username" name="username" autocomplete="username" autofocus required></label>
      <label><span>密码</span><input id="password" name="password" type="password" autocomplete="current-password" required></label>
      <button id="submit" type="submit" style="width:100%">登 录</button>
    </form>
  </div>
  <p class="foot">还没有账号？<a href="/register">申请访问</a>（需管理员批准）</p>
</div>`;
    const script = `${CLIENT_HELPERS}
  var NEXT = ${JSON.stringify(next)};
  el('form').addEventListener('submit', async function (event) {
    event.preventDefault();
    hide('msg');
    el('submit').disabled = true;
    try {
      var result = await api('POST', '/api/auth/login', {
        username: el('username').value.trim(),
        password: el('password').value
      });
      if (result.user && result.user.mustChangePassword) {
        location.href = '/account?first=1&next=' + encodeURIComponent(NEXT);
      } else {
        location.href = NEXT && NEXT.charAt(0) === '/' ? NEXT : '/';
      }
    } catch (error) {
      show('msg', 'error', error.message);
      el('submit').disabled = false;
    }
  });`;
    // Warm the default fonts while the password is being typed.
    res.type("html").send(layout("登录", body, script + buildPrefetchScript()));
  });

  // ---- GET /register --------------------------------------------------------
  router.get("/register", (req, res) => {
    if (req.user) { res.redirect(302, "/"); return; }
    const body = `
<div class="wrap">
  <div class="brand">
    <h1>申请访问</h1>
    <p>提交后需由管理员批准方可登录</p>
  </div>
  <div class="card">
    <div id="msg" class="msg"></div>
    <form id="form">
      <label><span>用户名</span><input id="username" autocomplete="username" autofocus required>
        <p class="hint">2–32 字符，可用中英文、数字、下划线、连字符</p></label>
      <label><span>称呼<em style="font-style:normal;color:#a09580">（选填）</em></span><input id="displayName" autocomplete="nickname"></label>
      <label><span>密码</span><input id="password" type="password" autocomplete="new-password" required>
        <p class="hint">至少 6 位</p></label>
      <label><span>申请说明<em style="font-style:normal;color:#a09580">（选填，便于管理员判断）</em></span>
        <textarea id="note" style="min-height:5rem" placeholder="例如：研究方向、与站点的关系"></textarea></label>
      <button id="submit" type="submit" style="width:100%">提交申请</button>
    </form>
  </div>
  <p class="foot">已有账号？<a href="/login">返回登录</a></p>
</div>`;
    const script = `${CLIENT_HELPERS}
  el('form').addEventListener('submit', async function (event) {
    event.preventDefault();
    hide('msg');
    el('submit').disabled = true;
    try {
      var result = await api('POST', '/api/auth/register', {
        username: el('username').value.trim(),
        displayName: el('displayName').value.trim(),
        password: el('password').value,
        note: el('note').value.trim()
      });
      show('msg', 'ok', result.message || '申请已提交。');
      el('form').reset();
    } catch (error) {
      show('msg', 'error', error.message);
    } finally {
      el('submit').disabled = false;
    }
  });`;
    res.type("html").send(layout("申请访问", body, script));
  });

  // ---- GET /account ---------------------------------------------------------
  router.get("/account", (req, res) => {
    if (!req.user) { res.redirect(302, "/login?next=%2Faccount"); return; }
    const first = req.query.first === "1";
    const next = String(req.query.next || "/");
    const body = `
<div class="wrap">
  <div class="brand">
    <h1>${first ? "请先设置新密码" : "账号设置"}</h1>
    <p>${escapeHtml(req.user.displayName || req.user.username)} · ${escapeHtml(ROLE_LABELS[req.user.role] || req.user.role)}</p>
  </div>
  <div class="card">
    ${first ? '<p class="hint" style="margin-top:0;margin-bottom:1rem">此账号仍在使用初始密码，请改为自己的密码后再进入阅读器。</p>' : ""}
    <div id="msg" class="msg"></div>
    <form id="form">
      <label><span>当前密码</span><input id="current" type="password" autocomplete="current-password" autofocus required></label>
      <label><span>新密码</span><input id="next1" type="password" autocomplete="new-password" required>
        <p class="hint">至少 6 位</p></label>
      <label><span>确认新密码</span><input id="next2" type="password" autocomplete="new-password" required></label>
      <button id="submit" type="submit" style="width:100%">保存新密码</button>
    </form>
  </div>
  <p class="foot"><a href="/">返回阅读器</a>${req.user.role !== ROLES.VISITOR ? ' · <a href="/admin">后台管理</a>' : ""} · <a href="#" id="logout">退出登录</a></p>
</div>`;
    const script = `${CLIENT_HELPERS}
  var NEXT = ${JSON.stringify(next)};
  el('form').addEventListener('submit', async function (event) {
    event.preventDefault();
    hide('msg');
    if (el('next1').value !== el('next2').value) {
      show('msg', 'error', '两次输入的新密码不一致。');
      return;
    }
    el('submit').disabled = true;
    try {
      await api('POST', '/api/auth/change-password', {
        currentPassword: el('current').value,
        newPassword: el('next1').value
      });
      show('msg', 'ok', '密码已更新，正在跳转…');
      setTimeout(function () { location.href = NEXT && NEXT.charAt(0) === '/' ? NEXT : '/'; }, 900);
    } catch (error) {
      show('msg', 'error', error.message);
      el('submit').disabled = false;
    }
  });
  el('logout').addEventListener('click', async function (event) {
    event.preventDefault();
    await api('POST', '/api/auth/logout');
    location.href = '/login';
  });`;
    res.type("html").send(layout(first ? "设置新密码" : "账号设置", body, script));
  });

  // ---- GET /admin -----------------------------------------------------------
  router.get("/admin", requireRole(ROLES.MANAGER), (req, res) => {
    const isAdmin = req.user.role === ROLES.ADMIN;
    const body = `
<div class="wrap wrap-wide">
  <div class="topbar">
    <h1>后台管理</h1>
    <div class="who">
      ${escapeHtml(req.user.displayName || req.user.username)}
      <span class="tag role-${escapeHtml(req.user.role)}">${escapeHtml(ROLE_LABELS[req.user.role])}</span>
      · <a href="/">阅读器</a> · <a href="/account">改密码</a> · <a href="#" id="logout">退出</a>
    </div>
  </div>

  <div class="tabs">
    <button class="on" data-panel="users">用户管理</button>
    <button data-panel="staging">临时书库</button>
    <button data-panel="site">版本说明</button>
    ${isAdmin ? '<button data-panel="audit">审计日志</button>' : ""}
  </div>

  <div id="panel-users" class="panel on">
    <div class="card">
      <h2>账号列表 <span class="sub" id="userCounts"></span></h2>
      <div id="usersMsg" class="msg"></div>
      <div class="scroll-x"><table>
        <thead><tr>
          <th>用户名</th><th>称呼</th><th>角色</th><th>状态</th>
          <th>申请说明</th><th>注册时间</th><th style="min-width:230px">操作</th>
        </tr></thead>
        <tbody id="usersBody"></tbody>
      </table></div>
      <div id="usersEmpty" class="empty" style="display:none">暂无账号。</div>
      <p class="hint">${isAdmin
        ? "超级管理员可管理全部账号并调整角色。"
        : "管理员可审批和管理访客账号；管理员与超级管理员账号只能由超级管理员调整。"}</p>
    </div>
    ${isAdmin ? `
    <div class="card">
      <h2>直接创建账号</h2>
      <div id="createMsg" class="msg"></div>
      <div class="row">
        <label class="grow" style="margin-bottom:0"><span>用户名</span><input id="newUsername"></label>
        <label class="grow" style="margin-bottom:0"><span>称呼</span><input id="newDisplayName"></label>
        <label class="grow" style="margin-bottom:0"><span>初始密码</span><input id="newPassword" type="text" value="password"></label>
        <label style="margin-bottom:0;min-width:130px"><span>角色</span>
          <select id="newRole">
            <option value="visitor">访客</option>
            <option value="manager">管理员</option>
            <option value="admin">超级管理员</option>
          </select></label>
        <button id="createBtn" style="align-self:flex-end">创建</button>
      </div>
      <p class="hint">新账号首次登录时会被要求修改密码。</p>
    </div>` : ""}
  </div>

  <div id="panel-staging" class="panel">
    <div class="card">
      <h2>上传书籍到临时书库</h2>
      <div id="uploadMsg" class="msg"></div>
      <label><span>选择文件（.epub 或 .txt，单个不超过 150 MB）</span><input id="file" type="file" accept=".epub,.txt"></label>
      <div class="row">
        <label class="grow" style="margin-bottom:0"><span>书名（留空则自动识别）</span><input id="upTitle"></label>
        <label class="grow" style="margin-bottom:0"><span>作者（选填）</span><input id="upAuthor"></label>
      </div>
      <div class="row" style="margin-top:1rem">
        <button id="uploadBtn">上传并导入</button>
        <span id="uploadProgress" class="hint" style="margin:0"></span>
      </div>
      <p class="hint">临时书库的书可以在阅读器里和其他史籍一起阅读，但不进入正文检索库，也不参与跨书史料比对与语义检索。</p>
    </div>
    <div class="card">
      <h2>临时书库</h2>
      <div id="stagingMsg" class="msg"></div>
      <div class="scroll-x"><table>
        <thead><tr><th>书名</th><th>作者</th><th>章数</th><th>段数</th><th>字数</th><th>上传者</th><th>上传时间</th><th>操作</th></tr></thead>
        <tbody id="stagingBody"></tbody>
      </table></div>
      <div id="stagingEmpty" class="empty" style="display:none">临时书库还没有书。</div>
    </div>
  </div>

  <div id="panel-site" class="panel">
    <div class="card">
      <h2>版本说明 <span class="sub" id="noticeMeta"></span></h2>
      <div id="noticeMsg" class="msg"></div>
      <textarea id="noticeText" placeholder="例如：v1.3.3 更新了……"></textarea>
      <div class="row" style="margin-top:0.75rem"><button id="noticeSave">保存版本说明</button></div>
      <p class="hint">保存后展示在阅读器的「关于」面板中，按纯文本原样显示（保留换行）。</p>
    </div>
    <div class="card">
      <h2>README <span class="sub" id="readmeMeta"></span></h2>
      <div id="readmeMsg" class="msg"></div>
      <textarea id="readmeText" style="min-height:16rem" placeholder="站点说明 / 使用指南"></textarea>
      <div class="row" style="margin-top:0.75rem"><button id="readmeSave">保存 README</button></div>
    </div>
  </div>

  ${isAdmin ? `
  <div id="panel-audit" class="panel">
    <div class="card">
      <h2>审计日志 <span class="sub">最近 200 条</span></h2>
      <div class="scroll-x"><table>
        <thead><tr><th style="min-width:150px">时间</th><th>操作人</th><th>动作</th><th>详情</th></tr></thead>
        <tbody id="auditBody"></tbody>
      </table></div>
    </div>
  </div>` : ""}
</div>`;

    const script = `${CLIENT_HELPERS}
  var IS_ADMIN = ${isAdmin ? "true" : "false"};
  var ROLE_LABELS = ${JSON.stringify(ROLE_LABELS)};
  var STATUS_LABELS = { pending: '待审批', active: '已启用', rejected: '已拒绝', disabled: '已停用' };

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtNumber(n) { return Number(n || 0).toLocaleString('zh-CN'); }
  function fmtTime(value) { return value ? String(value).replace('T', ' ').slice(0, 16) : '—'; }

  // ---- tabs ----
  document.querySelectorAll('.tabs button').forEach(function (tab) {
    tab.addEventListener('click', function () {
      document.querySelectorAll('.tabs button').forEach(function (b) { b.classList.remove('on'); });
      document.querySelectorAll('.panel').forEach(function (p) { p.classList.remove('on'); });
      tab.classList.add('on');
      el('panel-' + tab.dataset.panel).classList.add('on');
      if (tab.dataset.panel === 'audit') loadAudit();
    });
  });

  el('logout').addEventListener('click', async function (event) {
    event.preventDefault();
    await api('POST', '/api/auth/logout');
    location.href = '/login';
  });

  // ---- users ----
  async function loadUsers() {
    try {
      var data = await api('GET', '/api/admin/users');
      el('userCounts').textContent = '共 ' + data.counts.total + ' 个账号'
        + (data.counts.pending ? '，' + data.counts.pending + ' 个待审批' : '');
      var rows = data.users.map(function (user) {
        var actions = [];
        if (user.manageable) {
          if (user.status === 'pending') {
            actions.push('<button class="small" data-act="approve" data-id="' + user.id + '">批准</button>');
            actions.push('<button class="small ghost" data-act="reject" data-id="' + user.id + '">拒绝</button>');
          } else if (user.status === 'active') {
            actions.push('<button class="small ghost" data-act="disable" data-id="' + user.id + '">停用</button>');
          } else {
            actions.push('<button class="small" data-act="approve" data-id="' + user.id + '">启用</button>');
          }
          actions.push('<button class="small ghost" data-act="resetpw" data-id="' + user.id + '">重置密码</button>');
          if (IS_ADMIN) {
            actions.push('<button class="small ghost" data-act="role" data-id="' + user.id
              + '" data-role="' + esc(user.role) + '">改角色</button>');
          }
          actions.push('<button class="small danger" data-act="delete" data-id="' + user.id
            + '" data-name="' + esc(user.username) + '">删除</button>');
        } else {
          actions.push('<span class="hint">—</span>');
        }
        return '<tr>'
          + '<td><strong>' + esc(user.username) + '</strong></td>'
          + '<td>' + esc(user.displayName || '') + '</td>'
          + '<td><span class="tag role-' + esc(user.role) + '">' + esc(ROLE_LABELS[user.role] || user.role) + '</span></td>'
          + '<td><span class="tag ' + esc(user.status) + '">' + esc(STATUS_LABELS[user.status] || user.status) + '</span></td>'
          + '<td style="max-width:220px">' + esc(user.note || '') + '</td>'
          + '<td>' + fmtTime(user.createdAt) + '</td>'
          + '<td><div class="row">' + actions.join('') + '</div></td>'
          + '</tr>';
      });
      el('usersBody').innerHTML = rows.join('');
      el('usersEmpty').style.display = rows.length ? 'none' : 'block';
    } catch (error) {
      show('usersMsg', 'error', error.message);
    }
  }

  el('usersBody').addEventListener('click', async function (event) {
    var button = event.target.closest('button[data-act]');
    if (!button) return;
    var id = button.dataset.id;
    var act = button.dataset.act;
    hide('usersMsg');
    try {
      if (act === 'approve') {
        await api('PATCH', '/api/admin/users/' + id, { status: 'active' });
      } else if (act === 'reject') {
        await api('PATCH', '/api/admin/users/' + id, { status: 'rejected' });
      } else if (act === 'disable') {
        await api('PATCH', '/api/admin/users/' + id, { status: 'disabled' });
      } else if (act === 'resetpw') {
        var pw = prompt('设置新密码（该用户下次登录须再次修改）：', 'password');
        if (!pw) return;
        await api('PATCH', '/api/admin/users/' + id, { password: pw });
        show('usersMsg', 'ok', '密码已重置。');
      } else if (act === 'role') {
        var role = prompt('输入新角色：visitor / manager / admin', button.dataset.role);
        if (!role) return;
        await api('PATCH', '/api/admin/users/' + id, { role: role.trim() });
      } else if (act === 'delete') {
        if (!confirm('确定删除账号「' + button.dataset.name + '」？此操作不可撤销。')) return;
        await api('DELETE', '/api/admin/users/' + id);
        show('usersMsg', 'ok', '账号已删除。');
      }
      loadUsers();
    } catch (error) {
      show('usersMsg', 'error', error.message);
    }
  });

  if (IS_ADMIN) {
    el('createBtn').addEventListener('click', async function () {
      hide('createMsg');
      try {
        await api('POST', '/api/admin/users', {
          username: el('newUsername').value.trim(),
          displayName: el('newDisplayName').value.trim(),
          password: el('newPassword').value,
          role: el('newRole').value
        });
        show('createMsg', 'ok', '账号已创建。');
        el('newUsername').value = '';
        el('newDisplayName').value = '';
        loadUsers();
      } catch (error) {
        show('createMsg', 'error', error.message);
      }
    });
  }

  // ---- staging library ----
  async function loadStaging() {
    try {
      var data = await api('GET', '/api/admin/staging');
      var rows = data.books.map(function (book) {
        return '<tr>'
          + '<td><strong>' + esc(book.title) + '</strong><br><span class="hint">' + esc(book.slug) + '</span></td>'
          + '<td>' + esc(book.author || '—') + '</td>'
          + '<td>' + fmtNumber(book.chapterCount) + '</td>'
          + '<td>' + fmtNumber(book.paragraphCount) + '</td>'
          + '<td>' + fmtNumber(book.charCount) + '</td>'
          + '<td>' + esc(book.uploadedBy || '—') + '</td>'
          + '<td>' + fmtTime(book.uploadedAt) + '</td>'
          + '<td><div class="row">'
          + '<button class="small ghost" data-act="rename" data-slug="' + esc(book.slug) + '" data-title="' + esc(book.title) + '">改名</button>'
          + '<button class="small danger" data-act="delete" data-slug="' + esc(book.slug) + '" data-title="' + esc(book.title) + '">删除</button>'
          + '</div></td></tr>';
      });
      el('stagingBody').innerHTML = rows.join('');
      el('stagingEmpty').style.display = rows.length ? 'none' : 'block';
    } catch (error) {
      show('stagingMsg', 'error', error.message);
    }
  }

  el('stagingBody').addEventListener('click', async function (event) {
    var button = event.target.closest('button[data-act]');
    if (!button) return;
    hide('stagingMsg');
    try {
      if (button.dataset.act === 'rename') {
        var title = prompt('新的书名：', button.dataset.title);
        if (!title) return;
        await api('PATCH', '/api/admin/staging/' + encodeURIComponent(button.dataset.slug), { title: title.trim() });
      } else if (button.dataset.act === 'delete') {
        if (!confirm('确定从临时书库删除「' + button.dataset.title + '」？')) return;
        await api('DELETE', '/api/admin/staging/' + encodeURIComponent(button.dataset.slug));
        show('stagingMsg', 'ok', '已删除。');
      }
      loadStaging();
    } catch (error) {
      show('stagingMsg', 'error', error.message);
    }
  });

  el('uploadBtn').addEventListener('click', function () {
    hide('uploadMsg');
    var file = el('file').files[0];
    if (!file) { show('uploadMsg', 'error', '请先选择文件。'); return; }

    var params = new URLSearchParams({ filename: file.name });
    if (el('upTitle').value.trim()) params.set('title', el('upTitle').value.trim());
    if (el('upAuthor').value.trim()) params.set('author', el('upAuthor').value.trim());

    // XHR rather than fetch so the upload progress bar is real.
    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/admin/staging/upload?' + params.toString());
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    el('uploadBtn').disabled = true;
    xhr.upload.onprogress = function (event) {
      if (!event.lengthComputable) return;
      el('uploadProgress').textContent = '上传中 ' + Math.round(event.loaded / event.total * 100) + '%';
    };
    xhr.onload = function () {
      el('uploadBtn').disabled = false;
      el('uploadProgress').textContent = '';
      var data = {};
      try { data = JSON.parse(xhr.responseText); } catch (e) {}
      if (xhr.status >= 200 && xhr.status < 300) {
        show('uploadMsg', 'ok', '《' + (data.book && data.book.title) + '》已导入，共 '
          + fmtNumber(data.book && data.book.paragraphCount) + ' 段。');
        el('file').value = '';
        el('upTitle').value = '';
        el('upAuthor').value = '';
        loadStaging();
      } else {
        show('uploadMsg', 'error', data.error || ('上传失败 (' + xhr.status + ')'));
      }
    };
    xhr.onerror = function () {
      el('uploadBtn').disabled = false;
      el('uploadProgress').textContent = '';
      show('uploadMsg', 'error', '上传失败，请检查网络。');
    };
    el('uploadProgress').textContent = '正在解析…';
    xhr.send(file);
  });

  // ---- site content ----
  async function loadSite(key, textId, metaId) {
    try {
      var data = await api('GET', '/api/admin/site/' + key);
      el(textId).value = data.value || '';
      el(metaId).textContent = data.updatedAt
        ? '最后由 ' + (data.updatedBy || '—') + ' 修改于 ' + fmtTime(data.updatedAt) : '尚未设置';
    } catch (error) { /* leave the field empty on failure */ }
  }
  async function saveSite(key, textId, metaId, msgId) {
    hide(msgId);
    try {
      var data = await api('PUT', '/api/admin/site/' + key, { value: el(textId).value });
      el(metaId).textContent = '最后由 ' + (data.updatedBy || '—') + ' 修改于 ' + fmtTime(data.updatedAt);
      show(msgId, 'ok', '已保存。');
    } catch (error) {
      show(msgId, 'error', error.message);
    }
  }
  el('noticeSave').addEventListener('click', function () { saveSite('version_notice', 'noticeText', 'noticeMeta', 'noticeMsg'); });
  el('readmeSave').addEventListener('click', function () { saveSite('readme', 'readmeText', 'readmeMeta', 'readmeMsg'); });

  // ---- audit ----
  async function loadAudit() {
    if (!IS_ADMIN) return;
    try {
      var data = await api('GET', '/api/admin/audit?limit=200');
      el('auditBody').innerHTML = data.entries.map(function (entry) {
        return '<tr><td>' + fmtTime(entry.at) + '</td><td>' + esc(entry.actor)
          + '</td><td>' + esc(entry.action) + '</td><td>' + esc(entry.detail) + '</td></tr>';
      }).join('');
    } catch (error) { /* audit is non-critical */ }
  }

  loadUsers();
  loadStaging();
  loadSite('version_notice', 'noticeText', 'noticeMeta');
  loadSite('readme', 'readmeText', 'readmeMeta');`;

    res.type("html").send(layout("后台管理", body, script));
  });

  return router;
}
