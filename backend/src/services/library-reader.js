import { getDb, initializeLibrary } from "./library-db.js";
import { bookEpubExists, listEpubBookSlugs, DEFAULT_BOOK_SLUG } from "./book-service.js";

/**
 * Returns all readable books with reading-relevant metadata.
 * A book is considered readable if it has an EPUB OR has paragraphs in DB.
 */
export async function getReadableBooks() {
  await initializeLibrary();
  const db = getDb();
  const rows = db.prepare(`
    SELECT slug, title, author, dynasty, category, description,
           chapter_count AS chapterCount, paragraph_count AS paragraphCount
    FROM books
    ORDER BY CASE WHEN slug = 'ming-shi' THEN 0 ELSE 1 END,
             CASE WHEN category = 'base' THEN 0 ELSE 1 END,
             title
  `).all();

  // EPUB-only books not yet in DB (rare, but we want to surface them)
  const epubSlugs = new Set(listEpubBookSlugs());
  const dbSlugs = new Set(rows.map((r) => r.slug));

  const result = [];
  for (const row of rows) {
    const hasEpub = epubSlugs.has(row.slug);
    if (!hasEpub && row.paragraphCount === 0) continue; // skip empty books
    const charCount = computeCharCount(db, row.slug);
    result.push({
      slug: row.slug,
      title: row.title,
      author: row.author || "",
      dynasty: row.dynasty || "",
      category: row.category || "reference",
      description: row.description || "",
      chapterCount: row.chapterCount || 0,
      paragraphCount: row.paragraphCount || 0,
      charCount,
      hasEpub
    });
  }
  // Add any EPUB-only books missing from DB
  for (const slug of epubSlugs) {
    if (!dbSlugs.has(slug)) {
      result.push({
        slug,
        title: slug,
        author: "",
        dynasty: "",
        category: "epub-only",
        description: "",
        chapterCount: 0,
        paragraphCount: 0,
        charCount: 0,
        hasEpub: true
      });
    }
  }
  return result;
}

const charCountCache = new Map();
function computeCharCount(db, slug) {
  if (charCountCache.has(slug)) return charCountCache.get(slug);
  const row = db.prepare(`
    SELECT COALESCE(SUM(LENGTH(p.content)), 0) AS total
    FROM paragraphs p
    JOIN books b ON b.id = p.book_id
    WHERE b.slug = ?
  `).get(slug);
  const total = Number(row?.total || 0);
  charCountCache.set(slug, total);
  return total;
}

/**
 * Returns chapter list (for DB-reader sidebar TOC) of a book.
 */
export async function getReaderChapters(slug) {
  await initializeLibrary();
  const db = getDb();
  const book = db.prepare("SELECT id, title, author FROM books WHERE slug = ?").get(slug);
  if (!book) return null;
  const chapters = db.prepare(`
    SELECT chapter, chapter_order AS chapterOrder,
           COUNT(*) AS paragraphCount,
           COALESCE(SUM(LENGTH(content)), 0) AS charCount
    FROM paragraphs
    WHERE book_id = ?
    GROUP BY chapter, chapter_order
    ORDER BY chapter_order, chapter
  `).all(book.id);
  return {
    slug,
    title: book.title,
    author: book.author || "",
    chapters: chapters.map((c, index) => ({
      order: index,
      rawOrder: c.chapterOrder,
      label: c.chapter,
      paragraphCount: c.paragraphCount,
      charCount: Number(c.charCount || 0)
    }))
  };
}

/**
 * Returns paragraphs of a chapter (DB-reader content).
 */
export async function getReaderChapter(slug, chapterIndex) {
  await initializeLibrary();
  const db = getDb();
  const book = db.prepare("SELECT id, title FROM books WHERE slug = ?").get(slug);
  if (!book) return null;

  const chapters = db.prepare(`
    SELECT chapter, chapter_order AS chapterOrder
    FROM paragraphs
    WHERE book_id = ?
    GROUP BY chapter, chapter_order
    ORDER BY chapter_order, chapter
  `).all(book.id);

  const target = chapters[chapterIndex];
  if (!target) return null;

  const rows = db.prepare(`
    SELECT id, content, paragraph_hash AS paragraphHash, anchor
    FROM paragraphs
    WHERE book_id = ? AND chapter = ? AND chapter_order = ?
    ORDER BY id
  `).all(book.id, target.chapter, target.chapterOrder);

  return {
    slug,
    bookTitle: book.title,
    chapter: target.chapter,
    chapterIndex,
    rawOrder: target.chapterOrder,
    chapterCount: chapters.length,
    paragraphs: rows.map((r) => ({
      id: r.id,
      content: r.content,
      hash: r.paragraphHash,
      anchor: r.anchor || ""
    }))
  };
}

export { DEFAULT_BOOK_SLUG, bookEpubExists };
