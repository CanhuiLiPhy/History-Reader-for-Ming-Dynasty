/**
 * 中文：后台管理 API——用户管理、临时书库、版本说明编辑、审计日志。
 *
 * Administration API, mounted at /api/admin by server.js. Every route sits
 * behind requireRole('manager'); the finer admin-only rules are enforced
 * per-route below.
 *
 * Permission model:
 *   admin   — everything, including creating or demoting managers, changing any
 *             role, reading the audit log. Cannot delete or demote themselves.
 *   manager — may approve, edit, reset the password of, and delete VISITOR
 *             accounts only; may never touch another manager or an admin, and
 *             may never change anyone's role (granting privilege is reserved
 *             to admin). May upload books to the staging library and edit the
 *             site's version notice / README.
 *
 * Uploads are streamed straight to disk rather than buffered by a body parser:
 * the target host has ~400 MB of RAM and a 150 MB EPUB must never be held in
 * memory.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import {
  ROLES, ROLE_LABELS, STATUSES,
  audit, createUser, deleteUser, destroyUserSessions,
  findUserWithSecret, getUserById, getSiteContent, setSiteContent,
  listAudit, listUsers, updateUser, validatePassword, validateUsername,
} from "./auth-db.js";
import { canManageUser } from "./middleware.js";
import {
  MAX_UPLOAD_BYTES,
  deleteStagingBook, importStagingBook, listStagingBooks, updateStagingBook,
} from "../services/staging-library.js";

/** Site-content keys a manager may edit. / 允许编辑的站点内容键。 */
const EDITABLE_SITE_KEYS = new Set(["version_notice", "readme"]);

/**
 * 中文：把上传请求的 body 流式落盘到临时文件。
 *
 * Stream a request body to a temporary file, enforcing a hard size cap.
 * Nothing is buffered in memory beyond the socket's own chunks.
 *
 * Args:
 *   req (express.Request): the upload request; its raw body is the file.
 *   maxBytes (number): abort once this many bytes have arrived.
 *
 * Returns:
 *   Promise<object>: {filePath (string), size (number)}.
 *
 * Raises:
 *   Error: 'FILE_TOO_LARGE' when the cap is exceeded (the partial file is
 *     removed first), or any I/O error from the underlying stream.
 */
