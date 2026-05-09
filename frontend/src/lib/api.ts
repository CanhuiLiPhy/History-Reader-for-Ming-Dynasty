import type {
  AiActionResponse,
  AiSettings,
  BookMeta,
  ChronologyResponse,
  CustomAction,
  DefaultsPayload,
  DbReaderChaptersPayload,
  DbReaderChapterPayload,
  EmperorPayload,
  GeocodeResponse,
  GeographyPayload,
  OfficialsPayload,
  OfficeSearchPayload,
  ReadableBook,
  ReignConversionResponse,
  ReferenceCompareResponse,
  ReferenceLookupResponse,
  SearchResponse,
  TimelineResponse,
} from "../types";

async function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit, timeoutMs = 35000) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("请求超时，请稍后重试。", { cause: error });
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const data = text ? (JSON.parse(text) as T | { error?: string }) : ({} as T);

  if (!response.ok) {
    const errorMessage =
      typeof data === "object" && data && "error" in data && typeof data.error === "string"
        ? data.error
        : `请求失败：${response.status}`;
    throw new Error(errorMessage);
  }

  return data as T;
}

export async function fetchDefaults(): Promise<DefaultsPayload> {
  const response = await fetchWithTimeout("/api/settings/defaults");
  return parseJsonResponse<DefaultsPayload>(response);
}

export async function fetchBookMeta(slug?: string): Promise<BookMeta> {
  const url = new URL("/api/book/meta", window.location.origin);
  if (slug) url.searchParams.set("slug", slug);
  const response = await fetchWithTimeout(url);
  return parseJsonResponse<BookMeta>(response);
}

export async function fetchLibraryBooks(): Promise<{ books: ReadableBook[] }> {
  const response = await fetchWithTimeout("/api/library/books");
  return parseJsonResponse<{ books: ReadableBook[] }>(response);
}

export async function fetchReaderChapters(slug: string): Promise<DbReaderChaptersPayload> {
  const response = await fetchWithTimeout(`/api/library/books/${encodeURIComponent(slug)}/chapters`);
  return parseJsonResponse<DbReaderChaptersPayload>(response);
}

export async function fetchReaderChapter(slug: string, index: number): Promise<DbReaderChapterPayload> {
  const response = await fetchWithTimeout(`/api/library/books/${encodeURIComponent(slug)}/chapter/${index}`);
  return parseJsonResponse<DbReaderChapterPayload>(response);
}

export function libraryEpubUrl(slug: string): string {
  // Suffix `.epub` so epub.js detects this as a zip file rather than a
  // directory base URL (which would make it fetch META-INF/container.xml).
  return `/api/library/books/${encodeURIComponent(slug)}/source.epub`;
}

export async function searchBook(
  query: string,
  mode: "local" | "fuzzy" | "ai",
  aiSettings: AiSettings,
  limit = 50,
  slugs?: string[],
): Promise<SearchResponse> {
  const response = await fetchWithTimeout("/api/book/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      q: query,
      mode,
      limit,
      // slugs 为空数组 / undefined 时后端默认搜全部书
      slugs: slugs && slugs.length ? slugs : undefined,
      aiSettings: mode === "ai" ? aiSettings : undefined,
    }),
  });
  return parseJsonResponse<SearchResponse>(response);
}

export async function fetchPersonChronology(person: string): Promise<ChronologyResponse> {
  const url = new URL("/api/book/person-chronology", window.location.origin);
  url.searchParams.set("person", person);
  const response = await fetchWithTimeout(url);
  return parseJsonResponse<ChronologyResponse>(response);
}

export async function fetchAiChronology(person: string, aiSettings: AiSettings): Promise<ChronologyResponse> {
  // FTS search 32 snippets → format context → single AI call.
  // 后端单模型 timeout 已升到 300s；留 600s 给最多 2 次 fallback。
  const response = await fetchWithTimeout("/api/ai/person-chronology", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      person,
      aiSettings,
    }),
  }, 600000);
  return parseJsonResponse<ChronologyResponse>(response);
}

