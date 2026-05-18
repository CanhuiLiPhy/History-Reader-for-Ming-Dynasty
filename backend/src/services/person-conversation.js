/**
 * Multi-turn conversation about a specific historical person.
 *
 * Knowledge base resolution priority (only when mode === "core-person"):
 *  1. Biography index (明史 / 石匮书后集 / 东林列传 / 罪惟录 中的传记切片) — if
 *     the person has a non-empty entry, the entire 传记 is the primary KB.
 *  2. Otherwise: embedding KNN retrieval over all 22 books filtered by a
 *     relevance threshold, with the person name + current question as the
 *     query. Top-K relevant snippets become the KB.
 *
 * When mode !== "core-person", KB is rebuilt fresh per turn from the
 * latest question only (no person bias).
 *
 * Backend is stateless: the full message history travels in the request
 * payload from the frontend.
 */
import { chatCompletion, aiReady } from "./ai-service.js";
import { lookupBiographicalReferences } from "./book-service.js";
import { isAvailable as embeddingAvailable, vectorSearch } from "./embedding-service.js";
import { fetchParagraphsByIds, searchReferenceParagraphs } from "./library-db.js";

const SYSTEM_BASE = `你是明史研究助手。读者就一个历史人物或者一段史事跟你对话。回答原则：

1. **以下面提供的知识库为准**。每条史料前有「【片段#N】《书名》章节」标头；引用时显式说出书名 + 章节（如「按《明史·袁崇焕传》记载…」）。
2. 若知识库中无相关材料，明确说"未在已检索的史料中找到"，不要凭印象编造细节。
3. 文言原文可在引用时附上简短现代汉语解释，不必逐字翻译整段。
4. 多轮对话中保持上下文连贯：读者后续追问通常承接前面话题，避免无谓重复全篇。
5. 史料之间如有冲突（不同书记载不一致），明确指出"《A书》与《B书》记载略有出入：…"。
6. 控制篇幅：答得详尽但不冗长。点对点回应读者关注的问题，必要时分段。`;

const KB_NONE_MESSAGE = "（本轮未检索到任何相关史料。请提示读者改换检索关键词或调宽相关性阈值。）";

function buildKBPrompt(kb) {
  if (!kb.snippets.length) return KB_NONE_MESSAGE;
  return kb.snippets
    .map((s, i) => `【片段#${i + 1}】《${s.bookTitle}》${s.chapter}\n${s.text}`)
    .join("\n\n");
}

/**
 * Resolve the knowledge base for this conversation turn.
 *
 * @returns {object} { kind, snippets[], note }
 *   kind: "biography" | "embedding" | "fts5" | "empty"
 *   snippets[]: [{ paragraphId?, bookTitle, chapter, anchor, text }]
 */
async function resolveKnowledgeBase({ person, mode, latestQuestion }) {
  const trimmedQuestion = (latestQuestion || "").trim();
  const trimmedPerson = (person || "").trim();

  // 1. Core-person + biography index hit → use full bio slices
  if (mode === "core-person" && trimmedPerson) {
    const bioSlices = lookupBiographicalReferences(trimmedPerson);
    if (bioSlices && bioSlices.length) {
      // Cap each slice to ~6000 chars to keep total prompt reasonable
      const PER_SLICE_CAP = 6000;
      return {
        kind: "biography",
        snippets: bioSlices.map((s) => ({
          bookSlug: s.bookSlug,
          bookTitle: s.bookTitle,
          chapter: s.chapterLabel,
          anchor: s.anchor,
          text: s.paragraphs.join("\n").slice(0, PER_SLICE_CAP),
          biographical: true,
        })),
        note: `本对话以传记索引中的《${bioSlices.map((s) => s.bookTitle).join("》《")}》中 ${trimmedPerson} 的列传为主要知识库。`,
      };
    }
  }

  // 2. Embedding retrieval. Combine person + question for richer query.
  if (embeddingAvailable()) {
    const queryParts = [];
    if (mode === "core-person" && trimmedPerson) queryParts.push(trimmedPerson);
    if (trimmedQuestion) queryParts.push(trimmedQuestion);
    const query = queryParts.join(" ").slice(0, 800);

    if (query.length >= 2) {
      const vecResults = await vectorSearch(query, 40);
      if (vecResults.length) {
        // Relevance threshold: cosine distance < 0.55 ≈ similarity > 0.45
        // (sqlite-vec returns cosine distance for normalized vectors).
        // 核心人物模式提高阈值（更严格），开放模式放宽。
        const threshold = mode === "core-person" ? 0.55 : 0.7;
        const filtered = vecResults.filter((r) => r.distance < threshold).slice(0, 12);
        if (filtered.length) {
          const rows = fetchParagraphsByIds(filtered.map((r) => r.paragraph_id), "");
          const byId = new Map(rows.map((r) => [r.paragraphId, r]));
          const snippets = filtered
            .map((r) => byId.get(r.paragraph_id))
            .filter(Boolean)
            .map((row) => ({
              paragraphId: row.paragraphId,
              bookSlug: row.bookSlug,
              bookTitle: row.bookTitle,
              chapter: row.chapter,
              anchor: row.anchor,
              text: row.content,
            }));
          return {
            kind: "embedding",
            snippets,
            note: `基于嵌入检索从 22 部史料库中筛出与当前问题最相关的 ${snippets.length} 条片段。`,
          };
        }
      }
    }
  }

  // 3. FTS5 fallback (when embedding unavailable or returned nothing)
  if (trimmedPerson) {
    const keywords = [trimmedPerson];
    if (trimmedQuestion) keywords.push(trimmedQuestion.slice(0, 30));
    const rows = searchReferenceParagraphs({ keywords, limit: 10, excludeSlug: "" });
    if (rows.length) {
      return {
        kind: "fts5",
        snippets: rows.map((r) => ({
          paragraphId: r.paragraphId,
          bookSlug: r.bookSlug,
          bookTitle: r.bookTitle,
          chapter: r.chapter,
          anchor: r.anchor,
          text: r.content,
        })),
        note: "未启用嵌入检索，使用关键词全文检索的最佳命中。",
      };
    }
  }

  return {
    kind: "empty",
    snippets: [],
    note: "未检索到任何相关材料。",
  };
}

