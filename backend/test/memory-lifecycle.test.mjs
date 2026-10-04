import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import * as url from "node:url";
import vm from "node:vm";
import { createBookCache } from "../src/services/book-cache.js";

test("parsed books share concurrent loads and evict the least recently used book", async () => {
  const calls = [];
  const cache = createBookCache(async (slug) => { calls.push(slug); return { slug }; });
  const [first, concurrent] = await Promise.all([cache.get("a"), cache.get("a")]);
  assert.equal(first, concurrent);
  await cache.get("b");
  assert.equal(await cache.get("a"), first);
  await cache.get("c");
  await cache.get("b");
  assert.deepEqual(calls, ["a", "b", "c", "b"]);
});

test("idle book entries expire and failed loads can be retried", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100_000 });
  let attempts = 0;
  const cache = createBookCache(async () => {
    if (++attempts === 1) throw new Error("temporary read failure");
    return { attempt: attempts };
  }, { idleMs: 100 });
  await assert.rejects(cache.get("a"), /temporary read failure/);
  const first = await cache.get("a");
  t.mock.timers.tick(99);
  assert.equal(await cache.get("a"), first);
  t.mock.timers.tick(101);
  assert.notEqual(await cache.get("a"), first);
  assert.equal(attempts, 3);
});

// Evaluate the real service with isolated subprocesses, clocks and SQLite.
// No model is loaded and no project library or credentials are accessed.
async function embeddingHarness({ databaseFails = false } = {}) {
  let now = 100_000;
  let dbClosed = 0;
  const timers = new Map();
  const processes = [];
  const setTimer = (callback, ms) => {
    const timer = { callback, due: now + ms, ms, unref() {} };
    timers.set(timer, timer);
    return timer;
  };
  const clearTimer = (timer) => timers.delete(timer);
  const advance = (ms) => {
    const end = now + ms;
    for (;;) {
      const next = [...timers.values()].filter((timer) => timer.due <= end)
        .sort((a, b) => a.due - b.due)[0];
      if (!next) break;
      now = next.due;
      timers.delete(next);
      next.callback();
    }
    now = end;
  };
  function spawn() {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = new EventEmitter();
    proc.stdin.destroyed = false;
    proc.requests = [];
    proc.signals = [];
    proc.exitCode = null;
    proc.signalCode = null;
    proc.stdin.write = (line, callback) => { proc.requests.push(JSON.parse(line)); callback?.(); };
    proc.stdin.end = () => { proc.stdin.destroyed = true; };
    proc.kill = (signal) => { proc.signals.push(signal); };
    proc.reply = (obj) => proc.stdout.emit("data", Buffer.from(JSON.stringify(obj) + "\n"));
    proc.finish = () => { proc.exitCode = 0; proc.emit("exit", 0); proc.emit("close", 0); };
    processes.push(proc);
    return proc;
  }
  class FakeDatabase {
    loadExtension() { if (databaseFails) throw new Error("bad extension"); }
    pragma() {}
    prepare() { return { get() { return 1; } }; }
    close() { dbClosed += 1; }
  }
  const context = vm.createContext({
    Buffer,
    console: { log() {}, warn() {} },
    process: { env: {}, platform: process.platform, arch: process.arch },
    Date: class extends Date { static now() { return now; } },
    setTimeout: setTimer,
    clearTimeout: clearTimer
  });
  const sourceUrl = new URL("../src/services/embedding-service.js", import.meta.url);
  const module = new vm.SourceTextModule(await fs.readFile(sourceUrl, "utf8"), {
    context,
    initializeImportMeta(meta) { meta.url = sourceUrl.href; }
  });
  const imports = {
    "node:child_process": { spawn },
    "node:fs": { default: { existsSync: (name) => name.endsWith(".py") || databaseFails } },
    "node:path": { default: path },
    "node:url": { fileURLToPath: url.fileURLToPath },
    "better-sqlite3": { default: FakeDatabase },
    "../config/defaults.js": { CACHE_ROOT: "/unused/cache" }
  };
  await module.link((specifier) => {
    const exports = imports[specifier];
    assert.ok(exports, `unexpected import ${specifier}`);
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context });
  });
  await module.evaluate();
  return { api: module.namespace, processes, timers, advance, dbClosed: () => dbClosed };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("successful concurrent embeddings clear request deadlines and only idle when all are done", async () => {
  const h = await embeddingHarness();
  const first = h.api.embedQuery("洪武");
  const second = h.api.embedQuery("永乐");
  assert.equal(h.processes.length, 1);
  const proc = h.processes[0];
  proc.reply({ event: "ready" });
  await flush();
  proc.reply({ id: proc.requests[0].id, embedding: [1, 2] });
  assert.deepEqual(Array.from(await first), [1, 2]);
  assert.deepEqual([...h.timers.values()].map((timer) => timer.ms), [16000]);
  proc.reply({ id: proc.requests[1].id, embedding: [3, 4] });
  await second;
  assert.deepEqual([...h.timers.values()].map((timer) => timer.ms), [90000]);
  h.advance(90000);
  assert.deepEqual(proc.signals, ["SIGTERM"]);
  proc.finish();
  assert.equal(h.timers.size, 0);
});