export async function runAiAction(payload: {
  type: "translate" | "pronounce" | "explain" | "qa" | "punctuate" | "custom";
  selection?: string;
  question?: string;
  aiSettings: AiSettings;
  customAction?: CustomAction;
}): Promise<AiActionResponse> {
  // QA chain: up to 4 sequential AI calls (qaPlan + book scope + reference
  // filter + final answer) plus web search. Each backend AI call can take up
  // to 300s after the timeout bump; with multi-model fallback the whole chain
  // can take 10+ minutes on a slow primary. Give the frontend abort enough
  // headroom that we never beat the backend's own retry chain.
  const timeoutMs = payload.type === "qa" ? 900000 : 600000;
  const response = await fetchWithTimeout("/api/ai/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }, timeoutMs);
  return parseJsonResponse<AiActionResponse>(response);
}

export async function synthesizeSpeech(text: string, aiSettings: AiSettings): Promise<Blob> {
  const response = await fetchWithTimeout("/api/ai/speech", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      voice: aiSettings.ttsVoice || "",
    }),
  }, 60000);

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `TTS 调用失败：${response.status}`);
  }

  return response.blob();
}

export async function lookupReference(query: string, aiSettings: AiSettings): Promise<ReferenceLookupResponse> {
  const response = await fetchWithTimeout("/api/reference/lookup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      aiSettings,
    }),
  });
  return parseJsonResponse<ReferenceLookupResponse>(response);
}

export async function compareReference(selectedText: string, aiSettings: AiSettings, currentBookSlug?: string): Promise<ReferenceCompareResponse> {
  // 史料对比内部要串行：抽关键词 → 圈选书目 → 大批量检索 → 二次过滤
  // → 最终 6 节报告。每步可能触发 timeout fallback（一个模型挂了换下一个）。
  // 后端单模型 timeout=300s × 最多 6 个模型轮询 = 30 分钟上限太长。
  // 折中：前端给 15 分钟（900s），让后端有空间做 2-3 次 fallback。
  const response = await fetchWithTimeout("/api/reference/compare", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      selectedText,
      aiSettings,
      currentBookSlug,
    }),
  }, 900000);
  return parseJsonResponse<ReferenceCompareResponse>(response);
}

export async function fetchTimeline(hintText: string): Promise<TimelineResponse> {
  const response = await fetchWithTimeout("/api/reference/timeline", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hintText }),
  });
  return parseJsonResponse<TimelineResponse>(response);
}

export async function fetchGeography(): Promise<GeographyPayload> {
  const response = await fetchWithTimeout("/api/reference/geography");
  return parseJsonResponse<GeographyPayload>(response);
}

export async function geocodePlaces(query: string, aiSettings?: AiSettings): Promise<GeocodeResponse> {
  // Geocoding falls back to AI when local DB doesn't match — pass user-entered
  // API key + base URL so packaged apps without a server-side .env still work.
  const url = new URL("/api/reference/geocode", window.location.origin);
  url.searchParams.set("q", query);
  if (aiSettings) {
    if (aiSettings.baseURL) url.searchParams.set("baseURL", aiSettings.baseURL);
    if (aiSettings.apiKey) url.searchParams.set("apiKey", aiSettings.apiKey);
    if (aiSettings.smallModel) url.searchParams.set("smallModel", aiSettings.smallModel);
    if (aiSettings.model) url.searchParams.set("model", aiSettings.model);
  }
  // 60s timeout: AI lookup can be slow for unfamiliar place names.
  const response = await fetchWithTimeout(url, undefined, 60000);
  return parseJsonResponse<GeocodeResponse>(response);
}