/**
 * Run one turn of the person conversation.
 *
 * @param {object} payload
 *   person: 人物名
 *   mode: "core-person" | "open"
 *   messages: 完整对话历史 (含本轮 user 提问) [{role:"user"|"assistant", content}]
 *   aiSettings: AI 凭据
 */
export async function answerPersonConversation({ person, mode, messages, aiSettings }) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("messages 必须非空");
  }
  const latestUserMsg = [...messages].reverse().find((m) => m.role === "user");
  const latestQuestion = latestUserMsg?.content || "";

  const kb = await resolveKnowledgeBase({ person, mode, latestQuestion });

  if (!aiReady(aiSettings)) {
    return {
      assistant: `(AI 未配置 API Key)\n\n${kb.note}\n\n${buildKBPrompt(kb)}`,
      sources: kb.snippets,
      sourceMode: kb.kind,
      model: "",
    };
  }

  const systemPrompt = [
    SYSTEM_BASE,
    "",
    `本轮核心人物：${person || "（无）"}`,
    `检索模式：${mode === "core-person" ? "核心人物模式" : "开放对话"}`,
    `知识库来源：${kb.note}`,
    "",
    "## 知识库",
    buildKBPrompt(kb),
  ].join("\n");

  const llmMessages = [
    { role: "system", content: systemPrompt },
    ...messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  const response = await chatCompletion(llmMessages, aiSettings, {
    temperature: 0.3,
    maxTokens: 3000,
    modelStrategy: "large",
  });

  return {
    assistant: response.text,
    sources: kb.snippets.map((s, i) => ({ ...s, index: i + 1 })),
    sourceMode: kb.kind,
    sourceNote: kb.note,
    model: response.model,
    usage: response.usage,
  };
}

/**
 * Free-form multi-turn 史料对话 (v1.2): 通用 RAG 问答，没有「核心人物」约束。
 * 每轮根据最新用户问题做 embedding KNN 召回相关史料；旧轮的 KB 不缓存（前端
 * 把 messages 全部传回来），后端 stateless。
 */
