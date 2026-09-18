/**
 * 中文：阅读状态的持久化层。网站版按账号存服务器，桌面版存浏览器（行为不变）。
 *
 * Persistence adapter for reader state — bookmarks, notes, highlights, AI
 * settings, theme and layout preferences.
 *
 * Two modes, chosen automatically at boot by probing /api/user/state:
 *
 *   account mode (web deployment) — the server is the source of truth. State
 *     is keyed by account, so signing in from another browser or machine
 *     restores everything, and two accounts sharing one browser never see each
 *     other's data. A per-account IndexedDB store mirrors the server purely as
 *     an offline cache; it is namespaced by user id so the isolation holds in
 *     the cache layer too.
 *
 *   local mode (Electron desktop build) — behaves exactly as before this
 *     adapter existed: one browser-local IndexedDB store, no network.
 *
 * Writes hit the local cache immediately and are pushed to the server on a
 * short debounce, so a burst of edits (dragging a highlight, typing a note)
 * collapses into one request instead of one per keystroke.
 */
import localforage from "localforage";

/** Debounce window before queued writes are pushed to the server. / 写入合并窗口。 */
const FLUSH_DEBOUNCE_MS = 700;

/** Attempts before a failed push gives up until the next write. / 重试上限。 */
const MAX_FLUSH_RETRIES = 3;

type StateMap = Record<string, unknown>;

type Backend =
  | { mode: "local"; store: LocalForage }
  | { mode: "account"; store: LocalForage; userId: number; snapshot: StateMap };

let backendPromise: Promise<Backend> | null = null;

/** Keys written since the last successful flush. / 待同步的键。 */
const dirtyKeys = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushInFlight: Promise<void> | null = null;

/** Invoked when a server sync fails, so the UI can warn. / 同步失败回调。 */
let onSyncError: ((message: string) => void) | null = null;

/**
 * 中文：注册同步失败回调，便于界面提示用户。
 *
 * Register a callback invoked when a server sync fails, so the UI can warn the
 * user instead of silently pretending their notes were saved.
 *
 * Args:
 *   handler (function|null): receives a Chinese message, or null to clear.
 */
export function setSyncErrorHandler(handler: ((message: string) => void) | null): void {
  onSyncError = handler;
}

/**
 * 中文：建一个 IndexedDB 存储实例。
 *
 * Create an IndexedDB-backed store.
 *
 * Args:
 *   storeName (string): object-store name. Namespaced per account in account
 *     mode so cached state cannot leak between users on a shared browser.
 *
 * Returns:
 *   LocalForage: the store instance.
 */
function createStore(storeName: string): LocalForage {
  return localforage.createInstance({ name: "mingshi-reader-ai", storeName });
}

/**
 * 中文：探测后端模式，每次页面加载只跑一次。
 *
 * Determine which persistence mode applies, once per page load.
 *
 * Probes GET /api/user/state. A JSON response with `enabled: true` selects
 * account mode and seeds the in-memory snapshot from the server. Anything else
 * — the desktop build's `enabled: false`, a 401, a network failure, or the SPA
 * fallback answering with HTML — selects local mode.
 *
 * Returns:
 *   Promise<Backend>: the resolved backend descriptor.
 */
function resolveBackend(): Promise<Backend> {
  if (backendPromise) return backendPromise;
  backendPromise = (async (): Promise<Backend> => {
    try {
      const response = await fetch("/api/user/state", {
        headers: { Accept: "application/json" },
        credentials: "same-origin",
      });
      if (response.ok) {
        const data = await response.json();
        if (data?.enabled && data?.user?.id) {
          return {
            mode: "account",
            userId: data.user.id,
            snapshot: (data.state ?? {}) as StateMap,
            store: createStore(`reader_state_u${data.user.id}`),
          };
        }
      }
    } catch {
      // Desktop build, offline, or the endpoint answered with the SPA shell.
    }
    return { mode: "local", store: createStore("reader_state") };
  })();
  return backendPromise;
}

/**
 * 中文：读一个持久化的值。
 *
 * Read a persisted value.
 *
 * Resolution order in account mode: server snapshot → this account's offline
 * cache → the supplied fallback. In local mode: browser store → fallback.
 *
 * Args:
 *   key (string): storage key, e.g. "mingshi-reader-ai:bookmarks".
 *   fallback (T): value returned when nothing is stored.
 *
 * Returns:
 *   Promise<T>: the stored value, or `fallback`.
 */
