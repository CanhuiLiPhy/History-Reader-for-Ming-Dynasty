#!/usr/bin/env node
/**
 * 从 backend/src/data/timeline-events.json 加载分类好的事件到 DB。
 *
 * 用途：
 *   - 安装后首次启动：start.sh 自动调用，把 git 里固化的分类导入空 DB
 *   - 手动重置：丢弃本地 DB 改动，回到 git 里的分类基线
 *
 * 用法：
 *   node backend/scripts/load-timeline-from-json.mjs           # 仅当表为空时导入
 *   node backend/scripts/load-timeline-from-json.mjs --force   # 不管多少行都覆盖
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DB_PATH = path.join(REPO_ROOT, "backend", ".cache", "library.sqlite");
const JSON_PATH = path.join(REPO_ROOT, "backend", "src", "data", "timeline-events.json");

const force = process.argv.includes("--force");

if (!fs.existsSync(JSON_PATH)) {
  console.error(`未找到 ${JSON_PATH}`);
  process.exit(1);
}

if (!fs.existsSync(path.dirname(DB_PATH))) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

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

const existing = db.prepare("SELECT COUNT(*) AS c FROM timeline_events").get().c;
if (existing > 0 && !force) {
  console.log(`timeline_events 已有 ${existing} 行，跳过（用 --force 强制重导）`);
  db.close();
  process.exit(0);
}

const payload = JSON.parse(fs.readFileSync(JSON_PATH, "utf8"));
const events = payload.events || [];
console.log(`从 JSON 加载 ${events.length} 个事件到 DB${existing > 0 ? "（覆盖原 " + existing + " 行）" : ""}`);

const insert = db.prepare(`
  INSERT INTO timeline_events (id, year, reign, reign_year_text, description, category, scale, source_line, hidden)
  VALUES (@id, @year, @reign, @reignYearText, @description, @category, @scale, @sourceLine, @hidden)
`);

const tx = db.transaction((rows) => {
  db.prepare("DELETE FROM timeline_events").run();
  db.prepare("DELETE FROM sqlite_sequence WHERE name='timeline_events'").run();
  for (const r of rows) {
    insert.run({
      id: r.id,
      year: r.year,
      reign: r.reign || "",
      reignYearText: r.reignYearText || "",
      description: r.description,
      category: r.category,
      scale: r.scale,
      sourceLine: r.sourceLine || null,
      hidden: r.hidden ? 1 : 0,
    });
  }
});
tx(events);

const after = db.prepare("SELECT COUNT(*) AS c FROM timeline_events").get().c;
console.log(`完成。DB 现有 ${after} 行 timeline_events`);
db.close();
