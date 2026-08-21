/**
 * 中文：账号系统的数据层——用户、会话、站点内容、审计日志，全部存在独立的
 * auth.sqlite 里，与古籍正文库 library.sqlite 完全隔离。
 *
 * Authentication data layer for the web deployment. Owns a dedicated SQLite
 * file (auth.sqlite) holding users, sessions, editable site content and an
 * audit trail. Deliberately isolated from library.sqlite so that re-syncing
 * the corpus never clobbers accounts, and so the account DB can be backed up
 * on its own.
 *
 * Password hashing uses Node's built-in scrypt (crypto.scryptSync) — no
 * native dependency such as bcrypt is introduced, which matters because the
 * target host is a 512 MB Lightsail box where compiling native modules is
 * expensive and fragile.
 *
 * Stored hash format:
 *   scrypt$<N>$<r>$<p>$<saltHex>$<derivedKeyHex>
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { DATA_ROOT } from "../config/defaults.js";

/**
 * 中文：账号库文件路径，可用环境变量覆盖。
 *
 * Absolute path of the account database. Defaults to `<DATA_ROOT>/.userdata/
 * auth.sqlite`; override with MINGSHI_AUTH_DB. The `.userdata` directory is
 * intentionally outside `.cache/` so corpus rsyncs never touch it.
 */
export const AUTH_DB_PATH = process.env.MINGSHI_AUTH_DB
  ? path.resolve(process.env.MINGSHI_AUTH_DB)
  : path.join(DATA_ROOT, ".userdata", "auth.sqlite");

/** Role identifiers, ordered by privilege. / 角色标识，按权限从低到高。 */
export const ROLES = Object.freeze({ VISITOR: "visitor", MANAGER: "manager", ADMIN: "admin" });

/** Numeric privilege rank used by requireRole(). / 角色权限等级，供 requireRole 比较。 */
export const ROLE_RANK = Object.freeze({ visitor: 1, manager: 2, admin: 3 });

/** Human-readable role labels for the admin console. / 后台展示用的角色中文名。 */
export const ROLE_LABELS = Object.freeze({ visitor: "访客", manager: "管理员", admin: "超级管理员" });

/** Account lifecycle states. / 账号状态。 */
export const STATUSES = Object.freeze({
  PENDING: "pending",   // 注册后等待审批 / awaiting approval
  ACTIVE: "active",     // 已批准，可登录 / approved, may sign in
  REJECTED: "rejected", // 申请被拒 / application refused
  DISABLED: "disabled", // 曾获批但被停用 / previously approved, now suspended
});

/** Session lifetime in milliseconds (30 days). / 会话有效期，30 天。 */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

let db = null;

/**
 * 中文：打开（并在首次调用时初始化）账号库。
 *
 * Open the account database, creating the file, directory and schema on first
 * use. The handle is cached for the process lifetime.
 *
 * Returns:
 *   Database: an open better-sqlite3 handle in WAL mode.
 */
export function getAuthDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(AUTH_DB_PATH), { recursive: true });
  db = new Database(AUTH_DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  return db;
}

/**
 * 中文：建表。
 *
 * Create tables and indexes if absent. Safe to call repeatedly.
 *
 * Args:
 *   database (Database): open better-sqlite3 handle.
 */
function applySchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      username             TEXT UNIQUE NOT NULL,
      password_hash        TEXT NOT NULL,
      role                 TEXT NOT NULL DEFAULT 'visitor',
      status               TEXT NOT NULL DEFAULT 'pending',
      display_name         TEXT NOT NULL DEFAULT '',
      note                 TEXT NOT NULL DEFAULT '',
      must_change_password INTEGER NOT NULL DEFAULT 0,
      created_at           TEXT NOT NULL DEFAULT (datetime('now')),
      reviewed_at          TEXT,
      reviewed_by          TEXT,
      last_login_at        TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      user_agent TEXT NOT NULL DEFAULT '',
      ip         TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS site_content (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_by TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      at      TEXT NOT NULL DEFAULT (datetime('now')),
      actor   TEXT NOT NULL DEFAULT '',
      action  TEXT NOT NULL,
      detail  TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);
  `);
}

// ---------------------------------------------------------------------------
// Password hashing / 密码哈希
// ---------------------------------------------------------------------------

/**
 * 中文：把明文密码转成可入库的 scrypt 哈希串。
 *
 * Derive a salted scrypt hash for storage.
 *
 * Args:
 *   plain (string): the plaintext password, 1..1024 chars.
 *
 * Returns:
 *   string: `scrypt$N$r$p$saltHex$keyHex`, ASCII, ~180 chars.
 *
 * Math:
 *   key = scrypt(plain, salt, N=16384, r=8, p=1, dkLen=64)
 */
export function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(plain), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("hex")}$${key.toString("hex")}`;
}

