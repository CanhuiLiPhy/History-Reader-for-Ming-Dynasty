import fs from "node:fs/promises";
import path from "node:path";
import cors from "cors";
import express from "express";
import mime from "mime-types";
import { FRONTEND_DIST, PORT, BOOK_PATH, getPublicDefaults } from "./config/defaults.js";
import { explainReignTerm } from "./data/reign-map.js";
import { buildPersonChronology, getBookMeta, getContextSnippets, searchBook } from "./services/book-service.js";
import { aiReady, expandSearchIntent, resolveAiSettings, runReaderAction, synthesizeSpeech } from "./services/ai-service.js";
import { initializeLibrary } from "./services/library-db.js";
import { ensureSplitEpub } from "./services/epub-splitter.js";
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

app.get("/api/book/meta", async (_req, res, next) => {
  try {
    const meta = await getBookMeta();
    res.json(meta);
  } catch (error) {
    next(error);
  }
});

async function handleBookSearch(req, res, next) {
  try {
    const payload = req.method === "POST" ? req.body || {} : req.query;
    const query = String(payload.q || "").trim();
    const mode = String(payload.mode || "hybrid");
    const limit = Number.parseInt(String(payload.limit || "20"), 10);
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
        aiExpansion = { note: `AI 扩展失败，已回退到本地搜索：${error.message}` };
      }
    }

    const result = await searchBook(query, { limit, expandedQueries });
    res.json({
      ...result,
      aiExpansion
    });
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

app.post("/api/reference/compare", async (req, res, next) => {
  try {
    const { selectedText = "", aiSettings: clientAiSettings = {} } = req.body || {};
    if (!String(selectedText).trim()) {
      res.status(400).json({ error: "缺少待比对的《明史》选段。" });
      return;
    }
    const aiSettings = resolveAiSettings(clientAiSettings);
    const result = await Promise.race([
      runCrossSourceComparison(String(selectedText).trim(), aiSettings),
      new Promise((_, reject) => setTimeout(() => reject(new Error("史料比对超时，请稍后再试或缩短选段。")), 180000))
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

    const chronology = await buildPersonChronology(person);
    const result = await runReaderAction({
      type: "chronology",
      person,
      contextSnippets: chronology.items.slice(0, 16).map((item, index) => ({
        index: index + 1,
        chapterTitle: item.chapterTitle,
        chapterHref: item.chapterHref,
        snippet: item.snippet
      })),
      aiSettings
    });

    res.json({
      ...chronology,
      summary: result.answer,
      model: result.model
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

app.get("/book/source.epub", async (_req, res, next) => {
  try {
    const splitPath = await ensureSplitEpub(BOOK_PATH);
    const stat = await fs.stat(splitPath);
    res.type("application/epub+zip");
    res.setHeader("Content-Length", stat.size);
    const { createReadStream } = await import("node:fs");
    createReadStream(splitPath).pipe(res);
  } catch (error) {
    console.error("epub-splitter failed, serving original:", error.message);
    try {
      const stat = await fs.stat(BOOK_PATH);
      res.type("application/epub+zip");
      res.setHeader("Content-Length", stat.size);
      const { createReadStream } = await import("node:fs");
      createReadStream(BOOK_PATH).pipe(res);
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