export async function readPersistedState<T>(key: string, fallback: T): Promise<T> {
  const backend = await resolveBackend();

  if (backend.mode === "account") {
    if (Object.prototype.hasOwnProperty.call(backend.snapshot, key)) {
      const value = backend.snapshot[key];
      return (value ?? fallback) as T;
    }
    // Nothing on the server for this key yet — consult this account's own
    // offline cache (e.g. edits made while the connection was down).
    try {
      const cached = await backend.store.getItem<T>(key);
      if (cached !== null && cached !== undefined) return cached;
    } catch {
      // IndexedDB unavailable (private browsing) — use the default.
    }
    return fallback;
  }

  try {
    const value = await backend.store.getItem<T>(key);
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * 中文：写一个持久化的值。本地立即落盘，服务器合并后异步推送。
 *
 * Persist a value.
 *
 * The offline cache is written immediately so a reload is never lossy even
 * with the network down; in account mode the key is additionally queued for a
 * debounced push to the server.
 *
 * Args:
 *   key (string): storage key.
 *   value (T): JSON-serialisable value.
 *
 * Returns:
 *   Promise<void>: resolves once the local write completes. The server push
 *     happens afterwards; await flushPersistedState() to include it.
 */
export async function writePersistedState<T>(key: string, value: T): Promise<void> {
  const backend = await resolveBackend();

  try {
    await backend.store.setItem(key, value);
  } catch {
    // Cache write failed (quota, private browsing). In account mode the server
    // push below is the authoritative save, so this is not fatal.
  }

  if (backend.mode !== "account") return;

  backend.snapshot[key] = value;
  dirtyKeys.add(key);
  scheduleFlush();
}

/**
 * 中文：安排一次延迟同步，每次新写入都重置计时器。
 *
 * Schedule the debounced server push, restarting the timer on each new write
 * so a burst of edits collapses into a single request.
 */
function scheduleFlush(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushPersistedState();
  }, FLUSH_DEBOUNCE_MS);
}

/**
 * 中文：立刻把待同步的改动推到服务器。
 *
 * Push all pending writes to the server now, bypassing the debounce.
 *
 * Concurrent calls share one in-flight request. A key leaves the dirty set
 * only after the server confirms it, so a failed push is retried on the next
 * write rather than silently lost.
 *
 * Returns:
 *   Promise<void>: resolves when the push finishes, successfully or not.
 */
export async function flushPersistedState(): Promise<void> {
  if (flushInFlight) return flushInFlight;

  const backend = await resolveBackend();
  if (backend.mode !== "account" || !dirtyKeys.size) return;

  flushInFlight = (async () => {
    for (let attempt = 1; attempt <= MAX_FLUSH_RETRIES; attempt += 1) {
      const keys = [...dirtyKeys];
      if (!keys.length) return;

      const entries: StateMap = {};
      for (const key of keys) entries[key] = backend.snapshot[key];

      try {
        const response = await fetch("/api/user/state", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ entries }),
        });

        if (response.status === 401) {
          onSyncError?.("登录状态已失效，改动未能保存。请重新登录。");
          return;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const result = await response.json();
        // Retire only the keys the server actually accepted.
        const refused = new Set<string>(result?.skipped ?? []);
        for (const key of keys) if (!refused.has(key)) dirtyKeys.delete(key);

        if (refused.size) {
          onSyncError?.(
            result?.quotaExceeded
              ? "云端存储已满，部分改动未能保存。可清理旧的札记或勾画后重试。"
              : "部分改动过大，未能保存到云端。"
          );
        }
        return;
      } catch {
        if (attempt === MAX_FLUSH_RETRIES) {
          onSyncError?.("改动暂时未能同步到服务器，已保存在本机，稍后自动重试。");
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
      }
    }
  })().finally(() => { flushInFlight = null; });

  return flushInFlight;
}

// Push pending edits before the tab goes away. `visibilitychange` fires
// reliably on mobile and on tab close, where `beforeunload` often does not.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flushPersistedState();
  });
  window.addEventListener("pagehide", () => { void flushPersistedState(); });
}
