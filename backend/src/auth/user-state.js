/**
 * 中文：每个账号自己的阅读状态——书签、札记、勾画、AI 设置、界面偏好，
 * 全部按 user_id 存在服务器上，换浏览器、换设备重新登录都还在。
 *
 * Per-account reader state: bookmarks, notes, highlights, AI settings, theme
 * and layout preferences. Previously all of this lived in the browser's
 * localForage, which made it per-browser rather than per-account — clearing
 * site data or signing in from another machine lost everything, and two
 * accounts sharing a browser shared each other's notes.
 *
 * Storage model: one row per (user_id, key). The key namespace is exactly the
 * one the frontend already uses ("mingshi-reader-ai:bookmarks", …), and the
 * value is the JSON-serialised state blob. Keeping the frontend's own key
 * strings means the client-side change is confined to its storage adapter.
 *
 * Rows live in auth.sqlite alongside the accounts, so a user's data is removed
 * by the same ON DELETE CASCADE that removes the account.
 */
import { getAuthDb } from "./auth-db.js";

/**
 * 中文：前端存 AI 设置用的 key，两边必须一致。
 *
 * The exact storage key the frontend uses for its AI settings
 * (`${STORAGE_PREFIX}:ai-settings` in frontend/src/App.tsx). Credentials stored
 * under it are redacted on read and merged write-only on save.
 */
export const AI_SETTINGS_STATE_KEY = "mingshi-reader-ai:ai-settings";

/** Largest accepted serialised value for a single key (4 MB). / 单键值上限。 */
export const MAX_VALUE_BYTES = 4 * 1024 * 1024;

/** Largest total state a single account may store (24 MB). / 单账号总量上限。 */
export const MAX_TOTAL_BYTES = 24 * 1024 * 1024;

/** Longest accepted state key. / 键名长度上限。 */
const MAX_KEY_LENGTH = 200;

let schemaReady = false;

/**
 * 中文：建 user_state 表。
 *
 * Create the user_state table on first use. Idempotent.
 *
 * Returns:
 *   Database: the open auth database handle.
 */
