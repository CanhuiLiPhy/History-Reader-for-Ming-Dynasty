/**
 * 中文：账号相关的 API 路由——登录、登出、注册、查看自己、改密码。
 *
 * Public authentication API. Mounted at /api/auth by server.js.
 *
 * Routes:
 *   POST /api/auth/login            sign in, issue a session cookie
 *   POST /api/auth/logout           revoke the current session
 *   GET  /api/auth/me               describe the signed-in account
 *   POST /api/auth/register         submit an application (status: pending)
 *   POST /api/auth/change-password  change one's own password
 *
 * Sign-in is rate-limited per client IP to blunt credential stuffing; the
 * limiter is in-process, which is sufficient for a single-node deployment.
 */
import express from "express";
import {
  ROLES, ROLE_LABELS, ROLE_RANK, STATUSES,
  audit, createSession, createUser, destroySession, destroyUserSessions,
  findUserWithSecret, touchLogin, updateUser,
  validatePassword, validateUsername, verifyPassword,
} from "./auth-db.js";
import { clearSessionCookie, setSessionCookie } from "./middleware.js";

/** Max failed sign-ins per IP within the window before lockout. / 登录失败次数上限。 */
const LOGIN_MAX_ATTEMPTS = 10;

/** Rate-limit window in milliseconds (15 minutes). / 限流窗口。 */
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

/** ip -> {count, firstAt} — in-process failed-login tracker. / 登录失败计数。 */
const loginAttempts = new Map();

/**
 * 中文：取客户端 IP，优先用 nginx 转发头。
 *
 * Resolve the client IP, preferring the left-most entry of X-Forwarded-For
 * (set by the nginx reverse proxy) and falling back to the socket address.
 *
 * Args:
 *   req (express.Request): the current request.
 *
 * Returns:
 *   string: an IP string, or '' when undeterminable.
 */
function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.ip || req.socket?.remoteAddress || "";
}

/**
 * 中文：检查该 IP 是否已被登录限流拦住。
 *
 * Check whether an IP has exhausted its sign-in attempts. Expired windows are
 * reset lazily on access.
 *
 * Args:
 *   ip (string): client IP.
 *
 * Returns:
 *   boolean: true when further attempts must be refused.
 */
function isRateLimited(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.firstAt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(ip);
    return false;
  }
  return entry.count >= LOGIN_MAX_ATTEMPTS;
}

/**
 * 中文：记一次登录失败。
 *
 * Record a failed sign-in for an IP, starting a new window when needed.
 *
 * Args:
 *   ip (string): client IP.
 */
function recordFailure(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry || Date.now() - entry.firstAt > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, firstAt: Date.now() });
    return;
  }
  entry.count += 1;
}

/**
 * 中文：把用户对象整理成可以安全下发给前端的形状。
 *
 * Shape a user row for the client, adding the display label and a capability
 * map so the frontend never has to re-derive permission rules.
 *
 * Args:
 *   user (object|null): public user fields from auth-db.
 *
 * Returns:
 *   object|null: {id, username, displayName, role, roleLabel, status,
 *     mustChangePassword, can: {manageUsers, manageAllUsers, uploadBooks,
 *     editSiteContent, editTimeline}}, or null when not signed in.
 */
export function describeUser(user) {
  if (!user) return null;
  const isAdmin = user.role === ROLES.ADMIN;
  const isManager = user.role === ROLES.MANAGER || isAdmin;
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName || user.username,
    role: user.role,
    roleLabel: ROLE_LABELS[user.role] || user.role,
    status: user.status,
    mustChangePassword: Boolean(user.mustChangePassword),
    can: {
      manageUsers: isManager,      // 管理员可管访客；admin 可管所有人
      manageAllUsers: isAdmin,     // 只有 admin 能动管理员及 admin 账号
      uploadBooks: isManager,      // 上传书到临时库
      editSiteContent: isManager,  // 编辑版本说明 / README
      editTimeline: isManager,     // 修改时间线数据
    },
  };
}

/**
 * 中文：创建 /api/auth 路由。
 *
 * Build the public authentication router.
 *
 * Returns:
 *   express.Router: the router to mount at /api/auth.
 */
