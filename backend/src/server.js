import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import cors from "cors";
import express from "express";
import mime from "mime-types";
import { FRONTEND_DIST, PORT, getBuiltinAiCredentials, getPublicDefaults } from "./config/defaults.js";
import { explainReignTerm } from "./data/reign-map.js";
import { buildPersonChronology, getBookMeta, getContextSnippets, searchBook, searchAcrossBooks, searchFuzzy, resolveBookEpubPath, bookEpubExists, DEFAULT_BOOK_SLUG, lookupBiographicalReferences } from "./services/book-service.js";
import { ensureAnchorMap, translateAnchor, extractAnchorFragment } from "./services/epub-anchor-map.js";
import { ensureSplitEpub as ensureSplitEpubForAnchor } from "./services/epub-splitter.js";
import { aiReady, expandSearchIntent, resolveAiSettings, runReaderAction, scrubSecrets, synthesizeSpeech } from "./services/ai-service.js";
import { initializeLibrary } from "./services/library-db.js";
import { ensureSplitEpub } from "./services/epub-splitter.js";
import { getReadableBooks, getReaderChapters, getReaderChapter } from "./services/library-reader.js";
import { answerPersonConversation, answerFreeConversation, getPersonBiographies } from "./services/person-conversation.js";
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
  searchOfficeReferences,
  filterRelevantReferences
} from "./services/reference-service.js";
import { searchByEmbedding, isAvailable as embeddingAvailable } from "./services/embedding-service.js";
import { ROLES, getSiteContent, initializeAuth } from "./auth/auth-db.js";
import { attachUser, requireAuth, requireRole } from "./auth/middleware.js";
import { createAuthRouter } from "./auth/auth-routes.js";
import { createAdminRouter } from "./auth/admin-routes.js";
import { createAuthPagesRouter } from "./auth/pages.js";
import { createUserRouter } from "./auth/user-routes.js";
import { getUserAiCredentials } from "./auth/user-state.js";
import { getStagingChapter, getStagingChapters, isStagingSlug, listStagingBooks } from "./services/staging-library.js";

const app = express();

// Behind nginx: trust the single reverse-proxy hop so req.ip / req.secure
// reflect the real client rather than 127.0.0.1.
app.set("trust proxy", 1);

app.use(cors());
app.use(express.json({ limit: "4mb" }));

// Cache policy.
//   /api/*    — never cached: responses are per-user and change constantly.
//   *.epub    — exempt. These are immutable book blobs of 5–24 MB each; under
//               blanket no-store every reload and every book switch re-fetched
//               the whole file (明史 4.9 MB, 國榷 23.5 MB), which was the single
//               largest cause of the reader feeling slow on the web. The routes
//               themselves set a validated long-lived policy.
//   Static    — handled in serveFrontend().
app.use((req, res, next) => {
  if (req.path.startsWith("/api/") && !req.path.endsWith(".epub")) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  }
  next();
});

/**
 * 中文：EPUB 书文件的缓存策略——私有缓存 1 天，之后靠 ETag 校验，命中就 304。
 *
 * Cache policy for book blobs.
 *
 * `private` because the file is only reachable by an authenticated account and
 * must not be held by a shared proxy. One day of freshness, then revalidation:
 * a re-imported book propagates within a day, and an unchanged one costs a
 * 304 instead of 24 MB. `must-revalidate` keeps a stale copy from being served
 * after expiry.
 *
 * Args:
 *   res (express.Response): response to receive the header.
 */
function setEpubCacheHeaders(res) {
  res.setHeader("Cache-Control", "private, max-age=86400, must-revalidate");
  res.removeHeader("Pragma");
  res.removeHeader("Expires");
}