/**
 * 中文：校验密码，使用恒定时间比较。
 *
 * Verify a plaintext password against a stored hash. Uses
 * crypto.timingSafeEqual so that comparison time does not leak the prefix
 * length of a wrong guess. Any malformed stored value yields false rather
 * than throwing.
 *
 * Args:
 *   plain (string): candidate plaintext password.
 *   stored (string): value previously produced by hashPassword().
 *
 * Returns:
 *   boolean: true when the password matches.
 */
export function verifyPassword(plain, stored) {
  try {
    const parts = String(stored || "").split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const [, n, r, p, saltHex, keyHex] = parts;
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(keyHex, "hex");
    const actual = crypto.scryptSync(String(plain), salt, expected.length, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
    });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * 中文：密码强度校验，返回错误信息或 null。
 *
 * Validate a candidate password against the deployment's minimum policy.
 *
 * Args:
 *   plain (string): candidate password.
 *
 * Returns:
 *   string|null: a Chinese error message, or null when acceptable.
 */
export function validatePassword(plain) {
  const value = String(plain || "");
  if (value.length < 6) return "密码至少 6 位。";
  if (value.length > 200) return "密码过长。";
  return null;
}

/**
 * 中文：用户名校验，返回错误信息或 null。
 *
 * Validate a candidate username: 2..32 chars of letters, digits, underscore,
 * hyphen or CJK ideographs.
 *
 * Args:
 *   name (string): candidate username.
 *
 * Returns:
 *   string|null: a Chinese error message, or null when acceptable.
 */
export function validateUsername(name) {
  const value = String(name || "").trim();
  if (value.length < 2 || value.length > 32) return "用户名长度需为 2–32 字符。";
  if (!/^[A-Za-z0-9_\-一-鿿]+$/.test(value)) return "用户名只能含中英文、数字、下划线和连字符。";
  return null;
}

// ---------------------------------------------------------------------------
// Users / 用户
// ---------------------------------------------------------------------------

const PUBLIC_USER_COLUMNS = `
  id, username, role, status, display_name AS displayName, note,
  must_change_password AS mustChangePassword,
  created_at AS createdAt, reviewed_at AS reviewedAt,
  reviewed_by AS reviewedBy, last_login_at AS lastLoginAt
`;

/**
 * 中文：按用户名查用户（含密码哈希，仅供登录校验使用）。
 *
 * Look up a user row including its password hash. Callers must not send the
 * returned object to a client.
 *
 * Args:
 *   username (string): exact username, case-sensitive.
 *
 * Returns:
 *   object|undefined: the raw row, or undefined when no such user.
 */
export function findUserWithSecret(username) {
  return getAuthDb().prepare("SELECT * FROM users WHERE username = ?").get(String(username || "").trim());
}

/**
 * 中文：按 id 查用户（不含密码哈希）。
 *
 * Fetch a user by primary key, excluding the password hash.
 *
 * Args:
 *   id (number): users.id.
 *
 * Returns:
 *   object|undefined: public user fields, or undefined.
 */
export function getUserById(id) {
  return getAuthDb().prepare(`SELECT ${PUBLIC_USER_COLUMNS} FROM users WHERE id = ?`).get(id);
}

/**
 * 中文：列出全部用户，待审批的排在最前。
 *
 * List every account, ordered pending-first then by creation time descending.
 *
 * Returns:
 *   Array<object>: public user fields, no password hashes.
 */
export function listUsers() {
  return getAuthDb().prepare(`
    SELECT ${PUBLIC_USER_COLUMNS} FROM users
    ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END,
             CASE role WHEN 'admin' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END,
             created_at DESC
  `).all();
}

/**
 * 中文：创建用户。
 *
 * Insert a new account.
 *
 * Args:
 *   spec (object):
 *     username (string): unique login name.
 *     password (string): plaintext, hashed before storage.
 *     role (string): one of ROLES. Default 'visitor'.
 *     status (string): one of STATUSES. Default 'pending'.
 *     displayName (string): optional friendly name.
 *     note (string): optional application reason / admin note.
 *     mustChangePassword (boolean): force a password change at next sign-in.
 *
 * Returns:
 *   object: the created user's public fields.
 *
 * Raises:
 *   Error: when the username already exists (SQLite UNIQUE violation).
 */
export function createUser(spec) {
  const database = getAuthDb();
  const info = database.prepare(`
    INSERT INTO users (username, password_hash, role, status, display_name, note, must_change_password)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(spec.username).trim(),
    hashPassword(spec.password),
    spec.role || ROLES.VISITOR,
    spec.status || STATUSES.PENDING,
    spec.displayName || "",
    spec.note || "",
    spec.mustChangePassword ? 1 : 0
  );
  return getUserById(info.lastInsertRowid);
}

/**
 * 中文：更新用户的可变字段。
 *
 * Patch mutable fields of a user. Unknown keys are ignored; a `password` key
 * is hashed and also clears the must-change flag.
 *
 * Args:
 *   id (number): users.id.
 *   patch (object): any of {username, role, status, displayName, note,
 *     password, mustChangePassword, reviewedBy}. A username collision surfaces
 *     as a UNIQUE constraint error from SQLite — callers must handle it.
 *
 * Returns:
 *   object|undefined: the updated public user, or undefined when absent.
 */
export function updateUser(id, patch) {
  const database = getAuthDb();
  const sets = [];
  const values = [];

  if (patch.username !== undefined) { sets.push("username = ?"); values.push(String(patch.username).trim()); }
  if (patch.role !== undefined) { sets.push("role = ?"); values.push(patch.role); }
  if (patch.status !== undefined) {
    sets.push("status = ?", "reviewed_at = datetime('now')");
    values.push(patch.status);
  }
  if (patch.displayName !== undefined) { sets.push("display_name = ?"); values.push(patch.displayName); }
  if (patch.note !== undefined) { sets.push("note = ?"); values.push(patch.note); }
  if (patch.reviewedBy !== undefined) { sets.push("reviewed_by = ?"); values.push(patch.reviewedBy); }
  if (patch.password) {
    sets.push("password_hash = ?", "must_change_password = 0");
    values.push(hashPassword(patch.password));
  }
  if (patch.mustChangePassword !== undefined) {
    sets.push("must_change_password = ?");
    values.push(patch.mustChangePassword ? 1 : 0);
  }
  if (!sets.length) return getUserById(id);

  values.push(id);
  database.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  return getUserById(id);
}

/**
 * 中文：删除用户，其会话随外键级联清除。
 *
 * Delete a user. Their sessions cascade away via the foreign key.
 *
 * Args:
 *   id (number): users.id.
 *
 * Returns:
 *   boolean: true when a row was removed.
 */
export function deleteUser(id) {
  return getAuthDb().prepare("DELETE FROM users WHERE id = ?").run(id).changes > 0;
}

/**
 * 中文：记录一次成功登录的时间。
 *
 * Stamp last_login_at for a user.
 *
 * Args:
 *   id (number): users.id.
 */
export function touchLogin(id) {
  getAuthDb().prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(id);
}

// ---------------------------------------------------------------------------
// Sessions / 会话
// ---------------------------------------------------------------------------

/**
 * 中文：为用户签发一个新会话，返回 cookie 用的随机 token。
 *
 * Issue a session for a user and persist it.
 *
 * Args:
 *   userId (number): users.id.
 *   meta (object): {userAgent (string), ip (string)} recorded for auditing.
 *
 * Returns:
 *   object: {token (string, 64 hex chars), expiresAt (Date)}.
 */
export function createSession(userId, meta = {}) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  getAuthDb().prepare(`
    INSERT INTO sessions (token, user_id, expires_at, user_agent, ip)
    VALUES (?, ?, ?, ?, ?)
  `).run(token, userId, expiresAt.toISOString(), String(meta.userAgent || "").slice(0, 300), String(meta.ip || ""));
  return { token, expiresAt };
}

/**
 * 中文：用 token 换取用户；过期会话会被顺手清掉。
 *
 * Resolve a session token to its owning user. Expired sessions are deleted on
 * access and treated as absent.
 *
 * Args:
 *   token (string): the raw session token from the cookie.
 *
 * Returns:
 *   object|null: public user fields, or null when the token is invalid,
 *     expired, or the account is no longer active.
 */
export function resolveSession(token) {
  if (!token) return null;
  const database = getAuthDb();
  const row = database.prepare("SELECT user_id AS userId, expires_at AS expiresAt FROM sessions WHERE token = ?").get(token);
  if (!row) return null;
  if (new Date(row.expiresAt).getTime() <= Date.now()) {
    database.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    return null;
  }
  const user = getUserById(row.userId);
  if (!user || user.status !== STATUSES.ACTIVE) return null;
  return user;
}

/**
 * 中文：销毁单个会话（登出）。
 *
 * Destroy one session.
 *
 * Args:
 *   token (string): the session token to revoke.
 */
export function destroySession(token) {
  if (!token) return;
  getAuthDb().prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

/**
 * 中文：销毁某用户的全部会话（改密码、停用、删号时调用）。
 *
 * Revoke every session belonging to a user. Called after a password change,
 * a suspension, or a role change so stale cookies cannot outlive the decision.
 *
 * Args:
 *   userId (number): users.id.
 */
export function destroyUserSessions(userId) {
  getAuthDb().prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

/**
 * 中文：清理所有已过期会话。
 *
 * Delete every expired session row.
 *
 * Returns:
 *   number: how many rows were removed.
 */
export function purgeExpiredSessions() {
  return getAuthDb().prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run().changes;
}

// ---------------------------------------------------------------------------
// Site content / 站点内容（版本说明、README）
// ---------------------------------------------------------------------------

/**
 * 中文：读取一条站点内容。
 *
 * Read an editable site-content entry.
 *
 * Args:
 *   key (string): content key, e.g. 'version_notice' or 'readme'.
 *
 * Returns:
 *   object: {key, value, updatedAt, updatedBy}; value is '' when unset.
 */
export function getSiteContent(key) {
  const row = getAuthDb().prepare(
    "SELECT key, value, updated_at AS updatedAt, updated_by AS updatedBy FROM site_content WHERE key = ?"
  ).get(key);
  return row || { key, value: "", updatedAt: null, updatedBy: "" };
}

/**
 * 中文：写入一条站点内容。
 *
 * Upsert an editable site-content entry.
 *
 * Args:
 *   key (string): content key.
 *   value (string): markdown / plain text body.
 *   updatedBy (string): username of the editor, for display and audit.
 *
 * Returns:
 *   object: the stored entry, same shape as getSiteContent().
 */
export function setSiteContent(key, value, updatedBy) {
  getAuthDb().prepare(`
    INSERT INTO site_content (key, value, updated_at, updated_by)
    VALUES (?, ?, datetime('now'), ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                   updated_at = excluded.updated_at,
                                   updated_by = excluded.updated_by
  `).run(key, String(value ?? ""), String(updatedBy || ""));
  return getSiteContent(key);
}

// ---------------------------------------------------------------------------
// Audit log / 审计日志
// ---------------------------------------------------------------------------

/**
 * 中文：记一条审计日志。
 *
 * Append an audit entry. Never throws — auditing must not break a request.
 *
 * Args:
 *   actor (string): acting username, or 'anonymous'.
 *   action (string): short machine-ish verb, e.g. 'user.approve'.
 *   detail (string): free-form human-readable detail.
 */
export function audit(actor, action, detail = "") {
  try {
    getAuthDb().prepare("INSERT INTO audit_log (actor, action, detail) VALUES (?, ?, ?)")
      .run(String(actor || "anonymous"), String(action), String(detail));
  } catch {
    // Auditing is best-effort; a failure here must never break the request.
  }
}

/**
 * 中文：读取最近的审计日志。
 *
 * Read the most recent audit entries, newest first.
 *
 * Args:
 *   limit (number): maximum rows, clamped to 1..500. Default 100.
 *
 * Returns:
 *   Array<object>: rows of {id, at, actor, action, detail}.
 */
export function listAudit(limit = 100) {
  const capped = Math.max(1, Math.min(500, Number(limit) || 100));
  return getAuthDb().prepare("SELECT id, at, actor, action, detail FROM audit_log ORDER BY id DESC LIMIT ?").all(capped);
}

// ---------------------------------------------------------------------------
// Seeding / 初始账号
// ---------------------------------------------------------------------------

/**
 * 中文：首次启动时建好 licanhui / tanyayun / yinhaofeng 三个账号。
 *
 * Ensure the deployment's built-in accounts exist. Idempotent: an account that
 * already exists is left completely untouched, so a later password change is
 * never reverted by a restart.
 *
 * Seeded accounts (initial password 'password', flagged must-change):
 *   licanhui    -> admin   (full privileges)
 *   tanyayun    -> manager
 *   yinhaofeng  -> manager
 *
 * Returns:
 *   Array<string>: usernames that were newly created this call.
 */
export function seedBuiltinAccounts() {
  const seeds = [
    { username: "licanhui", role: ROLES.ADMIN, displayName: "李灿辉" },
    { username: "tanyayun", role: ROLES.MANAGER, displayName: "谭雅云" },
    { username: "yinhaofeng", role: ROLES.MANAGER, displayName: "尹浩峰" },
  ];
  const created = [];
  for (const seed of seeds) {
    if (findUserWithSecret(seed.username)) continue;
    createUser({
      ...seed,
      password: "password",
      status: STATUSES.ACTIVE,
      note: "系统预置账号",
      mustChangePassword: true,
    });
    created.push(seed.username);
    audit("system", "user.seed", `预置账号 ${seed.username} (${seed.role})`);
  }
  return created;
}

/**
 * 中文：初始化账号系统——建表、建预置账号、清过期会话。
 *
 * Initialise the auth subsystem at server boot. Per-account AI-settings
 * seeding lives in user-state.js (seedUserAiSettings) so that this module has
 * no dependency on the state layer, and the two do not form an import cycle.
 *
 * Returns:
 *   object: {dbPath (string), seeded (Array<string>), purged (number)}.
 */
export function initializeAuth() {
  getAuthDb();
  const seeded = seedBuiltinAccounts();
  const purged = purgeExpiredSessions();
  return { dbPath: AUTH_DB_PATH, seeded, purged };
}
