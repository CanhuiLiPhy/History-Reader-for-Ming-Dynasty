/**
 * 中文：每本书「上次读到哪一页」的精确记录（页首那个字），与旧的 last-location 并存，重新打开时据此回到同一页。
 *
 * Precise per-book reading position, persisted next to the legacy
 * `last-location:<slug>` value so that reopening a book (page reload, or
 * switching away and back) lands on the page whose first character the reader
 * last saw — not on the paragraph start or the chapter start.
 *
 * Why the legacy value is not enough:
 * - EPUB: `last-location` is epub.js's `location.start.cfi`. For Chinese text,
 *   which has no spaces, it points at the start of the first visible text
 *   node, i.e. the start of the whole paragraph, often pages earlier. It is
 *   also generated on the year-annotated DOM, whose text-node indices do not
 *   exist yet in the freshly rendered section epub.js resolves it against when
 *   the book is reopened, so it can fall back to the chapter start.
 * - Paragraph books keep no position at all and reopen at chapter 0.
 *
 * A record carries a {@link TextAnchor} from `reflow-anchor.ts`: a character
 * offset over all text of the section / chapter plus a short context string.
 * Element structure (annotation spans, highlights) does not affect it, so it
 * resolves in the fresh document as well as in the annotated one.
 *
 * An EPUB record also stores the `last-location` CFI it was saved with and is
 * applied only when the book is reopened at exactly that CFI. Anything else —
 * a cross-book search jump, data written before this record existed, a CFI
 * saved while no record could be taken — keeps the legacy behaviour.
 *
 * DOM-free, so the save / restore decisions are unit-tested in Node.
 */
import type { TextAnchor } from "./reflow-anchor";

/** 中文：记录格式版本号。 / Format version stamped on every record. */
export const READING_POSITION_VERSION = 1;

/** 中文：记录里最多保存的上下文字数。 / Longest context string a record keeps. */
const MAX_CONTEXT_LENGTH = 64;

/**
 * 中文：EPUB 书的精确阅读位置。
 *
 * Reading position in an EPUB book.
 *
 * @property v - Format version, {@link READING_POSITION_VERSION}.
 * @property kind - Always `"epub"`.
 * @property cfi - The `last-location` CFI saved at the same moment. The record
 *   only applies when the book is reopened at exactly this CFI.
 * @property sectionIndex - Spine index of the section holding the anchor.
 * @property offset - Anchor offset (UTF-16 code units) over the section text.
 * @property context - Text starting at `offset`, used to verify / recover it.
 */
export type EpubReadingPosition = TextAnchor & {
  v: typeof READING_POSITION_VERSION;
  kind: "epub";
  cfi: string;
  sectionIndex: number;
};

/**
 * 中文：段落书（无 EPUB）的精确阅读位置。
 *
 * Reading position in a paragraph (non-EPUB) book.
 *
 * @property v - Format version, {@link READING_POSITION_VERSION}.
 * @property kind - Always `"db"`.
 * @property chapterIndex - Zero-based index into the book's chapter list.
 * @property offset - Anchor offset (UTF-16 code units) over the chapter text.
 * @property context - Text starting at `offset`, used to verify / recover it.
 */
export type DbReadingPosition = TextAnchor & {
  v: typeof READING_POSITION_VERSION;
  kind: "db";
  chapterIndex: number;
};

/** 中文：两类书的阅读位置。 / A reading position of either book kind. */
export type ReadingPosition = EpubReadingPosition | DbReadingPosition;

/**
 * 中文：某本书阅读位置的存储键名（不含全局前缀）。
 *
 * Storage name of a book's reading position, without the app-wide prefix.
 *
 * @param slug - Book slug, e.g. `"ming-shi"`.
 * @returns `"reading-position:<slug>"`.
 */
export function readingPositionStorageName(slug: string): string {
  return `reading-position:${slug}`;
}

/**
 * 中文：判断是否为非负整数。
 *
 * @param value - Any value.
 * @returns True for a finite integer ≥ 0.
 */
function isIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * 中文：校验并规整锚点部分（偏移 + 上下文）。
 *
 * Validate the anchor part of a record.
 *
 * @param offset - Candidate character offset.
 * @param context - Candidate context string.
 * @returns A clean anchor (context capped at {@link MAX_CONTEXT_LENGTH}), or
 *   `null` when the offset is not a non-negative integer or the context is
 *   not a string.
 */
function cleanAnchor(offset: unknown, context: unknown): TextAnchor | null {
  if (!isIndex(offset) || typeof context !== "string") return null;
  return { offset, context: context.slice(0, MAX_CONTEXT_LENGTH) };
}

