/**
 * 中文：账号自己的状态同步接口——书签、札记、勾画、AI 设置全走这里。
 *
 * Per-account state synchronisation API, mounted at /api/user behind the
 * authentication gate.
 *
 * Routes:
 *   GET  /api/user/state        read this account's entire stored state
 *   PUT  /api/user/state        upsert a batch of keys (null value deletes)
 *   POST /api/user/state/clear  drop everything this account has stored
 *
 * The request body is deliberately a flat {key: value} map matching the
 * frontend's own storage keys, so the client-side change stays confined to its
 * storage adapter rather than spreading through the reader's state logic.
 */
import express from "express";
import { audit } from "./auth-db.js";
import {
  MAX_TOTAL_BYTES,
  clearUserState,
  describeUserState,
  getUserState,
  putUserState,
  redactStateCredentials,
} from "./user-state.js";

/**
 * 中文：创建 /api/user 路由。
 *
 * Build the per-account state router. Mount it after requireAuth.
 *
 * Returns:
 *   express.Router: the router to mount at /api/user.
 */
export function createUserRouter() {
  const router = express.Router();

  // State blobs carry every bookmark and note an account owns, so this route
  // needs a far larger ceiling than the app-wide 4 MB JSON limit.
  router.use(express.json({ limit: "25mb" }));

  /** GET /api/user/state — the whole state map for the signed-in account.
   *
   *  密钥字段在这里抹掉：账号能知道「配没配」，但永远拿不到值。
   *  Credentials are stripped here — the account learns whether a key is
   *  configured, never what it is. Without this the reader's own settings sync
   *  hands the stored key back to whoever holds the account. */
  router.get("/state", (req, res) => {
    res.json({
      enabled: true,
      user: { id: req.user.id, username: req.user.username, role: req.user.role },
      state: redactStateCredentials(getUserState(req.user.id)),
      usage: { ...describeUserState(req.user.id), quotaBytes: MAX_TOTAL_BYTES },
    });
  });

  /** PUT /api/user/state — upsert a batch; a null value deletes that key. */
  router.put("/state", (req, res) => {
    const entries = req.body?.entries;
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
      res.status(400).json({ error: "entries 必须是对象。" });
      return;
    }
    const result = putUserState(req.user.id, entries);
    res.json({
      ok: true,
      ...result,
      quotaBytes: MAX_TOTAL_BYTES,
      // A non-empty `skipped` means the client's write was silently refused;
      // surface it so the reader can warn instead of pretending it saved.
      quotaExceeded: result.skipped.length > 0 && result.totalBytes >= MAX_TOTAL_BYTES,
    });
  });

  /** POST /api/user/state/clear — wipe this account's stored state. */
  router.post("/state/clear", (req, res) => {
    const removed = clearUserState(req.user.id);
    audit(req.user.username, "user.state.clear", `${removed} 项`);
    res.json({ ok: true, removed });
  });

  return router;
}
