/**
 * Dump chapter openings with PUA chars (U+E000-U+F8FF) replaced by ▓ marker.
 *
 * I can read the marked version, write corrections also using ▓, and the
 * companion import script will substitute the actual PUA chars back.
 *
 * Usage:
 *   node backend/scripts/dump-with-pua-markers.mjs --ids 763448,763700,... --out <file>
 *   node backend/scripts/dump-with-pua-markers.mjs --flags-file /tmp/bad-flags.json --out <file>
 */
import fs from "node:fs";
import { getDb, initializeLibrary } from "../src/services/library-db.js";

function readArg(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? "" : (process.argv[i + 1] || "");
}

const IDS = readArg("--ids");
const FLAGS_FILE = readArg("--flags-file");
const OUT = readArg("--out") || "/tmp/pua-marked.json";

await initializeLibrary();
const db = getDb();

let ids = [];
if (IDS) ids = IDS.split(",").map(x => Number(x.trim())).filter(Boolean);
if (FLAGS_FILE) {
  const flags = JSON.parse(fs.readFileSync(FLAGS_FILE, "utf8"));
  ids = flags.map(f => f.id);
}
if (!ids.length) { console.error("Need --ids or --flags-file"); process.exit(1); }

const MARKER = "▓"; // ▓

function maskPUA(s) {
  let out = "";
  for (const c of s) {
    const cp = c.codePointAt(0);
    if (cp >= 0xE000 && cp <= 0xF8FF) out += MARKER;
    else out += c;
  }
  return out;
}

const out = [];
for (const id of ids) {
  const r = db.prepare("SELECT content FROM paragraphs WHERE id=?").get(id);
  if (!r) continue;
  out.push({ id, marked: maskPUA(r.content), has_pua: r.content !== maskPUA(r.content) });
}

fs.writeFileSync(OUT, JSON.stringify(out, null, 2), "utf8");
console.log(`dumped ${out.length} entries, PUA-using: ${out.filter(x=>x.has_pua).length}`);
