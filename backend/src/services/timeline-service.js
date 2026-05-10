/**
 * Timeline runtime service — DB-backed.
 *
 * The classifier and source-text parser have been moved to
 * `backend/scripts/build-timeline.mjs`, which writes all classified events
 * into the `timeline_events` table inside `library.sqlite`. This module is a
 * thin SQL layer on top of that table.
 *
 * Manual edits: run any SQLite client and `UPDATE timeline_events SET ...`
 * — there is no in-memory cache, so changes show up on the next request.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "./library-db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TIMELINE_JSON_PATH = path.join(__dirname, "..", "data", "timeline-events.json");

export const ALL_CATEGORIES = ["皇室","政争","制度","军事","民变","外交","经济","灾异","文化","人物","其他"];

let bootstrapDone = false;

function ensureTable() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS timeline_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      year INTEGER NOT NULL,
      reign TEXT,
      reign_year_text TEXT,
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      scale INTEGER NOT NULL CHECK (scale BETWEEN 1 AND 5),
      source_line INTEGER,
      hidden INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_timeline_year ON timeline_events(year);
    CREATE INDEX IF NOT EXISTS idx_timeline_category ON timeline_events(category);
    CREATE INDEX IF NOT EXISTS idx_timeline_scale ON timeline_events(scale);
  `);

  // 首次启动若表为空，从打包随附的 JSON 引导分类数据。
  if (!bootstrapDone) {
    bootstrapDone = true;
    const count = db.prepare("SELECT COUNT(*) AS c FROM timeline_events").get().c;
    if (count === 0 && fs.existsSync(TIMELINE_JSON_PATH)) {
      try {
        const payload = JSON.parse(fs.readFileSync(TIMELINE_JSON_PATH, "utf8"));
        const events = payload.events || [];
        const insert = db.prepare(
          `INSERT INTO timeline_events (id, year, reign, reign_year_text, description, category, scale, source_line, hidden)
           VALUES (@id, @year, @reign, @reignYearText, @description, @category, @scale, @sourceLine, @hidden)`
        );
        const tx = db.transaction((rows) => {
          for (const r of rows) insert.run({
            id: r.id, year: r.year,
            reign: r.reign || "", reignYearText: r.reignYearText || "",
            description: r.description, category: r.category, scale: r.scale,
            sourceLine: r.sourceLine || null, hidden: r.hidden ? 1 : 0,
          });
        });
        tx(events);
        console.log(`[timeline] 引导 ${events.length} 条分类数据 ← timeline-events.json`);
      } catch (e) {
        console.warn(`[timeline] 引导失败: ${e.message}`);
      }
    }
  }
}

export function listAllTimelineEvents({ includeHidden = true } = {}) {
  ensureTable();
  const db = getDb();
  const where = includeHidden ? "" : "WHERE hidden = 0";
  return db.prepare(
    `SELECT id, year, reign, reign_year_text AS reignYearText, description, category, scale, hidden, source_line AS sourceLine
     FROM timeline_events ${where}
     ORDER BY year ASC, source_line ASC`
  ).all();
}

export function patchTimelineEvent(id, patch) {
  ensureTable();
  const db = getDb();
  const fields = [];
  const params = {};
  if (patch.category != null) {
    if (!ALL_CATEGORIES.includes(patch.category)) throw new Error(`invalid category: ${patch.category}`);
    fields.push("category = @category"); params.category = patch.category;
  }
  if (patch.scale != null) {
    const s = Number(patch.scale);
    if (!Number.isInteger(s) || s < 1 || s > 5) throw new Error(`invalid scale: ${patch.scale}`);
    fields.push("scale = @scale"); params.scale = s;
  }
  if (patch.description != null) {
    fields.push("description = @description"); params.description = String(patch.description).trim();
  }
  if (patch.hidden != null) {
    fields.push("hidden = @hidden"); params.hidden = patch.hidden ? 1 : 0;
  }
  if (patch.year != null) {
    const y = Number(patch.year);
    if (!Number.isInteger(y) || y < 1300 || y > 1700) throw new Error(`invalid year: ${patch.year}`);
    fields.push("year = @year"); params.year = y;
  }
  if (patch.reign != null) {
    fields.push("reign = @reign"); params.reign = String(patch.reign);
  }
  if (patch.reignYearText != null) {
    fields.push("reign_year_text = @reignYearText"); params.reignYearText = String(patch.reignYearText);
  }
  if (!fields.length) return null;
  params.id = id;
  db.prepare(`UPDATE timeline_events SET ${fields.join(", ")} WHERE id = @id`).run(params);
  return db.prepare(`SELECT id, year, reign, reign_year_text AS reignYearText, description, category, scale, hidden FROM timeline_events WHERE id = ?`).get(id);
}

export function deleteTimelineEvent(id) {
  ensureTable();
  const db = getDb();
  return db.prepare("DELETE FROM timeline_events WHERE id = ?").run(id);
}

export function createTimelineEvent({ year, reign = "", reignYearText = "", description, category, scale }) {
  ensureTable();
  if (!ALL_CATEGORIES.includes(category)) throw new Error(`invalid category: ${category}`);
  const s = Number(scale);
  if (!Number.isInteger(s) || s < 1 || s > 5) throw new Error(`invalid scale: ${scale}`);
  const y = Number(year);
  if (!Number.isInteger(y) || y < 1300 || y > 1700) throw new Error(`invalid year: ${year}`);
  const db = getDb();
  const result = db.prepare(
    `INSERT INTO timeline_events (year, reign, reign_year_text, description, category, scale)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(y, reign, reignYearText, String(description).trim(), category, s);
  return db.prepare(`SELECT * FROM timeline_events WHERE id = ?`).get(result.lastInsertRowid);
}

/**
 * Query events. All filters optional.
 *   from / to   — gregorian year range (inclusive)
 *   reign       — match by reign name (e.g. "嘉靖")
 *   scales      — array of importance levels (1-5) to include; omit/empty = all
 *   minScale    — legacy: only events with scale >= this (overridden by scales)
 *   categories  — array of category names to include (omit/empty = all)
 *   limit       — max events returned (default 200)
 */
