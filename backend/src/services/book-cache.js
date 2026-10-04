/** Keep only recently used parsed books, sharing concurrent loads of one book. */
export function createBookCache(load, { maxEntries = 2, idleMs = 5 * 60_000 } = {}) {
  const entries = new Map();
  const loading = new Map();
  let expiryTimer = null;

  function scheduleExpiry() {
    clearTimeout(expiryTimer);
    expiryTimer = null;
    const oldest = entries.values().next().value;
    if (!oldest) return;
    expiryTimer = setTimeout(() => {
      const now = Date.now();
      for (const [key, entry] of entries) {
        if (now - entry.usedAt >= idleMs) entries.delete(key);
      }
      scheduleExpiry();
    }, Math.max(1, oldest.usedAt + idleMs - Date.now()));
    expiryTimer.unref?.();
  }

  return {
    async get(key) {
      const cached = entries.get(key);
      if (cached && Date.now() - cached.usedAt < idleMs) {
        entries.delete(key);
        cached.usedAt = Date.now();
        entries.set(key, cached);
        scheduleExpiry();
        return cached.value;
      }
      entries.delete(key);
      if (loading.has(key)) return loading.get(key);

      // Store the promise before invoking the loader, including synchronous errors.
      const promise = Promise.resolve().then(() => load(key)).then((value) => {
        entries.set(key, { value, usedAt: Date.now() });
        while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
        scheduleExpiry();
        return value;
      }).finally(() => loading.delete(key));
      loading.set(key, promise);
      return promise;
    }
  };
}
