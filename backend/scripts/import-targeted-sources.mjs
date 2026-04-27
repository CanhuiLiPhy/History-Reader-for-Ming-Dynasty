import { getLibraryDbPath, importReferenceSources, initializeLibrary } from "../src/services/library-db.js";

const DEFAULT_TARGETS = [
  "huangming-jingshi-wenbian",
  "zuiwei-lu",
  "shiku-shu",
  "guochao-dianhui",
  "mingshi-lu-wanli",
  "chongzhen-changbian",
  "sanchao-liaoshi-shilu"
];

function readArg(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return "";
  return process.argv[index + 1] || "";
}

const slugsArg = readArg("--slugs");
const maxPagesArg = readArg("--max-pages");
const delayMsArg = readArg("--delay-ms");
const slugs = slugsArg ? slugsArg.split(",").map((item) => item.trim()).filter(Boolean) : DEFAULT_TARGETS;
const maxPages = maxPagesArg ? Number.parseInt(maxPagesArg, 10) : undefined;
const delayMs = delayMsArg ? Number.parseInt(delayMsArg, 10) : 1800;

await initializeLibrary();
const results = await importReferenceSources(slugs, { maxPages, delayMs });

console.log(`SQLite database: ${getLibraryDbPath()}`);
console.log(`Targets: ${slugs.join(", ")}`);
for (const item of results) {
  const suffix = item.error ? ` ERROR: ${item.error}` : "";
  console.log(`${item.title}: imported ${item.pagesImported} pages / ${item.paragraphsImported} paragraphs${suffix}`);
}
