import fs from "node:fs/promises";
import path from "node:path";
import cors from "cors";
import express from "express";
import mime from "mime-types";
import { FRONTEND_DIST, PORT, getPublicDefaults } from "./config/defaults.js";
import { explainReignTerm } from "./data/reign-map.js";
import { buildPersonChronology, getBookMeta, getContextSnippets, searchBook, searchAcrossBooks, searchFuzzy, resolveBookEpubPath, bookEpubExists, DEFAULT_BOOK_SLUG, lookupBiographicalReferences } from "./services/book-service.js";
import { aiReady, expandSearchIntent, resolveAiSettings, runReaderAction, synthesizeSpeech } from "./services/ai-service.js";
import { initializeLibrary } from "./services/library-db.js";
import { ensureSplitEpub } from "./services/epub-splitter.js";
import { getReadableBooks, getReaderChapters, getReaderChapter } from "./services/library-reader.js";
import { queryTimelineEvents, ALL_CATEGORIES, listAllTimelineEvents, patchTimelineEvent, deleteTimelineEvent, createTimelineEvent } from "./services/timeline-service.js";
import {
  answerReadingQuestion,
  convertChronologyTerm,
  ensureReferenceLibraryReady,
  getAuxiliaryDatasetSummary,
  getEmperorPayload,
  getGeographyPayload,
  getOfficialsPayload,
  getTimelinePayload,
  geocodePlaces,
  lookupReadingReference,
  runCrossSourceComparison,
  searchOfficeReferences
} from "./services/reference-service.js";

const app = express();

app.use(cors());
app.use(express.json({ limit: "4mb" }));

// Disable caching for all responses during development
app.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/settings/defaults", (_req, res) => {
  res.json(getPublicDefaults());
});

