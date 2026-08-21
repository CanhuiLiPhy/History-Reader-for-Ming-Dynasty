/**
 * 中文：鉴权中间件——解析会话 cookie、挂载 req.user、按角色拦截请求。
 *
 * Express middleware for the web deployment's session auth. Provides:
 *   attachUser  — resolve the session cookie into req.user (or null)
 *   requireAuth — gate a route behind a signed-in, approved account
 *   requireRole — gate a route behind a minimum privilege rank
 *
 * Cookies are parsed by hand rather than via cookie-parser so the deployment
 * adds no npm dependency; the server runs on a 512 MB host where every avoided
 * native/transitive install is worthwhile.
 */
import { ROLE_RANK, resolveSession } from "./auth-db.js";

/** Name of the session cookie. / 会话 cookie 名。 */
export const SESSION_COOKIE = "mingshi_session";

/**
 * 中文：解析 Cookie 请求头为对象。
 *
 * Parse a raw Cookie header into a plain object.
 *
 * Args:
 *   header (string|undefined): the raw `Cookie` request header.
 *
 * Returns:
 *   Object<string, string>: decoded cookie name → value pairs. Malformed
 *     percent-encoding falls back to the raw value rather than throwing.
 */
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      out[name] = raw;
    }
  }
  return out;
}

/**
 * 中文：写入会话 cookie。
 *
 * Set the session cookie on a response. `secure` is enabled whenever the
 * request arrived over HTTPS (directly or via nginx's X-Forwarded-Proto), so
 * the same code works for a plain-HTTP first boot and for the TLS site.
 *
 * Args:
 *   req (express.Request): the current request, used to detect HTTPS.
 *   res (express.Response): response to receive the Set-Cookie header.
 *   token (string): session token from createSession().
 *   expiresAt (Date): absolute expiry.
 */
export function setSessionCookie(req, res, token, expiresAt) {
  const secure = req.secure || String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Expires=${expiresAt.toUTCString()}`,
  ];
  if (secure) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}

/**
 * 中文：清除会话 cookie。
 *
 * Clear the session cookie by expiring it in the past.
 *
 * Args:
 *   res (express.Response): response to receive the Set-Cookie header.
 */
export function clearSessionCookie(res) {
  res.append("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/**
 * 中文：把当前会话对应的用户挂到 req.user 上；未登录则为 null。
 *
 * Express middleware that resolves the session cookie and attaches the user.
 * Always calls next(); authorisation decisions belong to requireAuth /
 * requireRole so that public routes can still see who is signed in.
 *
 * Sets:
 *   req.cookies (Object<string,string>)
 *   req.sessionToken (string|null)
 *   req.user (object|null) — public user fields, no password hash.
 */
export function attachUser(req, _res, next) {
  req.cookies = parseCookies(req.headers.cookie);
  const token = req.cookies[SESSION_COOKIE] || null;
  req.sessionToken = token;
  req.user = token ? resolveSession(token) : null;
  next();
}

/**
 * 中文：判断请求想要 JSON 还是网页。
 *
 * Decide whether an unauthenticated request should get a 401 JSON body or an
 * HTML redirect to the sign-in page.
 *
 * Uses originalUrl rather than path: inside a mounted router (e.g. one mounted
 * at /api/admin) req.path has the mount prefix stripped, so an API route would
 * otherwise be misclassified as a document request and answered with HTML.
 *
 * Args:
 *   req (express.Request): the current request.
 *
 * Returns:
 *   boolean: true when the caller is an API/XHR client wanting JSON.
 */
function wantsJson(req) {
  if (String(req.originalUrl || req.path || "").startsWith("/api/")) return true;
  const accept = String(req.headers.accept || "");
  return accept.includes("application/json") && !accept.includes("text/html");
}

/**
 * 中文：要求已登录。未登录时 API 返回 401，网页跳转登录页。
 *
 * Express middleware requiring an authenticated, approved account.
 *
 * Behaviour on failure:
 *   API/XHR requests  -> 401 with {error, loginUrl}
 *   Document requests -> 302 to /login?next=<original url>
 */
export function requireAuth(req, res, next) {
  if (req.user) { next(); return; }
  if (wantsJson(req)) {
    res.status(401).json({ error: "需要登录后才能访问。", loginUrl: "/login" });
    return;
  }
  const next_ = encodeURIComponent(req.originalUrl || "/");
  res.redirect(302, `/login?next=${next_}`);
}

/**
 * 中文：要求至少具备某个角色等级。
 *
 * Build middleware requiring at least `minRole` privilege.
 *
 * Args:
 *   minRole (string): one of 'visitor' | 'manager' | 'admin'.
 *
 * Returns:
 *   Function: an Express middleware (req, res, next).
 *
 * Behaviour on failure:
 *   not signed in -> delegates to requireAuth (401 or redirect)
 *   insufficient  -> 403 JSON for API, 403 HTML for documents
 */
export function requireRole(minRole) {
  const needed = ROLE_RANK[minRole] || 99;
  return function roleGate(req, res, next) {
    if (!req.user) { requireAuth(req, res, next); return; }
    if ((ROLE_RANK[req.user.role] || 0) >= needed) { next(); return; }
    if (wantsJson(req)) {
      res.status(403).json({ error: "权限不足。" });
      return;
    }
    res.status(403).type("html").send(
      `<!doctype html><meta charset="utf-8"><title>权限不足</title>` +
      `<body style="font-family:system-ui;padding:3rem;text-align:center">` +
      `<h1 style="font-weight:500">权限不足</h1>` +
      `<p>当前账号无权访问此页面。</p><p><a href="/">返回阅读器</a></p></body>`
    );
  };
}

/**
 * 中文：判断 A 用户能否管理 B 用户。
 *
 * Authorisation rule for account administration.
 *
 * Rules:
 *   - admin may manage every account except deleting/demoting themselves
 *     (self-protection is enforced separately at the route layer);
 *   - manager may manage visitor accounts only — never another manager and
 *     never an admin;
 *   - visitor may manage nobody.
 *
 * Args:
 *   actor (object): the signed-in user (public fields, needs .role).
 *   target (object): the account being acted upon (needs .role).
 *
 * Returns:
 *   boolean: true when the action is permitted.
 */
export function canManageUser(actor, target) {
  if (!actor || !target) return false;
  if (actor.role === "admin") return true;
  if (actor.role === "manager") return target.role === "visitor";
  return false;
}
