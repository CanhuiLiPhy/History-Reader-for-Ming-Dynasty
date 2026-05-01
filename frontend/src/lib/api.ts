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
  mode: "hybrid" | "ai",
  aiSettings: AiSettings,
  limit = 18,
  slug?: string,
): Promise<SearchResponse> {
  const response = await fetchWithTimeout("/api/book/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      q: query,
      mode,
      limit,
      slug,
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
  // Server-side flow: FTS search 32 snippets → format context → single AI call
  // (often 30–60 s on slow models). 35 s default is too tight; match runAiAction.
  const response = await fetchWithTimeout("/api/ai/person-chronology", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      person,
      aiSettings,
    }),
  }, 180000);
  return parseJsonResponse<ChronologyResponse>(response);
}

export async function runAiAction(payload: {
  type: "translate" | "pronounce" | "explain" | "qa" | "custom";
  selection?: string;
  question?: string;
  aiSettings: AiSettings;
  customAction?: CustomAction;
}): Promise<AiActionResponse> {
  // QA chain: up to 4 sequential AI calls (qaPlan + book scope + reference
  // filter + final answer) plus web search. Each backend AI call can take up
  // to 180s, so the chain can run for several minutes on slow models. Be
  // generous on the frontend abort.
  const timeoutMs = payload.type === "qa" ? 360000 : 180000;
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
  const response = await fetchWithTimeout("/api/reference/compare", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      selectedText,
      aiSettings,
      currentBookSlug,
    }),
  }, 300000);
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