app.get("/api/reference/overview", async (_req, res, next) => {
  try {
    const payload = await ensureReferenceLibraryReady();
    res.json({
      ...payload,
      datasets: getAuxiliaryDatasetSummary()
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/book/meta", async (req, res, next) => {
  try {
    const slug = String(req.query.slug || DEFAULT_BOOK_SLUG).trim() || DEFAULT_BOOK_SLUG;
    const meta = await getBookMeta(slug);
    res.json(meta);
  } catch (error) {
    next(error);
  }
});

// New: list all readable books
app.get("/api/library/books", async (_req, res, next) => {
  try {
    const books = await getReadableBooks();
    res.json({ books });
  } catch (error) {
    next(error);
  }
});

// New: chapter list for DB-reader (non-EPUB books)
app.get("/api/library/books/:slug/chapters", async (req, res, next) => {
  try {
    const slug = String(req.params.slug || "").trim();
    if (!slug) { res.status(400).json({ error: "缺少 slug。" }); return; }
    const data = await getReaderChapters(slug);
    if (!data) { res.status(404).json({ error: "未找到该书。" }); return; }
    res.json(data);
  } catch (error) {
    next(error);
  }
});

// New: chapter content for DB-reader
app.get("/api/library/books/:slug/chapter/:index", async (req, res, next) => {
  try {
    const slug = String(req.params.slug || "").trim();
    const index = Number.parseInt(String(req.params.index || "0"), 10);
    if (!slug) { res.status(400).json({ error: "缺少 slug。" }); return; }
    if (!Number.isFinite(index) || index < 0) { res.status(400).json({ error: "章节索引无效。" }); return; }
    const data = await getReaderChapter(slug, index);
    if (!data) { res.status(404).json({ error: "未找到该章节。" }); return; }
    res.json(data);
  } catch (error) {
    next(error);
  }
});

// New: per-book EPUB blob (for books that ship an EPUB file).
// URL ends in `.epub` so epub.js's URL sniffer treats this as a zip blob
// rather than a directory base URL (which would make it fetch META-INF/container.xml).
app.get("/api/library/books/:slug/source.epub", async (req, res, next) => {
  try {
    const slug = String(req.params.slug || "").trim();
    if (!slug) { res.status(400).json({ error: "缺少 slug。" }); return; }
    if (!bookEpubExists(slug)) { res.status(404).json({ error: "该书无 EPUB 文件。" }); return; }
    const epubPath = resolveBookEpubPath(slug);
    try {
      const splitPath = await ensureSplitEpub(epubPath);
      const stat = await fs.stat(splitPath);
      res.type("application/epub+zip");
      res.setHeader("Content-Length", stat.size);
      const { createReadStream } = await import("node:fs");
      createReadStream(splitPath).pipe(res);
    } catch (splitError) {
      console.error("epub-splitter failed for", slug, splitError.message, "→ serving original");
      const stat = await fs.stat(epubPath);
      res.type("application/epub+zip");
      res.setHeader("Content-Length", stat.size);
      const { createReadStream } = await import("node:fs");
      createReadStream(epubPath).pipe(res);
    }
  } catch (error) {
    next(error);
  }
});

async function handleBookSearch(req, res, next) {
  try {
    const payload = req.method === "POST" ? req.body || {} : req.query;
    const query = String(payload.q || "").trim();
    // 三种模式：
    //   local —— 本地检索（FTS5 trigram 子串 + LIKE 回退，简繁双展）
    //   fuzzy —— 模糊检索（bigram 覆盖度评分 + 简繁双展）
    //   ai    —— AI 意图检索（先让 LLM 改写 / 扩展查询，再走 local；失败或
    //            空命中时自动回落到 fuzzy）
    // 兼容老前端的 "hybrid" → 视作 local。
    const rawMode = String(payload.mode || "local");
    const mode = rawMode === "hybrid" ? "local" : rawMode;
    // Mode-specific defaults when frontend doesn't pass an explicit limit:
    //   local 100 / fuzzy 50 / ai 80
    const MODE_DEFAULT_LIMIT = { local: 100, fuzzy: 50, ai: 80 };
    const limit = payload.limit
      ? Number.parseInt(String(payload.limit), 10)
      : MODE_DEFAULT_LIMIT[mode] ?? 50;

    let slugs = Array.isArray(payload.slugs)
      ? payload.slugs
      : typeof payload.slugs === "string" && payload.slugs.trim()
      ? payload.slugs.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
    if (!slugs.length && payload.slug && String(payload.slug).trim()) {
      slugs = [String(payload.slug).trim()];
    }
    const aiSettings = resolveAiSettings(payload.aiSettings || {
      baseURL: payload.baseURL,
      apiKey: payload.apiKey,
      model: payload.model
    });

    let expandedQueries = [];
    let aiExpansion = null;

    if (mode === "ai" && query && aiReady(aiSettings)) {
      try {
        aiExpansion = await expandSearchIntent(query, aiSettings);
        expandedQueries = [
          ...(aiExpansion?.keywords || []),
          ...(aiExpansion?.people || []),
          ...(aiExpansion?.timeHints || []),
          ...(aiExpansion?.events || []),
          ...(aiExpansion?.searchQueries || [])
        ];
      } catch (error) {
        aiExpansion = { note: `AI 扩展失败，已自动回退到本地模糊检索：${error.message}` };
      }
    }

    // 单本搜索路由：
    //   - 有 EPUB 文件的书 → searchBook（基于 EPUB segments + Fuse.js 模糊）
    //   - 没 EPUB 的书（local-text / wikisource / ctext 仅 paragraph）→ 走
    //     searchAcrossBooks 单 slug 模式（FTS5）
    // 老逻辑直接调 searchBook 会抛 ENOENT，导致 .txt / 抓取来源的书全程搜不到。
    const singleSlug = slugs.length === 1 ? slugs[0] : null;
    const singleHasEpub = singleSlug ? bookEpubExists(singleSlug) : false;
    const useEpubSearch = singleSlug && singleHasEpub;

    let result;
    if (mode === "fuzzy") {
      result = await searchFuzzy(query, { limit, slugs });
    } else if (mode === "ai") {
      // AI 模式：先做 local（带扩展词）；为空 → 自动回退 fuzzy。
      result = useEpubSearch
        ? await searchBook(query, { limit, expandedQueries, slug: singleSlug })
        : await searchAcrossBooks(query, { limit, expandedQueries, slugs });
      if (!result.total) {
        const fb = await searchFuzzy(query, { limit, slugs });
        if (fb.total) {
          result = fb;
          aiExpansion = aiExpansion || {};
          aiExpansion.note = (aiExpansion.note || "") + (aiExpansion.note ? " " : "") + "本地未找到精确匹配，已使用模糊检索结果。";
        }
      }
    } else {
      // local（含老的 hybrid 别名）
      result = useEpubSearch
        ? await searchBook(query, { limit, expandedQueries, slug: singleSlug })
        : await searchAcrossBooks(query, { limit, expandedQueries, slugs });
    }
    res.json({ ...result, aiExpansion });
  } catch (error) {
    next(error);
  }
}

app.get("/api/book/search", handleBookSearch);
app.post("/api/book/search", handleBookSearch);

app.get("/api/book/person-chronology", async (req, res, next) => {
  try {
    const person = String(req.query.person || "").trim();
    if (!person) {
      res.status(400).json({ error: "缺少人物名 person。" });
      return;
    }

    const base = await buildPersonChronology(person);
    res.json(base);
  } catch (error) {
    next(error);
  }
});

app.get("/api/book/reign-lookup", (req, res) => {
  const term = String(req.query.term || "").trim();
  const result = explainReignTerm(term);
  if (!result) {
    res.status(404).json({ error: "未识别到可换算的明代年号。" });
    return;
  }
  res.json(result);
});

app.post("/api/reference/lookup", async (req, res, next) => {
  try {
    const { query = "", aiSettings: clientAi1 = {} } = req.body || {};
    const aiSettings = resolveAiSettings(clientAi1);
    if (!String(query).trim()) {
      res.status(400).json({ error: "缺少待查询词条。" });
      return;
    }

    const result = await lookupReadingReference(String(query).trim(), aiSettings);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/reference/compare", async (req, res, _next) => {
  try {
    const { selectedText = "", aiSettings: clientAiSettings = {}, currentBookSlug = DEFAULT_BOOK_SLUG } = req.body || {};
    if (!String(selectedText).trim()) {
      res.status(400).json({ error: "缺少待比对的选段。" });
      return;
    }
    const aiSettings = resolveAiSettings(clientAiSettings);
    // 整个 cross-compare 流程 = 4 步串行 AI 调用（关键词抽取 → 书目筛选 →
    // 候选过滤 → 最终报告），每步可能撞 timeout 走 fallback 队列。给足空间。
    // 前端 fetchWithTimeout 是 900s，这里设 850s 留 50s 给响应序列化。
    const result = await Promise.race([
      runCrossSourceComparison(String(selectedText).trim(), aiSettings, String(currentBookSlug || DEFAULT_BOOK_SLUG)),
      new Promise((_, reject) => setTimeout(() => reject(new Error("史料比对超时，请稍后再试或缩短选段。")), 850000))
    ]);
    res.json(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "史料比对失败";
    res.status(msg.includes("超时") ? 504 : 500).json({ error: msg });
  }
});

app.post("/api/reference/timeline", (req, res) => {
  const { hintText = "" } = req.body || {};
  res.json(getTimelinePayload(String(hintText)));
});

app.get("/api/reference/geography", (_req, res) => {
  res.json(getGeographyPayload());
});

app.get("/api/reference/geocode", async (req, res, next) => {
  try {
    const query = String(req.query.q || "").trim();
    if (!query) {
      res.status(400).json({ error: "缺少地名 q。" });
      return;
    }
    const aiSettings = resolveAiSettings(req.query);
    res.json(await geocodePlaces(query, aiSettings));
  } catch (error) {
    next(error);
  }
});

app.get("/api/reference/emperors", (_req, res) => {
  res.json(getEmperorPayload());
});

app.get("/api/reference/officials", (_req, res) => {
  res.json(getOfficialsPayload());
});

app.get("/api/reference/history-timeline", (req, res) => {
  const from = req.query.from ? Number.parseInt(String(req.query.from), 10) : undefined;
  const to = req.query.to ? Number.parseInt(String(req.query.to), 10) : undefined;
  const reign = String(req.query.reign || "").trim() || undefined;
  const minScale = req.query.minScale ? Math.max(1, Math.min(5, Number.parseInt(String(req.query.minScale), 10))) : 1;
  const limit = req.query.limit ? Math.max(1, Math.min(2000, Number.parseInt(String(req.query.limit), 10))) : 200;
  // categories=皇室,军事,灾异 — comma-separated; omit/empty = all
  const catParam = String(req.query.categories || "").trim();
  const categories = catParam ? catParam.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  // scales=3,4,5 — multi-select importance; omit/empty = all (subject to minScale legacy)
  const scaleParam = String(req.query.scales || "").trim();
  const scales = scaleParam
    ? scaleParam.split(",").map((s) => Number.parseInt(s.trim(), 10)).filter((n) => n >= 1 && n <= 5)
    : undefined;
  res.json(queryTimelineEvents({ from, to, reign, minScale, scales, categories, limit }));
});

app.get("/api/reference/history-timeline-categories", (_req, res) => {
  res.json({ categories: ALL_CATEGORIES });
});

// ===== timeline event admin (inline edit + double-click modal) =====
app.get("/api/timeline-events", (_req, res) => {
  res.json({ events: listAllTimelineEvents({ includeHidden: true }) });
});

app.patch("/api/timeline-events/:id", (req, res) => {
  const id = Number.parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id)) { res.status(400).json({ error: "bad id" }); return; }
  try {
    const updated = patchTimelineEvent(id, req.body || {});
    if (!updated) { res.status(404).json({ error: "not found or no fields" }); return; }
    res.json({ event: updated });
  } catch (e) {
    res.status(400).json({ error: e?.message || String(e) });
  }
});

app.delete("/api/timeline-events/:id", (req, res) => {
  const id = Number.parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id)) { res.status(400).json({ error: "bad id" }); return; }
  const r = deleteTimelineEvent(id);
  res.json({ deleted: r.changes });
});

app.post("/api/timeline-events", (req, res) => {
  try {
    const created = createTimelineEvent(req.body || {});
    res.json({ event: created });
  } catch (e) {
    res.status(400).json({ error: e?.message || String(e) });
  }
});

app.get("/api/reference/reign-convert", (req, res) => {
  const term = String(req.query.term || "").trim();
  if (!term) {
    res.status(400).json({ error: "缺少待换算内容。" });
    return;
  }

  const result = convertChronologyTerm(term);
  if (!result) {
    res.status(404).json({ error: "未识别到明代年号或可换算的公元年份。" });
    return;
  }

  res.json(result);
});

app.get("/api/reference/office-search", async (req, res, next) => {
  try {
    const query = String(req.query.q || "").trim();
    if (!query) {
      res.status(400).json({ error: "缺少职官或职位关键词。" });
      return;
    }

    const result = await searchOfficeReferences(query);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/reference/chapter-context", async (req, res, next) => {
  try {
    const slug = String(req.query.slug || "").trim();
    const chapter = String(req.query.chapter || "").trim();
    const highlight = String(req.query.highlight || "").trim();
    if (!slug || !chapter) {
      res.status(400).json({ error: "缺少 slug 或 chapter 参数。" });
      return;
    }
    await initializeLibrary();
    const { getDb } = await import("./services/library-db.js");
    const db = getDb();
    const book = db.prepare("SELECT id, title FROM books WHERE slug = ?").get(slug);
    if (!book) { res.status(404).json({ error: "未找到书目。" }); return; }

    const paragraphs = db.prepare(
      "SELECT content FROM paragraphs WHERE book_id = ? AND chapter = ? ORDER BY chapter_order, id"
    ).all(book.id, chapter);

    res.json({
      bookTitle: book.title,
      chapter,
      highlight,
      paragraphs: paragraphs.map(p => p.content)
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/ai/action", async (req, res, next) => {
  try {
    const { type, selection = "", question = "", person = "", aiSettings: clientAi2 = {}, customAction = null } = req.body || {};
    const aiSettings = resolveAiSettings(clientAi2);
    if (type === "qa") {
      const result = await answerReadingQuestion({
        selection,
        question,
        aiSettings
      });
      res.json(result);
      return;
    }

    const query = selection || question || person;
    const contextSnippets = query ? await getContextSnippets(query, 6) : [];

    const result = await runReaderAction({
      type,
      selection,
      question,
      person,
      contextSnippets,
      aiSettings,
      customAction
    });

    res.json({
      ...result,
      contextSnippets
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/ai/person-chronology", async (req, res, next) => {
  try {
    const { person = "", aiSettings: clientAi3 = {} } = req.body || {};
    const aiSettings = resolveAiSettings(clientAi3);
    if (!person.trim()) {
      res.status(400).json({ error: "缺少人物名。" });
      return;
    }

    // First try the biography index — if this person has a dedicated 列传 /
    // 世家 / 行状 chapter in any of 明史 / 石匮书后集 / 东林列传 / 罪惟录,
    // pass that exact slice as the AI's primary reference. Otherwise fall
    // back to the keyword-fuzzy chronology built from full-text search.
    const bioSlices = lookupBiographicalReferences(person);
    const chronology = await buildPersonChronology(person);

    let contextSnippets;
    if (bioSlices && bioSlices.length) {
      // Each slice's paragraphs are joined into one big snippet per book —
      // the AI receives the full biographical chapter slice, not just a
      // 200-char fuzzy match. Cap each slice's joined text to keep the
      // total prompt under model context.
      const PER_SLICE_CHAR_CAP = 6000;
      contextSnippets = bioSlices.map((s, i) => ({
        index: i + 1,
        chapterTitle: `${s.bookTitle}·${s.chapterLabel}`,
        chapterHref: s.anchor,
        snippet: s.paragraphs.join("\n").slice(0, PER_SLICE_CHAR_CAP),
        biographical: true
      }));
    } else {
      contextSnippets = chronology.items.slice(0, 16).map((item, index) => ({
        index: index + 1,
        chapterTitle: item.chapterTitle,
        chapterHref: item.chapterHref,
        snippet: item.snippet
      }));
    }

    const result = await runReaderAction({
      type: "chronology",
      person,
      contextSnippets,
      aiSettings
    });

    res.json({
      ...chronology,
      summary: result.answer,
      model: result.model,
      sourceMode: bioSlices && bioSlices.length ? "biography-index" : "keyword-search",
      biographicalChapters: bioSlices ? bioSlices.map((s) => ({
        bookSlug: s.bookSlug,
        bookTitle: s.bookTitle,
        chapterLabel: s.chapterLabel,
        anchor: s.anchor,
        paragraphCount: s.paragraphs.length,
        sliceFromIndex: s.sliceFromIndex,
        sliceToIndex: s.sliceToIndex,
        chapterParagraphCount: s.chapterParagraphCount,
      })) : []
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/ai/speech", async (req, res, next) => {
  try {
    const { text = "", voice = "" } = req.body || {};
    // TTS uses server-side config for model/key, but accepts client voice choice
    const aiSettings = resolveAiSettings({});
    if (voice) aiSettings.ttsVoice = voice;
    if (!text.trim()) {
      res.status(400).json({ error: "缺少要朗读的文本。" });
      return;
    }

    const audio = await synthesizeSpeech(text, aiSettings);
    const isWav = audio.length > 4 && audio[0] === 0x52 && audio[1] === 0x49 && audio[2] === 0x46 && audio[3] === 0x46;
    res.setHeader("Content-Type", isWav ? "audio/wav" : "audio/mpeg");
    res.setHeader("Content-Length", String(audio.length));
    res.send(audio);
  } catch (error) {
    // Return 501 so frontend knows to use browser TTS without showing scary error
    const msg = error instanceof Error ? error.message : "TTS 服务暂不可用";
    res.status(501).json({ error: msg, fallback: "browser" });
  }
});

app.get("/book/source.epub", async (req, res, next) => {
  try {
    const slug = String(req.query.slug || DEFAULT_BOOK_SLUG).trim() || DEFAULT_BOOK_SLUG;
    const epubPath = resolveBookEpubPath(slug);
    const splitPath = await ensureSplitEpub(epubPath);
    const stat = await fs.stat(splitPath);
    res.type("application/epub+zip");
    res.setHeader("Content-Length", stat.size);
    const { createReadStream } = await import("node:fs");
    createReadStream(splitPath).pipe(res);
  } catch (error) {
    console.error("epub-splitter failed, serving original:", error.message);
    try {
      const slug = String(req.query.slug || DEFAULT_BOOK_SLUG).trim() || DEFAULT_BOOK_SLUG;
      const epubPath = resolveBookEpubPath(slug);
      const stat = await fs.stat(epubPath);
      res.type("application/epub+zip");
      res.setHeader("Content-Length", stat.size);
      const { createReadStream } = await import("node:fs");
      createReadStream(epubPath).pipe(res);
    } catch (fallbackError) {
      next(fallbackError);
    }
  }
});

async function serveFrontend() {
  try {
    await fs.access(FRONTEND_DIST);
    app.use(express.static(FRONTEND_DIST));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(FRONTEND_DIST, "index.html"));
    });
  } catch {
    app.get("/", (_req, res) => {
      res.type("text/plain").send("Frontend dist not found. Run `npm run dev` or `npm run build` first.");
    });
  }
}

await serveFrontend();
await initializeLibrary();

app.use((error, _req, res, _next) => {
  const status = error.status || 500;
  res.status(status).json({
    error: error.message || "服务器内部错误"
  });
});

app.listen(PORT, () => {
  console.log(`Mingshi Reader backend running at http://127.0.0.1:${PORT}`);
});
