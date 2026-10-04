// Run: node --experimental-vm-modules --test frontend/tests/storage.test.mjs
// Every test loads the real adapter into an isolated VM with fake network,
// timers and LocalForage. No application server, account or IndexedDB is used.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../src/lib/storage.ts", import.meta.url), "utf8");
const javascript = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
}).outputText;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const response = (data = {}, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => data,
});

async function drainMicrotasks() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

async function createHarness({ userId = 11, put, setItem } = {}) {
  const timers = new Map();
  let now = 0;
  let nextTimer = 0;
  const requests = [];
  const stores = [];
  const errors = [];
  const context = vm.createContext({
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, due: now + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    async fetch(url, options = {}) {
      assert.equal(url, "/api/user/state");
      assert.equal(options.credentials, "same-origin");
      if (options.method !== "PUT") {
        return response(userId === null ? { enabled: false } : {
          enabled: true, user: { id: userId }, state: {},
        });
      }
      const body = JSON.parse(options.body);
      requests.push(body.entries);
      return put ? put(body.entries, requests.length) : response();
    },
  });
  const localforage = new vm.SyntheticModule(["default"], function () {
    this.setExport("default", {
      createInstance(config) {
        stores.push(config);
        const cache = new Map();
        return {
          async getItem(key) { return cache.get(key) ?? null; },
          async setItem(key, value) {
            if (setItem) await setItem(key, value);
            cache.set(key, value);
            return value;
          },
        };
      },
    });
  }, { context });
  const module = new vm.SourceTextModule(javascript, { context });
  await module.link((specifier) => {
    assert.equal(specifier, "localforage");
    return localforage;
  });
  await module.evaluate();
  const api = module.namespace;
  api.setSyncErrorHandler((message) => errors.push(message));
  return {
    api, requests, stores, timers, errors,
    async runNextTimer() {
      const [id, timer] = [...timers].sort((a, b) => a[1].due - b[1].due)[0] ?? [];
      assert.ok(timer, "expected a scheduled timer");
      timers.delete(id);
      now = timer.due;
      timer.callback();
      await drainMicrotasks();
    },
  };
}

test("an acknowledged request preserves and later sends a newer edit of the same key", async () => {
  const firstRequest = deferred();
  const h = await createHarness({ put: (_, index) => index === 1 ? firstRequest.promise : response() });
  await h.api.writePersistedState("notes", ["old note"]);
  const flushing = h.api.flushPersistedState();
  await drainMicrotasks();
  await h.api.writePersistedState("notes", ["latest note"]);
  // The latest edit's debounce fires while the first request is still pending.
  await h.runNextTimer();
  assert.equal(h.requests.length, 1);
  firstRequest.resolve(response());
  await flushing;
  assert.equal(h.timers.size, 1);
  await h.runNextTimer();
  assert.deepEqual(h.requests, [{ notes: ["old note"] }, { notes: ["latest note"] }]);
  assert.equal(h.timers.size, 0);
});

test("new keys written during a request receive a follow-up flush", async () => {
  const firstRequest = deferred();
  const h = await createHarness({ put: (_, index) => index === 1 ? firstRequest.promise : response() });
  await h.api.writePersistedState("notes", ["saved"]);
  const flushing = h.api.flushPersistedState();
  await drainMicrotasks();
  await h.api.writePersistedState("last-location:book-b", "chapter-4");
  firstRequest.resolve(response());
  await flushing;
  await h.runNextTimer();
  assert.deepEqual(h.requests[1], { "last-location:book-b": "chapter-4" });
});

test("concurrent flushes share one request before backend resolution yields", async () => {
  const request = deferred();
  const h = await createHarness({ put: () => request.promise });
  await h.api.writePersistedState("notes", ["one"]);
  const first = h.api.flushPersistedState();
  const second = h.api.flushPersistedState();
  await drainMicrotasks();
  assert.equal(h.requests.length, 1);
  request.resolve(response());
  await Promise.all([first, second]);
  assert.equal(h.timers.size, 0);
});

test("out-of-order cache completion cannot overwrite the latest account snapshot", async () => {
  const olderCacheWrite = deferred();
  const h = await createHarness({ setItem: (_, value) => value === "old" ? olderCacheWrite.promise : undefined });
  const oldWrite = h.api.writePersistedState("note", "old");
  await drainMicrotasks();
  await h.api.writePersistedState("note", "new");
  olderCacheWrite.resolve();
  await oldWrite;
  assert.equal(await h.api.readPersistedState("note", "missing"), "new");
  await h.api.flushPersistedState();
  assert.deepEqual(h.requests, [{ note: "new" }]);
});

test("server-refused entries remain available for a later edit without a retry loop", async () => {
  const h = await createHarness({ put: (_, index) => index === 1
    ? response({ skipped: ["notes"], quotaExceeded: true }) : response() });
  await h.api.writePersistedState("notes", ["too large"]);
  await h.api.flushPersistedState();
  assert.equal(h.errors.length, 1);
  assert.equal(h.timers.size, 0);
  await h.api.flushPersistedState();
  assert.equal(h.requests.length, 2, "refused entries must not be discarded");
});

test("network failure stops after three attempts and a later edit resumes syncing", async () => {
  let fail = true;
  const h = await createHarness({ put: () => {
    if (fail) throw new Error("offline");
    return response();
  } });
  await h.api.writePersistedState("notes", ["offline note"]);
  const flushing = h.api.flushPersistedState();
  await drainMicrotasks();
  await h.runNextTimer();
  await h.runNextTimer();
  await flushing;
  assert.equal(h.requests.length, 3);
  assert.equal(h.timers.size, 0);
  assert.equal(h.errors.length, 1);
  fail = false;
  await h.api.writePersistedState("notes", ["edited after reconnection"]);
  await h.runNextTimer();
  assert.equal(h.requests.length, 4);
  assert.deepEqual(h.requests[3], { notes: ["edited after reconnection"] });
});

test("per-account caches stay namespaced and local mode never sends a PUT", async () => {
  const accountA = await createHarness({ userId: 12 });
  const accountB = await createHarness({ userId: 45 });
  const local = await createHarness({ userId: null });
  for (const h of [accountA, accountB, local]) {
    await h.api.writePersistedState("notes", ["private"]);
    await h.api.flushPersistedState();
  }
  assert.equal(accountA.stores[0].storeName, "reader_state_u12");
  assert.equal(accountB.stores[0].storeName, "reader_state_u45");
  assert.equal(local.stores[0].storeName, "reader_state");
  assert.equal(local.requests.length, 0);
  assert.equal(local.timers.size, 0);
});
