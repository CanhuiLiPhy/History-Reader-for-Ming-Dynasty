#!/usr/bin/env node
// Dumps the raw <tr>…</tr> from the MinerU markdown for every year listed on
// the command line (or the default suspicious set). Used to inspect whether
// the original OCR has month tokens that the parser missed, vs. months that
// were never captured at all.
//
//   node scripts/dump-source-rows.mjs 1411 1430 1411 1414 ...

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SRC = path.join(REPO_ROOT, "donotpack", "database", "MinerU_markdown_大事年表_2050501523587526656.md");

const YEARS = process.argv.slice(2).length
  ? process.argv.slice(2).map(Number)
  : [
      1384,1385,1386,1387,1410,1411,1412,1413,1414,
      1430,1431,1432,1433,1434,1462,1463,1476,1477,1478,
      1480,1481,1483,1484,1498,1540,1541,1542,1543,1544,1545,
      1557,1559,1578,1580,1581,1582,1583,1587,1590,
      1629,1631,1662,1663,1664,1665,1666,
    ];

const md = fs.readFileSync(SRC, "utf8");
const trRe = /<tr>([\s\S]*?)<\/tr>/g;
const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/g;

const yearSet = new Set(YEARS);
const collected = new Map(); // year → array of stringified-cell arrays

let m;
while ((m = trRe.exec(md))) {
  const cells = [];
  let c;
  cellRe.lastIndex = 0;
  while ((c = cellRe.exec(m[1]))) {
    cells.push(c[1].replace(/\s+/g, "").trim());
  }
  if (!cells.length) continue;
  for (const cell of cells) {
    if (/^\d{4}$/.test(cell) && yearSet.has(+cell)) {
      const year = +cell;
      if (!collected.has(year)) collected.set(year, []);
      collected.get(year).push(cells);
      break;
    }
  }
}

for (const year of YEARS) {
  const rows = collected.get(year);
  console.log("================================================================");
  console.log(`【${year}】`);
  if (!rows) { console.log("  （未找到该年份的行）"); continue; }
  for (const cells of rows) {
    console.log("  cells:");
    cells.forEach((c, i) => console.log(`    [${i}] ${c}`));
  }
}
