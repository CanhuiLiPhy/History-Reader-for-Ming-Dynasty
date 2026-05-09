#!/usr/bin/env node
// Dumps every event from the timeline service with its assigned category +
// scale, written to donotpack/database/明代大事年表-分级.txt for review.
// Two views:
//   1. Sorted by year (chronological audit)
//   2. Grouped by (category, scale) — easier to spot mis-classified clusters

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { queryTimelineEvents, getTimelineDistribution } from "../src/services/timeline-service.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const OUT = path.join(REPO_ROOT, "donotpack", "database", "明代大事年表-分级.txt");

const all = queryTimelineEvents({ from: 1350, to: 1666, minScale: 1, limit: 5000 });
const dist = getTimelineDistribution();

const lines = [];
lines.push("# 明代大事年表 — 分级与分类审查表");
lines.push("# 格式: <scale>★ [<category>] <year> <reign><reignYear>年 <description>");
lines.push("#");
lines.push("# === 总体分布 ===");
lines.push(`# total = ${dist.total} events`);
lines.push("# scale:");
const totalForPct = dist.total || 1;
for (let s = 5; s >= 1; s--) {
  const n = dist.byScale[s] || 0;
  const pct = ((100 * n) / totalForPct).toFixed(1);
  lines.push(`#   ${s}: ${String(n).padStart(4)}  (${pct.padStart(5)}%)`);
}
lines.push("# category:");
const cats = Object.entries(dist.byCategory).sort((a, b) => b[1] - a[1]);
for (const [c, n] of cats) {
  const pct = ((100 * n) / totalForPct).toFixed(1);
  lines.push(`#   ${c}: ${String(n).padStart(4)}  (${pct.padStart(5)}%)`);
}
lines.push("");

// View 1: chronological
lines.push("");
lines.push("================================================================");
lines.push("【按年份排列 (chronological)】");
lines.push("================================================================");
for (const e of all.events) {
  lines.push(`${e.scale}★ [${e.category.padEnd(2, "　")}] ${e.year} ${e.reign}${e.reignYearText}年 ${e.description}`);
}

// View 2: grouped by category + scale
lines.push("");
lines.push("");
lines.push("================================================================");
lines.push("【按 类别×分级 分组 (group by category × scale)】");
lines.push("================================================================");

const groups = new Map(); // key = `${category}|${scale}` → array of events
for (const e of all.events) {
  const key = `${e.category}|${e.scale}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(e);
}

const ALL_CATS = ["皇室","政争","制度","军事","民变","外交","经济","灾异","文化","人物","其他"];
for (const cat of ALL_CATS) {
  for (let scale = 5; scale >= 1; scale--) {
    const key = `${cat}|${scale}`;
    const arr = groups.get(key);
    if (!arr || !arr.length) continue;
    lines.push("");
    lines.push(`---------- [${cat}] ★${scale} (n=${arr.length}) ----------`);
    for (const e of arr) {
      lines.push(`  ${e.year} ${e.reign}${e.reignYearText}年 ${e.description}`);
    }
  }
}

fs.writeFileSync(OUT, lines.join("\n"), "utf8");
console.log(`✓ Wrote ${OUT}`);
console.log(`  ${all.events.length} events; ${groups.size} (cat × scale) groups`);