function streamToTempFile(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const filePath = path.join(os.tmpdir(), `mingshi-upload-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
    const out = fs.createWriteStream(filePath);
    let size = 0;
    let aborted = false;

    const fail = (error) => {
      if (aborted) return;
      aborted = true;
      out.destroy();
      fs.rm(filePath, { force: true }, () => reject(error));
    };

    req.on("data", (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > maxBytes) fail(new Error("FILE_TOO_LARGE"));
    });
    req.on("error", fail);
    out.on("error", fail);
    out.on("finish", () => { if (!aborted) resolve({ filePath, size }); });
    req.pipe(out);
  });
}

/**
 * 中文：创建 /api/admin 路由。
 *
 * Build the administration router. Mount it behind requireRole('manager').
 *
 * Returns:
 *   express.Router: the router to mount at /api/admin.
 */
export function createAdminRouter() {
  const router = express.Router();

  // JSON parsing for everything except the raw-stream upload endpoint.
  router.use((req, res, next) => {
    if (req.path === "/staging/upload") { next(); return; }
    express.json({ limit: "256kb" })(req, res, next);
  });

  // =========================================================================
  // Users / 用户管理
  // =========================================================================

  /** GET /api/admin/users — list every account with the caller's rights on it. */
  router.get("/users", (req, res) => {
    const users = listUsers().map((user) => ({
      ...user,
      roleLabel: ROLE_LABELS[user.role] || user.role,
      manageable: canManageUser(req.user, user) && user.id !== req.user.id,
    }));
    res.json({
      users,
      viewer: { id: req.user.id, username: req.user.username, role: req.user.role },
      counts: {
        total: users.length,
        pending: users.filter((u) => u.status === STATUSES.PENDING).length,
      },
    });
  });

  /** POST /api/admin/users — create an account directly (admin only). */
  router.post("/users", (req, res) => {
    if (req.user.role !== ROLES.ADMIN) {
      res.status(403).json({ error: "只有超级管理员可以直接创建账号。" });
      return;
    }
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    const role = String(req.body?.role || ROLES.VISITOR);

    const usernameError = validateUsername(username);
    if (usernameError) { res.status(400).json({ error: usernameError }); return; }
    const passwordError = validatePassword(password);
    if (passwordError) { res.status(400).json({ error: passwordError }); return; }
    if (!Object.values(ROLES).includes(role)) { res.status(400).json({ error: "角色无效。" }); return; }
    if (findUserWithSecret(username)) { res.status(409).json({ error: "该用户名已被使用。" }); return; }

    const created = createUser({
      username, password, role,
      status: STATUSES.ACTIVE,
      displayName: String(req.body?.displayName || "").trim().slice(0, 64),
      note: String(req.body?.note || "").trim().slice(0, 500),
      mustChangePassword: req.body?.mustChangePassword !== false,
    });
    audit(req.user.username, "user.create", `${username} role=${role}`);
    res.status(201).json({ user: created });
  });

  /** PATCH /api/admin/users/:id — approve, reject, rename, reset password, or change role. */
  router.patch("/users/:id", (req, res) => {
    const id = Number.parseInt(String(req.params.id), 10);
    if (!Number.isInteger(id)) { res.status(400).json({ error: "用户 id 无效。" }); return; }

    const target = getUserById(id);
    if (!target) { res.status(404).json({ error: "未找到该用户。" }); return; }
    if (!canManageUser(req.user, target)) {
      res.status(403).json({ error: "无权修改该账号。" });
      return;
    }

    const patch = {};
    const actions = [];

    if (req.body?.status !== undefined) {
      const status = String(req.body.status);
      if (!Object.values(STATUSES).includes(status)) { res.status(400).json({ error: "状态无效。" }); return; }
      if (target.id === req.user.id && status !== STATUSES.ACTIVE) {
        res.status(400).json({ error: "不能停用自己的账号。" });
        return;
      }
      patch.status = status;
      patch.reviewedBy = req.user.username;
      actions.push(`status=${status}`);
    }

    if (req.body?.role !== undefined) {
      // Granting or revoking privilege is reserved to admin: a manager who
      // could promote a visitor to manager would effectively be an admin.
      if (req.user.role !== ROLES.ADMIN) {
        res.status(403).json({ error: "只有超级管理员可以更改账号角色。" });
        return;
      }
      const role = String(req.body.role);
      if (!Object.values(ROLES).includes(role)) { res.status(400).json({ error: "角色无效。" }); return; }
      if (target.id === req.user.id && role !== ROLES.ADMIN) {
        res.status(400).json({ error: "不能降低自己的权限。" });
        return;
      }
      patch.role = role;
      actions.push(`role=${role}`);
    }

    if (req.body?.displayName !== undefined) {
      patch.displayName = String(req.body.displayName).trim().slice(0, 64);
      actions.push("displayName");
    }
    if (req.body?.note !== undefined) {
      patch.note = String(req.body.note).trim().slice(0, 500);
      actions.push("note");
    }
    if (req.body?.password) {
      const passwordError = validatePassword(String(req.body.password));
      if (passwordError) { res.status(400).json({ error: passwordError }); return; }
      patch.password = String(req.body.password);
      patch.mustChangePassword = true;
      actions.push("password-reset");
    }

    if (!actions.length) { res.status(400).json({ error: "没有要修改的字段。" }); return; }

    const updated = updateUser(id, patch);
    // A suspension, role change or password reset must not leave live cookies
    // behind — drop the target's sessions unless we only edited cosmetics.
    if (patch.status || patch.role || patch.password) destroyUserSessions(id);
    audit(req.user.username, "user.update", `${target.username}: ${actions.join(", ")}`);
    res.json({ user: updated });
  });

  /** DELETE /api/admin/users/:id — remove an account. */
  router.delete("/users/:id", (req, res) => {
    const id = Number.parseInt(String(req.params.id), 10);
    if (!Number.isInteger(id)) { res.status(400).json({ error: "用户 id 无效。" }); return; }
    if (id === req.user.id) { res.status(400).json({ error: "不能删除自己的账号。" }); return; }

    const target = getUserById(id);
    if (!target) { res.status(404).json({ error: "未找到该用户。" }); return; }
    if (!canManageUser(req.user, target)) { res.status(403).json({ error: "无权删除该账号。" }); return; }

    deleteUser(id);
    audit(req.user.username, "user.delete", target.username);
    res.json({ ok: true });
  });

  // =========================================================================
  // Staging library / 临时书库
  // =========================================================================

  /** GET /api/admin/staging — list staged books. */
  router.get("/staging", (_req, res) => {
    res.json({ books: listStagingBooks(), maxUploadBytes: MAX_UPLOAD_BYTES });
  });

  /**
   * POST /api/admin/staging/upload?filename=&title=&author=&description=
   * The raw request body IS the file. Query parameters carry the metadata,
   * which keeps the endpoint free of any multipart-parsing dependency.
   */
  router.post("/staging/upload", async (req, res) => {
    const filename = String(req.query.filename || "").trim();
    if (!filename) { res.status(400).json({ error: "缺少 filename 参数。" }); return; }
    if (!/\.(epub|txt)$/i.test(filename)) { res.status(400).json({ error: "只支持 .epub 和 .txt 文件。" }); return; }

    let upload = null;
    try {
      upload = await streamToTempFile(req, MAX_UPLOAD_BYTES);
      if (!upload.size) { res.status(400).json({ error: "上传内容为空。" }); return; }

      const book = await importStagingBook({
        filePath: upload.filePath,
        originalName: filename,
        title: String(req.query.title || "").trim(),
        author: String(req.query.author || "").trim(),
        description: String(req.query.description || "").trim(),
        chapterRegex: String(req.query.chapterRegex || "").trim() || undefined,
        uploadedBy: req.user.username,
      });
      upload = null; // importStagingBook took ownership of the temp file.

      audit(req.user.username, "staging.upload", `${book.slug} «${book.title}» ${book.paragraphCount} 段`);
      res.status(201).json({ ok: true, book });
    } catch (error) {
      const message = error?.message === "FILE_TOO_LARGE"
        ? `文件超过 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB 上限。`
        : (error?.message || "导入失败。");
      res.status(400).json({ error: message });
    } finally {
      if (upload?.filePath) await fsp.rm(upload.filePath, { force: true }).catch(() => {});
    }
  });

  /** PATCH /api/admin/staging/:slug — edit a staged book's display metadata. */
  router.patch("/staging/:slug", (req, res) => {
    const slug = String(req.params.slug || "");
    const patch = {};
    for (const key of ["title", "author", "dynasty", "description"]) {
      if (req.body?.[key] !== undefined) patch[key] = String(req.body[key]).slice(0, 200);
    }
    if (!Object.keys(patch).length) { res.status(400).json({ error: "没有要修改的字段。" }); return; }
    if (!updateStagingBook(slug, patch)) { res.status(404).json({ error: "未找到该书。" }); return; }
    audit(req.user.username, "staging.update", slug);
    res.json({ ok: true });
  });

  /** DELETE /api/admin/staging/:slug — remove a staged book. */
  router.delete("/staging/:slug", (req, res) => {
    const slug = String(req.params.slug || "");
    if (!deleteStagingBook(slug)) { res.status(404).json({ error: "未找到该书。" }); return; }
    audit(req.user.username, "staging.delete", slug);
    res.json({ ok: true });
  });

  // =========================================================================
  // Site content / 站点内容（版本说明、README）
  // =========================================================================

  /** GET /api/admin/site/:key — read an editable site-content entry. */
  router.get("/site/:key", (req, res) => {
    const key = String(req.params.key || "");
    if (!EDITABLE_SITE_KEYS.has(key)) { res.status(404).json({ error: "未知的内容键。" }); return; }
    res.json(getSiteContent(key));
  });

  /** PUT /api/admin/site/:key — replace an editable site-content entry. */
  router.put("/site/:key", (req, res) => {
    const key = String(req.params.key || "");
    if (!EDITABLE_SITE_KEYS.has(key)) { res.status(404).json({ error: "未知的内容键。" }); return; }
    const value = String(req.body?.value ?? "");
    if (value.length > 200000) { res.status(400).json({ error: "内容过长（上限 20 万字符）。" }); return; }
    const saved = setSiteContent(key, value, req.user.username);
    audit(req.user.username, "site.update", `${key} (${value.length} 字符)`);
    res.json(saved);
  });

  // =========================================================================
  // Audit log / 审计日志（仅 admin）
  // =========================================================================

  /** GET /api/admin/audit?limit= — read recent audit entries (admin only). */
  router.get("/audit", (req, res) => {
    if (req.user.role !== ROLES.ADMIN) { res.status(403).json({ error: "只有超级管理员可以查看审计日志。" }); return; }
    res.json({ entries: listAudit(req.query.limit) });
  });

  return router;
}