export async function answerFreeConversation({ messages, aiSettings, kbSize = 12 }) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("messages 必须非空");
  }
  const latestUser = [...messages].reverse().find((m) => m.role === "user");
  const latestQuestion = (latestUser?.content || "").trim();

  // KB 解析：embedding KNN 拿 kbSize 条最相关；阈值放宽，开放对话 mode
  let snippets = [];
  let kbKind = "empty";
  if (embeddingAvailable() && latestQuestion.length >= 2) {
    try {
      const vec = await vectorSearch(latestQuestion, 30);
      const filtered = vec.filter((r) => r.distance < 130).slice(0, kbSize);
      if (filtered.length) {
        const rows = fetchParagraphsByIds(filtered.map((r) => r.paragraph_id), "");
        const byId = new Map(rows.map((r) => [r.paragraphId, r]));
        snippets = filtered
          .map((r) => byId.get(r.paragraph_id))
          .filter(Boolean)
          .map((row) => ({
            paragraphId: row.paragraphId,
            bookSlug: row.bookSlug,
            bookTitle: row.bookTitle,
            chapter: row.chapter,
            anchor: row.anchor,
            text: row.content,
          }));
        kbKind = "embedding";
      }
    } catch (err) {
      console.warn(`[free-conv] embedding failed: ${err.message}`);
    }
  }

  if (snippets.length === 0 && latestQuestion) {
    // 嵌入不可用 / 无结果 → FTS5 fallback
    try {
      const rows = searchReferenceParagraphs({ keywords: [latestQuestion.slice(0, 30)], limit: kbSize, excludeSlug: "" });
      if (rows.length) {
        snippets = rows.map((r) => ({
          paragraphId: r.paragraphId,
          bookSlug: r.bookSlug,
          bookTitle: r.bookTitle,
          chapter: r.chapter,
          anchor: r.anchor,
          text: r.content,
        }));
        kbKind = "fts5";
      }
    } catch { /* ignore */ }
  }

  const kbPrompt = snippets.length === 0
    ? "（本轮未检索到任何相关史料。请如实告知用户，并提示其换关键词或换问法。）"
    : snippets.map((s, i) => `【片段#${i + 1}】《${s.bookTitle}》${s.chapter}\n${s.text}`).join("\n\n");

  if (!aiReady(aiSettings)) {
    return {
      assistant: `(AI 未配置 API Key)\n\n本轮检索到 ${snippets.length} 条相关史料：\n\n${kbPrompt}`,
      sources: snippets,
      sourceMode: kbKind,
      model: "",
    };
  }

  const systemPrompt = [
    "你是明史研究助手。读者发起一个跨多轮的史料问答会话。每轮你会收到本轮最新问题对应的知识库（由 embedding 检索得到）。",
    "",
    "回答原则：",
    "1. 以下面提供的知识库为准，每条史料前有「【片段#N】《书名》章节」标头；引用时显式说出书名 + 章节。",
    "2. 若知识库中无相关材料，明确说\"未在已检索的史料中找到\"，不要凭印象编造细节。",
    "3. 多轮对话保持上下文连贯：读者后续追问通常承接前面话题，避免无谓重复全篇。",
    "4. 不同史料如有冲突，明确指出。",
    "5. 控制篇幅：详尽但不冗长，必要时分段。",
    "",
    "## 本轮知识库",
    kbPrompt,
  ].join("\n");

  const llmMessages = [
    { role: "system", content: systemPrompt },
    ...messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  const response = await chatCompletion(llmMessages, aiSettings, {
    temperature: 0.3,
    maxTokens: 3000,
    modelStrategy: "large",
  });

  return {
    assistant: response.text,
    sources: snippets.map((s, i) => ({ ...s, index: i + 1 })),
    sourceMode: kbKind,
    model: response.model,
    usage: response.usage,
  };
}

/**
 * Return list of biographical 列传 for a person (used by 人物列传 tab).
 * Returns { biographies: [...], related: [...] } where related is filled
 * with embedding-retrieved related paragraphs from OTHER books when the
 * biography index has fewer than 2 hits (i.e. usually only 明史 covers them).
 */
export async function getPersonBiographies(person) {
  const slices = lookupBiographicalReferences(person);
  const biographies = (slices || []).map((s) => ({
    bookSlug: s.bookSlug,
    bookTitle: s.bookTitle,
    chapterLabel: s.chapterLabel,
    anchor: s.anchor,
    paragraphs: s.paragraphs,
    paragraphCount: s.paragraphs.length,
    sliceFromIndex: s.sliceFromIndex,
    sliceToIndex: s.sliceToIndex,
    chapterParagraphCount: s.chapterParagraphCount,
  }));

  // 4 部纪传体只有 ≤ 1 条命中（大多数人物属此类）时，
  // 用 embedding 检索补一段「其他史料中相关的段落」，提升 UX。
  let related = [];
  if (biographies.length <= 1 && embeddingAvailable() && person && person.trim()) {
    try {
      const vecResults = await vectorSearch(person.trim(), 30);
      // 高阈值（距离更小即更相关；BGE int8 余弦距离实际范围 0-200，
      // 这里取 < 110 作为粗筛）。然后逐条用人名 substring 双确认，
      // 避免主题相近但其实没提到此人的段落混入。
      const promising = vecResults.filter((r) => r.distance < 110).slice(0, 20);
      const rows = fetchParagraphsByIds(promising.map((r) => r.paragraph_id), "");
      const indexedSlugs = new Set(biographies.map((b) => b.bookSlug));
      const seen = new Set();
      related = rows
        .filter((r) => !indexedSlugs.has(r.bookSlug))
        .filter((r) => (r.content || "").includes(person.trim()))
        .filter((r) => {
          const key = `${r.bookSlug}:${r.chapter}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, 8)
        .map((r) => ({
          paragraphId: r.paragraphId,
          bookSlug: r.bookSlug,
          bookTitle: r.bookTitle,
          chapter: r.chapter,
          anchor: r.anchor,
          snippet: (r.content || "").slice(0, 240),
        }));
    } catch (err) {
      console.warn(`[person-bio] related embedding lookup failed: ${err.message}`);
    }
  }

  return { biographies, related };
}