// 中文：账号系统只在网站版启用；Electron 桌面版不设 MINGSHI_REQUIRE_AUTH，
// 行为与加入账号系统之前完全一致，不会弹登录。
//
// The account system is opt-in via MINGSHI_REQUIRE_AUTH=1, which only the web
// deployment's .env sets. The Electron desktop build ships the very same
// server.js; leaving the flag unset keeps that build's behaviour byte-for-byte
// identical to before accounts existed — no sign-in wall on a local app.
const AUTH_ENABLED = process.env.MINGSHI_REQUIRE_AUTH === "1";

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

/**
 * 中文：为一次请求解析出该用什么凭证。密钥只在服务端流动，绝不经过浏览器。
 *
 * Resolve the credentials an individual request may use.
 *
 * This is the single choke point for "who is allowed to spend whose key", and
 * the reason a distributed account can use the owner's key without ever being
 * able to read it.
 *
 * Desktop build (AUTH_ENABLED false): unchanged from before accounts existed —
 * there is no account system, the client owns its settings and passes them in.
 *
 * Web build: whatever credentials the client sent are **discarded**, because
 * the client is never given any (see redactAiCredentials / redactStateCredentials).
 * The effective key is then chosen server-side:
 *
 *   1. the account's own key, if it has entered one — anybody may add theirs;
 *   2. otherwise the built-in key from the server environment, but only for
 *      manager and admin. A visitor with no key of its own simply gets no AI.
 *
 * Order matters: an account's own key wins, so adding one is a real override
 * rather than a no-op. Provider lists concatenate in the same order, and
 * resolveProviderForModel takes the first match.
 *
 * Args:
 *   req (express.Request): the live request; `req.user` supplies id and role.
 *   clientAi (object): the `aiSettings` blob from the request body. Only its
 *     non-credential fields (model choice, prompt, custom actions) are honoured.
 *
 * Returns:
 *   object: settings ready for the AI service, credentials attached in-process.
 */