export async function fetchChapterContext(slug: string, chapter: string, highlight = ""): Promise<{ bookTitle: string; chapter: string; highlight: string; paragraphs: string[] }> {
  const url = new URL("/api/reference/chapter-context", window.location.origin);
  url.searchParams.set("slug", slug);
  url.searchParams.set("chapter", chapter);
  if (highlight) url.searchParams.set("highlight", highlight);
  const response = await fetchWithTimeout(url);
  return parseJsonResponse(response);
}

export async function fetchEmperors(): Promise<EmperorPayload> {
  const response = await fetchWithTimeout("/api/reference/emperors");
  return parseJsonResponse<EmperorPayload>(response);
}

export async function fetchOfficials(): Promise<OfficialsPayload> {
  const response = await fetchWithTimeout("/api/reference/officials");
  return parseJsonResponse<OfficialsPayload>(response);
}

export async function convertReignTerm(term: string): Promise<ReignConversionResponse> {
  const url = new URL("/api/reference/reign-convert", window.location.origin);
  url.searchParams.set("term", term);
  const response = await fetchWithTimeout(url);
  return parseJsonResponse<ReignConversionResponse>(response);
}

export async function searchOfficeReferences(query: string): Promise<OfficeSearchPayload> {
  const url = new URL("/api/reference/office-search", window.location.origin);
  url.searchParams.set("q", query);
  const response = await fetchWithTimeout(url);
  return parseJsonResponse<OfficeSearchPayload>(response);
}

export type HistoryTimelineEvent = {
  id?: number;
  year: number;
  reign: string;
  reignYearText: string;
  description: string;
  category: string; // 皇室/政争/制度/军事/民变/外交/经济/灾异/文化/人物/其他
  scale: number; // 1-5
  hidden?: number;
  sourceLine?: number;
};
export type HistoryTimelinePayload = {
  total: number;
  events: HistoryTimelineEvent[];
  yearMin: number;
  yearMax: number;
};

export const HISTORY_CATEGORIES = ["皇室","政争","制度","军事","民变","外交","经济","灾异","文化","人物","其他"] as const;
export type HistoryCategory = typeof HISTORY_CATEGORIES[number];

export async function fetchHistoryTimeline(opts: { from?: number; to?: number; reign?: string; minScale?: number; scales?: number[]; categories?: string[]; limit?: number } = {}): Promise<HistoryTimelinePayload> {
  const url = new URL("/api/reference/history-timeline", window.location.origin);
  if (opts.from != null) url.searchParams.set("from", String(opts.from));
  if (opts.to != null) url.searchParams.set("to", String(opts.to));
  if (opts.reign) url.searchParams.set("reign", opts.reign);
  if (opts.minScale) url.searchParams.set("minScale", String(opts.minScale));
  if (opts.scales && opts.scales.length > 0) url.searchParams.set("scales", opts.scales.join(","));
  if (opts.categories && opts.categories.length > 0) url.searchParams.set("categories", opts.categories.join(","));
  if (opts.limit) url.searchParams.set("limit", String(opts.limit));
  const response = await fetchWithTimeout(url);
  return parseJsonResponse<HistoryTimelinePayload>(response);
}

export async function fetchAllTimelineEvents(): Promise<{ events: HistoryTimelineEvent[] }> {
  const response = await fetchWithTimeout(new URL("/api/timeline-events", window.location.origin));
  return parseJsonResponse<{ events: HistoryTimelineEvent[] }>(response);
}

export async function patchTimelineEventApi(id: number, patch: Partial<HistoryTimelineEvent>): Promise<{ event: HistoryTimelineEvent }> {
  const url = new URL(`/api/timeline-events/${id}`, window.location.origin);
  const response = await fetchWithTimeout(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  return parseJsonResponse<{ event: HistoryTimelineEvent }>(response);
}

export async function deleteTimelineEventApi(id: number): Promise<{ deleted: number }> {
  const url = new URL(`/api/timeline-events/${id}`, window.location.origin);
  const response = await fetchWithTimeout(url, { method: "DELETE" });
  return parseJsonResponse<{ deleted: number }>(response);
}
