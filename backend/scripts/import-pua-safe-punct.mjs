/**
 * Import manually-punctuated content that uses ▓ markers for PUA chars.
 *
 * Algorithm per row:
 *   1. Read DB's original content (with actual PUA chars)
 *   2. Walk my correction. For each char:
 *        - if ▓: take next PUA char from original; check it's actually PUA
 *        - if punct: append as-is (my added punct)
 *        - else (content char): must match next non-punct char in original
 *   3. After full walk: stripped(reconstructed) must equal stripped(original)
 *   4. If valid, UPDATE paragraphs.content = reconstructed
 *
 * Usage:
 *   node backend/scripts/import-pua-safe-punct.mjs --in <corrections.json> [--dry-run]
 *
 * corrections.json: array of { id, content: "...with ▓ markers..." }
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

const MARKER = "▓";
const PUNCT = new Set("，。：；？！「」、,.:;?!\"'《》〈〉()（）—…—-");
const WHITESPACE = new Set(" 　\t\n\xa0");

function isContent(c) {
  return !PUNCT.has(c) && !WHITESPACE.has(c) && c !== MARKER;
}
function isPUA(c) {
  const cp = c.codePointAt(0);
  return cp >= 0xE000 && cp <= 0xF8FF;
}

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
  const origChars = [...cur.content];
  const newChars = [...r.content];

  let oi = 0; // index into origChars
  let reconstructed = "";
  let bad = false;
  let badReason = "";

  for (let ni = 0; ni < newChars.length; ni++) {
    const nc = newChars[ni];
    if (nc === MARKER) {
      // skip whitespace/punct in original to find next PUA
      while (oi < origChars.length && !isContent(origChars[oi])) {
        reconstructed += origChars[oi];
        oi++;
      }
      if (oi >= origChars.length) { bad = true; badReason = "marker but no original char left"; break; }
      const oc = origChars[oi];
      if (!isPUA(oc)) { bad = true; badReason = `marker at new[${ni}] but orig[${oi}] '${oc}' (U+${oc.codePointAt(0).toString(16)}) is not PUA`; break; }
      reconstructed += oc;
      oi++;
    } else if (PUNCT.has(nc)) {
      // my added punct — skip any original punct/whitespace at this position
      while (oi < origChars.length && (PUNCT.has(origChars[oi]) || WHITESPACE.has(origChars[oi]))) {
        oi++;
      }
      reconstructed += nc;
    } else if (WHITESPACE.has(nc)) {
      // preserve whitespace from my version
      while (oi < origChars.length && (PUNCT.has(origChars[oi]) || WHITESPACE.has(origChars[oi]))) {
        oi++;
      }
      reconstructed += nc;
    } else {
      // content char — must match next content char in original
      while (oi < origChars.length && !isContent(origChars[oi])) {
        reconstructed += origChars[oi];
        oi++;
      }
      if (oi >= origChars.length) { bad = true; badReason = `content '${nc}' but original exhausted`; break; }
      if (origChars[oi] !== nc) {
        bad = true;
        badReason = `content mismatch at new[${ni}]='${nc}' vs orig[${oi}]='${origChars[oi]}' (U+${origChars[oi].codePointAt(0).toString(16)})`;
        break;
      }
      reconstructed += nc;
      oi++;
    }
  }
  // append any trailing whitespace/punct from original
  while (!bad && oi < origChars.length && !isContent(origChars[oi])) {
    reconstructed += origChars[oi];
    oi++;
  }
  if (!bad && oi < origChars.length) {
    bad = true;
    badReason = `original has ${origChars.length - oi} chars remaining unmatched (first: '${origChars[oi]}')`;
  }

  if (bad) {
    mismatch++;
    problems.push({ id: r.id, note: badReason });
    continue;
  }
  if (reconstructed === cur.content) { sameAsExisting++; continue; }
  updates.push({ id: r.id, content: reconstructed });
  ok++;
}

if (!DRY && updates.length) tx(updates);

console.log("=".repeat(60));
console.log(`Input rows:       ${rows.length}`);
console.log(`Updated:          ${ok} ${DRY ? "(dry-run)" : ""}`);
console.log(`Same as existing: ${sameAsExisting}`);
console.log(`Char mismatch:    ${mismatch}`);
console.log(`ID not found:     ${missing}`);
if (problems.length && problems.length <= 20) for (const p of problems) console.log("  ", p);
else if (problems.length) {
  console.log(`  ${problems.length} problems (first 10):`);
  for (const p of problems.slice(0, 10)) console.log("  ", p);
}