export function createAuthRouter() {
  const router = express.Router();
  router.use(express.json({ limit: "32kb" }));

  // ---- POST /api/auth/login -------------------------------------------------
  router.post("/login", (req, res) => {
    const ip = clientIp(req);
    if (isRateLimited(ip)) {
      res.status(429).json({ error: "登录尝试过于频繁，请 15 分钟后再试。" });
      return;
    }

    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    if (!username || !password) {
      res.status(400).json({ error: "请输入用户名和密码。" });
      return;
    }

    const user = findUserWithSecret(username);
    // Verify even when the user is missing so a wrong username and a wrong
    // password take comparable time and cannot be told apart by timing.
    const passwordOk = user
      ? verifyPassword(password, user.password_hash)
      : verifyPassword(password, "scrypt$16384$8$1$00$00");

    if (!user || !passwordOk) {
      recordFailure(ip);
      audit(username, "auth.login.fail", `ip=${ip}`);
      res.status(401).json({ error: "用户名或密码不正确。" });
      return;
    }

    if (user.status === STATUSES.PENDING) {
      res.status(403).json({ error: "账号正在等待管理员审批，请稍后再试。" });
      return;
    }
    if (user.status === STATUSES.REJECTED) {
      res.status(403).json({ error: "账号申请未获批准。" });
      return;
    }
    if (user.status !== STATUSES.ACTIVE) {
      res.status(403).json({ error: "账号已被停用，请联系管理员。" });
      return;
    }

    loginAttempts.delete(ip);
    const { token, expiresAt } = createSession(user.id, { userAgent: req.headers["user-agent"], ip });
    setSessionCookie(req, res, token, expiresAt);
    touchLogin(user.id);
    audit(user.username, "auth.login", `ip=${ip}`);

    res.json({
      ok: true,
      user: describeUser({ ...user, displayName: user.display_name, mustChangePassword: user.must_change_password }),
    });
  });

  // ---- POST /api/auth/logout ------------------------------------------------
  router.post("/logout", (req, res) => {
    if (req.sessionToken) destroySession(req.sessionToken);
    if (req.user) audit(req.user.username, "auth.logout", "");
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  // ---- GET /api/auth/me -----------------------------------------------------
  router.get("/me", (req, res) => {
    res.json({ user: describeUser(req.user) });
  });

  // ---- GET /api/auth/verify -------------------------------------------------
  /**
   * 中文：给 nginx auth_request 用的轻量校验端点，只回状态码不回内容。
   *
   * Session probe for nginx's auth_request directive. Answers 204 for a valid
   * session and 401 otherwise, with no body either way.
   *
   * This exists so nginx can serve the large static assets (154 MB of fonts,
   * the 2 MB app bundle) straight from disk with sendfile and gzip_static
   * while still enforcing the sign-in gate — previously every byte of every
   * font was proxied through Node, which capped throughput badly.
   */
  router.get("/verify", (req, res) => {
    if (req.user) { res.status(204).end(); return; }
    res.status(401).end();
  });

  // ---- POST /api/auth/register ---------------------------------------------
  router.post("/register", (req, res) => {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    const displayName = String(req.body?.displayName || "").trim().slice(0, 64);
    const note = String(req.body?.note || "").trim().slice(0, 500);

    const usernameError = validateUsername(username);
    if (usernameError) { res.status(400).json({ error: usernameError }); return; }
    const passwordError = validatePassword(password);
    if (passwordError) { res.status(400).json({ error: passwordError }); return; }

    if (findUserWithSecret(username)) {
      res.status(409).json({ error: "该用户名已被使用。" });
      return;
    }

    createUser({
      username, password, displayName, note,
      role: ROLES.VISITOR,
      status: STATUSES.PENDING,
    });
    audit(username, "auth.register", `ip=${clientIp(req)}`);

    res.status(201).json({
      ok: true,
      message: "申请已提交，需管理员批准后方可登录。",
    });
  });

  // ---- PATCH /api/auth/profile ---------------------------------------------
  /**
   * 中文：改自己的用户名 / 称呼。
   *
   * Update one's own profile.
   *
   * 权限：称呼谁都能改；**用户名只有管理员及以上能改**，访客账号的登录名固定。
   * 理由：用户名是别人认人和管理员审批时的凭据，让访客随意更名会让审批记录
   * 和审计日志失去意义。
   *
   * Permissions: anyone may change their display name; only 管理员 and above
   * may change their username. A visitor's login name is fixed, because it is
   * the handle an administrator approved and the one every audit entry refers
   * to — letting it change freely would detach those records from the person.
   *
   * Changing the username requires the current password: it alters how the
   * account is identified, so a walk-up on an unlocked screen should not be
   * enough to do it.
   *
   * Body:
   *   username (string, optional): new login name.
   *   displayName (string, optional): new friendly name.
   *   currentPassword (string): required when `username` is present.
   *
   * Responses:
   *   200 {ok, user}     updated
   *   400                nothing to change, or validation failed
   *   401                not signed in
   *   403                visitor attempting a username change, or wrong password
   *   409                username already taken
   */
  router.patch("/profile", (req, res) => {
    if (!req.user) { res.status(401).json({ error: "需要先登录。" }); return; }

    const patch = {};
    const changed = [];

    if (req.body?.displayName !== undefined) {
      patch.displayName = String(req.body.displayName).trim().slice(0, 64);
      changed.push("称呼");
    }

    if (req.body?.username !== undefined) {
      const nextName = String(req.body.username).trim();

      if ((ROLE_RANK[req.user.role] || 0) < ROLE_RANK[ROLES.MANAGER]) {
        res.status(403).json({ error: "访客账号不能修改用户名，请联系管理员。" });
        return;
      }

      const stored = findUserWithSecret(req.user.username);
      if (!stored || !verifyPassword(String(req.body?.currentPassword || ""), stored.password_hash)) {
        res.status(403).json({ error: "请输入正确的当前密码后再修改用户名。" });
        return;
      }

      if (nextName !== req.user.username) {
        const usernameError = validateUsername(nextName);
        if (usernameError) { res.status(400).json({ error: usernameError }); return; }
        if (findUserWithSecret(nextName)) {
          res.status(409).json({ error: `用户名「${nextName}」已被占用，请换一个。` });
          return;
        }
        patch.username = nextName;
        changed.push(`用户名 ${req.user.username} → ${nextName}`);
      }
    }

    if (!Object.keys(patch).length) {
      res.status(400).json({ error: "没有要修改的内容。" });
      return;
    }

    let updated;
    try {
      updated = updateUser(req.user.id, patch);
    } catch (error) {
      // The UNIQUE index is the real guard — two people renaming to the same
      // handle at once would slip past the lookup above.
      if (String(error?.message || "").includes("UNIQUE")) {
        res.status(409).json({ error: "该用户名刚被他人占用，请换一个。" });
        return;
      }
      throw error;
    }

    audit(req.user.username, "user.profile.update", changed.join("; "));
    res.json({ ok: true, user: describeUser(updated) });
  });

  // ---- POST /api/auth/change-password --------------------------------------
  router.post("/change-password", (req, res) => {
    if (!req.user) { res.status(401).json({ error: "需要先登录。" }); return; }

    const currentPassword = String(req.body?.currentPassword || "");
    const newPassword = String(req.body?.newPassword || "");
    const stored = findUserWithSecret(req.user.username);
    if (!stored || !verifyPassword(currentPassword, stored.password_hash)) {
      res.status(403).json({ error: "当前密码不正确。" });
      return;
    }
    const passwordError = validatePassword(newPassword);
    if (passwordError) { res.status(400).json({ error: passwordError }); return; }
    if (newPassword === currentPassword) {
      res.status(400).json({ error: "新密码不能与当前密码相同。" });
      return;
    }

    updateUser(req.user.id, { password: newPassword });
    // Every other session of this account is invalidated, then the caller is
    // re-issued a fresh one so the current tab stays signed in.
    destroyUserSessions(req.user.id);
    const { token, expiresAt } = createSession(req.user.id, {
      userAgent: req.headers["user-agent"], ip: clientIp(req),
    });
    setSessionCookie(req, res, token, expiresAt);
    audit(req.user.username, "auth.password.change", "");

    res.json({ ok: true, message: "密码已更新。" });
  });

  return router;
}