function db() {
  const database = getAuthDb();
  if (!schemaReady) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS user_state (
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key        TEXT NOT NULL,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, key)
      );
      CREATE INDEX IF NOT EXISTS idx_user_state_user ON user_state(user_id);
    `);
    schemaReady = true;
  }
  return database;
}

/**
 * 中文：读出某账号的全部状态。
 *
 * Read every stored key for one account.
 *
 * Args:
 *   userId (number): users.id.
 *
 * Returns:
 *   Object<string, any>: key → parsed JSON value. A row whose JSON fails to
 *     parse is skipped rather than throwing, so one corrupt entry cannot stop
 *     the reader from loading.
 */
export function getUserState(userId) {
  const rows = db().prepare("SELECT key, value FROM user_state WHERE user_id = ?").all(userId);
  const out = {};
  for (const row of rows) {
    try {
      out[row.key] = JSON.parse(row.value);
    } catch {
      // Skip an unparseable row; the client will simply fall back to its default.
    }
  }
  return out;
}

/**
 * 中文：读单个键。
 *
 * Read one stored key.
 *
 * Args:
 *   userId (number): users.id.
 *   key (string): state key.
 *
 * Returns:
 *   any: the parsed value, or undefined when absent or unparseable.
 */
export function getUserStateKey(userId, key) {
  const row = db().prepare("SELECT value FROM user_state WHERE user_id = ? AND key = ?").get(userId, key);
  if (!row) return undefined;
  try {
    return JSON.parse(row.value);
  } catch {
    return undefined;
  }
}

/**
 * 中文：判断一个值是不是「非空的字符串密钥」。
 *
 * True when `value` is a non-blank string, i.e. an actual credential rather
 * than the empty placeholder the redacted client sends back.
 */
function isSetKey(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * 中文：抹掉一份 AI 设置里的全部密钥，换成「是否已配置」的布尔标记。
 *
 * Strip credentials from a stored AI settings blob before it leaves the server.
 *
 * `GET /api/user/state` returns an account's whole state map to that account.
 * Because a key used to be stored here in plaintext, any holder of a seeded
 * account — visitors included — could read the owner's credential straight out
 * of that response. The reader never needs the value, only whether one exists,
 * so it is replaced by a boolean.
 *
 * Args:
 *   settings (any): the parsed value stored under AI_SETTINGS_STATE_KEY.
 *
 * Returns:
 *   any: same shape with `apiKey` / `ttsApiKey` / every
 *     `modelProviders[].apiKey` blanked and a matching `*Configured` boolean
 *     added. Non-object input is returned unchanged.
 */
export function redactAiSettings(settings) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return settings;
  return {
    ...settings,
    apiKey: "",
    apiKeyConfigured: isSetKey(settings.apiKey),
    ttsApiKey: "",
    ttsApiKeyConfigured: isSetKey(settings.ttsApiKey),
    modelProviders: (settings.modelProviders || []).map((provider) => ({
      ...provider,
      apiKey: "",
      apiKeyConfigured: isSetKey(provider?.apiKey),
    })),
  };
}

/**
 * 中文：对整份 state map 做密钥抹除，只处理 AI 设置那一条。
 *
 * Apply redactAiSettings to the AI settings entry of a whole state map.
 *
 * Args:
 *   state (Object<string, any>): the map returned by getUserState.
 *
 * Returns:
 *   Object<string, any>: a shallow copy safe to serialise into a response.
 */
export function redactStateCredentials(state) {
  if (!state || !state[AI_SETTINGS_STATE_KEY]) return state;
  return { ...state, [AI_SETTINGS_STATE_KEY]: redactAiSettings(state[AI_SETTINGS_STATE_KEY]) };
}

/**
 * 中文：写入型合并——客户端留空的密钥字段保留旧值，填了新值才覆盖。
 *
 * Merge an incoming AI settings write against what is already stored, giving
 * the credential fields write-only semantics.
 *
 * This is the other half of redaction. Because the client is handed "" for
 * every key, a naive round-trip (load settings → change the voice → save)
 * would write those blanks straight over the real credentials and silently
 * destroy them. So a blank incoming key means "leave it alone" and only a
 * non-blank one overwrites. That is exactly the "可重设、不可查看" behaviour:
 * a user can type a new key at any time but can never read the current one.
 *
 * Providers are matched by `id`, so editing one entry's alias does not clear
 * its key.
 *
 * Args:
 *   previous (any): currently stored settings, may be undefined.
 *   incoming (any): what the client just sent.
 *
 * Returns:
 *   any: `incoming` with blanked credentials refilled from `previous`.
 */
export function mergeAiSettingsWrite(previous, incoming) {
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) return incoming;
  if (!previous || typeof previous !== "object") return incoming;

  const previousProviders = new Map(
    (previous.modelProviders || []).filter((p) => p?.id).map((p) => [p.id, p])
  );

  return {
    ...incoming,
    apiKey: isSetKey(incoming.apiKey) ? incoming.apiKey : (previous.apiKey || ""),
    ttsApiKey: isSetKey(incoming.ttsApiKey) ? incoming.ttsApiKey : (previous.ttsApiKey || ""),
    modelProviders: (incoming.modelProviders || []).map((provider) => {
      if (isSetKey(provider?.apiKey)) return provider;
      const old = provider?.id ? previousProviders.get(provider.id) : null;
      return { ...provider, apiKey: old?.apiKey || "" };
    }),
  };
}

/**
 * 中文：服务端取某账号自己填的凭证，只在进程内用，绝不下发。
 *
 * Read one account's own credentials for in-process use.
 *
 * Returns the *unredacted* stored settings, so the value must never be placed
 * in a response. Request handlers use it to attach the account's own key to an
 * outbound LLM call without that key ever reaching the browser.
 *
 * Args:
 *   userId (number): users.id.
 *
 * Returns:
 *   object|null: { apiKey, baseURL, ttsApiKey, ttsBaseURL, modelProviders }
 *     when the account has supplied at least one key, otherwise null.
 */
export function getUserAiCredentials(userId) {
  const stored = getUserStateKey(userId, AI_SETTINGS_STATE_KEY);
  if (!stored || typeof stored !== "object") return null;
  const providers = (stored.modelProviders || []).filter((p) => isSetKey(p?.apiKey));
  if (!isSetKey(stored.apiKey) && !isSetKey(stored.ttsApiKey) && !providers.length) return null;
  return {
    apiKey: isSetKey(stored.apiKey) ? stored.apiKey.trim() : "",
    baseURL: stored.baseURL || "",
    ttsApiKey: isSetKey(stored.ttsApiKey) ? stored.ttsApiKey.trim() : "",
    ttsBaseURL: stored.ttsBaseURL || "",
    modelProviders: providers,
  };
}

/**
 * 中文：批量写入状态，返回写入结果与用量。
 *
 * Upsert a batch of state entries for one account, in a single transaction.
 *
 * A value of `null` deletes the key, which lets the client clear an entry
 * without a separate endpoint.
 *
 * Args:
 *   userId (number): users.id.
 *   entries (Object<string, any>): key → JSON-serialisable value, or null to
 *     delete that key.
 *
 * Returns:
 *   object: {written (number), deleted (number), skipped (Array<string>),
 *     totalBytes (number)} — `skipped` names keys refused for being too large,
 *     having an over-long key, or for exceeding the per-account quota.
 */
export function putUserState(userId, entries) {
  const database = db();
  const upsert = database.prepare(`
    INSERT INTO user_state (user_id, key, value, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  const remove = database.prepare("DELETE FROM user_state WHERE user_id = ? AND key = ?");
  const usedBytes = database.prepare(
    "SELECT COALESCE(SUM(LENGTH(value)), 0) AS total FROM user_state WHERE user_id = ?"
  );

  const skipped = [];
  let written = 0;
  let deleted = 0;

  const run = database.transaction(() => {
    let total = Number(usedBytes.get(userId)?.total || 0);

    for (const [key, value] of Object.entries(entries)) {
      if (typeof key !== "string" || !key || key.length > MAX_KEY_LENGTH) {
        skipped.push(String(key).slice(0, 60));
        continue;
      }
      if (value === null) {
        deleted += remove.run(userId, key).changes;
        continue;
      }

      // 密钥字段是「只写」的：客户端拿到的永远是空串，若原样写回会把真 key
      // 抹掉，所以这里用旧值补回。放在 putUserState 而不是路由里，是为了任何
      // 写入路径都自动受保护。
      // Credentials are write-only: the client only ever holds "", so writing
      // that back verbatim would erase the stored key. Refill from the previous
      // value here — inside the storage layer — so every write path is covered,
      // not just the one route that happens to remember.
      const toStore = key === AI_SETTINGS_STATE_KEY
        ? mergeAiSettingsWrite(getUserStateKey(userId, key), value)
        : value;

      let serialised;
      try {
        serialised = JSON.stringify(toStore);
      } catch {
        skipped.push(key);
        continue;
      }
      if (serialised === undefined) { skipped.push(key); continue; }

      const size = Buffer.byteLength(serialised, "utf8");
      if (size > MAX_VALUE_BYTES) { skipped.push(key); continue; }

      // Quota is checked against the delta this write introduces, so
      // repeatedly saving the same key never walks the account into the cap.
      const previous = database.prepare("SELECT LENGTH(value) AS len FROM user_state WHERE user_id = ? AND key = ?")
        .get(userId, key);
      const delta = size - Number(previous?.len || 0);
      if (total + delta > MAX_TOTAL_BYTES) { skipped.push(key); continue; }

      upsert.run(userId, key, serialised);
      total += delta;
      written += 1;
    }
    return total;
  });

  const totalBytes = run();
  return { written, deleted, skipped, totalBytes };
}

