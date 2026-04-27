PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  author TEXT DEFAULT '',
  dynasty TEXT DEFAULT '明',
  category TEXT NOT NULL DEFAULT 'reference',
  source_type TEXT NOT NULL DEFAULT 'manual',
  source_url TEXT DEFAULT '',
  description TEXT DEFAULT '',
  imported_at TEXT DEFAULT CURRENT_TIMESTAMP,
  chapter_count INTEGER NOT NULL DEFAULT 0,
  paragraph_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS paragraphs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  chapter TEXT NOT NULL,
  chapter_order INTEGER NOT NULL DEFAULT 0,
  anchor TEXT DEFAULT '',
  paragraph_hash TEXT NOT NULL UNIQUE,
  content TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_paragraphs_book_chapter_order
  ON paragraphs(book_id, chapter_order, id);

CREATE INDEX IF NOT EXISTS idx_paragraphs_anchor
  ON paragraphs(anchor);

CREATE VIRTUAL TABLE IF NOT EXISTS paragraphs_fts USING fts5(
  content,
  chapter,
  tokenize = 'trigram',
  content = 'paragraphs',
  content_rowid = 'id'
);

CREATE TRIGGER IF NOT EXISTS paragraphs_ai AFTER INSERT ON paragraphs BEGIN
  INSERT INTO paragraphs_fts(rowid, content, chapter)
  VALUES (new.id, new.content, new.chapter);
END;

CREATE TRIGGER IF NOT EXISTS paragraphs_ad AFTER DELETE ON paragraphs BEGIN
  INSERT INTO paragraphs_fts(paragraphs_fts, rowid, content, chapter)
  VALUES ('delete', old.id, old.content, old.chapter);
END;

CREATE TRIGGER IF NOT EXISTS paragraphs_au AFTER UPDATE ON paragraphs BEGIN
  INSERT INTO paragraphs_fts(paragraphs_fts, rowid, content, chapter)
  VALUES ('delete', old.id, old.content, old.chapter);
  INSERT INTO paragraphs_fts(rowid, content, chapter)
  VALUES (new.id, new.content, new.chapter);
END;
