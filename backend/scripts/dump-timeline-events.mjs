#!/usr/bin/env node
/**
 * Dump current timeline_events 表 → backend/src/data/timeline-events.json
 *
 * 包含全部字段（id, year, reign, reign_year_text, description, category,
 * scale, source_line, hidden）。开发者修改 DB 后跑此脚本，把分类结果固化到
 * git，这样别人 clone 仓库后用 load-timeline-from-json.mjs 能复现完全相同
 * 的分类状态。
 *
 * Usage:
 *   node backend/scripts/dump-timeline-events.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DB_PATH = path.join(REPO_ROOT, "backend", ".cache", "library.sqlite");
const OUT_PATH = path.join(REPO_ROOT, "backend", "src", "data", "timeline-events.json");

const db = new Database(DB_PATH, { readonly: true });
const rows = db.prepare(
  `SELECT id, year, reign, reign_year_text AS reignYearText, description,
          category, scale, source_line AS sourceLine, hidden
   FROM timeline_events ORDER BY year ASC, source_line ASC`
).all();
db.close();

const dist = { byCategory: {}, byScale: {} };
for (const r of rows) {
  dist.byCategory[r.category] = (dist.byCategory[r.category] || 0) + 1;
  dist.byScale[r.scale] = (dist.byScale[r.scale] || 0) + 1;
}

const payload = {
  exportedAt: new Date().toISOString(),
  total: rows.length,
  distribution: dist,
  events: rows,
};

fs.writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2), "utf8");
console.log(`exported ${rows.length} events → ${OUT_PATH}`);
console.log("category:", JSON.stringify(dist.byCategory));
console.log("scale:", JSON.stringify(dist.byScale));