function resolveRequestAiSettings(req, clientAi = {}) {
  if (!AUTH_ENABLED) return resolveAiSettings(clientAi);

  const { apiKey: _k, ttsApiKey: _t, baseURL: _b, ttsBaseURL: _tb, modelProviders: _p, ...safe } = clientAi || {};

  const own = req.user ? getUserAiCredentials(req.user.id) : null;
  const role = req.user?.role;
  const builtin = (role === ROLES.MANAGER || role === ROLES.ADMIN) ? getBuiltinAiCredentials() : null;

  const effective = { ...safe };
  // baseURL 与 apiKey 必须成对切换，混搭必然 401。
  if (own?.apiKey) {
    effective.apiKey = own.apiKey;
    effective.baseURL = own.baseURL || undefined;
  } else if (builtin?.apiKey) {
    effective.apiKey = builtin.apiKey;
    effective.baseURL = builtin.baseURL || undefined;
  }
  if (own?.ttsApiKey) {
    effective.ttsApiKey = own.ttsApiKey;
    effective.ttsBaseURL = own.ttsBaseURL || undefined;
  } else if (builtin?.ttsApiKey) {
    effective.ttsApiKey = builtin.ttsApiKey;
    effective.ttsBaseURL = builtin.ttsBaseURL || undefined;
  }
  effective.modelProviders = [...(own?.modelProviders || []), ...(builtin?.modelProviders || [])];

  // 顶层凭证兜底：只在「列表里加了一条」而顶层为空时，把第一条提上来。
  //
  // 密钥可以只存在于某条 provider 上：前端的 API Key 列表编辑器是按条管理的，
  // 顶层 baseURL/apiKey 只是兼容老调用链的镜像字段。而 chatCompletion 在模型
  // 名匹配不到任何 provider 时会回落到顶层那一对 —— 顶层为空就等于「有 key
  // 却用不了」。实测确实撞到：访客加了自己的 API 后仍被判定为「没有 key」。
  //
  // Promote the first provider's credentials when the top-level pair is empty.
  // A key may legitimately exist only on a provider entry — the list editor is
  // the real interface and the top-level baseURL/apiKey are a compatibility
  // mirror — while chatCompletion falls back to that top-level pair whenever a
  // model matches no provider. Leaving it empty produced "no API key" for an
  // account that had just added one.
  if (!effective.apiKey) {
    const first = effective.modelProviders.find((p) => String(p?.apiKey || "").trim() && p?.baseURL);
    if (first) {
      effective.apiKey = first.apiKey;
      effective.baseURL = first.baseURL;
    }
  }

  // 模型名只有相对于凭证才有意义 —— 凭证既然由服务端决定，模型就必须一起校验。
  //
  // 客户端会把它存着的整份 AI 设置发回来，其中的 model / modelOptions 可能是
  // 上一套供应商留下的。凭证换成 MiniMax 之后，那些名字（deepseek-v4-pro、
  // Doubao-Seed-2.0-mini…）会被原样拿去打 MiniMax 端点，一路 404 到重试链耗尽：
  //   「404 The model `Doubao-Seed-2.0-mini` does not exist.
  //     （已尝试模型：deepseek-v4-pro -> glm-4.7 -> Doubao-Seed-2.0-mini）」
  // 而且这是**静默**的 —— 账号设置页看起来一切正常，只有调用时才炸。
  //
  // A model name means nothing except relative to the credentials that will
  // serve it, so now that the server picks the credentials it must vet the
  // model too. The client posts back its whole stored AI settings, and those
  // may name models from a previous provider; those names were being forwarded
  // verbatim, producing a 404 for every entry in the retry chain. Anything the
  // effective providers cannot serve is dropped here and the server's own
  // default takes over.
  const servable = new Set((effective.modelProviders || []).flatMap((p) => p.models || []));
  if (servable.size) {
    const keep = (name) => (name && servable.has(name) ? name : undefined);
    const filter = (list) => (Array.isArray(list) ? list.filter((m) => servable.has(m)) : []);
    effective.model = keep(effective.model);
    effective.smallModel = keep(effective.smallModel);
    effective.defaultModel = keep(effective.defaultModel);
    const options = filter(effective.modelOptions);
    const smallOptions = filter(effective.smallModelOptions);
    effective.modelOptions = options.length ? options : [...servable];
    effective.smallModelOptions = smallOptions.length ? smallOptions : [...servable];
  }

  return resolveAiSettings(effective, { allowServerDefaults: false });
}

/**
 * 中文：没有可用凭证时给一句人话，而不是让 OpenAI SDK 抛英文报错。
 *
 * Guard an AI route when no credential resolved to this request.
 *
 * Without it a visitor account hits the OpenAI client's own "The
 * OPENAI_API_KEY environment variable is missing or empty", which says nothing
 * about what the person should actually do.
 *
 * Args:
 *   aiSettings (object): result of resolveRequestAiSettings.
 *   res (express.Response): response to answer with 400 when unusable.
 *
 * Returns:
 *   boolean: true when the request may proceed; false once a reply was sent.
 */
function ensureAiCredentials(aiSettings, res) {
  // 顶层或任意一条 provider 有 key 都算可用 —— 只认顶层会把「只在列表里加了
  // 一条 API」的账号误判为未配置。
  // Either the top-level key or any provider entry counts: checking only the
  // top-level rejected accounts whose key lives on a list entry.
  const hasProviderKey = (aiSettings?.modelProviders || []).some((p) => String(p?.apiKey || "").trim());
  if (aiSettings?.apiKey || hasProviderKey) return true;
  res.status(400).json({
    error: "当前账号还没有可用的 API Key。请在「设置 → AI 设置 → 自定义 API 配置」里添加一条自己的 Key 后再试。",
  });
  return false;
}