/**
 * 中文：删掉某账号的全部状态。
 *
 * Delete every stored key for one account (used when an admin resets a user).
 *
 * Args:
 *   userId (number): users.id.
 *
 * Returns:
 *   number: rows removed.
 */
export function clearUserState(userId) {
  return db().prepare("DELETE FROM user_state WHERE user_id = ?").run(userId).changes;
}

/**
 * 中文：统计某账号的存储用量，用于后台展示。
 *
 * Summarise an account's stored state for the admin console.
 *
 * Args:
 *   userId (number): users.id.
 *
 * Returns:
 *   object: {keys (number), bytes (number), updatedAt (string|null)}.
 */
export function describeUserState(userId) {
  const row = db().prepare(`
    SELECT COUNT(*) AS keys, COALESCE(SUM(LENGTH(value)), 0) AS bytes, MAX(updated_at) AS updatedAt
    FROM user_state WHERE user_id = ?
  `).get(userId);
  return { keys: Number(row?.keys || 0), bytes: Number(row?.bytes || 0), updatedAt: row?.updatedAt || null };
}

/*
 * 已移除：seedUserAiSettings()
 *
 * Removed in the 2026-08-18 credential hardening.
 *
 * 中文：它把 MINGSHI_SEED_AI_KEY 的明文 key 写进每个被点名账号的 user_state，
 * 而 user_state 是整份回给该账号的 —— 于是「把配好 key 的账号发给别人」就等于
 * 把 key 发给别人。实测确认三个账号（含一个访客）持有站主的百炼 key。
 *
 * It planted the plaintext MINGSHI_SEED_AI_KEY into each named account's
 * user_state, and GET /api/user/state hands that map back to the account in
 * full — so distributing a "pre-configured" account distributed the key with
 * it. An audit found three accounts holding the owner's DashScope key, one of
 * them a visitor.
 *
 * 替代机制 / Replacement: the built-in credential now stays in the server's
 * environment and is attached to outbound calls in-process, gated on role
 * (manager and above). See resolveRequestAiSettings in server.js and
 * getBuiltinAiCredentials in config/defaults.js. Nothing is ever written into
 * an account's state, so nothing can be read back out of it.
 */