test("an old sidecar exiting cannot cancel a replacement's request", async () => {
  const h = await embeddingHarness();
  const first = h.api.embedQuery("洪武");
  const old = h.processes[0];
  old.reply({ event: "ready" });
  await flush();
  const rejected = assert.rejects(first, /sidecar stopped/);
  const stopped = h.api.shutdownSidecar();
  await rejected;
  const next = h.api.embedQuery("永乐");
  const replacement = h.processes[1];
  replacement.reply({ event: "ready" });
  await flush();
  old.finish();
  await stopped;
  replacement.reply({ id: replacement.requests[0].id, embedding: [5] });
  assert.deepEqual(Array.from(await next), [5]);
  const reused = h.api.embedQuery("万历");
  await flush();
  assert.equal(h.processes.length, 2);
  replacement.reply({ id: replacement.requests[1].id, embedding: [6] });
  await reused;
});

test("startup timeout terminates the model and permits retry after cooldown", async () => {
  const h = await embeddingHarness();
  const first = h.api.embedQuery("洪武");
  const rejected = assert.rejects(first, /ready timeout \(60s\)/);
  h.advance(60000);
  await rejected;
  assert.deepEqual(h.processes[0].signals, ["SIGTERM"]);
  const retry = h.api.embedQuery("永乐");
  assert.equal(h.processes.length, 2);
  const proc = h.processes[1];
  proc.reply({ event: "ready" });
  await flush();
  h.processes[0].finish();
  proc.reply({ id: proc.requests[0].id, embedding: [1] });
  await retry;
});

test("startup and stdin errors reject work without poisoning the next process", async () => {
  const h = await embeddingHarness();
  const first = h.api.embedQuery("洪武");
  const rejected = assert.rejects(first, /ENOENT/);
  h.processes[0].emit("error", new Error("ENOENT"));
  await rejected;
  await assert.rejects(h.api.embedQuery("永乐"), /cooldown/);
  h.processes[0].finish();
  h.advance(30000);
  const retry = h.api.embedQuery("永乐");
  const proc = h.processes[1];
  proc.reply({ event: "ready" });
  await flush();
  const pipeRejected = assert.rejects(retry, /EPIPE/);
  proc.stdin.emit("error", new Error("EPIPE"));
  await pipeRejected;
  assert.deepEqual(proc.signals, ["SIGTERM"]);
  proc.finish();
  assert.equal(h.timers.size, 0);
});

test("expired embedding responses are ignored and do not disrupt subsequent work", async () => {
  const h = await embeddingHarness();
  const first = h.api.embedQuery("洪武", 100);
  const proc = h.processes[0];
  proc.reply({ event: "ready" });
  await flush();
  const rejected = assert.rejects(first, /query timeout/);
  h.advance(100);
  await rejected;
  const second = h.api.embedQuery("永乐");
  await flush();
  proc.reply({ id: proc.requests[0].id, embedding: [0] });
  proc.reply({ id: proc.requests[1].id, embedding: [1] });
  assert.deepEqual(Array.from(await second), [1]);
  assert.deepEqual([...h.timers.values()].map((timer) => timer.ms), [90000]);
});

test("a reported model startup error releases the failed process and readiness timer", async () => {
  const h = await embeddingHarness();
  const first = h.api.embedQuery("洪武");
  const rejected = assert.rejects(first, /sidecar startup error: missing model/);
  const proc = h.processes[0];
  proc.reply({ event: "error", stage: "model_load", error: "missing model" });
  await rejected;
  assert.deepEqual(proc.signals, ["SIGTERM"]);
  assert.deepEqual([...h.timers.values()].map((timer) => timer.ms), [3000]);
  proc.finish();
  assert.equal(h.timers.size, 0);
  h.advance(30000);
  const next = h.api.embedQuery("永乐");
  const rejection = assert.rejects(next, /sidecar stopped/);
  assert.equal(h.processes.length, 2);
  h.api.shutdownSidecar();
  await rejection;
});

test("shutdown waits for child close and force-kills a model that ignores SIGTERM", async () => {
  const h = await embeddingHarness();
  const query = h.api.embedQuery("洪武");
  const proc = h.processes[0];
  proc.reply({ event: "ready" });
  await flush();
  proc.reply({ id: proc.requests[0].id, embedding: [1] });
  await query;
  let stopped = false;
  const shutdown = h.api.shutdownSidecar().then(() => { stopped = true; });
  await flush();
  assert.equal(stopped, false);
  h.advance(3000);
  await shutdown;
  assert.deepEqual(proc.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(h.timers.size, 0);
});

test("a failed vector database initialization closes its SQLite handle", async () => {
  const h = await embeddingHarness({ databaseFails: true });
  assert.equal(h.api.isAvailable(), false);
  assert.equal(h.dbClosed(), 1);
});