if (AUTH_ENABLED) {
  // Resolve the session cookie into req.user for every request (public too).
  app.use(attachUser);

  // -------------------------------------------------------------------------
  // Public surface: sign-in, registration, and the pages that host them.
  // -------------------------------------------------------------------------
  app.use("/api/auth", createAuthRouter());
  app.use(createAuthPagesRouter());

  // -------------------------------------------------------------------------
  // Authentication gate. Every route registered after this line — including the
  // reader's own API and the static frontend bundle — requires a signed-in,
  // approved account.
  // -------------------------------------------------------------------------
  app.use(requireAuth);

  // Per-account state sync: bookmarks, notes, highlights, AI settings and UI
  // preferences all live server-side, keyed by account rather than browser.
  app.use("/api/user", createUserRouter());

  // Administration API (user management, staging library, site content).
  app.use("/api/admin", requireRole(ROLES.MANAGER), createAdminRouter());
} else {
  // Desktop build: tell the frontend's storage adapter there is no account
  // backend, so it keeps using local storage exactly as it always has.
  app.get("/api/user/state", (_req, res) => {
    res.json({ enabled: false, state: {} });
  });
}

// Site content authored in the admin console, read by the reader's 关于 panel.
// In the desktop build there is no admin console, so this answers with empty
// entries rather than touching (and thereby creating) the account database.
app.get("/api/site/content", (_req, res) => {
  if (!AUTH_ENABLED) {
    const empty = { value: "", updatedAt: null, updatedBy: "" };
    res.json({ versionNotice: { key: "version_notice", ...empty }, readme: { key: "readme", ...empty } });
    return;
  }
  res.json({
    versionNotice: getSiteContent("version_notice"),
    readme: getSiteContent("readme"),
  });
});