/**
 * 中文：生成 EPUB 阅读位置记录。
 *
 * Build the record saved for an EPUB book.
 *
 * @param cfi - The CFI being saved as `last-location` at the same moment.
 * @param sectionIndex - Spine index of the section on display.
 * @param anchor - First character of the page on display (or the anchor the
 *   reader's position is held at).
 * @returns The record, or `null` when an input is unusable.
 */
export function epubReadingPosition(cfi: string, sectionIndex: number, anchor: TextAnchor | null): EpubReadingPosition | null {
  const clean = anchor ? cleanAnchor(anchor.offset, anchor.context) : null;
  if (!clean || typeof cfi !== "string" || !cfi.startsWith("epubcfi(") || !isIndex(sectionIndex)) return null;
  return { v: READING_POSITION_VERSION, kind: "epub", cfi, sectionIndex, ...clean };
}

/**
 * 中文：生成段落书阅读位置记录。
 *
 * Build the record saved for a paragraph book.
 *
 * @param chapterIndex - Zero-based index of the chapter on display.
 * @param anchor - First character of the page on display (or the anchor the
 *   reader's position is held at).
 * @returns The record, or `null` when an input is unusable.
 */
export function dbReadingPosition(chapterIndex: number, anchor: TextAnchor | null): DbReadingPosition | null {
  const clean = anchor ? cleanAnchor(anchor.offset, anchor.context) : null;
  if (!clean || !isIndex(chapterIndex)) return null;
  return { v: READING_POSITION_VERSION, kind: "db", chapterIndex, ...clean };
}

/**
 * 中文：校验从存储里读回的值；格式不对（旧数据、损坏、手改）一律当作没有记录。
 *
 * Validate a value read back from storage. Anything malformed — missing
 * fields, another version, a corrupted or hand-edited entry — is treated as
 * "no record", which keeps the legacy behaviour.
 *
 * @param value - Raw value from the persistence layer.
 * @returns A clean record, or `null`.
 */
export function parseReadingPosition(value: unknown): ReadingPosition | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.v !== READING_POSITION_VERSION) return null;
  if (record.kind === "epub") {
    return epubReadingPosition(record.cfi as string, record.sectionIndex as number, record as unknown as TextAnchor);
  }
  if (record.kind === "db") {
    return dbReadingPosition(record.chapterIndex as number, record as unknown as TextAnchor);
  }
  return null;
}

/**
 * 中文：重新打开 EPUB 时要恢复的位置：只有记录与这次打开所用的 CFI 完全一致才恢复。
 *
 * The EPUB position to restore when a book is opened at `openingCfi`.
 *
 * @param value - Raw stored value (validated here).
 * @param openingCfi - The location the reader is about to display, normally
 *   the saved `last-location`; a search jump passes a chapter href instead.
 * @returns The record when it is an EPUB record saved with exactly this CFI,
 *   else `null` (the caller then keeps the legacy placement).
 */
export function epubPositionToRestore(value: unknown, openingCfi: string): EpubReadingPosition | null {
  const record = parseReadingPosition(value);
  return record?.kind === "epub" && Boolean(openingCfi) && record.cfi === openingCfi ? record : null;
}

/**
 * 中文：重新打开段落书时要恢复的位置：章节序号必须仍在目录范围内。
 *
 * The paragraph-book position to restore.
 *
 * @param value - Raw stored value (validated here).
 * @param chapterCount - Number of chapters the book has now.
 * @returns The record when it is a paragraph-book record whose chapter still
 *   exists, else `null` (the caller then opens chapter 0 as before).
 */
export function dbPositionToRestore(value: unknown, chapterCount: number): DbReadingPosition | null {
  const record = parseReadingPosition(value);
  return record?.kind === "db" && record.chapterIndex < chapterCount ? record : null;
}

/**
 * 中文：两条记录是否完全相同，用来跳过重复写入。
 *
 * Whether two records are identical, so an unchanged position is not written
 * again on every location report.
 *
 * @param a - A record or `null`.
 * @param b - A record or `null`.
 * @returns True when both are `null` or every field matches.
 */
export function sameReadingPosition(a: ReadingPosition | null, b: ReadingPosition | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind || a.offset !== b.offset || a.context !== b.context) return false;
  if (a.kind === "epub" && b.kind === "epub") return a.cfi === b.cfi && a.sectionIndex === b.sectionIndex;
  return a.kind === "db" && b.kind === "db" && a.chapterIndex === b.chapterIndex;
}
