/**
 * Import manually-punctuated paragraphs (Claude in-context corrections).
 *
 * Input JSON: array of { id, content }
 * Validation: strip(content) must match strip(db.content) — i.e., no chars added/removed.
 *
 * Usage:
 *   node backend/scripts/import-manual-punct.mjs --in <file> [--dry-run]
 */
import fs from "node:fs";
import { getDb, initializeLibrary } from "../src/services/library-db.js";

function readArg(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? "" : (process.argv[i + 1] || "");
}
function hasFlag(flag) { return process.argv.includes(flag); }

const IN = readArg("--in");
const DRY = hasFlag("--dry-run");
if (!IN) { console.error("Usage: --in <file> [--dry-run]"); process.exit(1); }

const PUNCT = new Set("，。：；？！「」、,.:;?!\"'《》〈〉()（）—…—- 　\n\t\xa0");
function strip(s) { return [...s].filter(c => !PUNCT.has(c)).join(""); }

await initializeLibrary();
const db = getDb();
const select = db.prepare("SELECT content FROM paragraphs WHERE id = ?");
const update = db.prepare("UPDATE paragraphs SET content = ? WHERE id = ?");
const tx = db.transaction(items => {
  for (const { id, content } of items) update.run(content, id);
});

const rows = JSON.parse(fs.readFileSync(IN, "utf8"));
let ok = 0, mismatch = 0, missing = 0, sameAsExisting = 0;
const problems = [];
const updates = [];

for (const r of rows) {
  const cur = select.get(r.id);
  if (!cur) { missing++; problems.push({ id: r.id, note: "id not found" }); continue; }
  if (cur.content === r.content) { sameAsExisting++; continue; }
  if (strip(cur.content) !== strip(r.content)) {
    mismatch++;
    problems.push({ id: r.id, note: "char mismatch", curStrip: strip(cur.content).slice(0, 30), newStrip: strip(r.content).slice(0, 30) });
    continue;
  }
  updates.push({ id: r.id, content: r.content });
  ok++;
}

if (!DRY && updates.length) tx(updates);

console.log("=".repeat(60));
console.log(`Input rows:       ${rows.length}`);
console.log(`Updated:          ${ok} ${DRY ? "(dry-run)" : ""}`);
console.log(`Same as existing: ${sameAsExisting}`);
console.log(`Char mismatch:    ${mismatch}`);
console.log(`ID not found:     ${missing}`);
if (problems.length && problems.length <= 15) for (const p of problems) console.log("  ", p);