app.get("/api/settings/defaults", (req, res) => {
  // 内置凭证条目只对管理员可见；访客得到一份空的 provider 列表，
  // 与 resolveRequestAiSettings 的角色门禁保持一致。
  // The built-in credential entry is listed for managers and admins only,
  // matching the role gate that decides who may actually spend it.
  const role = req.user?.role;
  const includeBuiltin = !AUTH_ENABLED || role === ROLES.MANAGER || role === ROLES.ADMIN;
  res.json(getPublicDefaults({ includeBuiltin, redact: AUTH_ENABLED }));
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

// New: list all readable books.
// The curated corpus comes first; administrator uploads from the staging
// library are appended so they show up in the same book list. Staged books
// carry category "staging" and are excluded from every search path.
app.get("/api/library/books", async (_req, res, next) => {
  try {
    const books = await getReadableBooks();
    const staged = listStagingBooks().map((book) => ({
      slug: book.slug,
      title: book.title,
      author: book.author || "",
      dynasty: book.dynasty || "",
      category: "staging",
      description: book.description || "",
      chapterCount: book.chapterCount,
      paragraphCount: book.paragraphCount,
      charCount: book.charCount,
      hasEpub: false,
      staging: true,
      uploadedBy: book.uploadedBy,
      uploadedAt: book.uploadedAt,
    }));
    res.json({ books: [...books, ...staged] });
  } catch (error) {
    next(error);
  }
});

// New: chapter list for DB-reader (non-EPUB books)
app.get("/api/library/books/:slug/chapters", async (req, res, next) => {
  try {
    const slug = String(req.params.slug || "").trim();
    if (!slug) { res.status(400).json({ error: "缺少 slug。" }); return; }
    if (isStagingSlug(slug)) {
      const staged = getStagingChapters(slug);
      if (!staged) { res.status(404).json({ error: "未找到该书。" }); return; }
      res.json(staged);
      return;
    }
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
    if (isStagingSlug(slug)) {
      const staged = getStagingChapter(slug, index);
      if (!staged) { res.status(404).json({ error: "未找到该章节。" }); return; }
      res.json(staged);
      return;
    }
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
    let servePath = epubPath;
    try {
      servePath = await ensureSplitEpub(epubPath);
    } catch (splitError) {
      console.error("epub-splitter failed for", slug, splitError.message, "→ serving original");
    }
    setEpubCacheHeaders(res);
    // sendFile (rather than a raw read stream) gives us ETag + Last-Modified
    // and answers a conditional request with 304, so a revalidation costs a
    // few hundred bytes instead of the whole book.
    // dotfiles:"allow" is required, not cosmetic: split EPUBs live under
    // backend/.cache/, and send()'s default dotfiles:"ignore" 404s any path
    // containing a dot-segment.
    res.sendFile(servePath, {
      dotfiles: "allow",
      headers: { "Content-Type": "application/epub+zip" },
    }, (error) => {
      if (error && !res.headersSent) next(error);
    });
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
    // 兼容老 "ai" 模式 → 视作 "semantic"（v1.2 起 AI 意图检索升级为 embedding RAG）
    const mode = rawMode === "hybrid" ? "local" : rawMode === "ai" ? "semantic" : rawMode;
    // Mode-specific defaults when frontend doesn't pass an explicit limit:
    //   local 100 / fuzzy 50 / semantic 60
    const MODE_DEFAULT_LIMIT = { local: 100, fuzzy: 50, ai: 80, semantic: 60 };
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
    const aiSettings = resolveRequestAiSettings(req, payload.aiSettings || { model: payload.model });

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
    if (mode === "semantic") {
      // v1.2: embedding RAG 语义检索 + 小模型相关性过滤
      if (!embeddingAvailable()) {
        // 嵌入不可用 → 直接 fallback 到 fuzzy
        result = await searchFuzzy(query, { limit, slugs });
        aiExpansion = { note: "嵌入服务不可用，已退回到本地模糊检索。" };
      } else {
        const ranked = await searchByEmbedding(query, { limit, slugs });
        // 小模型相关性过滤（>10 条时启用，避免空过滤把所有都剔了）
        let filtered = ranked;
        if (aiReady(aiSettings) && ranked.length > 10) {
          try {
            filtered = await filterRelevantReferences({
              question: query,
              selection: "",
              references: ranked.slice(0, Math.min(50, ranked.length)),
              aiSettings,
            });
            if (!filtered.length) filtered = ranked.slice(0, limit);
          } catch {
            filtered = ranked;
          }
        }
        const final = filtered.slice(0, limit);
        // Preload anchor maps so legacy pre-split hrefs get translated.
        const slugSet = new Set(final.map((r) => r.bookSlug).filter(Boolean));
        await Promise.all(
          [...slugSet].map(async (slug) => {
            try {
              const epubPath = resolveBookEpubPath(slug);
              if (!epubPath) return;
              const splitPath = await ensureSplitEpubForAnchor(epubPath);
              await ensureAnchorMap(slug, splitPath && splitPath !== epubPath ? splitPath : null);
            } catch {
              await ensureAnchorMap(slug, null);
            }
          })
        );
        result = {
          query,
          expandedQueries: [],
          total: final.length,
          results: final.map((row, idx) => ({
            id: `${row.bookSlug}-${row.paragraphId}`,
            bookSlug: row.bookSlug,
            bookTitle: row.bookTitle,
            chapterId: String(idx),
            chapterOrder: null,
            chapterHref: translateAnchor(row.bookSlug, row.anchor || ""),
            paragraphAnchor: extractAnchorFragment(row.anchor || ""),
            chapterTitle: row.chapter || "",
            score: typeof row._distance === "number" ? Number((-(row._distance / 100)).toFixed(3)) : 0,
            snippet: (row.content || "").slice(0, 240),
            text: row.content || "",
            years: [],
          })),
        };
        aiExpansion = { note: `语义检索 (BGE 嵌入 → vec KNN${aiReady(aiSettings) ? " + 小模型过滤" : ""})。` };
      }
    } else if (mode === "fuzzy") {
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
    const aiSettings = resolveRequestAiSettings(req, clientAi1);
    if (!ensureAiCredentials(aiSettings, res)) return;
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
    const aiSettings = resolveRequestAiSettings(req, clientAiSettings);
    if (!ensureAiCredentials(aiSettings, res)) return;
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
    const aiSettings = resolveRequestAiSettings(req, req.query);
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

let shixiCache = null;
app.get("/api/reference/shixi", async (_req, res, next) => {
  try {
    if (!shixiCache) {
      const shixiPath = path.resolve(__dirname, "data/shixi.json");
      const raw = await fs.readFile(shixiPath, "utf8");
      shixiCache = JSON.parse(raw);
    }
    res.json(shixiCache);
  } catch (error) {
    next(error);
  }
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
// Reading the event list is open to any signed-in account; mutating the shared
// timeline database is restricted to 管理员 and above, since these rows are
// global state rather than per-user data.
app.get("/api/timeline-events", (_req, res) => {
  res.json({ events: listAllTimelineEvents({ includeHidden: true }) });
});

app.use("/api/timeline-events", (req, res, next) => {
  if (!AUTH_ENABLED) { next(); return; }
  if (req.method === "GET" || req.method === "HEAD") { next(); return; }
  requireRole(ROLES.MANAGER)(req, res, next);
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
    const aiSettings = resolveRequestAiSettings(req, clientAi2);
    if (!ensureAiCredentials(aiSettings, res)) return;
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
    const aiSettings = resolveRequestAiSettings(req, clientAi3);
    if (!ensureAiCredentials(aiSettings, res)) return;
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

// 人物列传：列出该人物在 4 部纪传体（明史/石匮书后集/东林列传/罪惟录）
// 中的列传切片。命中索引时返回详细切片；未命中返回 has=false。
app.get("/api/person/biographies", async (req, res, next) => {
  try {
    const person = String(req.query.person || "").trim();
    if (!person) {
      res.status(400).json({ error: "缺少人物名 (?person=...)" });
      return;
    }
    const { biographies, related } = await getPersonBiographies(person);
    res.json({
      person,
      has: biographies.length > 0,
      biographies,
      related,
    });
  } catch (error) {
    next(error);
  }
});

// 多轮对话式人物问答。
// Body: { person, mode: "core-person"|"open", messages: [{role, content}, ...], aiSettings }
// 前端保管完整对话历史；后端每轮按当前最新问题重新解析知识库。
// v1.2 自由对话：通用 RAG 多轮问答。前端 stateless 传完整 messages。
app.post("/api/ai/free-conversation", async (req, res, next) => {
  try {
    const { messages = [], aiSettings: clientAi = {} } = req.body || {};
    const aiSettings = resolveRequestAiSettings(req, clientAi);
    if (!ensureAiCredentials(aiSettings, res)) return;
    if (!Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: "messages 必须非空 (至少包含一条用户消息)。" });
      return;
    }
    const result = await answerFreeConversation({ messages, aiSettings });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/ai/person-conversation", async (req, res, next) => {
  try {
    const {
      person = "",
      mode = "core-person",
      messages = [],
      aiSettings: clientAi = {},
    } = req.body || {};
    const aiSettings = resolveRequestAiSettings(req, clientAi);
    if (!ensureAiCredentials(aiSettings, res)) return;
    if (!Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: "messages 必须非空 (至少包含一条用户消息)。" });
      return;
    }
    const result = await answerPersonConversation({ person, mode, messages, aiSettings });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/ai/speech", async (req, res, next) => {
  try {
    const { text = "", voice = "" } = req.body || {};
    // TTS uses server-side config for model/key, but accepts client voice choice
    const aiSettings = resolveRequestAiSettings(req, {});
    if (!ensureAiCredentials(aiSettings, res)) return;
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
  const slug = String(req.query.slug || DEFAULT_BOOK_SLUG).trim() || DEFAULT_BOOK_SLUG;
  try {
    const epubPath = resolveBookEpubPath(slug);
    let servePath = epubPath;
    try {
      servePath = await ensureSplitEpub(epubPath);
    } catch (splitError) {
      console.error("epub-splitter failed, serving original:", splitError.message);
    }
    setEpubCacheHeaders(res);
    // dotfiles:"allow" is required, not cosmetic: split EPUBs live under
    // backend/.cache/, and send()'s default dotfiles:"ignore" 404s any path
    // containing a dot-segment.
    res.sendFile(servePath, {
      dotfiles: "allow",
      headers: { "Content-Type": "application/epub+zip" },
    }, (error) => {
      if (error && !res.headersSent) next(error);
    });
  } catch (error) {
    next(error);
  }
});

/**
 * 中文：挂载编译好的前端。带哈希的静态资源长缓存，index.html 不缓存。
 *
 * Serve the built React frontend.
 *
 * Caching: hashed bundles under /assets and the (large, stable) font files
 * get a one-year immutable lifetime, while index.html is revalidated on every
 * load so a redeploy takes effect immediately. The fonts are 154 MB in total,
 * which is why leaving them uncacheable is not an option on a public site.
 *
 * The SPA fallback is a terminal middleware rather than `app.get("*")`:
 * Express 5 routes through path-to-regexp v8, where a bare "*" is not a valid
 * pattern and throws at registration time.
 */
async function serveFrontend() {
  try {
    await fs.access(FRONTEND_DIST);
    app.use(express.static(FRONTEND_DIST, {
      index: false,
      maxAge: 0,
      setHeaders(res, filePath) {
        if (/[\\/](assets|fonts|icons)[\\/]/.test(filePath) || /-[A-Za-z0-9_-]{8,}\.(js|css)$/.test(filePath)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        } else {
          res.setHeader("Cache-Control", "no-cache");
        }
      },
    }));
    app.use((req, res, next) => {
      if (req.method !== "GET" && req.method !== "HEAD") { next(); return; }
      res.setHeader("Cache-Control", "no-cache");
      res.sendFile(path.join(FRONTEND_DIST, "index.html"));
    });
  } catch {
    app.get("/", (_req, res) => {
      res.type("text/plain").send("Frontend dist not found. Run `npm run dev` or `npm run build` first.");
    });
  }
}

if (AUTH_ENABLED) {
  const authInit = initializeAuth();
  if (authInit.seeded.length) {
    console.log(`[auth] 已创建预置账号: ${authInit.seeded.join(", ")}（初始密码 password，首次登录须修改）`);
  }
  // 不再往账号里种 key：内置凭证留在服务端，按角色在请求时挂载。
  // No credential is written into any account any more; the built-in key stays
  // in the server environment and is attached per request by role. See
  // resolveRequestAiSettings above.
  console.log(`[auth] 账号库: ${authInit.dbPath}`);
} else {
  console.log("[auth] 未启用账号系统（桌面/本地模式）。网站版请设置 MINGSHI_REQUIRE_AUTH=1。");
}

await serveFrontend();
await initializeLibrary();

app.use((error, _req, res, _next) => {
  const status = error.status || 500;
  res.status(status).json({
    // 出口脱敏：上游 401/403 的错误体可能带着 Authorization 里的 key，
    // 自建端点的错误格式不受我们控制，所以在这里过一遍再返回。
    // Scrub on the way out: an upstream auth failure can echo the credential,
    // and the self-hosted endpoint's error format is not ours to trust.
    error: scrubSecrets(error.message) || "服务器内部错误"
  });
});

// Bind to loopback by default so the Node port is never directly reachable
// from the internet — nginx terminates TLS and proxies to it. Set MINGSHI_HOST
// to 0.0.0.0 only when running without a reverse proxy.
const HOST = process.env.MINGSHI_HOST || "127.0.0.1";

app.listen(PORT, HOST, () => {
  console.log(`Mingshi Reader backend running at http://${HOST}:${PORT}`);
});