export function queryTimelineEvents({ from, to, reign, minScale = 1, scales, categories, limit = 200 } = {}) {
  ensureTable();
  const db = getDb();

  const where = ["hidden = 0"];
  const params = [];
  if (typeof from === "number") { where.push("year >= ?"); params.push(from); }
  if (typeof to === "number") { where.push("year <= ?"); params.push(to); }
  if (reign) { where.push("reign = ?"); params.push(reign); }
  if (Array.isArray(scales) && scales.length > 0) {
    where.push(`scale IN (${scales.map(() => "?").join(",")})`);
    params.push(...scales);
  } else if (minScale > 1) {
    where.push("scale >= ?");
    params.push(minScale);
  }
  if (Array.isArray(categories) && categories.length > 0) {
    where.push(`category IN (${categories.map(() => "?").join(",")})`);
    params.push(...categories);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = db.prepare(`SELECT COUNT(*) AS c FROM timeline_events ${whereSql}`).get(...params).c;
  const rows = db.prepare(
    `SELECT id, year, reign, reign_year_text AS reignYearText, description, category, scale
     FROM timeline_events ${whereSql}
     ORDER BY year ASC, source_line ASC
     LIMIT ?`
  ).all(...params, limit);
  const bounds = db.prepare("SELECT MIN(year) AS lo, MAX(year) AS hi FROM timeline_events").get();
  return {
    total,
    events: rows,
    yearMin: bounds.lo ?? 1368,
    yearMax: bounds.hi ?? 1644,
  };
}

export function getTimelineSummary() {
  ensureTable();
  const db = getDb();
  const r = db.prepare("SELECT COUNT(*) AS c, MIN(year) AS lo, MAX(year) AS hi FROM timeline_events").get();
  return { eventCount: r.c, yearMin: r.lo ?? 1368, yearMax: r.hi ?? 1644 };
}

export function getTimelineDistribution() {
  ensureTable();
  const db = getDb();
  const total = db.prepare("SELECT COUNT(*) AS c FROM timeline_events").get().c;
  const byScale = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const r of db.prepare("SELECT scale, COUNT(*) AS c FROM timeline_events GROUP BY scale").all()) {
    byScale[r.scale] = r.c;
  }
  const byCategory = Object.fromEntries(ALL_CATEGORIES.map((c) => [c, 0]));
  for (const r of db.prepare("SELECT category, COUNT(*) AS c FROM timeline_events GROUP BY category").all()) {
    byCategory[r.category] = r.c;
  }
  return { total, byScale, byCategory };
}
