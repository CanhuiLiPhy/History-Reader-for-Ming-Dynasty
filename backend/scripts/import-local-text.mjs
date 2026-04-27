import { getLibraryDbPath, importLocalTextSource, initializeLibrary } from "../src/services/library-db.js";

function readArg(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return "";
  return process.argv[index + 1] || "";
}

const slug = readArg("--slug");
const filePath = readArg("--file");
const chapterRegex = readArg("--chapter-regex");
const anchor = readArg("--anchor");

if (!slug || !filePath) {
  console.error("Usage: node backend/scripts/import-local-text.mjs --slug <book-slug> --file <text-file> [--chapter-regex '^卷'] [--anchor 'local://source']");
  process.exit(1);
}

await initializeLibrary();
const result = await importLocalTextSource(slug, filePath, {
  chapterRegex: chapterRegex || undefined,
  anchor: anchor || undefined
});

console.log(`SQLite database: ${getLibraryDbPath()}`);
console.log(`${result.title}: imported ${result.pagesImported} chapters / ${result.paragraphsImported} paragraphs from ${result.filePath}`);
