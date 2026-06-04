import type { MouseEvent as ReactMouseEvent } from "react";
import { startTransition, useEffect, useRef, useState } from "react";
import ePub from "epubjs";
import L from "leaflet";
import * as OpenCC from "opencc-js";
import "leaflet/dist/leaflet.css";
import {
  BookMarked,
  BookOpenText,
  Bookmark,
  Brain,
  Calculator,
  Download,
  FilePenLine,
  History,
  Highlighter,
  Landmark,
  LibraryBig,
  MapPinned,
  NotebookPen,
  Search,
  Settings2,
  Sparkles,
  UserRound,
  X,
} from "lucide-react";
import "./App.css";
import { ShixiTree } from "./components/ShixiTree";
import { HistoricalCalculator } from "./components/HistoricalCalculator";
import {
  compareReference,
  fetchAiChronology,
  fetchChapterContext,
  fetchBookMeta,
  fetchDefaults,
  fetchEmperors,
  fetchLibraryBooks,
  fetchOfficials,
  fetchHistoryTimeline,
  fetchAllTimelineEvents,
  patchTimelineEventApi,
  HISTORY_CATEGORIES,
  type HistoryTimelineEvent,
  fetchPersonBiographies,
  fetchPersonChronology,
  fetchReaderChapters,
  fetchReaderChapter,
  fetchTimeline,
  geocodePlaces,
  libraryEpubUrl,
  lookupReference,
  runAiAction,
  runFreeConversation,
  runPersonConversation,
  searchBook,
  searchOfficeReferences,
  synthesizeSpeech,
} from "./lib/api";
import { renderMarkdown } from "./lib/markdown";
import { readPersistedState, writePersistedState } from "./lib/storage";
import { annotateYearMentions, injectReaderDocumentStyles, refreshAnnotationDates } from "./lib/yearAnnotator";
import { resolveSelectionDate, resolveShiluSelectionDate, shiluRangesForChapter, type ResolvedSelectionDate } from "./lib/reign";
import type {
  AiActionResponse,
  AiSettings,
  BookMeta,
  ChronologyResponse,
  ConversationMessage,
  ConversationSource,
  CustomAction,
  DbReaderChaptersPayload,
  DbReaderChapterPayload,
  DefaultsPayload,
  EmperorPayload,
  GeocodePlace,
  GeocodeResponse,
  OfficialsPayload,
  OfficeSearchPayload,
  PersonBiographiesResponse,
  ReadableBook,
  ReaderBookmark,
  ReaderHighlight,
  ReaderNote,
  ReferenceCompareResponse,
  ReferenceLookupResponse,
  SearchResponse,
  SearchResult,
  TimelineResponse,
  TocItem,
} from "./types";

const STORAGE_PREFIX = "mingshi-reader-ai";
const LEGACY_DEFAULT_BASE_URL = "https://api.cometapi.com/v1";
const defaultAiSettings: AiSettings = {
  baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  apiKey: "",
  defaultModel: "deepseek-v4-pro",
  model: "deepseek-v4-pro",
  // Match backend/src/config/defaults.js — keep the full DashScope list so
  // a fresh install (no persisted state, no /api/settings/defaults reachable)
  // still shows a useful set of models.
  modelOptions: ["deepseek-v4-pro", "glm-4.7", "kimi-k2.6", "qwen3.6-max-preview"],
  smallModel: "deepseek-v4-flash",
  smallModelOptions: ["deepseek-v4-flash", "qwen3.6-flash", "qwen3.6-27b"],
  ttsBaseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  ttsModel: "qwen3-tts-flash",
  ttsVoice: "Cherry",
  systemPrompt: "",
  customActions: [],
  modelProviders: [],
};

// v1.2.1：勾画 5 选项合并到一个 select，每个 style code 对应 (kind, color)。
// 颜色采用沉稳的深色（旧版 v1.2 的 Tailwind 浅色被反馈"太浅，只适合高亮"）：
//   高亮三色：金笺 #efc24f、青玉 #67b7a8、绛纱 #d97c5b
//   下划线、圈点：正红 #d4231b
function resolveMarkStyle(style: "h-gold" | "h-jade" | "h-crimson" | "underline" | "circle"): { kind: "highlight" | "underline" | "circle"; color: string; label: string } {
  switch (style) {
    case "h-gold":    return { kind: "highlight", color: "#efc24f", label: "高亮·金笺" };
    case "h-jade":    return { kind: "highlight", color: "#67b7a8", label: "高亮·青玉" };
    case "h-crimson": return { kind: "highlight", color: "#d97c5b", label: "高亮·绛纱" };
    case "underline": return { kind: "underline", color: "#d4231b", label: "下划线（正红）" };
    case "circle":    return { kind: "circle",    color: "#d4231b", label: "圈点（正红）" };
  }
}

const CHAPTER_LOCATION_BREAK_SIZE = 650;
const toTraditional = OpenCC.Converter({ from: "cn", to: "tw" });

const sidebarTabs = [
  { key: "toc", label: "目录", icon: BookOpenText },
  { key: "search", label: "搜索", icon: Search },
  { key: "notes", label: "札记", icon: NotebookPen },
  { key: "bookmarks", label: "书签", icon: Bookmark },
  { key: "people", label: "资料", icon: LibraryBig },
  { key: "settings", label: "设置", icon: Settings2 },
] as const;

type SidebarTab = (typeof sidebarTabs)[number]["key"];

type SelectionOverlay = {
  visible: boolean;
  top: number;
  left: number;
};

type ChapterNavigationItem = {
  index: number;
  label: string;
  href: string;
  sectionHref: string;
  anchor: string;
  cfi: string;
  locationIndex: number;
  percentage: number;
};

type EpubSectionLike = {
  index?: number;
  cfiBase?: string;
  document?: Document;
  load?: (loader: unknown) => Promise<void>;
  unload?: () => void;
  cfiFromElement?: (element: Element) => string;
};

type EpubLocationLike = {
  start?: {
    cfi?: string;
    href?: string;
    percentage?: number;
    location?: number;
    displayed?: { page?: number; total?: number };
  };
  end?: {
    cfi?: string;
    percentage?: number;
    displayed?: { page?: number; total?: number };
  };
};

type EpubContentsLike = {
  window: Window;
  document: Document;
  // Compute a CFI (Canonical Fragment Identifier) for a DOM node inside
  // this section's iframe — used to navigate paginated EPUB to the exact
  // column/page where the paragraph lives. Available on epub.js Contents
  // class; typed as optional since some builds may lack it.
  cfiFromNode?: (node: Node) => string;
  cfiFromRange?: (range: Range) => string;
};

type EpubRenditionLike = {
  display: (target?: string) => Promise<void>;
  next: () => Promise<void> | void;
  prev: () => Promise<void> | void;
  destroy: () => void;
  spread?: (spread: "none" | "always" | "auto", min?: number) => void;
  resize?: (width: number, height: number) => void;
  currentLocation?: () => EpubLocationLike | null;
  themes: {
    default: (styles: Record<string, Record<string, string>>) => void;
    fontSize?: (size: string) => void;
    font?: (family: string) => void;
    override?: (key: string, value: string, priority?: boolean) => void;
  };
  getContents?: () => EpubContentsLike[];
  annotations: {
    add: (type: string, cfiRange: string, data?: object, callback?: unknown, className?: string, styles?: object) => void;
    remove: (cfiRange: string, type: string) => void;
  };
  on(event: "selected", handler: (cfiRange: string, contents: EpubContentsLike) => void): void;
  on(event: "relocated", handler: (location: EpubLocationLike) => void): void;
  on(event: "rendered", handler: (section: unknown, contents: EpubContentsLike) => void): void;
};

type EpubBookLike = {
  load: (path: string) => Promise<unknown>;
  renderTo: (element: HTMLElement, options: Record<string, unknown>) => EpubRenditionLike;
  spine?: {
    get: (target: string) => EpubSectionLike | null;
  };
  locations: {
    total?: number;
    generate?: (breakSize: number) => Promise<void>;
    percentageFromCfi?: (cfi: string) => number;
    locationFromCfi?: (cfi: string) => number;
    cfiFromLocation?: (location: number) => string;
    cfiFromPercentage?: (percentage: number) => string;
  };
  opened?: Promise<unknown>;
  ready: Promise<unknown>;
  destroy?: () => void;
};

declare global {
  interface Window {
    __chapterNav?: {
      items: ChapterNavigationItem[];
      cfiSuccessCount: number;
      totalLocations: number;
    };
  }
}

// Strip wikisource/four-library prefix from chapter labels so display reads like
// "卷01" instead of "明史紀事本末/卷01" or "天下郡國利病書 (四部叢刊本)/冊七".
function normalizeChapterLabel(label: string) {
  if (!label) return "";
  const lastSlash = label.lastIndexOf("/");
  return (lastSlash >= 0 ? label.slice(lastSlash + 1) : label).trim() || label;
}

// Extract the section prefix (before the LAST '/') for 2-level TOC grouping.
// Returns "" if no slash (flat list).
function chapterSectionPrefix(label: string) {
  if (!label) return "";
  const lastSlash = label.lastIndexOf("/");
  return lastSlash >= 0 ? label.slice(0, lastSlash).trim() : "";
}

function formatChars(n: number) {
  return n.toLocaleString();
}

// Rank → numeric for sorting (正一品 < 从一品 < 正二品 < ...). Entries with no
// recognized rank go to the end.
const RANK_NUMERALS = ["一", "二", "三", "四", "五", "六", "七", "八", "九"];
function rankOrder(rank: string): number {
  if (!rank) return 999;
  const m = rank.match(/^(正|从)([一二三四五六七八九])品/);
  if (!m) return 999;
  const tier = RANK_NUMERALS.indexOf(m[2]);
  return tier * 2 + (m[1] === "从" ? 1 : 0);
}

function storageKey(name: string) {
  return `${STORAGE_PREFIX}:${name}`;
}

function formatTime(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function findTocLabel(items: TocItem[], href: string): string {
  const normalizedHref = href.replace(/^OEBPS\//, "");
  for (const item of items) {
    const itemHref = item.href.replace(/^OEBPS\//, "");
    if (itemHref === normalizedHref) return item.label;
    if (item.children.length) {
      const child = findTocLabel(item.children, href);
      if (child) return child;
    }
  }

  const currentHref = normalizedHref.split("#")[0];
  for (const item of items) {
    const itemHref = item.href.split("#")[0].replace(/^OEBPS\//, "");
    if (itemHref === currentHref) return item.label;
    if (item.children.length) {
      const child = findTocLabel(item.children, href);
      if (child) return child;
    }
  }
  return "";
}

function normalizeDisplayTarget(target: string) {
  if (!target) return target;
  if (target.startsWith("epubcfi(")) return target;
  return target.replace(/^OEBPS\//, "");
}

function extractAnchor(target: string) {
  if (!target || target.startsWith("epubcfi(")) return "";
  return target.split("#")[1] || "";
}

function flattenTocItems(items: TocItem[], output: TocItem[] = []) {
  for (const item of items) {
    output.push(item);
    if (item.children.length) flattenTocItems(item.children, output);
  }
  return output;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function uniqueValues<T>(items: T[]) {
  return [...new Set(items)];
}



function mergeAiSettings(defaults: DefaultsPayload | null, persisted: AiSettings | null, customActions: CustomAction[]) {
  const base = defaults?.ai ?? defaultAiSettings;
  const persistedBaseUrl =
    persisted?.baseURL && persisted.baseURL !== LEGACY_DEFAULT_BASE_URL ? persisted.baseURL : base.baseURL;
  const persistedTtsBaseUrl =
    persisted?.ttsBaseURL && persisted.ttsBaseURL !== LEGACY_DEFAULT_BASE_URL ? persisted.ttsBaseURL : base.ttsBaseURL;
  // v1.2.1：modelProviders 是新的单一事实源。长度 0 时回落到 base 默认（带 dev env key 的两条）。
  const finalProviders = persisted?.modelProviders?.length ? persisted.modelProviders : (base.modelProviders ?? []);
  // modelOptions / smallModelOptions 自动从 providers 派生（所有激活模型的并集）。
  // providers 为空时（打包版首次启动 + 未持久化）回落到 base 静态列表，保证下拉不空。
  const pool = [...new Set(finalProviders.flatMap((p) => p.models))];
  const finalModelOptions = pool.length ? pool : (persisted?.modelOptions?.length ? persisted.modelOptions : base.modelOptions);
  const finalSmallModelOptions = pool.length ? pool : (persisted?.smallModelOptions?.length ? persisted.smallModelOptions : base.smallModelOptions);
  return {
    ...base,
    ...persisted,
    baseURL: persistedBaseUrl,
    ttsBaseURL: persistedTtsBaseUrl,
    model: persisted?.model && finalModelOptions.includes(persisted.model)
      ? persisted.model
      : (base.defaultModel || base.model || finalModelOptions[0] || "deepseek-v4-pro"),
    modelOptions: finalModelOptions,
    smallModel: persisted?.smallModel && finalSmallModelOptions?.includes(persisted.smallModel)
      ? persisted.smallModel
      : (base.smallModel || finalSmallModelOptions?.[0] || "qwen3.6-flash-2026-04-16"),
    smallModelOptions: finalSmallModelOptions,
    customActions: customActions.length ? customActions : persisted?.customActions?.length ? persisted.customActions : base.customActions,
    modelProviders: finalProviders,
  };
}

function formatDetailValue(value: unknown) {
  if (Array.isArray(value)) return value.join("、");
  if (typeof value === "object" && value != null) return JSON.stringify(value);
  return String(value ?? "");
}

function App() {
  const readerHostRef = useRef<HTMLDivElement | null>(null);
  const bookRef = useRef<EpubBookLike | null>(null);
  const renditionRef = useRef<EpubRenditionLike | null>(null);
  const selectionContentsRef = useRef<EpubContentsLike | null>(null);
  // Cached CSS string for the current reader theme, written by the theme
  // useEffect and read by the contents.register hook so newly-rendered
  // sections immediately get the right colors (instead of flashing default).
  const themeCssRef = useRef<string>("");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const noteInputRef = useRef<HTMLTextAreaElement | null>(null);
  const audioUrlRef = useRef("");
  const initialLocationRef = useRef("");
  const currentCfiRef = useRef("");
  const currentHrefRef = useRef("");
  const pendingAnchorRef = useRef("");
  // Set by navigateToSearchResult before a search-result click triggers
  // chapter loading; consumed by the chapter-loaded effect to scroll to
  // the exact paragraph and flash-highlight it.
  const pendingSearchNavRef = useRef<{ paragraphId: number; text: string; attempts: number } | null>(null);
  // v1.2: 标记模式撤销栈。每次打标（标记模式 / 普通工具栏的「标记」按钮）push 一条 [id...]
  // Cmd+Z / Ctrl+Z 弹一条并把这些 id 从 highlights 里删掉。
  const markUndoStackRef = useRef<string[][]>([]);
  // v1.2.1 G1: handleCrossCompare 入口处 snapshot 的「原始选段」，给「保存为札记」按钮用。
  // 必须在 clearSelection() 之前 snapshot，否则 selectionCfi / selectionText 会被清空。
  // historicalAt / historicalYear 在 snapshot 时通过 resolveSelectionDate 一并算好，
  // 这样保存的札记能挂到时间线对应位置（和正常 saveNote 行为一致）。
  const compareAnchorRef = useRef<{
    cfi: string;
    text: string;
    bookSlug: string;
    historicalAt?: string;
    historicalYear?: number;
  } | null>(null);
  // v1.2 标记模式 ref（rendition.on("selected") 闭包捕获用，React 状态更新它感知不到）
  const markModeRef = useRef(false);
  const markStyleRef = useRef<"h-gold" | "h-jade" | "h-crimson" | "underline" | "circle">("h-gold");
  const pendingLocationLabelRef = useRef("");
  const pendingLocationTargetRef = useRef("");
  const forcedChapterTargetRef = useRef("");
  const pendingProgressRef = useRef<number | null>(null);
  const chapterJumpTimerRef = useRef<number | null>(null);
  const jumpingRef = useRef(false);
  const chapterNavigationRef = useRef<ChapterNavigationItem[]>([]);
  const readerLayoutRef = useRef<"horizontal" | "vertical">("horizontal");
  const scriptVariantRef = useRef<"simplified" | "traditional">("traditional");
  const pageSpreadRef = useRef<"single" | "double">("single");
  const autoAnnotateRef = useRef(true);
  const [, setDefaults] = useState<DefaultsPayload | null>(null);
  const [meta, setMeta] = useState<BookMeta | null>(null);
  // Multi-book reading state (v0.3)
  const [readableBooks, setReadableBooks] = useState<ReadableBook[]>([]);
  const [currentBookSlug, setCurrentBookSlug] = useState<string>("ming-shi");
  const [bookSwitching, setBookSwitching] = useState(false);
  const [bookMenuOpen, setBookMenuOpen] = useState(false);
  const [dbReaderChapters, setDbReaderChapters] = useState<DbReaderChaptersPayload | null>(null);
  const [dbReaderChapter, setDbReaderChapter] = useState<DbReaderChapterPayload | null>(null);
  const [dbReaderIndex, setDbReaderIndex] = useState(0);
  const [dbReaderLoading, setDbReaderLoading] = useState(false);
  // DB-reader pagination (CSS columns flow horizontally; we scroll viewport-wise)
  const dbReaderHostRef = useRef<HTMLDivElement | null>(null);
  // AI 句读 inline overlay — wraps each char of the selected text in <span>
  // markers so the punctuated breaks show directly on the original text. The
  // ref holds a cleanup function that unwraps everything; called on next
  // selection / chapter change / next 句读 result.
  const dudouCleanupRef = useRef<(() => void) | null>(null);
  const [dbPageIndex, setDbPageIndex] = useState(0);
  const [dbPageTotal, setDbPageTotal] = useState(1);
  const [activeTab, setActiveTab] = useState<SidebarTab>("toc");
  const [bootError, setBootError] = useState("");
  const [loadingBoot, setLoadingBoot] = useState(true);
  const [readerReady, setReaderReady] = useState(false);
  const [currentCfi, setCurrentCfi] = useState("");
  const [currentHref, setCurrentHref] = useState("");
  const [currentSectionLabel, setCurrentSectionLabel] = useState("");
  const [progress, setProgress] = useState(0);
  const [chapterPageCurrent, setChapterPageCurrent] = useState(1);
  const [chapterPageTotal, setChapterPageTotal] = useState(1);
  const [chapterNavigation, setChapterNavigation] = useState<ChapterNavigationItem[]>([]);
  const [currentChapterIndex, setCurrentChapterIndex] = useState(0);
  const [locationsReady, setLocationsReady] = useState(false);
  const [selectionText, setSelectionText] = useState("");
  // 旧的 highlightStyle 在 v1.2 toolbar 精简后弹窗里已不暴露挑选；保留 state 以备
  // 之后某处复用，不会进入 React 渲染路径。
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_highlightStyle, _setHighlightStyle] = useState<{ kind: "highlight" | "underline" | "circle"; color: string }>({ kind: "highlight", color: "#efc24f" });
  void _highlightStyle; void _setHighlightStyle;
  // Bumped after layout-changing events (sidebar collapse, etc.) so the
  // highlights effect re-runs and forces annotations to re-render after epub.js
  // has settled in its new dimensions.
  const [highlightRedrawTick, setHighlightRedrawTick] = useState(0);
  const [selectionCfi, setSelectionCfi] = useState("");
  const [selectionOverlay, setSelectionOverlay] = useState<SelectionOverlay>({
    visible: false,
    top: 0,
    left: 0,
  });
  // 「保留」累积模式：开启时新选段不清空旧选段，而是追加到 pinnedSegments；
  // AI / 笔记 / 勾画 等动作把所有已 pin 的段 + 当前段 拼接 / 逐段处理，
  // 用以解决跨页跨章选段无法被一次性 OS-level selection 覆盖的问题。
  // pinnedSegments 不含当前 selectionText / selectionCfi —— 它们仍是
  // 「最新一段」的独立状态，effectiveSelectionText 才是 join 后的总文本。
  const [accumulateMode, setAccumulateMode] = useState(false);
  const [pinnedSegments, setPinnedSegments] = useState<{ cfi: string; text: string }[]>([]);
  // 拼好的总文本：所有 pin 段 + 当前段。供 AI / 检索 / 勾画 全部统一用。
  const effectiveSelectionText = pinnedSegments.length
    ? pinnedSegments.map((s) => s.text).join("") + selectionText
    : selectionText;
  // EPUB 的 selection handler 在 rendition init useEffect 内注册一次，
  // 闭包里的 accumulateMode / selectionText / selectionCfi 会变成 stale。
  // 用 ref 镜像，handler 始终读最新值。
  const accumulateModeRef = useRef(false);
  const selectionTextRef = useRef("");
  const selectionCfiRef = useRef("");
  useEffect(() => { accumulateModeRef.current = accumulateMode; }, [accumulateMode]);
  useEffect(() => { selectionTextRef.current = selectionText; }, [selectionText]);
  useEffect(() => { selectionCfiRef.current = selectionCfi; }, [selectionCfi]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMode, setSearchMode] = useState<"local" | "fuzzy" | "semantic">("local");
  const [searchResponse, setSearchResponse] = useState<SearchResponse | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState("");
  // 本地模糊检索的范围：空数组 = 全部书；否则为选中的 slug 列表。
  const [searchSlugs, setSearchSlugs] = useState<string[]>([]);
  const [searchScopeOpen, setSearchScopeOpen] = useState(false);
  // 检索结果显示条数（前后端共享，覆盖默认）
  const [searchLimit, setSearchLimit] = useState<number>(50);
  const [aiSettings, setAiSettings] = useState<AiSettings>(defaultAiSettings);
  const [customActions, setCustomActions] = useState<CustomAction[]>([]);
  const [highlights, setHighlights] = useState<ReaderHighlight[]>([]);
  const [notes, setNotes] = useState<ReaderNote[]>([]);
  const [bookmarks, setBookmarks] = useState<ReaderBookmark[]>([]);
  const [autoAnnotate, setAutoAnnotate] = useState(true);
  const [promptSupplementEnabled, setPromptSupplementEnabled] = useState(true);
  const [supplementDraft, setSupplementDraft] = useState("");
  const [pendingAction, setPendingAction] = useState<{ type: string; customAction?: CustomAction; handler?: string } | null>(null);
  const [sourceViewer, setSourceViewer] = useState<{ bookTitle: string; chapter: string; highlight: string; paragraphs: string[] } | null>(null);
  const [sourceViewerLoading, setSourceViewerLoading] = useState(false);
  const [apiConfigOpen, setApiConfigOpen] = useState(false);
  const [lastLocation, setLastLocation] = useState("");
  const [noteComposerOpen, setNoteComposerOpen] = useState(false);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [expandedNoteId, setExpandedNoteId] = useState<string | null>(null);
  // Notes view: sort + range filters (UI-only state, not persisted)
  const [notesSort, setNotesSort] = useState<"created-desc" | "created-asc" | "historical-asc" | "historical-desc" | "book">("created-desc");
  const [notesYearMin, setNotesYearMin] = useState("");
  const [notesYearMax, setNotesYearMax] = useState("");
  const [notesCreatedMin, setNotesCreatedMin] = useState("");
  const [notesCreatedMax, setNotesCreatedMax] = useState("");
  const [bookmarkNameDraft, setBookmarkNameDraft] = useState("");
  const [noteDraft, setNoteDraft] = useState("");
  // 笔记 → 历史时间线 集成。这些 draft 字段在打开 composer 时被
  // populated（新建笔记时按 selection 自动检测时间填，编辑时从既有 note 字段拷贝），
  // 保存时写回 note 对象。
  const [tlDraftEnabled, setTlDraftEnabled] = useState(false);
  const [tlDraftYear, setTlDraftYear] = useState<string>("");
  const [tlDraftMonth, setTlDraftMonth] = useState<string>("");
  const [tlDraftDay, setTlDraftDay] = useState<string>("");
  const [tlDraftScale, setTlDraftScale] = useState<number>(1);
  const [tlDraftCategory, setTlDraftCategory] = useState<string>("我的札记");
  const [tlDraftTitle, setTlDraftTitle] = useState<string>("");
  // v1.2.1: 右侧直接提问输入框隐藏（被左栏 AI 对话取代）；setter 在 selection-based qa path 还可能用到。
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [questionDraft, setQuestionDraft] = useState("");
  void setQuestionDraft;
  const [aiResponse, setAiResponse] = useState<AiActionResponse | null>(null);
  const [aiPanelTitle, setAiPanelTitle] = useState("选段助理");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState("");
  const [personQuery, setPersonQuery] = useState("");
  // 保留以备旧端点 /api/ai/person-chronology 兼容；UI 不再直接调用。
  // Underscore prefix tells TS we know it's unused but want to keep around.
  const [_personChronology, setPersonChronology] = useState<ChronologyResponse | null>(null);
  const [_personLoading, setPersonLoading] = useState(false);
  void _personChronology; void _personLoading;
  // 重构后的 人物 panel：分「人物列传」「AI 对话」两个 tab。
  const [personPanelTab, setPersonPanelTab] = useState<"biographies" | "conversation">("biographies");
  const [personBiographies, setPersonBiographies] = useState<PersonBiographiesResponse | null>(null);
  const [biographiesLoading, setBiographiesLoading] = useState(false);
  const [conversationMessages, setConversationMessages] = useState<ConversationMessage[]>([]);
  const [conversationLoading, setConversationLoading] = useState(false);
  const [conversationMode, setConversationMode] = useState<"core-person" | "open">("core-person");
  const [conversationInput, setConversationInput] = useState("");
  const [conversationSources, setConversationSources] = useState<ConversationSource[]>([]);
  const [conversationSourceMode, setConversationSourceMode] = useState<string>("");
  const [conversationError, setConversationError] = useState("");
  const [conversationSourcesExpanded, setConversationSourcesExpanded] = useState(false);
  // v1.2 自由对话（左侧资料 → AI 对话）：多轮 + 本地 history 自动存档。
  type FreeChatHistory = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    messages: ConversationMessage[];
    sources: ConversationSource[];
    sourceMode: string;
  };
  const [freeChats, setFreeChats] = useState<FreeChatHistory[]>([]);
  const [activeFreeChatId, setActiveFreeChatId] = useState<string | null>(null);
  const [freeChatInput, setFreeChatInput] = useState("");
  const [freeChatLoading, setFreeChatLoading] = useState(false);
  const [freeChatError, setFreeChatError] = useState("");
  const [freeChatSourcesExpanded, setFreeChatSourcesExpanded] = useState(false);
  // v1.2.1: AI 对话窗口里独立选模型（覆盖全局 defaultModel，只对此面板生效）
  const [freeChatModel, setFreeChatModel] = useState<string>("");
  // Baidu Baike inline lookup: when set, the chronology panel renders an
  // iframe pointing at https://baike.baidu.com/item/<name> below the result
  // area. Stored separately from personQuery so the user can keep typing in
  // the search box without resetting the embedded page.
  const [baikeQuery, setBaikeQuery] = useState("");
  const [ttsStatus, setTtsStatus] = useState("");
  const [referenceLookup, setReferenceLookup] = useState<ReferenceLookupResponse | null>(null);
  const [referenceCompare, setReferenceCompare] = useState<ReferenceCompareResponse | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [compareLoading, setCompareLoading] = useState(false);
  // v1.2.1 G3: 「展开」按钮控制的弹窗。右侧栏窄，弹窗里渲染同一份 reportMarkdown。
  const [compareExpandOpen, setCompareExpandOpen] = useState(false);
  // v1.2.1: 左侧札记面板的「展开」弹窗。值为要展开的 note id，null 关闭。
  const [noteExpandedFor, setNoteExpandedFor] = useState<string | null>(null);
  const [referenceError, setReferenceError] = useState("");
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [, setTimelineLoading] = useState(false);
  const [timelineData, setTimelineData] = useState<TimelineResponse | null>(null);
  const [emperorsData, setEmperorsData] = useState<EmperorPayload | null>(null);
  const [officialsData, setOfficialsData] = useState<OfficialsPayload | null>(null);
  const [officeSearchQuery, setOfficeSearchQuery] = useState("");
  const [officeSearchResult, setOfficeSearchResult] = useState<OfficeSearchPayload | null>(null);
  const [officeSearchLoading, setOfficeSearchLoading] = useState(false);
  const [referenceFilter, setReferenceFilter] = useState("");
  // Officials panel sub-tabs (v0.3 extended data)
  const [officialsTab, setOfficialsTab] = useState<"lineage" | "institutions" | "offices" | "chronology" | "princes">("lineage");
  const [officeRankFilter, setOfficeRankFilter] = useState("");
  const [chronologyFilter, setChronologyFilter] = useState("");
  const [openResourcePanel, setOpenResourcePanel] = useState<string | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  // Default collapsed — main reading area gets full width on launch.
  // The footer (page slider + status) follows this same flag.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [assistantCollapsed, setAssistantCollapsed] = useState(true);
  // v1.2: 键盘翻页 — 默认关闭；开启后 ←/→ 翻页（在 input/textarea 聚焦时不触发）。
  const [keyboardPagingEnabled, setKeyboardPagingEnabled] = useState(true);
  // v1.2: 标记模式 — 默认关闭；开启后选段直接按当前 default 颜色/形态打标，不弹工具栏；Cmd+Z 撤销最近一次。
  const [markModeEnabled, setMarkModeEnabled] = useState(false);
  // v1.2.1: 默认勾画样式 合并为 5 选项（高亮 3 色 + 下划线 + 圈点）
  // style code:
  //   "h-gold"     高亮·金笺   #efc24f
  //   "h-jade"     高亮·青玉   #67b7a8
  //   "h-crimson"  高亮·绛纱   #d97c5b
  //   "underline"  下划线·正红 #d4231b
  //   "circle"     圈点·正红   #d4231b
  type MarkStyle = "h-gold" | "h-jade" | "h-crimson" | "underline" | "circle";
  const [markStyle, setMarkStyle] = useState<MarkStyle>("h-gold");
  const [readerLayout, setReaderLayout] = useState<"horizontal" | "vertical">("horizontal");
  const [scriptVariant, setScriptVariant] = useState<"simplified" | "traditional">("traditional");
  // Independent UI 简繁 toggle. The 正文字体转换 above only affects body
  // content (EPUB iframe / DB-reader paragraphs); this one drives all the
  // chrome (sidebar / settings / modals / buttons). Default: 繁体 — matches
  // the body content default (also 繁体) so the whole app reads consistently.
  const [uiScriptVariant, setUiScriptVariant] = useState<"simplified" | "traditional">("traditional");
  const [pageSpread, setPageSpread] = useState<"single" | "double">("single");
  // v0.3 reading theme + font controls
  const [readerTheme, setReaderTheme] = useState<"default" | "sepia" | "dark" | "green">("default");
  // Body text 与 UI font 用同一组 key（共享 FONT_OPTIONS / FONT_FAMILIES 表，
  // 见下方 effect）。"system-songti" / "system-fangsong" 是两种系统字体回退栈
  // （区别在第一个回退是宋体类还是仿宋类），其余 8 个是 frontend/public/fonts/
  // 下的内置字体。
  type FontKey =
    | "system-songti"
    | "system-fangsong"
    | "mingchao"
    | "fangsong"
    | "songti"
    | "kaiti"
    | "zhengkai"
    | "xiawu"
    | "lishu"
    | "shoujin";
  const [readerFontFamily, setReaderFontFamily] = useState<FontKey>("mingchao");
  // UI 字体默认值：汇文正楷
  const [uiFontFamily, setUiFontFamily] = useState<FontKey>("zhengkai");
  const [readerFontSize, setReaderFontSize] = useState<number>(20);
  const [readerFontColor, setReaderFontColor] = useState<string>("");
  const [dateDisplay, setDateDisplay] = useState<"gregorian" | "lunar" | "both">("lunar");
  const dateDisplayRef = useRef<"gregorian" | "lunar" | "both">("lunar");
  const [showEmperor, setShowEmperor] = useState<boolean>(false);
  const showEmperorRef = useRef<boolean>(false);
  const [dateResult, setDateResult] = useState<ResolvedSelectionDate | { error: string } | null>(null);
  const [mapQuery, setMapQuery] = useState("");
  const [mapLoading, setMapLoading] = useState(false);
  const [mapResult, setMapResult] = useState<GeocodeResponse | null>(null);
  const [newActionName, setNewActionName] = useState("");
  const [newActionSystem, setNewActionSystem] = useState("");
  const [newActionTemplate, setNewActionTemplate] = useState("");
  const [hasLoadedLocalState, setHasLoadedLocalState] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const bootstrap = async () => {
      try {
        const [
          defaultsData,
          libraryBooksData,
          savedAiSettings,
          savedHighlights,
          savedNotes,
          savedBookmarks,
          savedAutoAnnotate,
          savedLastLocation,
          savedCustomActions,
          savedReaderLayout,
          savedScriptVariant,
          savedPageSpread,
          savedBookSlug,
          savedReaderTheme,
          savedReaderFontFamily,
          savedUiFontFamily,
          savedReaderFontSize,
          savedReaderFontColor,
          savedDateDisplay,
          savedShowEmperor,
          savedUiScriptVariant,
          savedKeyboardPaging,
          savedMarkMode,
          savedMarkStyle,
        ] =
          await Promise.all([
            fetchDefaults(),
            fetchLibraryBooks(),
            readPersistedState<AiSettings | null>(storageKey("ai-settings"), null),
            readPersistedState<ReaderHighlight[]>(storageKey("highlights"), []),
            readPersistedState<ReaderNote[]>(storageKey("notes"), []),
            readPersistedState<ReaderBookmark[]>(storageKey("bookmarks"), []),
            readPersistedState<boolean>(storageKey("auto-annotate"), true),
            readPersistedState<string>(storageKey("last-location"), ""), // legacy global key, used only as ming-shi fallback below
            readPersistedState<CustomAction[]>(storageKey("custom-actions"), []),
            readPersistedState<"horizontal" | "vertical">(storageKey("reader-layout"), "horizontal"),
            readPersistedState<"simplified" | "traditional">(storageKey("script-variant"), "traditional"),
            readPersistedState<"single" | "double">(storageKey("page-spread"), "single"),
            readPersistedState<string>(storageKey("current-book-slug"), "ming-shi"),
            readPersistedState<"default" | "sepia" | "dark" | "green">(storageKey("reader-theme"), "default"),
            // 老 localStorage 值（serif/fangsong/kaiti/lishu/shoujin）→ 新 key 映射；
            // 见下方 setReaderFontFamily 的迁移逻辑。这里先按 string 读，再做映射。
            readPersistedState<string>(storageKey("reader-font-family"), "mingchao"),
            readPersistedState<string>(storageKey("ui-font-family"), "zhengkai"),
            readPersistedState<number>(storageKey("reader-font-size"), 20),
            readPersistedState<string>(storageKey("reader-font-color"), ""),
            readPersistedState<"gregorian" | "lunar" | "both">(storageKey("date-display"), "lunar"),
            readPersistedState<boolean>(storageKey("show-emperor"), false),
            readPersistedState<"simplified" | "traditional">(storageKey("ui-script-variant"), "traditional"),
            readPersistedState<boolean>(storageKey("keyboard-paging-enabled"), true),
            readPersistedState<boolean>(storageKey("mark-mode-enabled"), false),
            readPersistedState<"h-gold" | "h-jade" | "h-crimson" | "underline" | "circle">(storageKey("mark-style"), "h-gold"),
          ]);

        if (cancelled) return;

        const normalizeActions = (actions: CustomAction[]) =>
          actions
            .filter((item) => item.id !== "exam-note")
            .map((item) =>
              item.id === "vernacular"
                ? { ...item, name: "翻译为现代文" }
                : item
            );
        const nextCustomActions = normalizeActions(savedCustomActions.length ? savedCustomActions : defaultsData.ai.customActions);

        // Resolve initial book: persisted slug if it exists in library and is readable, else ming-shi
        const persistedBook = libraryBooksData.books.find((b) => b.slug === savedBookSlug);
        const initialBook = persistedBook && (persistedBook.hasEpub || persistedBook.paragraphCount > 0)
          ? persistedBook
          : libraryBooksData.books.find((b) => b.slug === "ming-shi") || libraryBooksData.books[0];
        const initialSlug = initialBook?.slug || "ming-shi";

        // Fetch the initial book's content (meta for EPUB books, chapters for DB books)
        let initialMeta: BookMeta | null = null;
        let initialDbChapters: DbReaderChaptersPayload | null = null;
        let initialDbChapter: DbReaderChapterPayload | null = null;
        try {
          if (initialBook?.hasEpub) {
            initialMeta = await fetchBookMeta(initialSlug);
          } else if (initialBook) {
            initialDbChapters = await fetchReaderChapters(initialSlug);
            if (initialDbChapters.chapters.length > 0) {
              initialDbChapter = await fetchReaderChapter(initialSlug, 0);
            }
          }
        } catch (error) {
          if (!cancelled) setBootError(error instanceof Error ? error.message : `加载《${initialBook?.title || initialSlug}》失败。`);
        }
        if (cancelled) return;

        setDefaults(defaultsData);
        setReadableBooks(libraryBooksData.books);
        setCurrentBookSlug(initialSlug);
        setMeta(initialMeta);
        setDbReaderChapters(initialDbChapters);
        setDbReaderChapter(initialDbChapter);
        setDbReaderIndex(0);
        setCustomActions(nextCustomActions);
        setAiSettings(mergeAiSettings(defaultsData, savedAiSettings, nextCustomActions));
        // Drop legacy unanchored db-cfis (just `db:slug:idx` — 3 parts). Both
        // single-paragraph (5 parts) and cross-paragraph (`...:m:...`, 8 parts)
        // anchored forms are kept.
        setHighlights(
          savedHighlights.filter((h) => !h.cfiRange.startsWith("db:") || h.cfiRange.split(":").length >= 5)
        );
        setNotes(savedNotes);
        setBookmarks(savedBookmarks);
        setAutoAnnotate(savedAutoAnnotate);
        // setLastLocation is called below after we've loaded the per-book CFI.
        setReaderLayout(savedReaderLayout);
        setScriptVariant(savedScriptVariant);
        setPageSpread(savedPageSpread);
        setReaderTheme(savedReaderTheme);
        // 字体 key 老→新迁移：v1.0 之前的 5-key 体系 + 一个 v1.0.1 的 "system"
        // → v1.0.2 的 10-key 体系（system 拆 system-songti / system-fangsong）
        const fontKeyMigration: Record<string, FontKey> = {
          serif: "mingchao",
          fangsong: "fangsong",
          kaiti: "xiawu",   // 旧"楷书"指霞鹜文楷
          lishu: "lishu",
          shoujin: "shoujin",
          system: "system-songti",
        };
        const validKeys: FontKey[] = [
          "system-songti", "system-fangsong",
          "mingchao", "fangsong", "songti", "kaiti", "zhengkai", "xiawu", "lishu", "shoujin",
        ];
        const migrate = (raw: string, fallback: FontKey): FontKey =>
          fontKeyMigration[raw] ?? (validKeys.includes(raw as FontKey) ? (raw as FontKey) : fallback);
        setReaderFontFamily(migrate(savedReaderFontFamily, "mingchao"));
        setUiFontFamily(migrate(savedUiFontFamily, "zhengkai"));
        setReaderFontSize(savedReaderFontSize);
        setReaderFontColor(savedReaderFontColor);
        setDateDisplay(savedDateDisplay);
        dateDisplayRef.current = savedDateDisplay;
        setShowEmperor(savedShowEmperor);
        showEmperorRef.current = savedShowEmperor;
        setUiScriptVariant(savedUiScriptVariant);
        setKeyboardPagingEnabled(savedKeyboardPaging);
        setMarkModeEnabled(savedMarkMode);
        setMarkStyle(savedMarkStyle);
        readerLayoutRef.current = savedReaderLayout;
        scriptVariantRef.current = savedScriptVariant;
        pageSpreadRef.current = savedPageSpread;
        // Per-book last-location: each book gets its own saved CFI so that
        // a stale CFI from one book doesn't get applied to another (which
        // would resolve to invalid spine and silently render the cover page).
        // Legacy global "last-location" is read above and used as a one-time
        // ming-shi fallback for users upgrading from before this split.
        const perBookLocation = await readPersistedState<string>(storageKey(`last-location:${initialSlug}`), "");
        const effectiveLastLocation = perBookLocation || (initialSlug === "ming-shi" ? savedLastLocation : "");
        setLastLocation(effectiveLastLocation);
        initialLocationRef.current = effectiveLastLocation;
        setHasLoadedLocalState(true);
      } catch (error) {
        if (cancelled) return;
        setBootError(error instanceof Error ? error.message : "初始化失败。");
      } finally {
        if (!cancelled) {
          setLoadingBoot(false);
        }
      }
    };

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hasLoadedLocalState) return;
    void writePersistedState(storageKey("ai-settings"), aiSettings);
  }, [aiSettings, hasLoadedLocalState]);

  useEffect(() => {
    if (!hasLoadedLocalState) return;
    void writePersistedState(storageKey("custom-actions"), customActions);
  }, [customActions, hasLoadedLocalState]);

  useEffect(() => {
    if (!hasLoadedLocalState) return;
    void writePersistedState(storageKey("highlights"), highlights);
  }, [highlights, hasLoadedLocalState]);

  useEffect(() => {
    if (!hasLoadedLocalState) return;
    void writePersistedState(storageKey("notes"), notes);
  }, [notes, hasLoadedLocalState]);

  useEffect(() => {
    if (!hasLoadedLocalState) return;
    void writePersistedState(storageKey("bookmarks"), bookmarks);
  }, [bookmarks, hasLoadedLocalState]);

  useEffect(() => {
    autoAnnotateRef.current = autoAnnotate;
    if (!hasLoadedLocalState) return;
    void writePersistedState(storageKey("auto-annotate"), autoAnnotate);
  }, [autoAnnotate, hasLoadedLocalState]);

  useEffect(() => {
    if (!hasLoadedLocalState) return;
    if (!currentBookSlug) return;
    void writePersistedState(storageKey(`last-location:${currentBookSlug}`), lastLocation);
  }, [lastLocation, hasLoadedLocalState, currentBookSlug]);

  useEffect(() => {
    if (!hasLoadedLocalState) return;
    void writePersistedState(storageKey("current-book-slug"), currentBookSlug);
  }, [currentBookSlug, hasLoadedLocalState]);

  // v0.3 — apply reader theme + font controls to both DB-reader (CSS vars on
  // document root) and the EPUB rendition (epub.js iframe styles).
  useEffect(() => {
    const presets: Record<typeof readerTheme, { bg: string; color: string }> = {
      default: { bg: "#fcf8ee", color: "#1f160f" },
      sepia: { bg: "#f1e4c8", color: "#3a2810" },
      dark: { bg: "#1a1814", color: "#dcc89a" },
      green: { bg: "#dde9d4", color: "#23371b" },
    };
    // Bundled font names come first (always available); system fonts second
    // (cover characters the bundled font may miss); generic last as final
    // safety net.
    // 字体优先级：内置自有字体 → 系统等价回退 → 通用 serif/sans 兜底。
    // 10 个 key（前 2 个是系统宋体/仿宋两种回退栈，后 8 个是
    // frontend/public/fonts/fonts.css 里 @font-face 注册的内置字体）。
    const FONT_FAMILIES: Record<FontKey, string> = {
      "system-songti":  '"Source Han Serif SC", "Noto Serif SC", "Songti SC", "SimSun", "宋体", serif',
      "system-fangsong": '"FangSong", "STFangsong", "FangSong_GB2312", "仿宋", "Source Han Serif SC", "Noto Serif SC", serif',
      mingchao: '"Huiwen Mingchao", "Source Han Serif SC", "Noto Serif SC", "Songti SC", "SimSun", "宋体", serif',
      fangsong: '"Huiwen Fangsong", "FangSong", "STFangsong", "FangSong_GB2312", "仿宋", "Source Han Serif SC", serif',
      songti: '"Jinghua Laosong", "Source Han Serif SC", "Noto Serif SC", "Songti SC", "SimSun", "宋体", serif',
      kaiti: '"Fangzheng Yongle", "Huiwen Zhengkai", "LXGW WenKai", "KaiTi", "STKaiti", "BiauKai", "楷体", serif',
      zhengkai: '"Huiwen Zhengkai", "Fangzheng Yongle", "LXGW WenKai", "KaiTi", "STKaiti", serif',
      xiawu: '"LXGW WenKai", "Huiwen Zhengkai", "Fangzheng Yongle", "KaiTi", "STKaiti", serif',
      lishu: '"Fangzheng Liqi", "LiSu", "STLiti", "SimLi", "隶书", serif',
      shoujin: '"Fangzheng Shoujin", "LXGW WenKai", "KaiTi", "STKaiti", serif',
    };
    const families = FONT_FAMILIES;
    const preset = presets[readerTheme];
    const color = readerFontColor || preset.color;
    const family = families[readerFontFamily];
    const sizePx = `${readerFontSize}px`;

    const root = document.documentElement;
    root.style.setProperty("--reader-bg", preset.bg);
    root.style.setProperty("--reader-color", color);
    root.style.setProperty("--reader-font-family", family);
    root.style.setProperty("--reader-font-size", sizePx);
    root.dataset.readerTheme = readerTheme;

    // Build the theme override CSS injected into each EPUB iframe. EPUBs ship
    // stylesheets that target specific elements (e.g. `p { color: #000; }`)
    // which beat `body { color !important }` from epub.js themes. The wide
    // `body *` selector with !important is what actually flips dark mode.
    // We only override color + background + font — never layout/positioning,
    // since the EPUB's own CSS handles those.
    const themeCss = `
      html, body {
        color: ${color} !important;
        background-color: ${preset.bg} !important;
        font-family: ${family} !important;
        font-size: ${sizePx} !important;
      }
      body, body p, body div, body span, body h1, body h2, body h3, body h4,
      body h5, body h6, body li, body td, body th, body blockquote, body em,
      body strong, body a, body font, body section, body article {
        color: ${color} !important;
        background-color: transparent !important;
      }
      body a { text-decoration: none; }
    `;
    themeCssRef.current = themeCss;

    // Apply to live epub.js rendition if present.
    const rendition = renditionRef.current;
    if (rendition?.themes) {
      try {
        rendition.themes.default({
          body: {
            color: `${color} !important`,
            background: `${preset.bg} !important`,
            "font-family": `${family} !important`,
            "font-size": `${sizePx} !important`,
            "line-height": "1.92 !important",
            "letter-spacing": "0.01em",
            "max-width": "none !important",
          },
          p: { "text-indent": "2em" },
        });
        rendition.themes.fontSize?.(sizePx);
        rendition.themes.font?.(family);
      } catch {
        // some epub.js APIs unavailable; CSS-vars fallback covers the host
      }

      // Push theme CSS into already-rendered iframes (theme change while
      // reading should take effect immediately, not just on next page).
      try {
        const allContents = rendition.getContents?.() || [];
        for (const contents of allContents) {
          const doc = contents.document;
          let style = doc.getElementById("mingshi-injected-theme") as HTMLStyleElement | null;
          if (!style) {
            style = doc.createElement("style");
            style.id = "mingshi-injected-theme";
            doc.head.appendChild(style);
          }
          style.textContent = themeCss;
        }
      } catch {
        // contents not yet available; the contents.register hook will inject
        // themeCssRef.current when each section first renders
      }
    }
  }, [readerTheme, readerFontFamily, readerFontSize, readerFontColor, readerReady]);

  useEffect(() => {
    if (!hasLoadedLocalState) return;
    void writePersistedState(storageKey("reader-theme"), readerTheme);
  }, [readerTheme, hasLoadedLocalState]);

  useEffect(() => {
    if (!hasLoadedLocalState) return;
    void writePersistedState(storageKey("reader-font-family"), readerFontFamily);
  }, [readerFontFamily, hasLoadedLocalState]);

  // UI 字体（独立于正文字体）：写到 --ui-font-family CSS 变量上，App.css 里
  // body / 各面板继承。同时持久化到 localStorage 跨 session 保留。
  useEffect(() => {
    const FONT_FAMILIES_UI: Record<typeof uiFontFamily, string> = {
      "system-songti":   '"Source Han Serif SC", "Noto Serif SC", "Songti SC", "SimSun", "宋体", serif',
      "system-fangsong": '"FangSong", "STFangsong", "FangSong_GB2312", "仿宋", "Source Han Serif SC", "Noto Serif SC", serif',
      mingchao: '"Huiwen Mingchao", "Source Han Serif SC", "Noto Serif SC", "Songti SC", serif',
      fangsong: '"Huiwen Fangsong", "FangSong", "STFangsong", "仿宋", serif',
      songti:   '"Jinghua Laosong", "Source Han Serif SC", "Songti SC", "SimSun", serif',
      kaiti:    '"Fangzheng Yongle", "Huiwen Zhengkai", "LXGW WenKai", "KaiTi", serif',
      zhengkai: '"Huiwen Zhengkai", "Fangzheng Yongle", "LXGW WenKai", "KaiTi", serif',
      xiawu:    '"LXGW WenKai", "Huiwen Zhengkai", "Fangzheng Yongle", "KaiTi", serif',
      lishu:    '"Fangzheng Liqi", "LiSu", "STLiti", "隶书", serif',
      shoujin:  '"Fangzheng Shoujin", "LXGW WenKai", "KaiTi", serif',
    };
    document.documentElement.style.setProperty("--ui-font-family", FONT_FAMILIES_UI[uiFontFamily]);
  }, [uiFontFamily]);

  useEffect(() => {
    if (!hasLoadedLocalState) return;
    void writePersistedState(storageKey("ui-font-family"), uiFontFamily);
  }, [uiFontFamily, hasLoadedLocalState]);

  useEffect(() => {
    if (!hasLoadedLocalState) return;
    void writePersistedState(storageKey("reader-font-size"), readerFontSize);
  }, [readerFontSize, hasLoadedLocalState]);

  useEffect(() => {
    if (!hasLoadedLocalState) return;
    void writePersistedState(storageKey("reader-font-color"), readerFontColor);
  }, [readerFontColor, hasLoadedLocalState]);

  // dateDisplay / showEmperor change: refresh notes on already-rendered
  // iframes (ingredient data attrs are stamped during initial annotation
  // run, so refresh is O(annotated spans), no DOM walk needed).
  useEffect(() => {
    dateDisplayRef.current = dateDisplay;
    showEmperorRef.current = showEmperor;
    if (!hasLoadedLocalState) return;
    void writePersistedState(storageKey("date-display"), dateDisplay);
    void writePersistedState(storageKey("show-emperor"), showEmperor);
    const rendition = renditionRef.current;
    try {
      const allContents = rendition?.getContents?.() || [];
      for (const contents of allContents) {
        refreshAnnotationDates(contents.document, dateDisplay, showEmperor);
      }
    } catch {
      // contents not yet available; next annotateYearMentions call will
      // pick up the new mode via dateDisplayRef
    }
  }, [dateDisplay, showEmperor, hasLoadedLocalState]);

  // UI 简繁转换: walk the React-rendered chrome (sidebar / settings / modals
  // / buttons / labels), convert any text node to the requested variant,
  // and re-apply on every DOM mutation so React re-renders don't undo us.
  // Skips: <input>/<textarea> values (carry user data we mustn't munge), the
  // EPUB iframe and the DB-reader host (have their own conversion paths),
  // and the year-annotation tooltips (data-note attribute already cooked).
  // v1.2 persist 新加的 4 个开关。轻量，分开写 effect 避免一次写多个 key。
  useEffect(() => { if (hasLoadedLocalState) void writePersistedState(storageKey("keyboard-paging-enabled"), keyboardPagingEnabled); }, [keyboardPagingEnabled, hasLoadedLocalState]);
  useEffect(() => { markModeRef.current = markModeEnabled; if (hasLoadedLocalState) void writePersistedState(storageKey("mark-mode-enabled"), markModeEnabled); }, [markModeEnabled, hasLoadedLocalState]);
  useEffect(() => { markStyleRef.current = markStyle; if (hasLoadedLocalState) void writePersistedState(storageKey("mark-style"), markStyle); }, [markStyle, hasLoadedLocalState]);

  // v1.2 Cmd/Ctrl+Z 撤销最近一次勾画（不论是否在标记模式都生效，只要有 stack）
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z" || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (t) {
        const tag = t.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (t.isContentEditable) return;
      }
      const last = markUndoStackRef.current.pop();
      if (!last || !last.length) return;
      e.preventDefault();
      setHighlights((cur) => cur.filter((h) => !last.includes(h.id)));
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // v1.2 键盘翻页（设置开启时）：←/→ 翻页。在 input/textarea/contenteditable 聚焦时不触发。
  useEffect(() => {
    if (!keyboardPagingEnabled) return;
    function onKeyDown(e: KeyboardEvent) {
      // 排除 input 焦点（避免打字时误触）
      const t = e.target as HTMLElement | null;
      if (t) {
        const tag = t.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (t.isContentEditable) return;
      }
      // 排除任何打开的 modal（确保不干扰其他键盘操作）
      if (document.querySelector(".modal-backdrop")) return;
      // 区分 DB-reader vs EPUB
      const isDbReaderActive = readableBooks.find((b) => b.slug === currentBookSlug)?.hasEpub === false;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (isDbReaderActive) flipDbPage(-1);
        else goPrevPage();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (isDbReaderActive) flipDbPage(1);
        else goNextPage();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyboardPagingEnabled, currentBookSlug, readableBooks]);

  useEffect(() => {
    if (!hasLoadedLocalState) return;
    void writePersistedState(storageKey("ui-script-variant"), uiScriptVariant);

    if (uiScriptVariant !== "traditional") {
      // Reverting to simplified: easiest is just a soft reload — undoing
      // every prior conversion in-place is fragile. The toggle is rare, so
      // a reload is acceptable.
      // Skip reload on first apply (when state matches initial render).
      // Caller toggling will reload manually via the existing 「保存设置并刷新」 button.
      return;
    }

    const root = document.querySelector(".app-shell");
    if (!root) return;

    const SKIP_TAGS = new Set(["INPUT", "TEXTAREA", "IFRAME", "SCRIPT", "STYLE"]);
    const SKIP_SELECTOR = ".db-reader-host, .reader-host, [data-no-convert]";
    const isSkipped = (el: Element | null): boolean => {
      let cur = el;
      while (cur) {
        if (SKIP_TAGS.has(cur.tagName)) return true;
        if (cur.matches?.(SKIP_SELECTOR)) return true;
        cur = cur.parentElement;
      }
      return false;
    };

    // Mark a converted text node so we don't keep re-converting in a feedback
    // loop with the MutationObserver.
    const CONVERTED = new WeakSet<Text>();

    const convert = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const tn = node as Text;
        if (CONVERTED.has(tn)) return;
        const parent = tn.parentElement;
        if (parent && isSkipped(parent)) return;
        const original = tn.nodeValue || "";
        if (!original.trim()) return;
        const converted = toTraditional(original);
        if (converted !== original) tn.nodeValue = converted;
        CONVERTED.add(tn);
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as Element;
        if (isSkipped(el)) return;
        // Convert select <option> + button title attributes too — they show
        // user-facing text but aren't text nodes.
        if (el instanceof HTMLOptionElement) {
          const t = el.text;
          const c = toTraditional(t);
          if (c !== t) el.text = c;
        }
        const title = el.getAttribute("title");
        if (title) {
          const c = toTraditional(title);
          if (c !== title) el.setAttribute("title", c);
        }
        const placeholder = el.getAttribute("placeholder");
        if (placeholder) {
          const c = toTraditional(placeholder);
          if (c !== placeholder) el.setAttribute("placeholder", c);
        }
        for (const child of Array.from(el.childNodes)) convert(child);
      }
    };

    convert(root);

    const mo = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const n of m.addedNodes) convert(n);
        if (m.type === "characterData" && m.target.nodeType === Node.TEXT_NODE) {
          const tn = m.target as Text;
          // Re-converting requires forgetting our prior conversion.
          CONVERTED.delete(tn);
          convert(tn);
        }
      }
    });
    mo.observe(root, { childList: true, subtree: true, characterData: true });
    return () => mo.disconnect();
  }, [uiScriptVariant, hasLoadedLocalState]);

  useEffect(() => {
    readerLayoutRef.current = readerLayout;
    if (!hasLoadedLocalState) return;
    void writePersistedState(storageKey("reader-layout"), readerLayout);
  }, [readerLayout, hasLoadedLocalState]);

  useEffect(() => {
    scriptVariantRef.current = scriptVariant;
    if (!hasLoadedLocalState) return;
    void writePersistedState(storageKey("script-variant"), scriptVariant);
  }, [scriptVariant, hasLoadedLocalState]);

  useEffect(() => {
    pageSpreadRef.current = pageSpread;
    if (!hasLoadedLocalState) return;
    void writePersistedState(storageKey("page-spread"), pageSpread);
  }, [pageSpread, hasLoadedLocalState]);

  function scrollPendingAnchorIntoView(doc?: Document | null) {
    const anchor = pendingAnchorRef.current;
    if (!anchor) return;

    const targetDoc =
      doc ||
      ((readerHostRef.current?.querySelector("iframe") as HTMLIFrameElement | null)?.contentDocument ?? null);
    if (!targetDoc) return;

    const element =
      targetDoc.getElementById(anchor) ||
      targetDoc.querySelector(`[name="${anchor}"]`) ||
      targetDoc.querySelector(`#${CSS.escape(anchor)}`);

    if (!element) return;
    // In paginated flow (the default mode used by EPUB books here), epub.js
    // already positions the rendered page so the requested anchor is on the
    // visible column — no manual scroll needed. Worse, calling
    // scrollIntoView inside an iframe asks the browser to align the element
    // to the iframe AND the parent viewport, which yanks the reader chrome
    // (book header, sidebar headline) off-screen on every TOC click. So we
    // skip the scroll entirely when the rendition is paginated; only the
    // legacy "scrolled" flow falls back to scrollIntoView.
    const flow = (renditionRef.current as unknown as { settings?: { flow?: string } } | null)?.settings?.flow;
    if (flow && flow !== "paginated") {
      element.scrollIntoView({ block: "start" });
    }
    pendingAnchorRef.current = "";
  }

  function convertDocumentToTraditional(doc: Document) {
    const root = doc.body;
    if (!root || scriptVariantRef.current !== "traditional") return;

    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      const parent = node.parentElement;
      if (!node.nodeValue || !parent || parent.closest("script, style, textarea, code, pre")) continue;
      nodes.push(node);
    }

    for (const node of nodes) {
      node.nodeValue = toTraditional(node.nodeValue || "");
    }
  }

  function applyReaderDocumentPreferences(doc: Document) {
    injectReaderDocumentStyles(doc, { layoutMode: readerLayoutRef.current });
    convertDocumentToTraditional(doc);
    if (autoAnnotateRef.current) {
      annotateYearMentions(doc, {
        layoutMode: readerLayoutRef.current,
        dateDisplay: dateDisplayRef.current,
        showEmperor: showEmperorRef.current,
      });
    }
  }

  function getSpineSection(target: string) {
    if (!bookRef.current?.spine) return null;
    const normalized = normalizeDisplayTarget(target).split("#")[0];
    const candidates = uniqueValues([
      normalized,
      normalized.replace(/^OEBPS\//, ""),
      `OEBPS/${normalized.replace(/^OEBPS\//, "")}`,
    ]);

    for (const candidate of candidates) {
      const section = bookRef.current.spine.get(candidate);
      if (section) return section;
    }

    return null;
  }

  function getRenditionSpread() {
    return pageSpreadRef.current === "double" ? "always" : "none";
  }





  function deriveChapterState(
    nextCfi: string,
    nextHref: string,
    fallbackLabel: string,
    fallbackWholeProgress: number,
    forcedTarget = "",
  ) {
    const book = bookRef.current;
    const locations = book?.locations;
    const navigation = chapterNavigationRef.current;

    // Try to get whole-book progress from CFI
    let wholeProgress = fallbackWholeProgress;
    let wholeLocation = 0;
    if (nextCfi && locations) {
      const pct = locations.percentageFromCfi?.(nextCfi);
      if (pct != null && pct > 0) wholeProgress = clamp(pct * 100, 0, 100);
      const loc = locations.locationFromCfi?.(nextCfi);
      if (loc != null && loc > 0) wholeLocation = loc;
    }

    if (!navigation.length) {
      return {
        label: fallbackLabel || findTocLabel(meta?.tocTree || [], nextHref) || meta?.metadata.title || "",
        wholeProgress,
        chapterProgress: wholeProgress,
        pageCurrent: 1,
        pageTotal: 1,
        chapterIndex: 0,
      };
    }

    // --- Find chapter index ---
    // Primary: match by href (most reliable after EPUB splitting — each chapter = one file)
    let chapterIndex = -1;
    if (nextHref) {
      const normalizedHref = normalizeDisplayTarget(nextHref).split("#")[0];
      chapterIndex = navigation.findIndex((item) => {
        const navHref = normalizeDisplayTarget(item.href).split("#")[0];
        return navHref === normalizedHref || navHref === nextHref.split("#")[0];
      });
    }

    // Secondary: match by forcedTarget
    if (chapterIndex < 0 && forcedTarget) {
      const normalizedTarget = normalizeDisplayTarget(forcedTarget).split("#")[0];
      chapterIndex = navigation.findIndex((item) =>
        item.href === forcedTarget ||
        normalizeDisplayTarget(item.href).split("#")[0] === normalizedTarget ||
        item.cfi === forcedTarget
      );
    }

    // Tertiary: match by percentage
    if (chapterIndex < 0 && wholeProgress > 0) {
      const pv = wholeProgress / 100;
      chapterIndex = 0;
      for (let i = 0; i < navigation.length; i++) {
        if (navigation[i].percentage <= pv + 0.000001) chapterIndex = i;
        else break;
      }
    }

    if (chapterIndex < 0) chapterIndex = 0;

    // --- Compute page info ---
    const currentChapter = navigation[chapterIndex];
    const nextChapter = navigation[chapterIndex + 1];
    const totalLocations = Math.max(1, locations?.total ?? 1);
    const startLocation = currentChapter?.locationIndex ?? 0;
    const endLocationExclusive = nextChapter?.locationIndex ?? totalLocations;
    const pageTotal = Math.max(1, endLocationExclusive - startLocation);
    const pageCurrent = wholeLocation > 0 ? clamp(wholeLocation - startLocation + 1, 1, pageTotal) : 1;
    const chapterProgressValue = pageTotal <= 1 ? 0 : ((pageCurrent - 1) / Math.max(pageTotal - 1, 1)) * 100;

    // Fix wholeProgress if it was 0 but we know the chapter
    if (wholeProgress <= 0 && currentChapter) {
      wholeProgress = clamp(currentChapter.percentage * 100, 0, 100);
    }

    return {
      label: currentChapter?.label || fallbackLabel || meta?.metadata.title || "",
      wholeProgress,
      chapterProgress: clamp(chapterProgressValue, 0, 100),
      pageCurrent,
      pageTotal,
      chapterIndex,
    };
  }

  async function buildChapterNavigationMap() {
    if (!bookRef.current || !meta || bookRef.current.locations?.total == null) return;

    const tocItems =
      (meta.inPageToc?.length ?? 0) > 0
        ? meta.inPageToc!
        : flattenTocItems(meta.tocTree).filter((_, index) => index > 0);
    const totalLocations = Math.max(1, bookRef.current.locations.total ?? 1);
    const nextItems: ChapterNavigationItem[] = [];

    // After EPUB splitting, each chapter = one spine section.
    // Strategy 1: Parse locations._locations to find first location per spine section.
    // Strategy 2: Fallback to even distribution if _locations is unavailable.
    const locationsObj = bookRef.current.locations as any;
    const locationsArray: string[] = locationsObj?._locations || [];

    // Build map: spine CFI position (/6/N) -> first location index
    const spineStartMap = new Map<number, number>();
    for (let locIdx = 0; locIdx < locationsArray.length; locIdx++) {
      const cfiStr = locationsArray[locIdx];
      const m = typeof cfiStr === "string" ? cfiStr.match(/\/6\/(\d+)/) : null;
      if (!m) continue;
      const spinePos = parseInt(m[1], 10);
      if (!spineStartMap.has(spinePos)) {
        spineStartMap.set(spinePos, locIdx);
      }
    }

    const usedLocations = spineStartMap.size > 0;
    console.info(`buildChapterNavigationMap: ${tocItems.length} TOC items, ${totalLocations} locations, ${spineStartMap.size} spine positions found in _locations (${locationsArray.length} total entries)`);

    for (let i = 0; i < tocItems.length; i++) {
      const item = tocItems[i];
      const normalizedHref = normalizeDisplayTarget(item.href);
      const sectionHref = normalizedHref.split("#")[0];
      const anchor = extractAnchor(normalizedHref);
      const section = getSpineSection(item.href);

      let locationIndex = 0;
      let percentage = 0;
      let cfi = "";

      if (usedLocations && section) {
        const spineIndex = section.index ?? -1;
        const spinePos = (spineIndex + 1) * 2;
        const startLoc = spineStartMap.get(spinePos);
        if (startLoc != null) {
          locationIndex = startLoc;
          percentage = totalLocations > 1 ? locationIndex / (totalLocations - 1) : 0;
        }
        if (section.cfiBase) cfi = `epubcfi(${section.cfiBase})`;
      }

      // Fallback: even distribution
      if (locationIndex === 0 && i > 0) {
        locationIndex = Math.round((i / tocItems.length) * totalLocations);
        percentage = totalLocations > 1 ? locationIndex / (totalLocations - 1) : 0;
      }

      nextItems.push({ index: i, label: item.label, href: item.href, sectionHref, anchor, cfi, locationIndex, percentage });
    }

    // Ensure monotonically increasing
    for (let i = 1; i < nextItems.length; i++) {
      if (nextItems[i].locationIndex <= nextItems[i - 1].locationIndex) {
        nextItems[i].locationIndex = nextItems[i - 1].locationIndex + 1;
      }
    }
    for (const item of nextItems) {
      item.percentage = totalLocations > 1 ? item.locationIndex / (totalLocations - 1) : 0;
    }

    chapterNavigationRef.current = nextItems;
    setChapterNavigation(nextItems);

    // Debug — always log first and last for verification
    if (nextItems.length > 0) {
      const f = nextItems[0];
      const l = nextItems[nextItems.length - 1];
      console.info(`  chapterNav[0]: ${f.label} loc=${f.locationIndex} pct=${(f.percentage*100).toFixed(1)}%`);
      console.info(`  chapterNav[${nextItems.length-1}]: ${l.label} loc=${l.locationIndex} pct=${(l.percentage*100).toFixed(1)}%`);
    }
    (window as any).__chapterNav = { items: nextItems, totalLocations, spineStartMapSize: spineStartMap.size, locationsArrayLen: locationsArray.length };
    (window as any).__jumpToPage = jumpToPage;

    if (currentCfiRef.current) {
      const liveLocation = renditionRef.current?.currentLocation?.();
      const liveProgress =
        liveLocation?.start?.percentage != null && liveLocation?.end?.percentage != null
          ? ((liveLocation.start.percentage + liveLocation.end.percentage) / 2) * 100
          : progress;
      const derived = deriveChapterState(currentCfiRef.current, currentHref, currentSectionLabel, liveProgress);
      setCurrentSectionLabel(derived.label);
      setProgress(derived.wholeProgress);
      setChapterPageCurrent(derived.pageCurrent);
      setChapterPageTotal(derived.pageTotal);
      setCurrentChapterIndex(derived.chapterIndex);
    }
  }

  // Selection handler for the DB-reader (non-EPUB books) — mirrors the
  // selection event the epub.js reader emits, so AI / compare / lookup can
  // all reuse the same `selectionText` state.
  function handleDbReaderSelection(event: ReactMouseEvent<HTMLDivElement>) {
    const sel = window.getSelection();
    const text = sel?.toString().trim() || "";
    if (!text) {
      setSelectionOverlay((prev) => ({ ...prev, visible: false }));
      return;
    }
    // New selection ⇒ tear down any AI 句读 inline overlay from the previous run.
    clearDudouOverlay();
    // 累积模式：把当前 selectionText/selectionCfi 推入 pinnedSegments，
    // 然后下面把新选段写入 selectionText/selectionCfi。这样最新一段始终
    // 是 selectionText（其它逻辑无须改），effectiveSelectionText 拼总文本。
    if (accumulateMode && selectionText && selectionCfi) {
      setPinnedSegments((prev) => [...prev, { cfi: selectionCfi, text: selectionText }]);
    }
    const range = sel?.rangeCount ? sel.getRangeAt(0) : null;
    const rect = range?.getBoundingClientRect();
    const popupHeight = 60;
    const belowY = rect ? rect.bottom + window.scrollY + 12 : event.clientY + 12;
    const aboveY = rect ? rect.top + window.scrollY - popupHeight - 12 : belowY;
    const top = (belowY + popupHeight < window.innerHeight + window.scrollY) ? belowY : Math.max(8, aboveY);
    const left = rect ? rect.left + window.scrollX + (rect.width / 2) : event.clientX;
    setSelectionText(text);
    // Build a paragraph-anchored cfi when possible.
    //   single-paragraph: db:<slug>:<idx>:<pid>:<cstart>-<cend>            (5 parts)
    //   cross-paragraph:  db:<slug>:<idx>:m:<pidS>:<cS>:<pidE>:<cE>         (8 parts, marker "m")
    // so we can re-render highlights on the right span(s) on chapter load.
    let cfi = `db:${currentBookSlug}:${dbReaderIndex}`;
    if (range) {
      const findPara = (node: Node | null): HTMLElement | null => {
        let n: Node | null = node;
        while (n && n.nodeType !== 1) n = n.parentNode;
        let el = n as HTMLElement | null;
        while (el && !el.dataset?.paragraphId) el = el.parentElement;
        return el;
      };
      const offsetIn = (host: HTMLElement, target: Node, off: number) => {
        const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
        let pos = 0;
        while (walker.nextNode()) {
          const tn = walker.currentNode;
          if (tn === target) return pos + off;
          pos += (tn.nodeValue || "").length;
        }
        return pos;
      };
      const startPara = findPara(range.startContainer);
      const endPara = findPara(range.endContainer);
      if (startPara && endPara) {
        const pidS = startPara.dataset.paragraphId || "";
        const pidE = endPara.dataset.paragraphId || "";
        const cS = offsetIn(startPara, range.startContainer, range.startOffset);
        const cE = offsetIn(endPara, range.endContainer, range.endOffset);
        if (startPara === endPara) {
          if (pidS && cS >= 0 && cE > cS) {
            cfi = `db:${currentBookSlug}:${dbReaderIndex}:${pidS}:${cS}-${cE}`;
          }
        } else if (pidS && pidE) {
          cfi = `db:${currentBookSlug}:${dbReaderIndex}:m:${pidS}:${cS}:${pidE}:${cE}`;
        }
      }
    }
    setSelectionCfi(cfi);
    // v1.2 标记模式：直接打标，不弹工具栏
    if (markModeRef.current) {
      applyMarkModeHighlight(cfi, text);
      try { window.getSelection?.()?.removeAllRanges(); } catch { /* ignore */ }
      return;
    }
    setSelectionOverlay({ visible: true, top, left });
  }

  // Switch to a different book; tears down current rendition and refetches data.
  async function switchBook(slug: string) {
    if (slug === currentBookSlug) {
      setBookMenuOpen(false);
      return;
    }
    const target = readableBooks.find((b) => b.slug === slug);
    if (!target) return;
    setBookMenuOpen(false);
    setBookSwitching(true);
    try {
      // Reset reader-related transient state. Setting meta to null first forces
      // the EPUB reader effect to tear down BEFORE the new slug arrives — avoids
      // a window where ePub() is constructed with the new slug URL but the old
      // meta's chapter href, which would render a blank page.
      setReaderReady(false);
      setLocationsReady(false);
      setCurrentCfi("");
      setCurrentHref("");
      setCurrentSectionLabel("");
      setProgress(0);
      setChapterPageCurrent(1);
      setChapterPageTotal(1);
      setCurrentChapterIndex(0);
      // Load the destination book's per-book saved location so we resume
      // where the user left off in THAT book instead of dropping them at
      // the in-page TOC every switch.
      const savedForTarget = await readPersistedState<string>(storageKey(`last-location:${slug}`), "");
      initialLocationRef.current = savedForTarget;
      setLastLocation(savedForTarget);
      pendingAnchorRef.current = "";
      currentCfiRef.current = "";
      setMeta(null);
      setDbReaderChapters(null);
      setDbReaderChapter(null);
      setDbReaderIndex(0);
      setCurrentBookSlug(slug);

      if (target.hasEpub) {
        const newMeta = await fetchBookMeta(slug);
        setMeta(newMeta);
      } else {
        const chaptersData = await fetchReaderChapters(slug);
        setDbReaderChapters(chaptersData);
        if (chaptersData.chapters.length > 0) {
          const firstChapter = await fetchReaderChapter(slug, 0);
          setDbReaderChapter(firstChapter);
        }
      }
    } catch (error) {
      setBootError(error instanceof Error ? error.message : "切换书籍失败。");
    } finally {
      setBookSwitching(false);
    }
  }

  // Load a chapter for DB-reader (non-EPUB books)
  async function loadDbReaderChapter(index: number) {
    if (!dbReaderChapters || index < 0 || index >= dbReaderChapters.chapters.length) return;
    setDbReaderLoading(true);
    try {
      const data = await fetchReaderChapter(currentBookSlug, index);
      setDbReaderChapter(data);
      setDbReaderIndex(index);
      setDbPageIndex(0);
      // Force scroll back to start; effect below recomputes page totals
      requestAnimationFrame(() => {
        if (dbReaderHostRef.current) dbReaderHostRef.current.scrollLeft = 0;
        dbTargetPageRef.current = 0;
        dbAnchorParaRef.current = null;
      });
    } catch (error) {
      setBootError(error instanceof Error ? error.message : "加载章节失败。");
    } finally {
      setDbReaderLoading(false);
    }
  }

  // Maintains a "logical target page" so rapid clicks accumulate cleanly
  // (each click bumps the target and we scroll to that absolute position),
  // instead of stacking smooth scrollBy calls that drift mid-animation and
  // leave the reader half-page off.
  //
  // For layout-change reflow we use a stronger anchor: the paragraph element
  // that's currently at (or just past) the left edge of the visible area.
  // After clientWidth changes we look that element up and snap scrollLeft so
  // its column starts at the viewport's left edge. This is fully reversible:
  // expand → collapse returns to the *exact* original page, not a proportional
  // approximation that drifts due to rounding.
  const dbTargetPageRef = useRef<number | null>(null);
  const dbAnchorParaRef = useRef<string | null>(null);

  function captureDbAnchor() {
    const host = dbReaderHostRef.current;
    if (!host) return;
    // Find the first paragraph whose left edge is at or past the current
    // scrollLeft — that's the leftmost visible paragraph, our anchor.
    const left = host.scrollLeft;
    const paras = host.querySelectorAll<HTMLElement>("[data-paragraph-id]");
    let anchor: HTMLElement | null = null;
    for (const p of Array.from(paras)) {
      if (p.offsetLeft >= left - 2) { anchor = p; break; }
    }
    if (!anchor && paras.length) anchor = paras[paras.length - 1];
    dbAnchorParaRef.current = anchor?.dataset.paragraphId ?? null;
  }

  function flipDbPage(direction: -1 | 1) {
    const host = dbReaderHostRef.current;
    if (!host) return;
    const cw = host.clientWidth;
    if (!cw) return;
    const currentTarget = dbTargetPageRef.current ?? Math.round(host.scrollLeft / cw);
    const next = Math.max(0, Math.min(dbPageTotal - 1, currentTarget + direction));
    dbTargetPageRef.current = next;
    host.scrollTo({ left: next * cw, behavior: "smooth" });
    // Capture anchor after the smooth scroll finishes (not before — pre-flip
    // captures the OLD page's anchor and we'd never advance after layout).
    setTimeout(captureDbAnchor, 280);
  }

  function jumpDbPage(target: number) {
    const host = dbReaderHostRef.current;
    if (!host) return;
    const clamped = Math.max(0, Math.min(dbPageTotal - 1, target));
    dbTargetPageRef.current = clamped;
    host.scrollTo({ left: clamped * host.clientWidth, behavior: "smooth" });
    setTimeout(captureDbAnchor, 280);
  }

  // Recompute total pages whenever the chapter content or theme/font changes.
  useEffect(() => {
    const isDbReaderActive = readableBooks.find((b) => b.slug === currentBookSlug)?.hasEpub === false;
    if (!isDbReaderActive) return;
    const host = dbReaderHostRef.current;
    if (!host) return;
    const recompute = () => {
      const cw = host.clientWidth;
      const article = host.querySelector<HTMLElement>(".db-reader-article");
      if (article) {
        article.style.columnWidth = cw + "px";
      }
      const total = Math.max(1, Math.ceil(host.scrollWidth / Math.max(1, cw)));
      setDbPageTotal(total);
      // Anchor-based reflow: find the paragraph element we recorded as the
      // leftmost visible before the layout change, look up its NEW column
      // offset, and align the viewport to that column. This is exactly
      // reversible — expand → collapse returns to the same paragraph,
      // hence the same page, with no rounding drift.
      let targetPage = dbTargetPageRef.current ?? Math.round(host.scrollLeft / Math.max(1, cw));
      const anchorId = dbAnchorParaRef.current;
      if (anchorId) {
        const anchorEl = host.querySelector<HTMLElement>(`[data-paragraph-id="${anchorId}"]`);
        if (anchorEl) {
          // The paragraph's offsetLeft tells us where the browser laid it
          // out in the multi-column flow. Floor-divide by clientWidth to
          // get the column (= page) it sits in.
          targetPage = Math.floor(anchorEl.offsetLeft / Math.max(1, cw));
        }
      }
      const clamped = Math.max(0, Math.min(total - 1, targetPage));
      const desired = clamped * cw;
      if (Math.abs(host.scrollLeft - desired) > 1) {
        host.scrollLeft = desired;
      }
      dbTargetPageRef.current = clamped;
      setDbPageIndex(clamped);
    };
    // Wait one frame so CSS columns have finished laying out
    const id = requestAnimationFrame(recompute);
    const onResize = () => recompute();
    window.addEventListener("resize", onResize);
    // Watch the host itself — sidebar / assistant collapse triggers a
    // grid-template-columns transition (150ms). The deps-driven recompute
    // fires when state changes but the host's clientWidth is still mid-
    // transition; ResizeObserver fires throughout, so the final snap to a
    // valid page boundary actually lands on the new viewport size.
    const ro = new ResizeObserver(() => recompute());
    ro.observe(host);
    // Stabilizer: after smooth-scroll bursts settle (220 ms of no scroll
    // events), snap scrollLeft to the nearest column boundary. Catches any
    // sub-pixel drift from rapid flipDbPage() calls and forces a clean
    // integer-page resting state.
    let settleTimer: number | null = null;
    const onScroll = () => {
      const cw = host.clientWidth;
      setDbPageIndex(Math.round(host.scrollLeft / Math.max(1, cw)));
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        const nearest = Math.round(host.scrollLeft / Math.max(1, cw)) * cw;
        if (Math.abs(host.scrollLeft - nearest) > 1) {
          host.scrollTo({ left: nearest, behavior: "smooth" });
        }
        // Sync target page index + paragraph anchor so subsequent flips and
        // layout-change recomputes start from a clean state.
        dbTargetPageRef.current = Math.round(nearest / Math.max(1, cw));
        captureDbAnchor();
      }, 220);
    };
    host.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener("resize", onResize);
      host.removeEventListener("scroll", onScroll);
      ro.disconnect();
      if (settleTimer !== null) window.clearTimeout(settleTimer);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbReaderChapter, readerTheme, readerFontFamily, readerFontSize, sidebarCollapsed, assistantCollapsed, currentBookSlug, readableBooks]);

  // Consume pendingSearchNavRef after the chapter has rendered. Tries
  // immediately, then once more after a short delay to cover the multi-
  // column layout settle time for DB-reader and the iframe ready event
  // for EPUB rendition.
  useEffect(() => {
    if (!pendingSearchNavRef.current) return;
    if (scrollToSearchTarget()) return;
    const t1 = window.setTimeout(() => { if (!scrollToSearchTarget()) {
      const t2 = window.setTimeout(() => { scrollToSearchTarget(); }, 400);
      (window as unknown as { __searchScrollT2?: number }).__searchScrollT2 = t2;
    }}, 120);
    return () => { window.clearTimeout(t1); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbReaderChapter, dbReaderIndex, readerReady, currentBookSlug]);

  async function openLocation(target: string) {
    if (!renditionRef.current) return;

    // Look up chapter info from navigation map (for label & forced index)
    const navigation = chapterNavigationRef.current;
    const normalizedTarget = normalizeDisplayTarget(target);
    const matched = navigation.length > 0
      ? navigation.find((item) => item.href === target || normalizeDisplayTarget(item.href) === normalizedTarget)
      : null;

    pendingLocationLabelRef.current = matched?.label || (meta ? findTocLabel(meta.tocTree, target) : "");
    pendingLocationTargetRef.current = target;
    forcedChapterTargetRef.current = target;
    pendingAnchorRef.current = extractAnchor(target);

    // CFI target (from progress bar, bookmarks, saved location)
    if (target.startsWith("epubcfi(")) {
      try {
        await renditionRef.current.display(target);
        return;
      } catch { /* fall through to href attempts */ }
    }

    // href target — try several path variants because epub.js stores spine
    // entries under href keys that depend on the EPUB's internal layout
    // (OEBPS/, EPUB/, OPS/, or flat). We try the absolute path first, then
    // strip the leading directory so e.g. "EPUB/xhtml/foo.xhtml" also tries
    // "xhtml/foo.xhtml" (which is what epub.js may have keyed it as).
    const stripFirstDir = normalizedTarget.replace(/^[^/]+\//, "");
    const candidates = uniqueValues([
      target,
      normalizedTarget,
      stripFirstDir,
      `OEBPS/${stripFirstDir}`,
    ]);
    for (const candidate of candidates) {
      try {
        await renditionRef.current.display(candidate);
        window.setTimeout(() => scrollPendingAnchorIntoView(), 60);
        return;
      } catch {
        // Try next candidate
      }
    }
    // Final fallback: just display the first spine item (no target).
    try {
      await renditionRef.current.display();
    } catch {
      // give up
    }
  }

  function goNextPage() {
    renditionRef.current?.next?.();
  }

  function goPrevPage() {
    renditionRef.current?.prev?.();
  }

  function jumpToPage(targetPage: number) {
    if (!renditionRef.current || jumpingRef.current) return;
    const rendition = renditionRef.current;
    const book = bookRef.current;

    const loc = rendition.currentLocation?.() as EpubLocationLike | null;
    const liveTotal = loc?.start?.displayed?.total || 1;
    const livePage = loc?.start?.displayed?.page || 1;
    if (liveTotal <= 1) return;

    const safePage = clamp(targetPage, 1, liveTotal);
    if (safePage === livePage) return;

    // Direct CFI jump: convert (current chapter start CFI + page offset)
    // into a CFI via book.locations.cfiFromLocation(), then display it.
    // Falls back to step-by-step next/prev if locations API isn't ready.
    const navigation = chapterNavigationRef.current;
    const currentChapter = navigation[currentChapterIndex];
    const startLoc = currentChapter?.locationIndex;
    const cfiFromLocation = book?.locations?.cfiFromLocation;
    if (
      book &&
      typeof cfiFromLocation === "function" &&
      typeof startLoc === "number" &&
      Number.isFinite(startLoc)
    ) {
      try {
        const targetLocation = startLoc + (safePage - 1);
        const targetCfi = cfiFromLocation.call(book.locations, targetLocation);
        if (targetCfi && typeof targetCfi === "string") {
          jumpingRef.current = true;
          rendition.display(targetCfi)
            .catch(() => { /* swallow; relocated event won't fire on failure */ })
            .finally(() => { jumpingRef.current = false; });
          return;
        }
      } catch { /* fall through to stepping */ }
    }

    // Fallback: legacy step-by-step (slow, still here in case CFI jump
    // fails for an unusual book whose locations index hasn't loaded).
    const stepsNeeded = safePage - livePage;
    jumpingRef.current = true;
    const step = stepsNeeded > 0 ? () => rendition.next?.() : () => rendition.prev?.();
    let remaining = Math.abs(stepsNeeded);
    const doStep = () => {
      if (remaining <= 0) { jumpingRef.current = false; return; }
      remaining--;
      step();
      if (remaining > 0) window.setTimeout(doStep, 60);
      else jumpingRef.current = false;
    };
    doStep();
  }


  useEffect(() => {
    if (!meta || !hasLoadedLocalState || !readerHostRef.current || bookRef.current) return;

    const host = readerHostRef.current;
    host.innerHTML = "";

    // epubjs needs concrete pixel dimensions for paginated flow to work.
    // "100%" makes it unable to calculate page breaks → total=1 for every section.
    const hostRect = host.getBoundingClientRect();
    const hostWidth = Math.round(hostRect.width) || 800;
    const hostHeight = Math.round(hostRect.height) || 600;

    const book = ePub(libraryEpubUrl(currentBookSlug)) as EpubBookLike;
    const rendition = book.renderTo(host, {
      width: hostWidth,
      height: hostHeight,
      flow: "paginated",
      spread: getRenditionSpread(),
      manager: "default",
    });

    if (import.meta.env.DEV) {
      console.info("epub:init");
      book.opened?.then(() => console.info("epub:opened")).catch((error: unknown) => console.error("epub:opened:error", error));
      book.ready?.then(() => console.info("epub:ready")).catch((error: unknown) => console.error("epub:ready:error", error));
    }

    bookRef.current = book;
    renditionRef.current = rendition;
    rendition.themes.default({
      body: {
        color: "#1f160f",
        "font-family": '"Source Han Serif SC", "Noto Serif SC", "Songti SC", serif',
        "line-height": "1.92",
        "letter-spacing": "0.01em",
        "max-width": "none",
        "margin": "0 auto",
      },
      p: {
        "text-indent": "2em",
      },
      "div, section, article": {
        "max-width": "none",
      },
    });

    // Inject bundled @font-face + width/font !important overrides into each
    // rendered section. Without this, EPUB's own stylesheets win over
    // rendition.themes.default and the user's font/theme picks have no effect.
    // EPUB iframe 不会自动继承父文档 <link> 的 fonts.css —— 必须把同样的
    // @font-face 注入到每个 section 里，rendition.themes.font() 才能找到字体。
    // URL 与 frontend/public/fonts/fonts.css 一致。
    const O = window.location.origin;
    const FONT_FACE_CSS = `
      @font-face { font-family: "Huiwen Mingchao";    src: url("${O}/fonts/${encodeURIComponent("明體（汇文明朝）.ttf")}") format("truetype"); font-display: swap; }
      @font-face { font-family: "Huiwen Fangsong";    src: url("${O}/fonts/${encodeURIComponent("仿宋（匯文仿宋）.ttf")}") format("truetype"); font-display: swap; }
      @font-face { font-family: "Jinghua Laosong";    src: url("${O}/fonts/${encodeURIComponent("宋體（京華老宋）.ttf")}") format("truetype"); font-display: swap; }
      @font-face { font-family: "Fangzheng Yongle";   src: url("${O}/fonts/${encodeURIComponent("楷體（方正永樂大典）.TTF")}") format("truetype"); font-display: swap; }
      @font-face { font-family: "Huiwen Zhengkai";    src: url("${O}/fonts/${encodeURIComponent("正楷（汇文正楷）.ttf")}") format("truetype"); font-display: swap; }
      @font-face { font-family: "LXGW WenKai";        src: url("${O}/fonts/${encodeURIComponent("霞鹜（霞鹜文楷）.ttf")}") format("truetype"); font-display: swap; }
      @font-face { font-family: "Fangzheng Liqi";     src: url("${O}/fonts/${encodeURIComponent("漢隸（方正禮器碑）.TTF")}") format("truetype"); font-display: swap; }
      @font-face { font-family: "Fangzheng Shoujin";  src: url("${O}/fonts/${encodeURIComponent("瘦金（方正瘦金）.TTF")}") format("truetype"); font-display: swap; }
    `;
    const LAYOUT_OVERRIDE_CSS = `
      /* Only neutralize EPUB's own width caps — never set explicit width or
         padding on html/body, since that interferes with epub.js paginated
         flow's column-width calculation and makes content overflow. */
      html, body {
        max-width: none !important;
        margin: 0 !important;
        box-sizing: border-box !important;
      }
      body *:not(code):not(pre) {
        font-family: inherit !important;
      }
      /* Some EPUBs (e.g. 三朝辽事实录) cap paragraphs to 40em which prevents
         text from filling the reader on wider viewports. Strip max-width and
         auto margins on common text-flow elements. */
      body p, body div, body section, body article, body blockquote,
      .calibre, .calibre1, .calibre_4, .calibre_5, .calibre_6,
      .x-ebookmaker-cover {
        max-width: none !important;
        margin-left: 0 !important;
        margin-right: 0 !important;
      }
      img, table, figure {
        max-width: 100% !important;
        height: auto !important;
      }
      /* AI 句读 inline overlay — 与正文页 .dudou-overlay-* 同步。
         读号 → 实心红圆，句号 → 空心红圆。CSS 圆形避免不同 CJK 字体下
         · / ● 字面尺寸不一致的问题。 */
      .dudou-overlay-char { position: relative; }
      .dudou-overlay-char.dudou-overlay-break::after {
        content: "";
        position: absolute;
        left: 50%;
        bottom: -0.32em;
        transform: translateX(-50%);
        width: 0.32em;
        height: 0.32em;
        border-radius: 50%;
        background: #d4231b;
        pointer-events: none;
      }
      .dudou-overlay-char.dudou-overlay-break.dudou-overlay-strong::after {
        background: transparent;
        border: 1.2px solid #d4231b;
        width: 0.36em;
        height: 0.36em;
      }
      /* 搜索结果一键跳转：目标段落短暂高亮 — 与外层 App.css 同步。 */
      @keyframes search-flash-fade {
        0%   { background-color: rgba(212, 35, 27, 0.32); box-shadow: 0 0 0 4px rgba(212, 35, 27, 0.18); }
        60%  { background-color: rgba(212, 35, 27, 0.18); box-shadow: 0 0 0 3px rgba(212, 35, 27, 0.10); }
        100% { background-color: transparent; box-shadow: none; }
      }
      .search-flash {
        animation: search-flash-fade 1.6s ease-out;
        border-radius: 0.2em;
      }
    `;
    type RenditionHooks = { hooks?: { content?: { register?: (cb: (contents: EpubContentsLike) => void) => void } } };
    const hooksHost = rendition as unknown as RenditionHooks;
    hooksHost.hooks?.content?.register?.((contents: EpubContentsLike) => {
      const doc = contents.document;
      if (!doc.querySelector("#mingshi-injected-fonts")) {
        const style = doc.createElement("style");
        style.id = "mingshi-injected-fonts";
        style.textContent = FONT_FACE_CSS;
        doc.head.appendChild(style);
      }
      // Layout overrides go LAST in <head> so they win the cascade.
      if (!doc.querySelector("#mingshi-injected-layout")) {
        const style = doc.createElement("style");
        style.id = "mingshi-injected-layout";
        style.textContent = LAYOUT_OVERRIDE_CSS;
        doc.head.appendChild(style);
      }
      // Theme/font/color overrides — re-applied by the theme useEffect when
      // the user changes settings; here we seed the initial value so a fresh
      // section doesn't flash with default theme before the effect catches up.
      if (!doc.querySelector("#mingshi-injected-theme")) {
        const style = doc.createElement("style");
        style.id = "mingshi-injected-theme";
        style.textContent = themeCssRef.current;
        doc.head.appendChild(style);
      }
    });

    rendition.on("selected", (cfiRange: string, contents: EpubContentsLike) => {
      // Safari sometimes delivers the event with a stale or empty selection.
      // Defer reading the selection until the next microtask so the browser
      // has finished updating it.
      Promise.resolve().then(() => {
        const selected = contents.window.getSelection();
        const text = selected?.toString().trim() || "";
        if (!text || !selected) return;
        // New selection ⇒ tear down any AI 句读 inline overlay from the
        // previous run so per-char marker spans don't pile up.
        clearDudouOverlay();
        // 累积模式：把当前 selectionText/selectionCfi 推入 pinnedSegments，
        // 然后下面把新选段写入 selectionText/selectionCfi（最新一段）。
        // 注意走 ref 而不是 state — 此 handler 闭包是 effect 注册时的 snapshot。
        if (accumulateModeRef.current && selectionTextRef.current && selectionCfiRef.current) {
          const prevText = selectionTextRef.current;
          const prevCfi = selectionCfiRef.current;
          setPinnedSegments((prev) => [...prev, { cfi: prevCfi, text: prevText }]);
        }

        const iframe = readerHostRef.current?.querySelector("iframe") as HTMLIFrameElement | null;
        const range = selected.rangeCount ? selected.getRangeAt(0) : null;
        const rect = range?.getBoundingClientRect();
        const frameRect = iframe?.getBoundingClientRect();

        const hasRect = rect && (rect.width > 0 || rect.height > 0);
        const popupHeight = 60; // approximate toolbar height
        const belowY = hasRect ? (frameRect?.top || 0) + rect!.bottom + 12 : (frameRect?.top || 0) + (frameRect?.height || 0) / 2;
        const aboveY = hasRect ? (frameRect?.top || 0) + rect!.top - popupHeight - 12 : belowY;
        // Show below if enough space, otherwise above
        const top = (belowY + popupHeight < window.innerHeight) ? belowY : Math.max(8, aboveY);
        const left = hasRect
          ? (frameRect?.left || 0) + rect!.left + (rect!.width / 2) + window.scrollX
          : (frameRect?.left || 0) + (frameRect?.width || 0) / 2 + window.scrollX;

        selectionContentsRef.current = contents;
        setSelectionText(text);
        setSelectionCfi(cfiRange);
        // v1.2 标记模式：直接打标，不弹工具栏
        if (markModeRef.current) {
          applyMarkModeHighlight(cfiRange, text);
          // 清掉浏览器选区，不进入选段流程
          try { selected.removeAllRanges(); } catch { /* ignore */ }
          return;
        }
        setSelectionOverlay({ visible: true, top, left });
      });
    });

    rendition.on("relocated", (location: EpubLocationLike) => {
      // Debug: dump raw location to see what epubjs reports
      (window as any).__lastLocation = location;
      const nextCfi = location?.start?.cfi || "";
      const nextHref = location?.start?.href || "";
      const nextProgress =
        nextCfi && bookRef.current?.locations?.percentageFromCfi
          ? (bookRef.current.locations.percentageFromCfi(nextCfi) || 0) * 100
          : (location?.start?.percentage || 0) * 100;
      const focusProgress =
        location?.start?.percentage != null && location?.end?.percentage != null
          ? ((location.start.percentage + location.end.percentage) / 2) * 100
          : nextProgress;
      const derived = deriveChapterState(
        nextCfi,
        nextHref,
        pendingLocationLabelRef.current || findTocLabel(meta.tocTree, nextHref) || meta.metadata.title,
        focusProgress,
        pendingLocationTargetRef.current || forcedChapterTargetRef.current
      );

      // epubjs directly reports page/total for the current section via displayed.
      // Use it when available — it's more accurate than our location-based calc.
      const epubjsPage = location?.start?.displayed?.page;
      const epubjsTotal = location?.start?.displayed?.total;
      const finalPageCurrent = (epubjsTotal && epubjsTotal > 1 && epubjsPage) ? epubjsPage : derived.pageCurrent;
      const finalPageTotal = (epubjsTotal && epubjsTotal > 1) ? epubjsTotal : derived.pageTotal;
      setCurrentCfi(nextCfi);
      setCurrentHref(nextHref);
      setCurrentSectionLabel(derived.label);
      setProgress(derived.wholeProgress);
      setChapterPageCurrent(finalPageCurrent);
      setChapterPageTotal(finalPageTotal);
      setCurrentChapterIndex(derived.chapterIndex);
      setLastLocation(nextCfi);
      pendingLocationLabelRef.current = "";
      pendingLocationTargetRef.current = "";
      setSelectionOverlay((prev) => ({ ...prev, visible: false }));
    });

    rendition.on("rendered", (section: unknown, contents: EpubContentsLike) => {
      const doc = contents.document as Document;
      applyReaderDocumentPreferences(doc);
      scrollPendingAnchorIntoView(doc);

      // Defensive re-sync: epub.js doesn't always fire `relocated` after a
      // display() call (in particular when navigating to a fresh anchor in
      // the SAME spine section it sometimes treats the move as a no-op).
      // The visible page changes but our React state — currentHref,
      // currentChapterIndex, chapterPageCurrent/Total — stays pointing at
      // the previous chapter, so the slider/label appear "stuck on the
      // last page of the old chapter" until the next refresh.
      //
      // Detect by comparing the just-rendered section's href against the
      // last href we recorded; if they diverge, fabricate a relocated-like
      // state update from rendition.currentLocation().
      const renderedHref =
        (section as { href?: string; url?: string } | undefined)?.href ||
        (section as { href?: string; url?: string } | undefined)?.url ||
        "";
      if (!renderedHref) return;
      const recordedHref = currentHrefRef.current;
      const sameSection =
        normalizeDisplayTarget(renderedHref).split("#")[0] ===
        normalizeDisplayTarget(recordedHref).split("#")[0];
      if (sameSection) return; // relocated will fire (or already did) — no rescue needed

      // Wait for epub.js to settle, then read the live location.
      window.setTimeout(() => {
        const live = renditionRef.current?.currentLocation?.() as EpubLocationLike | null;
        const liveCfi = live?.start?.cfi || "";
        const liveHref = live?.start?.href || renderedHref;
        if (!liveCfi) return;
        // If relocated already updated us in the meantime, bail.
        if (currentCfiRef.current === liveCfi) return;

        const livePct =
          bookRef.current?.locations?.percentageFromCfi
            ? (bookRef.current.locations.percentageFromCfi(liveCfi) || 0) * 100
            : (live?.start?.percentage || 0) * 100;
        const derived = deriveChapterState(
          liveCfi,
          liveHref,
          findTocLabel(meta.tocTree, liveHref) || meta.metadata.title,
          livePct,
          forcedChapterTargetRef.current
        );
        const epubjsPage = live?.start?.displayed?.page;
        const epubjsTotal = live?.start?.displayed?.total;
        const finalPage = (epubjsTotal && epubjsTotal > 1 && epubjsPage) ? epubjsPage : derived.pageCurrent;
        const finalTotal = (epubjsTotal && epubjsTotal > 1) ? epubjsTotal : derived.pageTotal;
        setCurrentCfi(liveCfi);
        setCurrentHref(liveHref);
        setCurrentSectionLabel(derived.label);
        setProgress(derived.wholeProgress);
        setChapterPageCurrent(finalPage);
        setChapterPageTotal(finalTotal);
        setCurrentChapterIndex(derived.chapterIndex);
      }, 50);
    });

    const init = async () => {
      try {
        const preferredStart = initialLocationRef.current || meta.inPageToc?.[0]?.href || meta.tocTree[1]?.href || meta.tocTree[0]?.href || "";
        const startTarget = normalizeDisplayTarget(preferredStart);
        pendingAnchorRef.current = extractAnchor(preferredStart);
        await new Promise((resolve) => window.requestAnimationFrame(() => resolve(null)));
        if (import.meta.env.DEV) {
          console.info("epub:display:start", startTarget || "default");
        }
        await openLocation(startTarget || "");
        if (import.meta.env.DEV) {
          console.info("epub:display:done");
        }
        setReaderReady(true);
        void book.ready
          .then(async () => {
            try {
              await book.locations.generate?.(CHAPTER_LOCATION_BREAK_SIZE);
              setLocationsReady(true);
              await buildChapterNavigationMap();
              if (currentCfiRef.current && book.locations.percentageFromCfi) {
                const liveProgress = (book.locations.percentageFromCfi(currentCfiRef.current) || 0) * 100;
                const derived = deriveChapterState(currentCfiRef.current, currentHref, currentSectionLabel, liveProgress);
                setProgress(derived.wholeProgress);
                setChapterPageCurrent(derived.pageCurrent);
                setChapterPageTotal(derived.pageTotal);
                setCurrentChapterIndex(derived.chapterIndex);
                setCurrentSectionLabel(derived.label);
              }
              if (pendingProgressRef.current != null) {
                pendingProgressRef.current = null;
              }
            } catch {
              // Ignore location generation failures and keep the reader usable.
            }
          })
          .catch(() => {
            // Ignore readiness failures and keep the core reading flow working.
          });
      } catch (error) {
        setBootError(error instanceof Error ? error.message : "阅读器初始化失败。");
      }
    };

    void init();

    // Resize handler: update epubjs dimensions so pagination recalculates.
    // ResizeObserver also picks up sidebar/assistant collapse/expand which
    // change reader width without firing window resize. Guard against feedback
    // loops by ignoring sub-pixel changes and debouncing through rAF.
    let lastW = 0;
    let lastH = 0;
    let resizePending = false;
    const onResize = () => {
      if (resizePending) return;
      resizePending = true;
      window.requestAnimationFrame(() => {
        resizePending = false;
        const rect = host.getBoundingClientRect();
        const w = Math.round(rect.width) || 800;
        const h = Math.round(rect.height) || 600;
        if (Math.abs(w - lastW) < 2 && Math.abs(h - lastH) < 2) return;
        lastW = w;
        lastH = h;
        // ResizeObserver fires as soon as observe() is called, which can race
        // ahead of the first display() call that wires up rendition.manager.
        // Calling rendition.resize() before manager exists throws inside
        // epub.js ("Cannot read properties of undefined (reading 'resize')")
        // and prevents the initial render from completing — the user sees a
        // blank reading area. Skip until the manager is up.
        if (!(rendition as unknown as { manager?: unknown }).manager) return;
        try {
          rendition.resize?.(w, h);
        } catch {
          // Swallow late resize errors during teardown.
        }
      });
    };
    window.addEventListener("resize", onResize);
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => onResize());
      resizeObserver.observe(host);
    }

    return () => {
      window.removeEventListener("resize", onResize);
      resizeObserver?.disconnect();
      if (chapterJumpTimerRef.current) {
        window.clearTimeout(chapterJumpTimerRef.current);
      }
      try {
        rendition.destroy();
      } catch {
        // ignore destroy errors
      }
      try {
        book.destroy?.();
      } catch {
        // ignore destroy errors
      }
      audioRef.current?.pause();
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
        audioUrlRef.current = "";
      }
      bookRef.current = null;
      renditionRef.current = null;
    };
  // EPUB 初始化随当前书籍 slug 与元数据变更：切书时销毁旧 rendition 并以新 EPUB URL 重新构建。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta, hasLoadedLocalState, currentBookSlug]);

  useEffect(() => {
    currentCfiRef.current = currentCfi;
  }, [currentCfi]);

  useEffect(() => {
    currentHrefRef.current = currentHref;
  }, [currentHref]);

  useEffect(() => {
    if (!locationsReady || !currentCfi) return;
    const liveLocation = renditionRef.current?.currentLocation?.();
    const liveProgress =
      liveLocation?.start?.percentage != null && liveLocation?.end?.percentage != null
        ? ((liveLocation.start.percentage + liveLocation.end.percentage) / 2) * 100
        : progress;
    const derived = deriveChapterState(currentCfi, currentHref, currentSectionLabel, liveProgress, forcedChapterTargetRef.current);
    setCurrentSectionLabel(derived.label);
    setProgress(derived.wholeProgress);
    setChapterPageCurrent(derived.pageCurrent);
    setChapterPageTotal(derived.pageTotal);
    setCurrentChapterIndex(derived.chapterIndex);
    forcedChapterTargetRef.current = "";
  // 这里基于当前 EPUB runtime 快照推导页面状态，不能把推导函数加入依赖导致重复定位。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationsReady, currentCfi, chapterNavigation.length]);

  useEffect(() => {
    if (!locationsReady || chapterNavigationRef.current.length || !meta) return;
    void buildChapterNavigationMap();
  // 章节导航图只需在 locations 准备好后补建一次。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationsReady, meta]);

  useEffect(() => {
    if (!readerReady || !renditionRef.current) return;

    const rendition = renditionRef.current;
    const epubType = (kind: ReaderHighlight["kind"]) =>
      kind === "underline" ? "underline" : kind === "circle" ? "underline" : "highlight";

    // DB-reader highlights have cfi like "db:<slug>:<idx>" — they can't be
    // applied to the EPUB rendition (epub.js would throw or silently break
    // its internal location state, which can crash the next page render).
    // Filter them out here.
    const epubHighlights = highlights.filter((h) => !h.cfiRange.startsWith("db:"));

    for (const item of epubHighlights) {
      rendition.annotations.remove(item.cfiRange, epubType(item.kind));
    }

    for (const item of epubHighlights) {
      const type = epubType(item.kind);
      let styles: Record<string, string>;
      if (item.kind === "circle" || item.kind === "underline") {
        // marks-pane 的 Underline 同时画 <rect> 和 <line>，且 <line> 的 stroke
        // 被硬编码成 "black"。我们走 inline style: color = 想要的颜色，配合
        // App.css 里 `g.reader-underline/circle line { stroke: currentColor
        // !important }` 把颜色传到 line，并用 `display:none` 干掉那个空心 rect。
        styles = {
          style: `color: ${item.color || "#d4231b"}`,
        };
      } else {
        // 高亮（3 色）保留矩形填充
        styles = { fill: item.color, "fill-opacity": "0.28", "mix-blend-mode": "multiply", stroke: "none" };
      }

      rendition.annotations.add(type, item.cfiRange, {}, undefined, `reader-${item.kind}`, styles);
    }
  }, [highlights, readerReady, highlightRedrawTick]);

  // DB-reader highlight rendering: walks every <p data-paragraph-id="N">
  // currently visible, finds saved highlights for that paragraph, and wraps
  // the (start, end) character range in a styled <span>.
  // Re-runs whenever highlights change, the chapter changes, or any setting
  // that triggers DOM re-render of paragraphs.
  useEffect(() => {
    const isDbBook = readableBooks.find((b) => b.slug === currentBookSlug)?.hasEpub === false;
    if (!isDbBook) return;
    const host = dbReaderHostRef.current;
    if (!host) return;

    // Tear down previous wrappers (idempotent re-render). The wrappers carry
    // a marker class so we don't accidentally unwrap something else.
    host.querySelectorAll(".db-mark-wrap").forEach((el) => {
      const parent = el.parentNode;
      if (!parent) return;
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
      parent.normalize?.();
    });

    const dbHighlights = highlights.filter((h) => {
      if (!h.cfiRange.startsWith("db:")) return false;
      const parts = h.cfiRange.split(":");
      if (parts.length < 5) return false;
      // single: db:slug:idx:pid:start-end       (5 parts)
      // multi:  db:slug:idx:m:pidS:cS:pidE:cE   (8 parts, parts[3]==="m")
      return parts[1] === currentBookSlug && Number(parts[2]) === dbReaderIndex;
    });
    if (!dbHighlights.length) return;

    function styleSpan(span: HTMLSpanElement, item: ReaderHighlight) {
      span.className = `db-mark-wrap db-mark-${item.kind}`;
      span.dataset.highlightId = item.id;
      if (item.kind === "highlight") {
        span.style.background = `${item.color || "#efc24f"}66`;
        span.style.padding = "0 0.05em";
      } else if (item.kind === "underline") {
        span.style.borderBottom = `2px solid ${item.color || "#d4231b"}`;
        span.style.paddingBottom = "0.05em";
      } else if (item.kind === "circle") {
        span.style.borderBottom = `2px dotted ${item.color || "#d4231b"}`;
        span.style.paddingBottom = "0.05em";
      }
    }

    // Wrap the (a, b) char range inside one paragraph with a styled span.
    function wrapRange(para: HTMLElement, a: number, b: number, item: ReaderHighlight) {
      if (b <= a) return;
      const walker = document.createTreeWalker(para, NodeFilter.SHOW_TEXT);
      let pos = 0;
      let startNode: Text | null = null;
      let startOff = 0;
      let endNode: Text | null = null;
      let endOff = 0;
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        const len = (node.nodeValue || "").length;
        if (!startNode && pos + len >= a) {
          startNode = node;
          startOff = a - pos;
        }
        if (pos + len >= b) {
          endNode = node;
          endOff = b - pos;
          break;
        }
        pos += len;
      }
      if (!startNode || !endNode) return;
      const range = document.createRange();
      try {
        range.setStart(startNode, startOff);
        range.setEnd(endNode, endOff);
      } catch {
        return;
      }
      const span = document.createElement("span");
      styleSpan(span, item);
      try {
        range.surroundContents(span);
      } catch {
        // surroundContents fails if the range partially encloses non-text
        // nodes — rare here since paragraphs are plain text.
      }
    }

    function paraTextLength(para: HTMLElement): number {
      const walker = document.createTreeWalker(para, NodeFilter.SHOW_TEXT);
      let total = 0;
      while (walker.nextNode()) total += (walker.currentNode.nodeValue || "").length;
      return total;
    }

    // Defer one frame so the fresh paragraphs from `dbReaderChapter` are in
    // the DOM before we try to walk them.
    const id = requestAnimationFrame(() => {
      for (const item of dbHighlights) {
        const parts = item.cfiRange.split(":");
        if (parts[3] === "m") {
          // Cross-paragraph: walk every paragraph between pidS and pidE in
          // document order and wrap the appropriate slice in each.
          const pidS = parts[4];
          const cS = Number(parts[5]);
          const pidE = parts[6];
          const cE = Number(parts[7]);
          if (!pidS || !pidE || !Number.isFinite(cS) || !Number.isFinite(cE)) continue;
          const allParas = Array.from(host.querySelectorAll<HTMLElement>("[data-paragraph-id]"));
          const startIdx = allParas.findIndex((p) => p.dataset.paragraphId === pidS);
          const endIdx = allParas.findIndex((p) => p.dataset.paragraphId === pidE);
          if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) continue;
          for (let i = startIdx; i <= endIdx; i++) {
            const para = allParas[i];
            const a = i === startIdx ? cS : 0;
            const b = i === endIdx ? cE : paraTextLength(para);
            wrapRange(para, a, b, item);
          }
        } else {
          // Single-paragraph: db:slug:idx:pid:start-end
          const pid = parts[3];
          const [a, b] = (parts[4] || "").split("-").map(Number);
          if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
          const para = host.querySelector(`[data-paragraph-id="${pid}"]`) as HTMLElement | null;
          if (!para) continue;
          wrapRange(para, a, b, item);
        }
      }
    });

    return () => cancelAnimationFrame(id);
  }, [highlights, dbReaderChapter, dbReaderIndex, currentBookSlug, readableBooks]);

  useEffect(() => {
    if (!readerReady || !renditionRef.current || !currentCfiRef.current) return;

    // For layout/script changes that only need a re-render of the current page
    // (auto-annotate, script variant), just re-display.
    // But for readerLayout changes, we must rebuild the rendition because
    // epubjs paginated flow doesn't support vertical-rl at all.
    void openLocation(currentCfiRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAnnotate, scriptVariant, readerReady]);

  // When layout changes, just re-display the current page to apply new styles.
  // Vertical mode keeps paginated flow — epubjs reports total=1 per section
  // but that's fine because each section = one chapter after EPUB splitting.
  // Prev/next simply go to prev/next chapter in vertical mode.
  useEffect(() => {
    if (!readerReady || !renditionRef.current || !currentCfiRef.current) return;
    void openLocation(currentCfiRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readerLayout, readerReady]);

  useEffect(() => {
    if (!readerReady || !renditionRef.current) return;
    renditionRef.current.spread?.(getRenditionSpread(), 720);
    if (currentCfiRef.current) {
      void openLocation(currentCfiRef.current);
    }
  // 分栏切换只调用 epubjs spread 并回到当前页；openLocation 用 ref 保持最新状态。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageSpread, readerReady]);

  // Resize epubjs rendition when sidebars collapse/expand
  useEffect(() => {
    if (!readerReady || !renditionRef.current || !readerHostRef.current) return;
    // Wait for CSS transition (max 150ms now) to finish, then resize + force a
    // fresh annotation render once epub.js has redrawn the view.
    const timer = window.setTimeout(() => {
      const rect = readerHostRef.current?.getBoundingClientRect();
      if (rect && renditionRef.current) {
        const r = renditionRef.current as unknown as { manager?: unknown; resize?: (w: number, h: number) => void };
        if (r.manager) {
          try { r.resize?.(Math.round(rect.width), Math.round(rect.height)); } catch { /* ignore */ }
        }
        window.setTimeout(() => setHighlightRedrawTick((t) => t + 1), 80);
      }
    }, 170);
    return () => window.clearTimeout(timer);
  }, [sidebarCollapsed, assistantCollapsed, readerReady]);

  function clearSelection() {
    // EPUB iframe selection
    selectionContentsRef.current?.window?.getSelection()?.removeAllRanges();
    // Main-window selection (DB-reader uses this, not the iframe). Without
    // this clear, the live text selection persists; subsequent mouseup
    // events on the host re-fire handleDbReaderSelection, which re-shows
    // the overlay's backdrop, and the backdrop intercepts every click on
    // the page-turn-zone — page flipping appears broken until the user
    // clicks somewhere that clears the OS-level selection.
    window.getSelection()?.removeAllRanges();
    setSelectionOverlay((prev) => ({ ...prev, visible: false }));
    // NOTE: Intentionally NOT clearing setSelectionText / setSelectionCfi
    // / selectionContentsRef here — earlier I tried to "clear React-side
    // selection state too for UI consistency" but it broke 识别日期 (which
    // walks back from the iframe range stored in selectionContentsRef to
    // build contextBefore — without the ref the resolver gets empty
    // context and reports "查找不到") and contradicts the product spec
    // that the selection persists until the next selection is made.
  }

  // 显式「清空当前选段」按钮 / 关闭累积开关 走这里 —— 把 React 侧 selection
  // state + 累积 buffer + 句读 overlay 都清掉。区别于 clearSelection 只清
  // OS-level 选区，不动 React state。
  function clearSelectionAndPinned() {
    setPinnedSegments([]);
    setSelectionText("");
    setSelectionCfi("");
    selectionContentsRef.current = null;
    clearDudouOverlay();
    clearSelection();
  }

  useEffect(() => {
    if (activeTab !== "people") return;
    if (emperorsData && officialsData) return;

    let cancelled = false;
    const loadAuxiliary = async () => {
      try {
        const [emperorPayload, officialPayload] = await Promise.all([
          emperorsData ? Promise.resolve(emperorsData) : fetchEmperors(),
          officialsData ? Promise.resolve(officialsData) : fetchOfficials(),
        ]);

        if (cancelled) return;
        setEmperorsData(emperorPayload);
        setOfficialsData(officialPayload);
      } catch (error) {
        if (!cancelled) {
          setReferenceError(error instanceof Error ? error.message : "辅助资料加载失败。");
        }
      }
    };

    void loadAuxiliary();
    return () => {
      cancelled = true;
    };
  }, [activeTab, emperorsData, officialsData]);

  function addSelectionHighlight(kind: "highlight" | "underline" | "circle", color: string) {
    if (!selectionCfi || !selectionText.trim()) return;
    if (selectionCfi.startsWith("db:") && selectionCfi.split(":").length < 5) {
      setAiError("无法定位选段所在段落，请重新选取。");
      clearSelection();
      return;
    }
    const allSegments = [
      ...pinnedSegments,
      { cfi: selectionCfi, text: selectionText },
    ].filter((s) => {
      if (!s.cfi || !s.text.trim()) return false;
      if (s.cfi.startsWith("db:") && s.cfi.split(":").length < 5) return false;
      return true;
    });
    const now = new Date().toISOString();
    const items: ReaderHighlight[] = allSegments.map((s) => ({
      id: crypto.randomUUID(),
      cfiRange: s.cfi,
      text: s.text,
      color,
      kind,
      createdAt: now,
    }));
    setHighlights((current) => [...items, ...current]);
    // 记入撤销栈（标记模式 / 普通工具栏都收集，统一 Cmd+Z 撤销）
    markUndoStackRef.current.push(items.map((it) => it.id));
    if (markUndoStackRef.current.length > 50) markUndoStackRef.current.shift();
    clearSelection();
  }

  // 标记模式下：选段刚结束时直接打标，不弹工具栏。cfi/text 直接从参数取，
  // 避免 React 状态未提交时拿到旧值；color/kind 从 ref 取，避免 rendition 闭包捕获过时值。
  function applyMarkModeHighlight(cfi: string, text: string) {
    if (!cfi || !text.trim()) return;
    if (cfi.startsWith("db:") && cfi.split(":").length < 5) return;
    const style = markStyleRef.current;
    const { kind, color } = resolveMarkStyle(style);
    const now = new Date().toISOString();
    const item: ReaderHighlight = {
      id: crypto.randomUUID(),
      cfiRange: cfi,
      text,
      color,
      kind,
      createdAt: now,
    };
    setHighlights((current) => [item, ...current]);
    markUndoStackRef.current.push([item.id]);
    if (markUndoStackRef.current.length > 50) markUndoStackRef.current.shift();
  }

  // 隐藏当前选段下面那一组 action 按钮后，启动笔记弹窗的入口暂时没了；
  // 函数本身保留，将来如果再增加入口（如选段工具栏的 "笔记" 按钮直接弹
  // composer 模态而非 inline 输入）可以直接复用。
  function startNoteComposer() {
    if (!selectionText.trim()) return;
    setNoteDraft("");
    setNoteComposerOpen(true);
  }
  void startNoteComposer;

  // Whenever the composer opens — either for a brand new note (editingNoteId
  // null) or for editing an existing one — seed the timeline draft fields so
  // the form pre-fills with sensible defaults (auto-detected date for new,
  // saved values for edits).
  useEffect(() => {
    if (!noteComposerOpen) return;
    if (editingNoteId) {
      const n = notes.find((x) => x.id === editingNoteId);
      if (!n) return;
      setTlDraftEnabled(!!n.inTimeline);
      setTlDraftYear(n.manualYear != null ? String(n.manualYear) : (n.historicalYear != null ? String(n.historicalYear) : ""));
      setTlDraftMonth(n.manualMonth != null ? String(n.manualMonth) : "");
      setTlDraftDay(n.manualDay != null ? String(n.manualDay) : "");
      setTlDraftScale(n.timelineScale ?? 1);
      setTlDraftCategory(n.timelineCategory ?? "我的札记");
      setTlDraftTitle(n.timelineTitle ?? "");
    } else {
      // New note — try to auto-detect a year from the current selection so
      // the user only has to flip the toggle on if they want to surface it.
      let detectedYear = "";
      let detectedMonth = "";
      let detectedDay = "";
      try {
        let contextBefore = "";
        const contents = selectionContentsRef.current;
        if (contents) {
          const sel = contents.window.getSelection?.();
          const range = sel?.rangeCount ? sel.getRangeAt(0) : null;
          if (range) {
            const before = contents.document.createRange();
            before.setStart(contents.document.body, 0);
            before.setEnd(range.startContainer, range.startOffset);
            contextBefore = before.toString();
          }
        }
        const resolved = resolveSelectionDate(selectionText, contextBefore, "lunar", false);
        if (resolved) {
          if (resolved.solarYear) detectedYear = String(resolved.solarYear);
          if (resolved.solarMonth) detectedMonth = String(resolved.solarMonth);
          if (resolved.solarDay) detectedDay = String(resolved.solarDay);
          if (!detectedYear && resolved.gregorianYear) detectedYear = String(resolved.gregorianYear);
        }
      } catch { /* best-effort */ }
      setTlDraftEnabled(false);
      setTlDraftYear(detectedYear);
      setTlDraftMonth(detectedMonth);
      setTlDraftDay(detectedDay);
      setTlDraftScale(1);
      setTlDraftCategory("我的札记");
      setTlDraftTitle("");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteComposerOpen, editingNoteId]);

  function saveNote() {
    if (!noteDraft.trim()) return;

    // Pull timeline draft into a typed patch — applied to both edit and new
    // note paths so behavior is uniform.
    const tlPatch: Partial<ReaderNote> = {
      inTimeline: tlDraftEnabled,
      manualYear: tlDraftYear ? parseInt(tlDraftYear, 10) : undefined,
      manualMonth: tlDraftMonth ? parseInt(tlDraftMonth, 10) : undefined,
      manualDay: tlDraftDay ? parseInt(tlDraftDay, 10) : undefined,
      timelineScale: tlDraftEnabled ? clamp(tlDraftScale, 1, 5) : undefined,
      timelineCategory: tlDraftEnabled ? (tlDraftCategory || "我的札记") : undefined,
      timelineTitle: tlDraftEnabled ? (tlDraftTitle.trim() || undefined) : undefined,
    };

    // Editing an existing note
    if (editingNoteId) {
      setNotes((current) => current.map((n) => n.id === editingNoteId ? { ...n, note: noteDraft.trim(), ...tlPatch } : n));
      setEditingNoteId(null);
      setNoteDraft("");
      setNoteComposerOpen(false);
      return;
    }

    // Creating a new note
    if (!selectionText.trim() || !selectionCfi) return;

    // Try to derive a historical timestamp from the selection + its
    // surrounding text. Best-effort: works only for explicit reign mentions
    // ("嘉靖三年" / "永乐元年八月" etc.) within or just before the selection.
    let historicalAt: string | undefined;
    let historicalYear: number | undefined;
    try {
      let contextBefore = "";
      const contents = selectionContentsRef.current;
      if (contents) {
        const sel = contents.window.getSelection?.();
        const range = sel?.rangeCount ? sel.getRangeAt(0) : null;
        if (range) {
          const before = contents.document.createRange();
          before.setStart(contents.document.body, 0);
          before.setEnd(range.startContainer, range.startOffset);
          contextBefore = before.toString();
        }
      } else {
        const sel = window.getSelection?.();
        const range = sel?.rangeCount ? sel.getRangeAt(0) : null;
        const host = document.querySelector(".db-reader-host");
        if (range && host) {
          const before = document.createRange();
          before.setStart(host, 0);
          before.setEnd(range.startContainer, range.startOffset);
          contextBefore = before.toString();
        }
      }
      const resolved = resolveSelectionDate(selectionText, contextBefore, "lunar", false);
      if (resolved) {
        if (resolved.solarYear && resolved.solarMonth && resolved.solarDay) {
          historicalAt = `${resolved.solarYear}-${String(resolved.solarMonth).padStart(2, "0")}-${String(resolved.solarDay).padStart(2, "0")}`;
        } else {
          historicalAt = resolved.phrase;
        }
        historicalYear = resolved.gregorianYear;
      }
    } catch {
      // best-effort; missing historical timestamp is fine
    }

    // 累积模式：每个 pin 段 + 当前段都生成一条笔记，共享同一 note 文本 /
    // 时间线 patch，但各自的 cfi/text 独立 — 跳回原文时能定位到该段。
    const segs = [
      ...pinnedSegments,
      { cfi: selectionCfi, text: selectionText },
    ].filter((s) => s.cfi && s.text.trim() && !(s.cfi.startsWith("db:") && s.cfi.split(":").length < 5));
    const noteText = noteDraft.trim();
    const newNotes: ReaderNote[] = segs.map((s) => ({
      id: crypto.randomUUID(),
      cfiRange: s.cfi,
      text: s.text,
      note: noteText,
      createdAt: new Date().toISOString(),
      historicalAt,
      historicalYear,
      bookSlug: currentBookSlug,
      ...tlPatch,
    }));
    // Replace-on-conflict: drop existing notes whose cfi+body matches any new one.
    setNotes((current) => {
      const dropKeys = new Set(newNotes.map((n) => `${n.cfiRange}::${n.note}`));
      const filtered = current.filter((n) => !dropKeys.has(`${n.cfiRange}::${n.note.trim()}`));
      return [...newNotes, ...filtered];
    });

    // 给每段未存过 highlight 的选段补一条黄色高亮，方便日后回看。
    const newHighlights: ReaderHighlight[] = [];
    for (const s of segs) {
      if (!highlights.some((item) => item.cfiRange === s.cfi)) {
        newHighlights.push({
          id: crypto.randomUUID(),
          cfiRange: s.cfi,
          text: s.text,
          color: "#efc24f",
          kind: "highlight",
          createdAt: new Date().toISOString(),
        });
      }
    }
    if (newHighlights.length) {
      setHighlights((current) => [...newHighlights, ...current]);
    }

    setNoteDraft("");
    setNoteComposerOpen(false);
    clearSelection();
  }

  function createBookmark() {
    if (!currentCfi) return;
    const label = bookmarkNameDraft.trim() || currentSectionLabel || "当前位置";
    const bookmark: ReaderBookmark = {
      id: crypto.randomUUID(),
      cfi: currentCfi,
      href: currentHref,
      label,
      createdAt: new Date().toISOString(),
    };
    setBookmarks((current) => [bookmark, ...current]);
    setBookmarkNameDraft("");
  }

  function removeHighlight(target: ReaderHighlight) {
    renditionRef.current?.annotations?.remove(target.cfiRange, target.kind === "highlight" ? "highlight" : "underline");
    setHighlights((current) => current.filter((item) => item.id !== target.id));
  }

  async function handleOfficeSearch() {
    if (!officeSearchQuery.trim()) return;
    try {
      setOfficeSearchLoading(true);
      setReferenceError("");
      const result = await searchOfficeReferences(officeSearchQuery.trim());
      setOfficeSearchResult(result);
    } catch (error) {
      setReferenceError(error instanceof Error ? error.message : "职官检索失败。");
    } finally {
      setOfficeSearchLoading(false);
    }
  }

  async function handleMapSearch() {
    if (!mapQuery.trim()) return;
    try {
      setMapLoading(true);
      setReferenceError("");
      const result = await geocodePlaces(mapQuery.trim(), aiSettings);
      setMapResult(result);
    } catch (error) {
      setReferenceError(error instanceof Error ? error.message : "地名定位失败。");
    } finally {
      setMapLoading(false);
    }
  }

  // Resolve the first date-token in the user's selection. Reaches outward
  // into the surrounding document text to fill in missing reign+year and
  // month context — mirrors how a reader naturally tracks context.
  async function handleResolveSelectionDate() {
    if (!selectionText.trim()) {
      setDateResult({ error: "请先选中含日期或月份的一段文字。" });
      return;
    }
    // Pull text from the start of the body up to the selection start so the
    // resolver can search backward for the most recent reign+year and month.
    let contextBefore = "";
    try {
      const contents = selectionContentsRef.current;
      if (contents) {
        // EPUB iframe path
        const sel = contents.window.getSelection?.();
        const range = sel?.rangeCount ? sel.getRangeAt(0) : null;
        if (range) {
          const before = contents.document.createRange();
          before.setStart(contents.document.body, 0);
          before.setEnd(range.startContainer, range.startOffset);
          contextBefore = before.toString();
        }
      } else {
        // DB-reader path: selection lives in main window
        const sel = window.getSelection?.();
        const range = sel?.rangeCount ? sel.getRangeAt(0) : null;
        const host = document.querySelector(".db-reader-host");
        if (range && host) {
          const before = document.createRange();
          before.setStart(host, 0);
          before.setEnd(range.startContainer, range.startOffset);
          contextBefore = before.toString();
        }
      }
    } catch {
      // fall through with empty context
    }

    // 当前章节 label：EPUB 路径用 currentSectionLabel（来自 epubjs relocated），
    // DB-reader 路径用 dbReaderChapter.chapter（明实录走这条 — 它是 DB-only 书）。
    const effectiveChapterLabel = currentSectionLabel || dbReaderChapter?.chapter || "";

    // 实录章节用专属解析路径（不走通用 resolveSelectionDate，避免污染）
    let resolved: ResolvedSelectionDate | null = null;
    const inShilu = effectiveChapterLabel && shiluRangesForChapter(effectiveChapterLabel);
    console.info("[识别日期] selectionText=", JSON.stringify(selectionText.slice(0, 60)), "label=", effectiveChapterLabel, "inShilu=", !!inShilu, "ctxBefore.len=", contextBefore.length);
    if (inShilu) {
      resolved = resolveShiluSelectionDate(selectionText, contextBefore, effectiveChapterLabel, dateDisplay);
      console.info("[识别日期] shilu 解析 →", resolved ? `命中 ${resolved.phrase}` : "null");
    }
    if (!resolved) {
      resolved = resolveSelectionDate(selectionText, contextBefore, dateDisplay, showEmperor);
      console.info("[识别日期] 通用解析 →", resolved ? `命中 ${resolved.phrase}` : "null");
    }

    // Fallback chain. The resolver searches level by level (smallest unit
    // → year → reign), so a missing reign in the current chapter is the
    // most common reason resolve returns null. Walk back through prior
    // chapters and retry, using the DB-side `/api/reference/chapter-context`
    // endpoint which works for any imported book (including EPUB ones —
    // 明史 etc. were imported via import-epub-source.mjs).
    //
    // We use the navigation map (chapterNavigationRef) to enumerate prior
    // chapters by label, then ask the backend for each chapter's text.
    if (!resolved && currentBookSlug) {
      try {
        let widerContext = contextBefore;
        // 章节列表：EPUB 路径用 meta.inPageToc / tocTree；DB-reader 路径
        // （明实录走这条 — DB-only，meta 为空）用 dbReaderChapters.chapters。
        // 缺一不可，否则跨章兜底无法定位上一章 label。
        const epubList: { label: string; href?: string }[] =
          (meta?.inPageToc?.length ?? 0) > 0
            ? meta!.inPageToc!
            : (meta ? flattenTocItems(meta.tocTree).filter((_, idx) => idx > 0) : []);
        const dbList: { label: string }[] =
          (dbReaderChapters?.chapters || []).map((c) => ({ label: c.label }));
        const fallbackList = epubList.length ? epubList : dbList;

        let curIdx = -1;
        if (selectionContentsRef.current) {
          if (currentHref) {
            const curHrefBase = currentHref.split("#")[0].replace(/^OEBPS\//, "");
            curIdx = epubList.findIndex((it) => {
              const navHref = (it.href || "").split("#")[0].replace(/^OEBPS\//, "");
              return navHref === curHrefBase || navHref.endsWith(curHrefBase) || curHrefBase.endsWith(navHref);
            });
          }
          if (curIdx < 0 && currentSectionLabel) {
            curIdx = epubList.findIndex((it) => it.label === currentSectionLabel);
          }
        } else {
          curIdx = dbReaderIndex;
        }
        console.info("[识别日期] fallback start: curIdx=", curIdx, "label=", effectiveChapterLabel, "fallbackList.length=", fallbackList.length);

        if (curIdx > 0 && fallbackList.length > 0) {
          const start = Math.max(0, curIdx - 5);
          const priorTexts: string[] = [];
          for (let i = start; i < curIdx; i++) {
            const it = fallbackList[i];
            const label = it?.label;
            if (!label) continue;
            try {
              const data = await fetchChapterContext(currentBookSlug, label, "");
              const txt = (data.paragraphs || []).join("\n");
              console.info("[识别日期] idx", i, "label=", label, "len=", txt.length);
              if (txt) priorTexts.push(txt);
            } catch (e) {
              console.warn("[识别日期] idx", i, "DB 抓章失败 label=", label, e);
            }
          }
          if (priorTexts.length) {
            widerContext = priorTexts.join("\n") + "\n" + contextBefore;
            console.info("[识别日期] 扩展后 contextBefore 总长", widerContext.length);
          }
        }
        if (widerContext !== contextBefore) {
          // ⚠ 用 effectiveChapterLabel（DB-reader 走 dbReaderChapter.chapter），
          // 否则 inShilu 为 true 但 chapterLabel 为空 → resolveShiluSelectionDate
          // 内部 shiluRangesForChapter("") 又返回 null → 永远 null。
          if (inShilu) {
            resolved = resolveShiluSelectionDate(selectionText, widerContext, effectiveChapterLabel, dateDisplay);
          }
          if (!resolved) {
            resolved = resolveSelectionDate(selectionText, widerContext, dateDisplay, showEmperor);
          }
          console.info("[识别日期] 扩展后再 resolve →", resolved ? `命中 ${resolved.phrase}` : "仍然 null");
        }
      } catch (e) {
        console.warn("[识别日期] fallback 出错", e);
      }
    }

    if (!resolved) {
      setDateResult({ error: "选段及其前文（含前几章）中未找到可识别的明代年号 / 月份 / 干支日。" });
      return;
    }
    setDateResult(resolved);
  }

  async function handleReferenceLookup(targetText = effectiveSelectionText) {
    if (!targetText.trim()) {
      setReferenceError("请先选中词语、短句或一小段文字。");
      return;
    }

    try {
      setLookupLoading(true);
      setReferenceError("");
      const response = await lookupReference(targetText.trim(), aiSettings);
      startTransition(() => {
        setReferenceLookup(response);
      });
      if (activeTab !== "search") {
        setAiPanelTitle("划词百科");
      }
    } catch (error) {
      setReferenceError(error instanceof Error ? error.message : "划词百科加载失败。");
    } finally {
      setLookupLoading(false);
    }
  }

  async function handleCrossCompare(targetText: string = effectiveSelectionText, supplement = "") {
    if (!targetText.trim()) {
      setReferenceError("请先选中一段《明史》原文。");
      return;
    }

    // 在 clearSelection 之前把 cfi + text + 历史时间 snapshot 存起来，给「保存为札记」用
    let snapshotHistoricalAt: string | undefined;
    let snapshotHistoricalYear: number | undefined;
    try {
      let contextBefore = "";
      const contents = selectionContentsRef.current;
      if (contents) {
        const sel = contents.window.getSelection?.();
        const range = sel?.rangeCount ? sel.getRangeAt(0) : null;
        if (range) {
          const before = contents.document.createRange();
          before.setStart(contents.document.body, 0);
          before.setEnd(range.startContainer, range.startOffset);
          contextBefore = before.toString();
        }
      } else {
        const sel = window.getSelection?.();
        const range = sel?.rangeCount ? sel.getRangeAt(0) : null;
        const host = document.querySelector(".db-reader-host");
        if (range && host) {
          const before = document.createRange();
          before.setStart(host, 0);
          before.setEnd(range.startContainer, range.startOffset);
          contextBefore = before.toString();
        }
      }
      const resolved = resolveSelectionDate(targetText, contextBefore, "lunar", false);
      if (resolved) {
        if (resolved.solarYear && resolved.solarMonth && resolved.solarDay) {
          snapshotHistoricalAt = `${resolved.solarYear}-${String(resolved.solarMonth).padStart(2, "0")}-${String(resolved.solarDay).padStart(2, "0")}`;
        } else {
          snapshotHistoricalAt = resolved.phrase;
        }
        snapshotHistoricalYear = resolved.gregorianYear;
      }
    } catch {
      // best-effort
    }
    compareAnchorRef.current = {
      cfi: selectionCfi || "",
      text: targetText.trim(),
      bookSlug: currentBookSlug,
      historicalAt: snapshotHistoricalAt,
      historicalYear: snapshotHistoricalYear,
    };

    try {
      setCompareLoading(true);
      setReferenceError("");
      const effectiveText = supplement ? `${targetText.trim()}\n【用户补充说明】${supplement}` : targetText.trim();
      const response = await compareReference(effectiveText, aiSettings, currentBookSlug);
      startTransition(() => {
        setReferenceCompare(response);
      });
      setAiPanelTitle("史料交叉比对");
      clearSelection();
    } catch (error) {
      setReferenceError(error instanceof Error ? error.message : "史料交叉比对失败。");
    } finally {
      setCompareLoading(false);
    }
  }

  // v1.2.1 G1: 把当前 referenceCompare 报告保存为一条 ReaderNote。
  // 选段位置/text/书籍 来自 handleCrossCompare 入口处 snapshot 的 compareAnchorRef。
  function saveCompareAsNote() {
    const anchor = compareAnchorRef.current;
    if (!anchor || !anchor.cfi || !anchor.text.trim()) {
      setReferenceError("无法保存：未找到原始选段位置。请先重新选段做一次比对。");
      return;
    }
    if (!referenceCompare?.reportMarkdown) {
      setReferenceError("当前没有比对报告可保存。");
      return;
    }
    const usedSourceList = (referenceCompare.contexts || []).map((c) => `《${c.bookTitle}》${c.chapter}`).filter((s, i, a) => a.indexOf(s) === i);
    const usedSourcesNote = usedSourceList.length
      ? `\n\n---\n\n**比对所用史料**：${usedSourceList.slice(0, 8).join(" / ")}${usedSourceList.length > 8 ? " 等" : ""}`
      : "";
    const noteContent = `【史料交叉比对】\n\n${referenceCompare.reportMarkdown.trim()}${usedSourcesNote}`;
    const now = new Date().toISOString();
    // v1.2.1：史料比对类札记，timelineTitle 默认 = 勾画文段（最多 40 字，时间线上只显这一行）
    const autoTitle = anchor.text.trim().slice(0, 40);
    const newNote: ReaderNote = {
      id: crypto.randomUUID(),
      cfiRange: anchor.cfi,
      text: anchor.text,
      note: noteContent,
      createdAt: now,
      historicalAt: anchor.historicalAt,
      historicalYear: anchor.historicalYear,
      bookSlug: anchor.bookSlug,
      // v1.2.1：默认进时间线，让用户保存后立刻能在「历史时间线」面板看到。
      // 不想看到可手动在札记面板「从时间线隐藏」。
      inTimeline: true,
      timelineTitle: autoTitle,
      timelineCategory: "史料比对",
      timelineScale: 3,
    };
    setNotes((cur) => [newNote, ...cur]);
    // 显式反馈
    setAiPanelTitle("已保存为札记");
  }

  async function openSourceViewer(slug: string, chapter: string, snippet: string) {
    try {
      setSourceViewerLoading(true);
      const data = await fetchChapterContext(slug, chapter, snippet.slice(0, 40));
      setSourceViewer(data);
    } catch {
      setReferenceError("无法加载史料原文。");
    } finally {
      setSourceViewerLoading(false);
    }
  }

  // openTimelinePanel: previously the entrypoint for the 「章节时间轴」 button
  // in the 资料 panel; that button has been removed in v1.0 (the panel was
  // judged not useful enough to keep). The function and its modal renderer
  // stay in case we want to re-expose it later — referenced via the modal
  // visibility check below.
  void fetchTimeline; void setTimelineLoading; void setTimelineData; void setTimelineOpen;

  function requestAiAction(type: "translate" | "pronounce" | "explain" | "qa" | "punctuate" | "custom", customAction?: CustomAction) {
    if (type !== "qa" && !selectionText.trim()) {
      setAiError("请先在正文里选中一段文字。");
      return;
    }
    if (type === "qa" && !questionDraft.trim()) {
      setAiError("请输入要提问的内容。");
      return;
    }
    // 句读 / 读音 / 现代文翻译 are mechanical formatting tasks —补充说明
    // 框对它们没意义，跳过直接执行。问答（qa）由专门的 question 输入承载，
    // 也不走补充弹窗。其余（解释 / 自定义动作）保留原行为。
    const SKIP_SUPPLEMENT = new Set(["qa", "punctuate", "pronounce", "translate"]);
    if (promptSupplementEnabled && !SKIP_SUPPLEMENT.has(type)) {
      setSupplementDraft("");
      setPendingAction({ type, customAction });
      return;
    }
    void performAiAction(type, customAction);
  }

  function requestCrossCompare() {
    if (!selectionText.trim()) {
      setReferenceError("请先选中一段《明史》原文。");
      return;
    }
    if (promptSupplementEnabled) {
      setSupplementDraft("");
      setPendingAction({ type: "crossCompare", handler: "compare" });
      return;
    }
    void handleCrossCompare();
  }

  function executePendingAction() {
    if (!pendingAction) return;
    const supplement = supplementDraft.trim();
    if (pendingAction.handler === "compare") {
      setPendingAction(null);
      void handleCrossCompare(effectiveSelectionText, supplement);
    } else {
      const { type, customAction } = pendingAction;
      setPendingAction(null);
      void performAiAction(type as any, customAction, supplement);
    }
  }

  // Snapshot the live selection range so a later overlay (after the AI await
  // resolves and we've called clearSelection) can rebuild it from saved
  // node refs. DOM nodes stay valid even after the OS-level selection clears.
  type DudouSnapshot =
    | { kind: "epub"; doc: Document; sc: Node; so: number; ec: Node; eo: number }
    | { kind: "db"; cfi: string };
  function snapshotForDudou(): DudouSnapshot | null {
    // EPUB iframe selection wins if present (selectionContentsRef set on iframe selection)
    const contents = selectionContentsRef.current;
    if (contents) {
      const sel = contents.window?.getSelection?.();
      const range = sel?.rangeCount ? sel.getRangeAt(0) : null;
      if (range && contents.document) {
        return {
          kind: "epub",
          doc: contents.document,
          sc: range.startContainer,
          so: range.startOffset,
          ec: range.endContainer,
          eo: range.endOffset,
        };
      }
    }
    if (selectionCfi.startsWith("db:") && selectionCfi.split(":").length >= 5) {
      return { kind: "db", cfi: selectionCfi };
    }
    return null;
  }

  // Builds a Map<plainCharIndex, isSentenceEnd> from the punctuated answer.
  // 标注规范：
  //   读号 (，、；：·)  → 实心圆 (filled disc)        — `dudou-overlay-break`
  //   句号 (。！？)     → 空心圆 (hollow ring)        — `+ dudou-overlay-strong`
  function buildDudouBreaks(answer: string): Map<number, boolean> {
    const PUNCT = /[·。，；：！？、]/;
    const SENTENCE_END = /[。！？]/; // 句号类 → 空心圆
    const breaks = new Map<number, boolean>();
    let plainIdx = -1;
    for (let i = 0; i < answer.length; i++) {
      const ch = answer[i];
      if (PUNCT.test(ch)) {
        if (plainIdx >= 0) {
          // 同位置多个标点：句号优先（视觉上句号 > 读号）。
          const prev = breaks.get(plainIdx) || false;
          breaks.set(plainIdx, prev || SENTENCE_END.test(ch));
        }
      } else {
        plainIdx++;
      }
    }
    return breaks;
  }

  // 累积模式：按 pinnedSegments 顺序解析每段为 DudouSnapshot，再把
  // 当前段 snapshot 接到末尾（顺序须与 effectiveSelectionText 拼接顺序一致）。
  // pinned 的 EPUB cfi 用 book.getRange 异步解析，跨章节 / 已离开当前章节
  // 的段会失败 → 静默跳过（plainIdx 仍按 segment.text.length 推进，避免
  // 后续 segment 的圆点错位）。
  async function snapshotsForDudou(): Promise<{ snap: DudouSnapshot | null; textLen: number }[]> {
    const out: { snap: DudouSnapshot | null; textLen: number }[] = [];
    for (const seg of pinnedSegments) {
      if (seg.cfi.startsWith("db:")) {
        const ok = seg.cfi.split(":").length >= 5;
        out.push({ snap: ok ? { kind: "db", cfi: seg.cfi } : null, textLen: seg.text.length });
      } else {
        // epub.js cfi → 重建 Range，需要章节当前 in-DOM
        const book = bookRef.current as unknown as { getRange?: (cfi: string) => Promise<Range | null> } | null;
        let snap: DudouSnapshot | null = null;
        try {
          const r = await book?.getRange?.(seg.cfi);
          if (r && r.startContainer.ownerDocument) {
            snap = {
              kind: "epub",
              doc: r.startContainer.ownerDocument,
              sc: r.startContainer, so: r.startOffset,
              ec: r.endContainer, eo: r.endOffset,
            };
          }
        } catch { /* 段已不在当前 iframe；plainIdx 仍按 textLen 推进 */ }
        out.push({ snap, textLen: seg.text.length });
      }
    }
    const cur = snapshotForDudou();
    out.push({ snap: cur, textLen: selectionText.length });
    return out;
  }

  // Wrap each char of the (start, end) range in a per-char span; chars whose
  // plain-index appears in `breaks` get a `dudou-overlay-break` class. Returns
  // (cleanup, consumedChars) — caller accumulates consumedChars across snaps
  // in 累积模式 to keep break indices aligned with effectiveSelectionText.
  function applyDudouOverlayForSnap(
    snap: DudouSnapshot,
    breaks: Map<number, boolean>,
    startPlainIdx: number,
  ): { cleanup: () => void; consumed: number } | null {
    let range: Range | null = null;
    let doc: Document;
    if (snap.kind === "epub") {
      doc = snap.doc;
      try {
        range = doc.createRange();
        range.setStart(snap.sc, snap.so);
        range.setEnd(snap.ec, snap.eo);
      } catch {
        return null;
      }
    } else {
      const host = dbReaderHostRef.current;
      if (!host) return null;
      doc = document;
      const parts = snap.cfi.split(":");
      let pidS: string, cS: number, pidE: string, cE: number;
      if (parts[3] === "m") {
        pidS = parts[4]; cS = Number(parts[5]); pidE = parts[6]; cE = Number(parts[7]);
      } else {
        pidS = parts[3]; pidE = parts[3];
        const [a, b] = (parts[4] || "").split("-").map(Number);
        cS = a; cE = b;
      }
      const allParas = Array.from(host.querySelectorAll<HTMLElement>("[data-paragraph-id]"));
      const sIdx = allParas.findIndex((p) => p.dataset.paragraphId === pidS);
      const eIdx = allParas.findIndex((p) => p.dataset.paragraphId === pidE);
      if (sIdx < 0 || eIdx < 0) return null;
      const startPara = allParas[sIdx];
      const endPara = allParas[eIdx];
      const findTextOffset = (para: HTMLElement, target: number): { node: Text; off: number } | null => {
        const walker = doc.createTreeWalker(para, NodeFilter.SHOW_TEXT);
        let pos = 0;
        while (walker.nextNode()) {
          const node = walker.currentNode as Text;
          const len = (node.nodeValue || "").length;
          if (pos + len >= target) return { node, off: target - pos };
          pos += len;
        }
        return null;
      };
      const startLoc = findTextOffset(startPara, cS);
      const endLoc = findTextOffset(endPara, cE);
      if (!startLoc || !endLoc) return null;
      try {
        range = doc.createRange();
        range.setStart(startLoc.node, startLoc.off);
        range.setEnd(endLoc.node, endLoc.off);
      } catch {
        return null;
      }
    }
    if (!range) return null;

    // Collect every char position inside the range as (textNode, offset).
    // We split text nodes char-by-char and replace each with a wrapping span,
    // remembering enough state to undo the change cleanly.
    const orig: { parent: Node; before: ChildNode | null; original: Text }[] = [];
    const inserted: HTMLSpanElement[] = [];
    const ancestor = range.commonAncestorContainer;
    const root: Node = ancestor.nodeType === 1 ? ancestor : (ancestor.parentNode || ancestor);
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => range!.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
    } as NodeFilter);
    const textNodes: Text[] = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode as Text);

    let plainIdx = startPlainIdx;
    let consumed = 0;
    for (const tn of textNodes) {
      const value = tn.nodeValue || "";
      let from = 0;
      let to = value.length;
      if (tn === range.startContainer) from = range.startOffset;
      if (tn === range.endContainer) to = range.endOffset;
      if (to <= from) continue;
      const slice = value.slice(from, to);

      const parent = tn.parentNode;
      if (!parent) continue;
      const next = tn.nextSibling;
      orig.push({ parent, before: next as ChildNode | null, original: tn });

      // Replace the whole text node with: [pre-text] + per-char spans + [post-text]
      const pre = value.slice(0, from);
      const post = value.slice(to);
      const frag = doc.createDocumentFragment();
      if (pre) frag.appendChild(doc.createTextNode(pre));
      for (let i = 0; i < slice.length; i++) {
        const ch = slice[i];
        const span = doc.createElement("span");
        span.className = "dudou-overlay-char";
        const isBreak = breaks.has(plainIdx);
        if (isBreak) {
          span.classList.add("dudou-overlay-break");
          if (breaks.get(plainIdx)) span.classList.add("dudou-overlay-strong");
        }
        span.textContent = ch;
        frag.appendChild(span);
        inserted.push(span);
        plainIdx++;
        consumed++;
      }
      if (post) frag.appendChild(doc.createTextNode(post));
      parent.replaceChild(frag, tn);
    }

    // Cleanup: replace the inserted fragments back with the original text nodes.
    const cleanup = () => {
      for (const span of inserted) {
        const parent = span.parentNode;
        if (!parent) continue;
        parent.removeChild(span);
      }
      // Restore original text nodes in their original positions and merge.
      for (const { parent, before, original } of orig) {
        try {
          if (before && before.parentNode === parent) parent.insertBefore(original, before);
          else parent.appendChild(original);
        } catch { /* best-effort */ }
      }
      // Clean up any leftover text nodes from pre/post split — normalize merges
      // adjacent text nodes back together.
      const ancestors = new Set<Node>();
      orig.forEach((o) => ancestors.add(o.parent));
      ancestors.forEach((n) => (n as Element).normalize?.());
    };
    return { cleanup, consumed };
  }

  // 顶层入口：单段 / 多段 通用。snaps 为 null 的位置仅推进 plainIdx，
  // 表示该段不在当前可见 DOM 中（pinned EPUB 段离开了 iframe），跳过 wrap。
  async function applyDudouOverlays(snaps: { snap: DudouSnapshot | null; textLen: number }[], answer: string): Promise<(() => void) | null> {
    const breaks = buildDudouBreaks(answer);
    const cleanups: Array<() => void> = [];
    let plainIdx = 0;
    for (const item of snaps) {
      if (item.snap) {
        const r = applyDudouOverlayForSnap(item.snap, breaks, plainIdx);
        if (r) {
          cleanups.push(r.cleanup);
          // 用 segment.textLen 推进而不是 r.consumed —— 二者通常一致，
          // 但取 textLen 能保证即使 wrap 部分失败 plainIdx 仍对齐。
          plainIdx += item.textLen;
          continue;
        }
      }
      // 未渲染 / 渲染失败 → 仅推进 plainIdx。
      plainIdx += item.textLen;
    }
    if (!cleanups.length) return null;
    return () => { for (const c of cleanups) { try { c(); } catch { /* ignore */ } } };
  }

  function clearDudouOverlay() {
    try { dudouCleanupRef.current?.(); } catch { /* ignore */ }
    dudouCleanupRef.current = null;
  }

  // Tear down 句读 overlay whenever the rendered chapter changes (db-reader
  // chapter switch / book switch). Without this, a stale cleanup function
  // can hold refs to nodes that no longer exist in the DOM.
  useEffect(() => {
    return () => clearDudouOverlay();
  }, [currentBookSlug, dbReaderIndex, currentChapterIndex]);

  async function performAiAction(type: "translate" | "pronounce" | "explain" | "qa" | "punctuate" | "custom", customAction?: CustomAction, supplement = "") {
    if (type !== "qa" && !selectionText.trim()) {
      setAiError("请先在正文里选中一段文字。");
      return;
    }
    if (type === "qa" && !questionDraft.trim()) {
      setAiError("请输入要提问的内容。");
      return;
    }

    const effectiveQuestion = supplement ? `${questionDraft}\n补充说明：${supplement}` : questionDraft;

    // Snapshot the selection range(s) BEFORE the await — clearSelection will
    // wipe the live OS-level selection. 累积模式下要 snapshot 所有 pin 段 +
    // 当前段；非累积模式下只 snapshot 当前段。
    const dudouSnaps = type === "punctuate" ? await snapshotsForDudou() : null;

    try {
      setAiLoading(true);
      setAiError("");
      setAiResponse(null);
      setAiPanelTitle(
        type === "custom" ? customAction?.name || "自定义操作"
          : type === "qa" ? "问答"
          : type === "translate" ? "翻译为现代文"
          : type === "pronounce" ? "读音标注"
          : type === "punctuate" ? "AI 句读"
          : "解释",
      );
      // 累积模式 → 用 effectiveSelectionText（拼好的总文本）发给 AI；非累积时
      // effectiveSelectionText === selectionText。
      const aiSelection = effectiveSelectionText;
      const response = await runAiAction({
        type,
        selection: supplement ? `${aiSelection}\n【用户补充】${supplement}` : aiSelection,
        question: effectiveQuestion,
        aiSettings: {
          ...aiSettings,
          customActions,
        },
        customAction,
      });
      setAiResponse(response);
      clearSelection();
      // Apply 句读 inline overlay AFTER clearSelection — snapshots still
      // point at valid DOM nodes; tear down any prior overlay first so
      // re-running 句读 doesn't stack markers.
      if (type === "punctuate" && dudouSnaps && response?.answer) {
        clearDudouOverlay();
        const cleanup = await applyDudouOverlays(dudouSnaps, response.answer);
        if (cleanup) dudouCleanupRef.current = cleanup;
      }
    } catch (error) {
      setAiError(error instanceof Error ? error.message : "AI 操作失败。");
    } finally {
      setAiLoading(false);
    }
  }

  async function handleSearch() {
    if (!searchQuery.trim()) return;
    try {
      setSearchLoading(true);
      setSearchError("");
      setSearchResponse(null);
      // searchSlugs 空数组 = 搜全部；非空 = 仅搜这些书。
      const response = await searchBook(searchQuery.trim(), searchMode, aiSettings, searchLimit, searchSlugs);
      startTransition(() => {
        setSearchResponse(response);
      });
    } catch (error) {
      setSearchError(error instanceof Error ? error.message : "搜索失败。");
    } finally {
      setSearchLoading(false);
    }
  }

  // Try to scroll to + flash-highlight the paragraph recorded in
  // pendingSearchNavRef. Called from the chapter-loaded effects below.
  // Returns true once the target was found and consumed; false if the
  // chapter rendered but the target paragraph wasn't located yet (effects
  // will retry on the next render).
  function scrollToSearchTarget(): boolean {
    const target = pendingSearchNavRef.current;
    if (!target) return false;

    // DB-reader path: query the rendered <p data-paragraph-id="N">
    // Note: 多栏布局未必已 settle。如果 offsetLeft 还 = 0，先把段落 id
    // 写进 dbAnchorParaRef，column-recompute useEffect 触发时会按它对齐；
    // 同时仍尝试主动 scrollTo，以应对 effect 已经跑过的场景。
    const dbHost = dbReaderHostRef.current;
    if (dbHost) {
      const el = dbHost.querySelector<HTMLElement>(`[data-paragraph-id="${target.paragraphId}"]`);
      console.info("[searchNav] DB-reader attempt: dbHost=present, paragraphId=" + target.paragraphId + ", el=" + (el ? "FOUND" : "MISSING"));
      if (el) {
        const cw = dbHost.clientWidth;
        dbAnchorParaRef.current = String(target.paragraphId);
        console.info("[searchNav] DB-reader matched: cw=" + cw + ", offsetLeft=" + el.offsetLeft + ", scrollWidth=" + dbHost.scrollWidth);
        if (cw > 0 && el.offsetLeft > 0) {
          const targetPage = Math.floor(el.offsetLeft / cw);
          dbHost.scrollTo({ left: targetPage * cw, behavior: "smooth" });
          dbTargetPageRef.current = targetPage;
          el.classList.add("search-flash");
          setTimeout(() => el.classList.remove("search-flash"), 1600);
          console.info("[searchNav] DB-reader scrolled to page " + targetPage);
          pendingSearchNavRef.current = null;
          return true;
        }
        // 找到段落但 layout 没 settle — 加 flash，但不清 ref，让后续重试再 scroll
        console.info("[searchNav] DB-reader layout not settled, will retry");
        el.classList.add("search-flash");
        setTimeout(() => el.classList.remove("search-flash"), 1600);
      }
    } else {
      // 仅 EPUB path 时才打这条；DB-reader 没渲染的时候 dbHost 自然是 null
      // — 不一定是 bug。
    }

    // EPUB path: 找到段落 → 算 CFI → rendition.display(cfi) 跳到分栏页
    const rendition = renditionRef.current as unknown as EpubRenditionLike & { currentLocation?: () => unknown };
    if (rendition && rendition.getContents) {
      const contentsList = rendition.getContents() || [];
      // iframe 内容可能被 OpenCC 转成繁体，DB 原始文本通常是简体 → 双路 needle 匹配。
      // 同时只比 CJK 字符（去掉所有标点、空白、英数），避免因「，」/「，」、「·」/「‧」差异 false miss。
      const onlyCjk = (s: string) => (s || "").replace(/[^一-鿿㐀-䶿]/g, "");
      const needleSimp = onlyCjk(target.text).slice(0, 18);
      const needleTrad = toTraditional(needleSimp);
      console.info("[searchNav] EPUB attempt", { contentsCount: contentsList.length, needleSimp, needleTrad, attempt: target.attempts });
      if (needleSimp.length >= 6 && contentsList.length > 0) {
        for (const contents of contentsList) {
          const doc = contents.document;
          if (!doc) continue;
          const blocks = doc.querySelectorAll<HTMLElement>("p, div, li, h1, h2, h3, h4, h5, h6, blockquote, span");
          let foundEl: HTMLElement | null = null;
          for (const el of Array.from(blocks)) {
            const txt = onlyCjk(el.textContent || "");
            if (txt.includes(needleSimp) || (needleTrad !== needleSimp && txt.includes(needleTrad))) {
              foundEl = el; break;
            }
          }
          if (!foundEl) {
            // 调试：打印这个 contents 文档前 30 块的文本前缀，看实际 iframe 内容
            const sample = Array.from(blocks).slice(0, 5).map((b) => onlyCjk(b.textContent || "").slice(0, 20));
            console.info("[searchNav] EPUB no match (totalBlocks=" + blocks.length + ", sample blocks=", sample, ")");
            continue;
          }
          const el = foundEl;
          console.info("[searchNav] EPUB matched", el.tagName, "text=", (el.textContent || "").slice(0, 30));

          let cfi: string | null = null;
          try {
            const range = doc.createRange();
            range.selectNodeContents(el);
            if (typeof contents.cfiFromRange === "function") {
              cfi = contents.cfiFromRange(range) || null;
            }
          } catch (e) {
            console.warn("[searchNav] cfiFromRange threw", e);
          }
          if (!cfi && typeof contents.cfiFromNode === "function") {
            try { cfi = contents.cfiFromNode(el) || null; } catch (e) {
              console.warn("[searchNav] cfiFromNode threw", e);
            }
          }
          console.info("[searchNav] computed cfi:", cfi ? cfi.slice(0, 100) : "(null)");

          el.classList.add("search-flash");
          window.setTimeout(() => el.classList.remove("search-flash"), 1600);

          if (cfi) {
            rendition.display(cfi).then(() => {
              console.info("[searchNav] display(cfi) resolved");
              el.classList.add("search-flash");
              window.setTimeout(() => el.classList.remove("search-flash"), 1600);
              pendingSearchNavRef.current = null;
            }).catch((err: unknown) => {
              console.warn("[searchNav] display(cfi) failed:", err);
              const tmpId = "mingshi-search-target-anchor";
              el.id = tmpId;
              const loc = rendition.currentLocation?.() as { start?: { href?: string } } | null;
              const href = loc?.start?.href || pendingLocationTargetRef.current || forcedChapterTargetRef.current;
              console.info("[searchNav] fallback anchor approach href=", href);
              if (href) {
                rendition.display(`${href}#${tmpId}`).finally(() => {
                  pendingSearchNavRef.current = null;
                });
              } else {
                pendingSearchNavRef.current = null;
              }
            });
            return true;
          }

          console.info("[searchNav] no cfi computed, trying scrollIntoView");
          try { el.scrollIntoView({ block: "start" }); } catch { /* ignore */ }
          pendingSearchNavRef.current = null;
          return true;
        }
      } else if (needleSimp.length < 6) {
        console.info("[searchNav] needle too short (<6), can't text-match");
      } else if (contentsList.length === 0) {
        console.info("[searchNav] contentsList empty — rendition not ready");
      }
    } else if (!rendition) {
      console.info("[searchNav] no rendition (DB-reader path likely already returned, or both readers missing)");
    }

    target.attempts += 1;
    if (target.attempts > 10) {
      console.warn("[searchNav] giving up after 10 attempts");
      pendingSearchNavRef.current = null;
    }
    return false;
  }

  // 点搜索结果：跨书时先 switchBook 再跳章节；同本书直接跳。
  // 跳转到具体段落用 pendingSearchNavRef：chapter 加载完成后会被消费。
  async function navigateToSearchResult(result: SearchResult) {
    // 解析 paragraph_id：result.id 格式为 `${bookSlug}-${paragraph_id}`
    const lastDash = (result.id || "").lastIndexOf("-");
    const paragraphId = lastDash >= 0 ? parseInt(result.id.slice(lastDash + 1), 10) : NaN;
    if (Number.isFinite(paragraphId)) {
      pendingSearchNavRef.current = {
        paragraphId,
        text: result.text || (result.snippet || "").replace(/<[^>]+>/g, ""),
        attempts: 0,
      };
    }

    const targetSlug = result.bookSlug;
    const targetBook = readableBooks.find((b) => b.slug === (targetSlug || currentBookSlug));
    const needsBookSwitch = !!targetSlug && targetSlug !== currentBookSlug;

    if (needsBookSwitch) {
      await switchBook(targetSlug);
      // 跨书跳转 EPUB 必须在 switchBook 之后再设 initialLocationRef，
      // 因为 switchBook 内部会读 last-location:<slug> 并写入这个 ref，
      // 在它之前赋值会被覆盖掉，导致 rendition init 仍然用上次保存位置 →
      // 用户表现就是「第一次点跳到上次的章节，第二次才跳到目标章节」。
      if (targetBook?.hasEpub && result.chapterHref) {
        initialLocationRef.current = result.chapterHref;
      }
    }

    // DB-reader books: result.chapterOrder is the DB's chapter_order field, NOT
    // the 0-based array index that loadDbReaderChapter expects. Resolve to the
    // proper array index by looking up (label, rawOrder) in the chapter list.
    // For ming-shi-lu chapter_order starts at 0 so they happen to coincide;
    // for siku-mingshi etc they're off by one or more.
    async function resolveDbChapterIndex(): Promise<number | null> {
      if (typeof result.chapterOrder !== "number") return null;
      let chs = dbReaderChapters?.chapters;
      // After switchBook the closure still sees the OLD dbReaderChapters; fetch
      // fresh in that case.
      if (needsBookSwitch || !chs) {
        try {
          const data = await fetchReaderChapters(targetSlug || currentBookSlug);
          chs = data.chapters;
        } catch {
          chs = undefined;
        }
      }
      if (chs && chs.length > 0) {
        const idx = chs.findIndex(
          (c) =>
            (typeof c.rawOrder === "number" && c.rawOrder === result.chapterOrder) ||
            c.label === result.chapterTitle,
        );
        if (idx >= 0) return idx;
      }
      return result.chapterOrder;
    }

    // 同本书：手动触发章节加载（跨书时 switchBook 已处理 EPUB；
    // DB-reader 跨书只加载了 chapter 0，目标章节 != 0 时这里补一次）
    if (targetBook?.hasEpub === false && typeof result.chapterOrder === "number") {
      const arrayIndex = await resolveDbChapterIndex();
      if (typeof arrayIndex === "number") {
        requestAnimationFrame(() => { void loadDbReaderChapter(arrayIndex); });
      }
    } else if (result.chapterHref && !needsBookSwitch) {
      void openLocation(result.chapterHref);
    } else if (typeof result.chapterOrder === "number") {
      const arrayIndex = await resolveDbChapterIndex();
      if (typeof arrayIndex === "number") {
        requestAnimationFrame(() => { void loadDbReaderChapter(arrayIndex); });
      }
    }

    // 兜底：当跳转目标是同书同章节（state deps 不变），effect 不会再 fire，
    // 这里直接定时重试几次。每次成功后 scrollToSearchTarget 内部会清掉 ref。
    if (Number.isFinite(paragraphId)) {
      window.setTimeout(() => scrollToSearchTarget(), 200);
      window.setTimeout(() => scrollToSearchTarget(), 700);
      window.setTimeout(() => scrollToSearchTarget(), 1500);
      window.setTimeout(() => scrollToSearchTarget(), 3000);
    }
  }

  // v1.2 自由对话：load + save history。本地 localStorage 一份，最多保留 50 个会话。
  useEffect(() => {
    if (!hasLoadedLocalState) return;
    void readPersistedState<FreeChatHistory[]>(storageKey("free-chats"), []).then((list) => {
      setFreeChats(Array.isArray(list) ? list : []);
    });
  }, [hasLoadedLocalState]);

  useEffect(() => {
    if (!hasLoadedLocalState) return;
    void writePersistedState(storageKey("free-chats"), freeChats.slice(0, 50));
  }, [freeChats, hasLoadedLocalState]);

  function newFreeChat() {
    const id = (typeof crypto !== "undefined" && "randomUUID" in crypto) ? crypto.randomUUID() : `chat-${Date.now()}`;
    setActiveFreeChatId(id);
    setFreeChatInput("");
    setFreeChatError("");
    setFreeChatSourcesExpanded(false);
  }

  function deleteFreeChat(id: string) {
    setFreeChats((cur) => cur.filter((c) => c.id !== id));
    if (activeFreeChatId === id) setActiveFreeChatId(null);
  }

  function renameFreeChat(id: string, title: string) {
    setFreeChats((cur) => cur.map((c) => c.id === id ? { ...c, title, updatedAt: new Date().toISOString() } : c));
  }

  async function sendFreeChatMessage() {
    const text = freeChatInput.trim();
    if (!text) return;
    let chat = freeChats.find((c) => c.id === activeFreeChatId);
    // 没有 active session 时自动开新对话
    let id = activeFreeChatId;
    if (!chat || !id) {
      id = (typeof crypto !== "undefined" && "randomUUID" in crypto) ? crypto.randomUUID() : `chat-${Date.now()}`;
      chat = {
        id,
        title: text.slice(0, 30) || "新对话",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [],
        sources: [],
        sourceMode: "",
      };
      setActiveFreeChatId(id);
    }
    const userMsg: ConversationMessage = { role: "user", content: text };
    const newHistory: ConversationMessage[] = [...chat.messages, userMsg];
    const updated: FreeChatHistory = { ...chat, messages: newHistory, updatedAt: new Date().toISOString() };
    setFreeChats((cur) => {
      const i = cur.findIndex((c) => c.id === id);
      if (i >= 0) return cur.map((c, idx) => idx === i ? updated : c);
      return [updated, ...cur];
    });
    setFreeChatInput("");
    setFreeChatError("");
    setFreeChatLoading(true);
    try {
      // 若 freeChatModel 非空，覆盖 defaultModel；否则用全局默认
      const settingsForChat = freeChatModel
        ? { ...aiSettings, defaultModel: freeChatModel }
        : aiSettings;
      const resp = await runFreeConversation({ messages: newHistory, aiSettings: settingsForChat });
      const finalMessages = [...newHistory, { role: "assistant" as const, content: resp.assistant }];
      setFreeChats((cur) => cur.map((c) => c.id === id
        ? {
            ...c,
            messages: finalMessages,
            sources: resp.sources || [],
            sourceMode: resp.sourceMode || "",
            updatedAt: new Date().toISOString(),
            // 第一轮自动用首问的前 30 字当标题（如果还没改过）
            title: c.title === "新对话" || !c.title
              ? (finalMessages[0]?.content?.slice(0, 30) || "新对话")
              : c.title,
          }
        : c
      ));
    } catch (error) {
      setFreeChatError(error instanceof Error ? error.message : "AI 对话失败。");
      setFreeChats((cur) => cur.map((c) => c.id === id ? { ...c, messages: chat!.messages } : c));
      setFreeChatInput(text);
    } finally {
      setFreeChatLoading(false);
    }
  }

  // 人物列传：从传记索引中拉取该人物在 4 部纪传体的全部列传切片。
  async function loadPersonBiographies() {
    const q = personQuery.trim();
    if (!q) return;
    try {
      setBiographiesLoading(true);
      setConversationError("");
      const data = await fetchPersonBiographies(q);
      setPersonBiographies(data);
    } catch (error) {
      setConversationError(error instanceof Error ? error.message : "人物列传加载失败。");
    } finally {
      setBiographiesLoading(false);
    }
  }

  // AI 对话：发出一轮提问，前端保管 messages 历史，后端 stateless。
  async function sendConversationMessage() {
    const text = conversationInput.trim();
    const person = personQuery.trim();
    if (!text) return;
    const userMsg: ConversationMessage = { role: "user", content: text };
    const newHistory: ConversationMessage[] = [...conversationMessages, userMsg];
    setConversationMessages(newHistory);
    setConversationInput("");
    setConversationError("");
    setConversationLoading(true);
    try {
      const resp = await runPersonConversation({
        person,
        mode: conversationMode,
        messages: newHistory,
        aiSettings,
      });
      setConversationMessages([...newHistory, { role: "assistant", content: resp.assistant }]);
      setConversationSources(resp.sources || []);
      setConversationSourceMode(resp.sourceMode || "");
    } catch (error) {
      setConversationError(error instanceof Error ? error.message : "AI 对话失败。");
      // 把刚加的用户消息撤回，便于用户重试
      setConversationMessages(conversationMessages);
      setConversationInput(text);
    } finally {
      setConversationLoading(false);
    }
  }

  function resetConversation() {
    setConversationMessages([]);
    setConversationSources([]);
    setConversationSourceMode("");
    setConversationInput("");
    setConversationError("");
  }

  // Legacy chronology entry — UI 不再使用，仅保留以备旧 API 调用。
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async function _loadPersonChronology(useAi: boolean) {
    if (!personQuery.trim()) return;
    try {
      setPersonLoading(true);
      setAiError("");
      setPersonChronology(null);
      const response = useAi ? await fetchAiChronology(personQuery.trim(), aiSettings) : await fetchPersonChronology(personQuery.trim());
      startTransition(() => {
        setPersonChronology(response);
      });
    } catch (error) {
      setAiError(error instanceof Error ? error.message : "人物志加载失败。");
    } finally {
      setPersonLoading(false);
    }
  }
  void _loadPersonChronology;

  async function speakText(sourceText: string) {
    if (!sourceText.trim()) return;
    setAiError("");
    setTtsStatus("正在生成朗读…");

    // Always try server TTS first (server uses its own config)
    try {
      const blob = await synthesizeSpeech(sourceText, aiSettings);
      const url = URL.createObjectURL(blob);
      audioRef.current?.pause();
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => { setTtsStatus("朗读完成"); URL.revokeObjectURL(url); if (audioUrlRef.current === url) audioUrlRef.current = ""; };
      audio.onpause = () => { if (!audio.ended) setTtsStatus("朗读已暂停"); };
      await audio.play();
      setTtsStatus("正在播放朗读");
      return;
    } catch {
      // Fall through to browser TTS
    }

    // Browser fallback
    if (!("speechSynthesis" in window)) { setTtsStatus("当前环境不支持朗读"); return; }
    const utterance = new SpeechSynthesisUtterance(sourceText);
    utterance.lang = "zh-CN";
    utterance.rate = 0.95;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
    setTtsStatus("浏览器朗读中");
    utterance.onend = () => setTtsStatus("朗读完成");
  }

  function pauseOrResumeSpeech() {
    if (audioRef.current && !audioRef.current.paused) { audioRef.current.pause(); setTtsStatus("朗读已暂停"); return; }
    if (audioRef.current?.paused && !audioRef.current.ended) { void audioRef.current.play(); setTtsStatus("正在播放朗读"); return; }
    if ("speechSynthesis" in window && window.speechSynthesis.speaking && !window.speechSynthesis.paused) { window.speechSynthesis.pause(); setTtsStatus("朗读已暂停"); return; }
    if ("speechSynthesis" in window && window.speechSynthesis.paused) { window.speechSynthesis.resume(); setTtsStatus("浏览器朗读中"); }
  }

  function stopSpeech() {
    audioRef.current?.pause(); audioRef.current = null;
    if (audioUrlRef.current) { URL.revokeObjectURL(audioUrlRef.current); audioUrlRef.current = ""; }
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    setTtsStatus("");
  }

  function downloadTextFile(filename: string, content: string, mimeType = "text/markdown;charset=utf-8") {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function exportNotes() {
    const lines = [
      `# ${meta?.metadata.title || "明史"}阅读札记`,
      "",
      `导出时间：${new Date().toLocaleString("zh-CN")}`,
      "",
      ...notes.flatMap((note, index) => [
        `## ${index + 1}. ${formatTime(note.createdAt)}`,
        "",
        `原文：${note.text}`,
        "",
        `札记：${note.note}`,
        "",
        `位置：${note.cfiRange}`,
        "",
      ]),
    ];
    downloadTextFile("明史-阅读札记.md", lines.join("\n"));
  }

  function exportBookmarks() {
    const lines = [
      `# ${meta?.metadata.title || "明史"}书签`,
      "",
      `导出时间：${new Date().toLocaleString("zh-CN")}`,
      "",
      ...bookmarks.flatMap((bookmark, index) => [
        `## ${index + 1}. ${bookmark.label}`,
        "",
        `时间：${formatTime(bookmark.createdAt)}`,
        "",
        `章节 href：${bookmark.href || "未知"}`,
        "",
        `位置：${bookmark.cfi}`,
        "",
      ]),
    ];
    downloadTextFile("明史-书签.md", lines.join("\n"));
  }

  // 助理面板的勾画记录列表已在 v1.0 隐藏（导出按钮也随之拆除），但函数本身
  // 保留：将来如果再次给笔记/勾画面板装回 "导出摘录" 入口，可以直接复用。
  function exportHighlights() {
    const lines = [
      `# ${meta?.metadata.title || "明史"}阅读摘录`,
      "",
      `导出时间：${new Date().toLocaleString("zh-CN")}`,
      "",
      ...highlights.flatMap((highlight, index) => [
        `## ${index + 1}. ${highlight.kind === "underline" ? "下划线" : highlight.kind === "circle" ? "圈点" : "高亮"} · ${formatTime(highlight.createdAt)}`,
        "",
        highlight.text,
        "",
        `颜色：${highlight.color}`,
        "",
        `位置：${highlight.cfiRange}`,
        "",
      ]),
    ];
    downloadTextFile("明史-阅读摘录.md", lines.join("\n"));
  }
  void exportHighlights;

  function addCustomAction() {
    if (!newActionName.trim() || !newActionTemplate.trim()) return;
    const action: CustomAction = {
      id: crypto.randomUUID(),
      name: newActionName.trim(),
      systemPrompt: newActionSystem.trim() || "你是一名专注于《明史》阅读辅助的助手。",
      userTemplate: newActionTemplate.trim(),
    };
    const nextActions = [action, ...customActions];
    setCustomActions(nextActions);
    setAiSettings((current) => ({ ...current, customActions: nextActions }));
    setNewActionName("");
    setNewActionSystem("");
    setNewActionTemplate("");
  }

  const currentBook = readableBooks.find((b) => b.slug === currentBookSlug) || null;
  // Header line: "书名·作者 · 约 N 字"
  const readingStats = currentBook
    ? `《${currentBook.title}》·${currentBook.author || "佚名"} · 约 ${formatChars(currentBook.charCount || (meta?.stats.totalChars ?? 0))} 字`
    : meta
      ? `${meta.metadata.creator} · 约 ${formatChars(meta.stats.totalChars)} 字`
      : "";
  const hasSelection = Boolean(selectionText.trim());
  const selectionHighlight = selectionCfi
    ? highlights.find((item) => item.cfiRange === selectionCfi || (selectionText && item.text === selectionText))
    : null;
  const referenceQuery = referenceFilter.trim();
  const filteredInstitutions = officialsData?.institutions.filter((item) =>
    !referenceQuery
      ? true
      : `${item.name} ${item.aliases.join(" ")} ${item.rank} ${item.keywords.join(" ")} ${item.subunits.join(" ")}`.includes(referenceQuery)
  );
  return (
    <div className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${assistantCollapsed ? "assistant-collapsed" : ""}`}>
      {sidebarCollapsed && (
        <button type="button" className="sidebar-toggle-btn" onClick={() => setSidebarCollapsed(false)} title="展开侧边栏">
          <span className="hamburger-icon">&#9776;</span>
        </button>
      )}
      <aside className={`sidebar ${sidebarCollapsed ? "is-collapsed" : ""}`}>
        <div className="brand-card">
          <div className="brand-row">
            <div className="book-selector">
              <button
                type="button"
                className="book-selector-trigger"
                onClick={() => setBookMenuOpen((v) => !v)}
                disabled={bookSwitching}
                title="切换阅读书目"
              >
                <LibraryBig size={14} />
                <span className="book-selector-label">{currentBook?.title || "选择书目"}</span>
                <span className="book-selector-caret">▾</span>
              </button>
              {bookMenuOpen && (
                <div className="book-selector-menu" role="menu">
                  {/*
                    手工指定的书目顺序（v1.0 起）：明史(底本) → 实录 → 纪事本末
                    → 国榷 → 罪惟录 → 明通鉴 → 石匮书 → 石匮书后集 → 崇祯长编
                    → 三朝辽事实录 → 万历野获编 → 明季北略 → 明季南略
                    → 东林列传 → 国朝献征录 → 皇明经世文编 → 大明会典 → 大明律
                    → 天下郡国利病书 → 廿二史札记 → 菽园杂记 → 读通鉴论
                    → 明史(四库全书本)。不在此列表里的书目按原顺序排在最后。
                  */}
                  {(() => {
                    const ORDER = [
                      "ming-shi",
                      "ming-shi-lu",
                      "mingshi-jishi-benmo",
                      "guoque",
                      "zuiwei-lu",
                      "ming-tong-jian",
                      "shiku-shu",
                      "shiku-shu-houji",
                      "chongzhen-changbian",
                      "sanchao-liaoshi-shilu",
                      "wanli-yehuobian",
                      "mingji-beilue",
                      "mingji-nanlue",
                      "donglin-liezhuan",
                      "guochao-xianzhenlu",
                      "huangming-jingshi-wenbian",
                      "da-ming-hui-dian",
                      "da-ming-lv",
                      "tianxia-junguo-libingshu",
                      "nianer-shi-zhaji",
                      "shuyuan-zaji",
                      "du-tong-jian-lun",
                      "ming-shi-siku",
                    ];
                    const idx = (slug: string) => {
                      const i = ORDER.indexOf(slug);
                      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
                    };
                    const sorted = [...readableBooks].sort((a, b) => idx(a.slug) - idx(b.slug));
                    return sorted.map((book) => (
                      <button
                        key={book.slug}
                        type="button"
                        className={`book-selector-item ${book.slug === currentBookSlug ? "is-active" : ""}`}
                        onClick={() => void switchBook(book.slug)}
                        role="menuitem"
                      >
                        <div className="book-selector-item-title">
                          《{book.title}》
                          {book.hasEpub ? <span className="book-tag book-tag-epub">原典</span> : <span className="book-tag book-tag-db">检索</span>}
                        </div>
                        <div className="book-selector-item-meta">
                          {(book.author || "佚名")} · 约 {formatChars(book.charCount)} 字
                        </div>
                      </button>
                    ));
                  })()}
                </div>
              )}
            </div>
            <button type="button" className="ghost-button compact-button sidebar-collapse-btn" onClick={() => setSidebarCollapsed(true)} title="折叠侧边栏">
              &lsaquo;
            </button>
          </div>
          <h1>
            {"明史阅读器"}
            <button type="button" className="version-badge" onClick={() => setAboutOpen(true)}>v1.3.1</button>
          </h1>
          <span className="muted-text">{readingStats}</span>
        </div>

        <div className="tab-strip">
          {sidebarTabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.key}
                type="button"
                className={`tab-button ${activeTab === tab.key ? "is-active" : ""}`}
                onClick={() => setActiveTab(tab.key)}
              >
                <Icon size={16} />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>

        <div className="sidebar-panel">
          {activeTab === "toc" && (
            <div className="panel-scroll">
              <div className="panel-headline">
                <BookOpenText size={18} />
                <span>目录跳转</span>
              </div>
              <div className="toc-tree">
                {currentBook?.hasEpub === false ? (
                  // DB-reader chapter list — group by section prefix when chapters use "{section}/{name}" labels
                  (() => {
                    const chapters = dbReaderChapters?.chapters ?? [];
                    const useGrouping = chapters.some((c) => chapterSectionPrefix(c.label));
                    if (!useGrouping) {
                      return chapters.map((chapter) => (
                        <button
                          key={chapter.order}
                          type="button"
                          className={`toc-leaf ${chapter.order === dbReaderIndex ? "is-active" : ""}`}
                          onClick={() => void loadDbReaderChapter(chapter.order)}
                        >
                          {normalizeChapterLabel(chapter.label)}
                        </button>
                      ));
                    }
                    const groups = new Map<string, typeof chapters>();
                    for (const ch of chapters) {
                      const prefix = chapterSectionPrefix(ch.label) || "其他";
                      if (!groups.has(prefix)) groups.set(prefix, []);
                      groups.get(prefix)!.push(ch);
                    }
                    const activePrefix = chapters[dbReaderIndex] ? (chapterSectionPrefix(chapters[dbReaderIndex].label) || "其他") : "";
                    return [...groups.entries()].map(([section, items]) => (
                      <details key={section} className="toc-section" open={section === activePrefix}>
                        <summary className="toc-section-summary">{section}（{items.length}）</summary>
                        {items.map((chapter) => (
                          <button
                            key={chapter.order}
                            type="button"
                            className={`toc-leaf toc-leaf-sub ${chapter.order === dbReaderIndex ? "is-active" : ""}`}
                            onClick={() => void loadDbReaderChapter(chapter.order)}
                          >
                            {normalizeChapterLabel(chapter.label)}
                          </button>
                        ))}
                      </details>
                    ));
                  })()
                ) : (meta?.inPageToc?.length ?? 0) > 0
                  ? (meta?.inPageToc ?? []).map((item) => (
                      <TocNode key={item.href} item={item} onSelect={openLocation} />
                    ))
                  : (meta?.tocTree ?? []).map((item) => (
                      <TocNode key={item.href} item={item} onSelect={openLocation} />
                    ))}
              </div>
            </div>
          )}

          {activeTab === "search" && (
            <div className="panel-scroll">
              <div className="panel-headline">
                <Search size={18} />
                <span>全文搜索</span>
              </div>
              <div className="stack-gap">
                <textarea
                  className="text-input tall"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder={'输入关键词、句子，或用模糊意图搜索，例如\u300c朱元璋少年经历\u300d\u300c海禁相关记载\u300d'}
                />
                <div className="inline-actions">
                  <select value={searchMode} onChange={(event) => setSearchMode(event.target.value as "local" | "fuzzy" | "semantic")} className="select-input">
                    <option value="local">本地检索</option>
                    <option value="fuzzy">模糊检索</option>
                    <option value="semantic">语义检索（RAG）</option>
                  </select>
                  <label style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem", fontSize: "0.78rem" }}>
                    最多
                    <input
                      type="number"
                      min={1}
                      max={500}
                      step={10}
                      value={searchLimit}
                      onChange={(e) => {
                        const v = Number.parseInt(e.target.value, 10);
                        if (!Number.isNaN(v) && v > 0 && v <= 500) setSearchLimit(v);
                      }}
                      style={{ width: "4.5rem", padding: "0.18rem 0.3rem" }}
                    />
                    条
                  </label>
                  <button type="button" className="primary-button" onClick={handleSearch} disabled={searchLoading}>
                    {searchLoading ? "检索中…" : "开始搜索"}
                  </button>
                </div>
                {(searchMode === "local" || searchMode === "fuzzy") && (
                  <details
                    open={searchScopeOpen}
                    onToggle={(e) => setSearchScopeOpen((e.target as HTMLDetailsElement).open)}
                    style={{ background: "rgba(110,66,23,0.04)", border: "1px solid rgba(110,66,23,0.18)", borderRadius: 6, padding: "0.4rem 0.6rem" }}
                  >
                    <summary style={{ cursor: "pointer", fontSize: "0.78rem" }}>
                      检索范围：{searchSlugs.length === 0
                        ? `全部（${readableBooks.length} 部）`
                        : `${searchSlugs.length} / ${readableBooks.length} 部`}
                    </summary>
                    <div className="inline-actions" style={{ flexWrap: "wrap", gap: "0.3rem", marginTop: "0.5rem" }}>
                      <button
                        type="button"
                        className={`ghost-button compact-button ${searchSlugs.length === 0 ? "is-active" : ""}`}
                        style={searchSlugs.length === 0 ? { background: "rgba(110,66,23,0.16)", borderColor: "rgba(110,66,23,0.22)" } : {}}
                        onClick={() => setSearchSlugs([])}
                      >
                        全部
                      </button>
                      {readableBooks.map((book) => {
                        const checked = searchSlugs.includes(book.slug);
                        return (
                          <button
                            key={book.slug}
                            type="button"
                            className={`ghost-button compact-button ${checked ? "is-active" : ""}`}
                            style={checked ? { background: "rgba(110,66,23,0.16)", borderColor: "rgba(110,66,23,0.22)" } : {}}
                            onClick={() => {
                              setSearchSlugs((prev) => {
                                if (prev.includes(book.slug)) {
                                  return prev.filter((s) => s !== book.slug);
                                }
                                return [...prev, book.slug];
                              });
                            }}
                          >
                            {book.title}
                          </button>
                        );
                      })}
                    </div>
                  </details>
                )}
                {searchError && <div className="error-box">{searchError}</div>}
                {searchResponse?.aiExpansion?.note && <div className="info-box">{searchResponse.aiExpansion.note}</div>}
                {searchResponse && (
                  <div className="stack-gap">
                    <div className="muted-text">
                      命中 {searchResponse.total} 条，扩展词：
                      {searchResponse.expandedQueries.join("、")}
                    </div>
                    <div className="result-list">
                      {searchResponse.results.map((result) => (
                        <button
                          key={result.id}
                          type="button"
                          className="result-card"
                          onClick={() => void navigateToSearchResult(result)}
                        >
                          <div className="result-title">
                            {result.bookTitle && (
                              <span className="muted-text" style={{ fontSize: "0.72rem", marginRight: "0.4rem" }}>《{result.bookTitle}》</span>
                            )}
                            {result.chapterTitle}
                          </div>
                          <div className="result-snippet">{result.snippet}</div>
                          {result.years.length > 0 && (
                            <div className="tag-row">
                              {result.years.slice(0, 3).map((year) => (
                                <span key={`${result.id}-${year.text}`} className="soft-tag">
                                  {year.text} → {year.gregorian}
                                </span>
                              ))}
                            </div>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === "notes" && (
            <div className="panel-scroll">
              <div className="panel-headline">
                <FilePenLine size={18} />
                <span>随笔札记</span>
                <div className="header-actions">
                  <button type="button" className="ghost-button compact-button" onClick={exportNotes} disabled={!notes.length}>
                    <Download size={15} />
                    导出
                  </button>
                </div>
              </div>
              <div className="stack-gap compact" style={{ marginBottom: "0.6rem" }}>
                <label className="field-label">
                  排序
                  <select className="select-input" value={notesSort} onChange={(e) => setNotesSort(e.target.value as typeof notesSort)}>
                    <option value="created-desc">按札记时间（新→旧）</option>
                    <option value="created-asc">按札记时间（旧→新）</option>
                    <option value="historical-asc">按历史时间（早→晚）</option>
                    <option value="historical-desc">按历史时间（晚→早）</option>
                    <option value="book">按书目分组</option>
                  </select>
                </label>
                <div className="inline-actions" style={{ flexWrap: "wrap", gap: "0.3rem" }}>
                  <input
                    type="number"
                    className="text-input"
                    style={{ flex: 1, minWidth: "5rem" }}
                    placeholder="历史年起"
                    value={notesYearMin}
                    onChange={(e) => setNotesYearMin(e.target.value)}
                  />
                  <input
                    type="number"
                    className="text-input"
                    style={{ flex: 1, minWidth: "5rem" }}
                    placeholder="历史年止"
                    value={notesYearMax}
                    onChange={(e) => setNotesYearMax(e.target.value)}
                  />
                </div>
                <div className="inline-actions" style={{ flexWrap: "wrap", gap: "0.3rem" }}>
                  <input
                    type="date"
                    className="text-input"
                    style={{ flex: 1, minWidth: "8rem" }}
                    value={notesCreatedMin}
                    onChange={(e) => setNotesCreatedMin(e.target.value)}
                    title="札记时间下限"
                  />
                  <input
                    type="date"
                    className="text-input"
                    style={{ flex: 1, minWidth: "8rem" }}
                    value={notesCreatedMax}
                    onChange={(e) => setNotesCreatedMax(e.target.value)}
                    title="札记时间上限"
                  />
                </div>
              </div>
              <div className="result-list">
                {(() => {
                  // Filter
                  const minY = notesYearMin ? parseInt(notesYearMin, 10) : null;
                  const maxY = notesYearMax ? parseInt(notesYearMax, 10) : null;
                  const minC = notesCreatedMin ? new Date(notesCreatedMin).getTime() : null;
                  const maxC = notesCreatedMax ? new Date(notesCreatedMax).getTime() + 24 * 3600 * 1000 : null;
                  let list = notes.filter((n) => {
                    if (minY != null || maxY != null) {
                      const y = n.historicalYear;
                      if (y == null) return false;
                      if (minY != null && y < minY) return false;
                      if (maxY != null && y > maxY) return false;
                    }
                    if (minC != null || maxC != null) {
                      const t = new Date(n.createdAt).getTime();
                      if (minC != null && t < minC) return false;
                      if (maxC != null && t > maxC) return false;
                    }
                    return true;
                  });
                  // Sort
                  if (notesSort === "created-desc") list = [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
                  else if (notesSort === "created-asc") list = [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
                  else if (notesSort === "historical-asc") list = [...list].sort((a, b) => (a.historicalYear ?? 9999) - (b.historicalYear ?? 9999));
                  else if (notesSort === "historical-desc") list = [...list].sort((a, b) => (b.historicalYear ?? -9999) - (a.historicalYear ?? -9999));
                  else if (notesSort === "book") {
                    list = [...list].sort((a, b) => (a.bookSlug || "").localeCompare(b.bookSlug || "") || b.createdAt.localeCompare(a.createdAt));
                  }

                  if (list.length === 0) return <div className="empty-state">先在正文里选段，再点"札记"。</div>;
                  // For "book" sort, render group headers
                  const groupedByBook = notesSort === "book";
                  const out: React.ReactNode[] = [];
                  let lastBook = "";
                  for (const note of list) {
                    if (groupedByBook && note.bookSlug !== lastBook) {
                      lastBook = note.bookSlug || "";
                      const bookTitle = readableBooks.find((b) => b.slug === lastBook)?.title || lastBook || "（未指定书目）";
                      out.push(
                        <div key={`group-${lastBook}`} className="muted-text" style={{ padding: "0.4rem 0", fontSize: "0.78rem", fontWeight: 600 }}>
                          《{bookTitle}》
                        </div>,
                      );
                    }
                    const isExpanded = expandedNoteId === note.id;
                    // 「史料交叉比对」生成的札记 note 是一整段 Markdown（含 ## 标题、表格、加粗等），
                    // 直接当纯文本渲染会一团乱。识别后用 renderMarkdown 渲染。
                    const isCrossCompareNote = note.note.startsWith("【史料交叉比对】");
                    const previewSource = isCrossCompareNote
                      ? note.note.replace(/^【史料交叉比对】\s*/, "").replace(/[#*`>|\-]/g, " ").replace(/\s+/g, " ").trim()
                      : note.note;
                    const preview = previewSource.length > 30 ? previewSource.slice(0, 30) + "…" : previewSource;
                    out.push(
                      <div key={note.id} className="result-card static-card">
                        <button type="button" className="note-summary-row" onClick={() => setExpandedNoteId(isExpanded ? null : note.id)}>
                          <span className="note-time">{formatTime(note.createdAt)}</span>
                          <span className="note-preview">{isCrossCompareNote ? `【交叉比对】${preview}` : preview}</span>
                          <span className="note-expand-icon">{isExpanded ? "▾" : "▸"}</span>
                        </button>
                        {note.historicalAt && (
                          <div className="muted-text" style={{ fontSize: "0.7rem", padding: "0 0.6rem 0.2rem" }}>
                            史时：{note.historicalAt}
                          </div>
                        )}
                        {isExpanded && (
                          <div className="note-detail">
                            <div className="note-source-block">
                              <div className="note-source-label">原选段 · 勾画位置</div>
                              <div className="note-source-text">{note.text || "（未记录原选段位置）"}</div>
                            </div>
                            <div className="note-content-frame">
                              {isCrossCompareNote ? (
                                <div
                                  className="markdown-body note-md-compact"
                                  dangerouslySetInnerHTML={{ __html: renderMarkdown(note.note.replace(/^【史料交叉比对】\s*/, "")) }}
                                />
                              ) : (
                                <div className="note-body">{note.note}</div>
                              )}
                            </div>
                            <div className="inline-actions" style={{ flexWrap: "wrap", gap: "0.3rem" }}>
                              <button type="button" className="ghost-button" onClick={() => openLocation(note.cfiRange)}>回到原文</button>
                              {isCrossCompareNote && (
                                <button type="button" className="ghost-button" onClick={() => setNoteExpandedFor(note.id)}>展开</button>
                              )}
                              <button type="button" className="ghost-button" onClick={() => { setEditingNoteId(note.id); setNoteDraft(note.note); setNoteComposerOpen(true); }}>编辑</button>
                              {/* 一键切换 在时间线显示，无需进 编辑 弹窗 */}
                              <button
                                type="button"
                                className="ghost-button"
                                onClick={() => {
                                  setNotes((cur) => cur.map((it) => it.id === note.id ? { ...it, inTimeline: !it.inTimeline } : it));
                                }}
                                title={note.inTimeline ? "从历史时间线中隐藏" : "在历史时间线中显示"}
                              >
                                {note.inTimeline ? "从历史时间线隐藏" : "加入历史时间线"}
                              </button>
                              <button type="button" className="ghost-button danger" onClick={() => { setNotes((current) => current.filter((item) => item.id !== note.id)); setExpandedNoteId(null); }}>删除</button>
                            </div>
                          </div>
                        )}
                      </div>,
                    );
                  }
                  return out;
                })()}
              </div>
            </div>
          )}

          {activeTab === "bookmarks" && (
            <div className="panel-scroll">
              <div className="panel-headline">
                <BookMarked size={18} />
                <span>书签</span>
              </div>
              <div className="stack-gap compact">
                <input
                  className="text-input"
                  value={bookmarkNameDraft}
                  onChange={(event) => setBookmarkNameDraft(event.target.value)}
                  placeholder="书签名称（可选，默认使用章节名）"
                />
                <div className="inline-actions">
                  <button type="button" className="primary-button" onClick={createBookmark}>
                    记录当前位置
                  </button>
                  <button type="button" className="ghost-button" onClick={exportBookmarks} disabled={!bookmarks.length}>
                    <Download size={15} />
                    导出
                  </button>
                </div>
              </div>
              <div className="result-list">
                {bookmarks.length === 0 && <div className="empty-state">还没有书签。</div>}
                {bookmarks.map((item) => (
                  <div key={item.id} className="result-card static-card">
                    <div className="result-title">{item.label}</div>
                    <div className="muted-text">{formatTime(item.createdAt)}</div>
                    <div className="inline-actions">
                      <button type="button" className="ghost-button" onClick={() => openLocation(item.cfi)}>
                        打开
                      </button>
                      <button
                        type="button"
                        className="ghost-button danger"
                        onClick={() => setBookmarks((current) => current.filter((bookmark) => bookmark.id !== item.id))}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === "people" && (
            <div className="panel-scroll">
              <div className="panel-headline">
                <LibraryBig size={18} />
                <span>辅助资料</span>
              </div>
              <div className="resource-button-list">
                <button type="button" className="resource-entry-button" onClick={() => setOpenResourcePanel("free-chat")}>
                  <Search size={16} />
                  <span>AI 对话</span>
                </button>
                <button type="button" className="resource-entry-button" onClick={() => setOpenResourcePanel("chronology")}>
                  <UserRound size={16} />
                  <span>人物志</span>
                </button>
                <button type="button" className="resource-entry-button" onClick={() => setOpenResourcePanel("reign")}>
                  <Calculator size={16} />
                  <span>历史计算器</span>
                </button>
                <button type="button" className="resource-entry-button" onClick={() => setOpenResourcePanel("officials")}>
                  <Landmark size={16} />
                  <span>职官/世系</span>
                </button>
                <button type="button" className="resource-entry-button" onClick={() => setOpenResourcePanel("map")}>
                  <MapPinned size={16} />
                  <span>古今地名地图</span>
                </button>
                <button type="button" className="resource-entry-button" onClick={() => setOpenResourcePanel("history-timeline")}>
                  <History size={16} />
                  <span>历史时间线</span>
                </button>
              </div>
            </div>
          )}

          {activeTab === "settings" && (
            <div className="panel-scroll">
              <div className="panel-headline">
                <Settings2 size={18} />
                <span>AI 与阅读设置</span>
              </div>
              <div className="stack-gap">
                <label className="field-label">
                  主模型
                  <select className="select-input" value={aiSettings.model} onChange={(e) => setAiSettings((c) => ({ ...c, model: e.target.value }))}>
                    {aiSettings.modelOptions.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                </label>
                <label className="field-label">
                  小模型
                  <select className="select-input" value={aiSettings.smallModel || ""} onChange={(e) => setAiSettings((c) => ({ ...c, smallModel: e.target.value }))}>
                    {(aiSettings.smallModelOptions || []).map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                </label>
                <label className="field-label">
                  语音风格
                  <select className="select-input" value={aiSettings.ttsVoice || "Ryan"} onChange={(e) => setAiSettings((c) => ({ ...c, ttsVoice: e.target.value }))}>
                    <optgroup label="百炼 qwen3-tts">
                      <option value="Ryan">Ryan（阳刚男声）</option>
                      <option value="Ethan">Ethan（沉稳男声）</option>
                      <option value="Cherry">Cherry（温柔女声）</option>
                      <option value="Serena">Serena（知性女声）</option>
                      <option value="Bella">Bella（优雅女声）</option>
                      <option value="Chelsie">Chelsie（活泼女声）</option>
                    </optgroup>
                  </select>
                </label>
                <button type="button" className="secondary-button" onClick={() => setApiConfigOpen(true)}>
                  自定义 API 配置
                </button>
                <div className="inline-actions">
                  <label className="toggle-row">
                    <input
                      type="checkbox"
                      checked={autoAnnotate}
                      onChange={(event) => setAutoAnnotate(event.target.checked)}
                    />
                    <span>自动标注明代年号与公元对照</span>
                  </label>
                  <label className="toggle-row">
                    <input
                      type="checkbox"
                      checked={promptSupplementEnabled}
                      onChange={(event) => setPromptSupplementEnabled(event.target.checked)}
                    />
                    <span>AI 操作前弹出补充说明提示</span>
                  </label>
                </div>
                <label className="field-label">
                  正文字体转换
                  <select className="select-input" value={scriptVariant} onChange={(event) => setScriptVariant(event.target.value as "simplified" | "traditional")}>
                    <option value="simplified">保留原文</option>
                    <option value="traditional">转换为繁体</option>
                  </select>
                </label>
                <label className="field-label">
                  界面字体转换
                  <select className="select-input" value={uiScriptVariant} onChange={(event) => setUiScriptVariant(event.target.value as "simplified" | "traditional")}>
                    <option value="simplified">简体</option>
                    <option value="traditional">繁体</option>
                  </select>
                </label>
                {/* 「虚拟翻页分栏」设置 v1.0.2 起隐藏：双栏在窄屏 / 高字号 +
                    长行时容易把段落截到栏外、挤压可读性。state（pageSpread /
                    setPageSpread）和持久化保留，将来要再 expose 直接把这段
                    label 放回来即可。 */}
                <div className="divider" />
                <div className="panel-headline small">
                  <Highlighter size={14} />
                  <span>页面外观</span>
                </div>
                <label className="field-label">
                  阅读主题
                  <select className="select-input" value={readerTheme} onChange={(e) => setReaderTheme(e.target.value as "default" | "sepia" | "dark" | "green")}>
                    <option value="default">默认（米白）</option>
                    <option value="sepia">古籍米黄</option>
                    <option value="dark">夜间</option>
                    <option value="green">护眼绿</option>
                  </select>
                </label>
                {/*
                  字体下拉顺序按用户指定：
                    系统宋体 / 系统仿宋
                    京华老宋 / 汇文仿宋 / 汇文正楷 / 汇文明朝 / 霞鹜文楷
                    方正永乐大典 / 方正瘦金 / 方正礼器碑
                  正文字体默认 mingchao（汇文明朝），界面字体默认 zhengkai（汇文正楷）
                */}
                <label className="field-label">
                  正文字体
                  <select
                    className="select-input"
                    value={readerFontFamily}
                    onChange={(e) => setReaderFontFamily(e.target.value as typeof readerFontFamily)}
                  >
                    <option value="system-songti">系统宋体</option>
                    <option value="system-fangsong">系统仿宋</option>
                    <option value="songti">宋體（京华老宋·内置）</option>
                    <option value="fangsong">仿宋（匯文仿宋·内置）</option>
                    <option value="zhengkai">正楷（匯文正楷·内置）</option>
                    <option value="mingchao">明體（匯文明朝·内置）</option>
                    <option value="xiawu">霞鹜文楷（内置）</option>
                    <option value="kaiti">楷體（方正永樂大典·内置）</option>
                    <option value="shoujin">瘦金（方正瘦金·内置）</option>
                    <option value="lishu">漢隸（方正禮器碑·内置）</option>
                  </select>
                </label>
                <label className="field-label">
                  界面字体
                  <select
                    className="select-input"
                    value={uiFontFamily}
                    onChange={(e) => setUiFontFamily(e.target.value as typeof uiFontFamily)}
                  >
                    <option value="system-songti">系统宋体</option>
                    <option value="system-fangsong">系统仿宋</option>
                    <option value="songti">宋體（京华老宋·内置）</option>
                    <option value="fangsong">仿宋（匯文仿宋·内置）</option>
                    <option value="zhengkai">正楷（匯文正楷·内置）</option>
                    <option value="mingchao">明體（匯文明朝·内置）</option>
                    <option value="xiawu">霞鹜文楷（内置）</option>
                    <option value="kaiti">楷體（方正永樂大典·内置）</option>
                    <option value="shoujin">瘦金（方正瘦金·内置）</option>
                    <option value="lishu">漢隸（方正禮器碑·内置）</option>
                  </select>
                </label>
                <label className="field-label">
                  字号 {readerFontSize}px
                  <input
                    type="range"
                    min={13}
                    max={28}
                    step={1}
                    value={readerFontSize}
                    onChange={(e) => setReaderFontSize(Number(e.target.value))}
                  />
                </label>
                <label className="field-label">
                  日期显示
                  <select className="select-input" value={dateDisplay} onChange={(e) => setDateDisplay(e.target.value as "gregorian" | "lunar" | "both")}>
                    <option value="lunar">仅农历</option>
                    <option value="gregorian">仅公历</option>
                    <option value="both">公历 + 农历</option>
                  </select>
                </label>
                <label className="toggle-row">
                  <input type="checkbox" checked={showEmperor} onChange={(e) => setShowEmperor(e.target.checked)} />
                  <span>气泡 / 模态显示在位皇帝（如 明英宗朱祁镇）</span>
                </label>
                <label className="toggle-row">
                  <input type="checkbox" checked={keyboardPagingEnabled} onChange={(e) => setKeyboardPagingEnabled(e.target.checked)} />
                  <span>键盘 ← → 翻页（默认关；开后阅读区无需手动点边缘）</span>
                </label>
                <div className="field-label" style={{ borderTop: "1px solid var(--ui-panel-border)", paddingTop: "0.5rem", marginTop: "0.3rem" }}>
                  <strong style={{ fontSize: "0.85rem" }}>标记模式（v1.2）</strong>
                  <div className="muted-text" style={{ fontSize: "0.72rem", marginTop: "0.2rem" }}>
                    在页头工具栏点「标记」按钮启用后，选段结束直接按下方配色 / 形态打标，不再弹工具栏。Cmd/Ctrl+Z 撤销最近一次。
                  </div>
                </div>
                <label className="field-label">
                  默认勾画样式
                  <select className="select-input" value={markStyle} onChange={(e) => setMarkStyle(e.target.value as "h-gold" | "h-jade" | "h-crimson" | "underline" | "circle")}>
                    <option value="h-gold">高亮 · 金笺（深黄）</option>
                    <option value="h-jade">高亮 · 青玉（深绿）</option>
                    <option value="h-crimson">高亮 · 绛纱（深红）</option>
                    <option value="underline">下划线（正红）</option>
                    <option value="circle">圈点（正红字下圆点）</option>
                  </select>
                </label>
                <label className="field-label">
                  字色（留空则跟随主题）
                  <div className="inline-actions">
                    <input
                      type="color"
                      value={readerFontColor || "#1f160f"}
                      onChange={(e) => setReaderFontColor(e.target.value)}
                      style={{ width: 48, height: 32, padding: 0, border: "none", background: "transparent" }}
                    />
                    <button type="button" className="ghost-button compact-button" onClick={() => setReaderFontColor("")}>重置</button>
                  </div>
                </label>
                <button type="button" className="secondary-button" onClick={() => setOpenResourcePanel("custom-actions")}>
                  自定义 AI 操作（{customActions.length} 个）
                </button>
                <div className="divider" />
                <button type="button" className="primary-button full-width" onClick={() => {
                  // Force save all settings to localStorage then reload
                  void writePersistedState(storageKey("ai-settings"), aiSettings);
                  void writePersistedState(storageKey("auto-annotate"), autoAnnotate);
                  void writePersistedState(storageKey("script-variant"), scriptVariant);
                  void writePersistedState(storageKey("page-spread"), pageSpread);
                  void writePersistedState(storageKey("custom-actions"), customActions);
                  // Clear browser caches and reload
                  if ("caches" in window) {
                    caches.keys().then(keys => keys.forEach(k => caches.delete(k)));
                  }
                  window.setTimeout(() => window.location.reload(), 200);
                }}>
                  保存设置并刷新页面
                </button>
              </div>
            </div>
          )}
        </div>
      </aside>

      <main className="reader-column">
        <header className="reader-toolbar">
          {currentBook?.hasEpub === false ? (
            <>
              <div>
                <div className="current-label">{normalizeChapterLabel(dbReaderChapter?.chapter || dbReaderChapters?.title || "载入中…")}</div>
                <div className="muted-text">
                  第 {dbReaderIndex + 1}/{dbReaderChapters?.chapters.length || "?"} 章 · 本章 {dbPageIndex + 1}/{dbPageTotal} 页 · {currentBook?.author || dbReaderChapters?.author || ""}
                </div>
              </div>
              <div className="toolbar-actions">
                <button type="button" className="ghost-button" onClick={() => flipDbPage(-1)} disabled={dbPageIndex <= 0}>
                  上一页
                </button>
                <button type="button" className="ghost-button" onClick={() => flipDbPage(1)} disabled={dbPageIndex >= dbPageTotal - 1}>
                  下一页
                </button>
                <button type="button" className="ghost-button" disabled={dbReaderIndex <= 0 || dbReaderLoading} onClick={() => void loadDbReaderChapter(dbReaderIndex - 1)}>
                  上一章
                </button>
                <button type="button" className="ghost-button" disabled={!dbReaderChapters || dbReaderIndex >= (dbReaderChapters.chapters.length - 1) || dbReaderLoading} onClick={() => void loadDbReaderChapter(dbReaderIndex + 1)}>
                  下一章
                </button>
              </div>
            </>
          ) : (
            <>
              <div>
                <div className="current-label">{currentSectionLabel || meta?.metadata.title || "载入中…"}</div>
                <div className="muted-text">
                  第 {currentChapterIndex + 1}/{meta?.stats.chapterCount || "?"} 章 · 本章 {chapterPageCurrent}/{chapterPageTotal} 页 · {meta?.metadata.creator}
                </div>
              </div>
              <div className="toolbar-actions">
                <button type="button" className="ghost-button" onClick={goPrevPage}>
                  上一页
                </button>
                <button type="button" className="ghost-button" onClick={goNextPage}>
                  下一页
                </button>
                <button type="button" className="ghost-button" onClick={createBookmark}>
                  <Bookmark size={16} />
                  书签
                </button>
                <button
                  type="button"
                  className={`ghost-button ${markModeEnabled ? "is-active-mode" : ""}`}
                  onClick={() => setMarkModeEnabled((v) => !v)}
                  title="标记模式（v1.2）：开启后选段直接按默认配色打标，Cmd+Z 撤销。颜色/形态在设置 → 默认勾画 里调。"
                  style={markModeEnabled ? { background: "rgba(212, 35, 27, 0.15)", borderColor: "rgba(212, 35, 27, 0.4)" } : undefined}
                >
                  <Highlighter size={16} />
                  {markModeEnabled ? "标记中" : "标记"}
                </button>
              </div>
            </>
          )}
        </header>

        <section className="reader-card">
          {loadingBoot && <div className="overlay-message">正在载入书籍与本地资料…</div>}
          {bootError && <div className="overlay-message error-box">{bootError}</div>}
          {bookSwitching && <div className="overlay-message">切换书目中…</div>}
          {currentBook?.hasEpub === false ? (
            <>
              <div className="db-reader-host" ref={dbReaderHostRef} onMouseUp={handleDbReaderSelection}>
                {dbReaderLoading && <div className="overlay-message">载入章节…</div>}
                {dbReaderChapter ? (
                  <article className="db-reader-article">
                    <h2 className="db-reader-chapter-title">{normalizeChapterLabel(dbReaderChapter.chapter)}</h2>
                    {dbReaderChapter.paragraphs.map((p) => (
                      <p key={p.id} className="db-reader-paragraph" data-paragraph-id={p.id}>{p.content}</p>
                    ))}
                  </article>
                ) : (!dbReaderLoading && <div className="overlay-message muted-text">无内容</div>)}
              </div>
              {/* page-turn-zone must be a SIBLING of the scroll host (not a
                  child), otherwise on pages with scrollLeft>0 they ride along
                  with the scrolled content and slide out of the viewport,
                  which makes edge-click flip break after page 1. */}
              <div className="page-turn-zone page-turn-left" onClick={() => flipDbPage(-1)} />
              <div className="page-turn-zone page-turn-right" onClick={() => flipDbPage(1)} />
            </>
          ) : (
            <>
              <div ref={readerHostRef} className="reader-host" />
              <div className="page-turn-zone page-turn-left" onClick={goPrevPage} />
              <div className="page-turn-zone page-turn-right" onClick={goNextPage} />
            </>
          )}
        </section>

        <footer className="reader-footer">
          {currentBook?.hasEpub === false ? (
            <input
              type="range"
              min={1}
              max={Math.max(1, dbPageTotal)}
              step={1}
              value={dbPageIndex + 1}
              onChange={(event) => jumpDbPage(Number.parseInt(event.target.value, 10) - 1)}
            />
          ) : (
            <input
              type="range"
              min={1}
              max={chapterPageTotal}
              step={1}
              value={chapterPageCurrent}
              onChange={(event) => {
                const targetPage = Number.parseInt(event.target.value, 10);
                jumpToPage(targetPage);
              }}
            />
          )}
          <div className="footer-meta">
            <span>当前位置已自动保存{locationsReady ? "" : " · 正在生成章节定位映射"}</span>
            <span>{ttsStatus || "AI / 浏览器朗读已就绪"}</span>
          </div>
        </footer>
      </main>

      {assistantCollapsed && (
        <button type="button" className="assistant-toggle-btn" onClick={() => setAssistantCollapsed(false)} title="展开助理面板">
          <span className="hamburger-icon">&#9776;</span>
        </button>
      )}
      <aside className={`assistant-panel ${assistantCollapsed ? "is-collapsed" : ""}`}>
        <div className="assistant-scroll">
          <div className="panel-headline">
            <Brain size={18} />
            <span>阅读助理</span>
            <div className="header-actions">
              <button type="button" className="ghost-button compact-button" onClick={() => setAssistantCollapsed(true)} title="折叠助理面板">&rsaquo;</button>
            </div>
          </div>
          <div className="selection-card">
            <div className="selection-title" style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
              <span>当前选段{pinnedSegments.length > 0 && <span className="muted-text" style={{ fontSize: "0.72rem", marginLeft: "0.4rem" }}>（已累积 {pinnedSegments.length + 1} 段）</span>}</span>
              {/* 「保留」累积开关 — 默认关；开启后新选段不替换旧选段，而是追加。
                  用以解决 EPUB / DB-reader 跨页跨章选段无法被一次 OS-level
                  selection 覆盖的问题。开关关掉 / 「清空」按钮 都会清光 buffer。 */}
              <label className="toggle-row" style={{ marginLeft: "auto", fontSize: "0.72rem", gap: "0.3rem" }} title="开启后新选段不清空旧选段，而是接在后面；AI/札记/勾画等动作对累积后的整段生效。关掉或点清空才会重置。">
                <input
                  type="checkbox"
                  checked={accumulateMode}
                  onChange={(e) => {
                    const on = e.target.checked;
                    setAccumulateMode(on);
                    if (!on) setPinnedSegments([]); // 关掉 → 清光累积 buffer
                  }}
                />
                <span>保留</span>
              </label>
              {(hasSelection || pinnedSegments.length > 0) && (
                <button
                  type="button"
                  className="ghost-button compact-button"
                  style={{ fontSize: "0.72rem" }}
                  onClick={clearSelectionAndPinned}
                  title="清空当前选段（含已累积段）"
                >
                  清空
                </button>
              )}
            </div>
            <div className="selection-body">
              {pinnedSegments.length > 0 && (
                <div style={{ marginBottom: "0.4rem" }}>
                  {pinnedSegments.map((s, i) => (
                    <div key={i} className="muted-text" style={{ fontSize: "0.78rem", padding: "0.15rem 0", borderLeft: "2px solid rgba(110,66,23,0.18)", paddingLeft: "0.5rem" }}>
                      <span style={{ opacity: 0.6 }}>#{i + 1} </span>{s.text}
                    </div>
                  ))}
                </div>
              )}
              {selectionText
                ? (pinnedSegments.length > 0
                    ? <div style={{ borderLeft: "2px solid #d4231b", paddingLeft: "0.5rem" }}><span className="muted-text" style={{ fontSize: "0.78rem", opacity: 0.7 }}>#{pinnedSegments.length + 1}（最新）</span><div>{selectionText}</div></div>
                    : selectionText)
                : "在正文中选中一段内容后，可在悬浮工具栏中一键翻译、标音、解释、做札记或进行史料比对。"}
            </div>
            {/*
              v1.0 起隐藏「当前选段」卡片下方的 7 个 action 按钮（现代文 /
              读音 / 解释 / 百科 / 史料比对 / AI 句读 / 札记）—— 它们与
              悬浮选段工具栏（在 selection-overlay.visible 时显示）的入口
              重复，而工具栏本来就贴着选段位置弹出，更顺手。自定义 AI 操作
              的 secondary-button 同此理，跟着隐藏。
            */}
          </div>

          {/* v1.2.1：右侧「直接提问」已被左侧「资料 → AI 对话」面板取代（多轮 + 本地存档 + 模型自选）。
              输入框 / 按钮隐藏，相关后端端点 /api/ai/action?type=qa 保留以备 selection-based 问答场景。 */}

          {aiError && <div className="error-box">{aiError}</div>}
          {referenceError && <div className="error-box">{referenceError}</div>}

          {(aiLoading || aiResponse) && (
          <div className="answer-panel">
            <div className="panel-headline small">
              <Sparkles size={16} />
              <span>{aiPanelTitle}</span>
            </div>
            {aiPanelTitle === "AI 句读" && !aiLoading && aiResponse?.answer ? (
              // 标注规范：读号 (，、；：) → 实心红圆，句号 (。！？) → 空心红圆。
              // 标点字符自身不渲染；前一个汉字下方加圆点（古书圈点样式）。
              // 仅在右栏展示，不入笔记 / 勾画。
              (() => {
                const PUNCT = /[·。，；：！？、]/;
                const SENTENCE_END = /[。！？]/;
                const chars = aiResponse.answer.match(/[\s\S]/g) || [];
                const out: React.ReactNode[] = [];
                for (let i = 0; i < chars.length; i++) {
                  const ch = chars[i];
                  if (PUNCT.test(ch)) continue; // hide marker
                  const next = chars[i + 1] || "";
                  if (PUNCT.test(next)) {
                    const cls = SENTENCE_END.test(next) ? "dudou-char dudou-break dudou-strong" : "dudou-char dudou-break";
                    out.push(<span key={i} className={cls}>{ch}</span>);
                  } else {
                    out.push(<span key={i} className="dudou-char">{ch}</span>);
                  }
                }
                return <div className="answer-card dudou-card">{out}</div>;
              })()
            ) : (
              <div
                className="answer-card markdown-body"
                dangerouslySetInnerHTML={{
                  __html: aiLoading
                    ? "AI 正在思考…"
                    : renderMarkdown(aiResponse?.answer || ""),
                }}
              />
            )}
            {aiResponse?.contextSnippets?.length ? (
              <div className="context-list">
                {aiResponse.contextSnippets.map((item) => (
                  <button key={`${item.index}-${item.chapterHref}`} type="button" className="context-card" onClick={() => openLocation(item.chapterHref)}>
                    <strong>依据 {item.index}</strong>
                    <span>{item.chapterTitle}</span>
                    <small>{item.snippet}</small>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          )}

          {(lookupLoading || referenceLookup) && (
          <div className="answer-panel">
            <div className="panel-headline small">
              <MapPinned size={16} />
              <span>划词百科</span>
            </div>
            <div
              className="answer-card markdown-body"
              dangerouslySetInnerHTML={{
                __html: lookupLoading
                  ? "正在检索本地资料并请求 AI 释义…"
                  : referenceLookup?.aiExplanation
                    ? renderMarkdown(referenceLookup.aiExplanation)
                    : "选中官职、人物、地名、年号后，可一键查看百科说明。",
              }}
            />
            {referenceLookup?.reignMatch && (
              <div className="tag-row">
                <span className="soft-tag">
                  {referenceLookup.reignMatch.label} → {referenceLookup.reignMatch.gregorian}
                </span>
              </div>
            )}
            {referenceLookup?.localMatches?.length ? (
              <div className="result-list compact">
                {referenceLookup.localMatches.map((match, index) => (
                  <div key={`${match.type}-${match.title}-${index}`} className="result-card static-card">
                    <div className="result-title">
                      {match.title}
                      <span className="mini-type">{match.type}</span>
                    </div>
                    <div className="result-snippet">{match.subtitle}</div>
                    <div className="note-body">{match.summary}</div>
                    <div className="detail-grid">
                      {Object.entries(match.details || {}).slice(0, 4).map(([key, value]) => (
                        <div key={key} className="detail-item">
                          <strong>{key}</strong>
                          <span>{formatDetailValue(value)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          )}

          {(compareLoading || referenceCompare) && (
          <div className="answer-panel">
            <div className="panel-headline small">
              <LibraryBig size={16} />
              <span>史料交叉比对</span>
              {referenceCompare?.reportMarkdown && !compareLoading && (
                <div className="header-actions">
                  <button
                    type="button"
                    className="ghost-button compact-button"
                    onClick={saveCompareAsNote}
                    title="把当前比对报告保存为一条札记，锚定到原始选段"
                  >
                    札记
                  </button>
                  <button
                    type="button"
                    className="ghost-button compact-button"
                    onClick={() => setCompareExpandOpen(true)}
                    title="在弹窗中展开查看完整报告"
                  >
                    展开
                  </button>
                </div>
              )}
            </div>
            <div className="tag-row">
              {referenceCompare?.keywords?.map((keyword) => (
                <span key={keyword} className="soft-tag">
                  {keyword}
                </span>
              ))}
            </div>
            <div
              className="markdown-body"
              dangerouslySetInnerHTML={{
                __html: renderMarkdown(
                  compareLoading
                    ? "正在提取关键词、检索参考史料并生成考证报告……"
                    : referenceCompare?.reportMarkdown || '选中一段原文后点击\u300c史料比对\u300d，这里会优先按人物与事件抽取检索重点，再生成 Markdown 格式的考证报告。'
                ),
              }}
            />
            {referenceCompare?.contexts?.length ? (
              <div className="context-list">
                {referenceCompare.contexts.map((item) => (
                  <div key={`${item.bookSlug}-${item.index}-${item.chapter}`} className="context-card static-card">
                    <strong>
                      {item.bookTitle} · {item.chapter}
                    </strong>
                    <span>{item.snippet}</span>
                    <button
                      type="button"
                      className="ghost-button compact-button"
                      onClick={() => openSourceViewer(item.bookSlug, item.chapter, item.content || item.snippet)}
                      disabled={sourceViewerLoading}
                    >
                      查看原文
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          )}

          <div className="note-input-panel">
            <div className="panel-headline small">
              <NotebookPen size={16} />
              <span>随笔札记</span>
            </div>
            {selectionText.trim() && <div className="muted-text" style={{ fontSize: "0.75rem" }}>选段：{selectionText.slice(0, 40)}{selectionText.length > 40 ? "…" : ""}</div>}
            <textarea
              ref={noteInputRef}
              className="text-input"
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              placeholder={selectionText.trim() ? "为选中的文段写札记…" : "先在正文中选段，再写札记"}
              rows={2}
            />
            <button
              type="button"
              className="primary-button"
              disabled={!noteDraft.trim() || !selectionText.trim() || !selectionCfi}
              onClick={saveNote}
              style={{ alignSelf: "flex-end" }}
            >
              保存札记
            </button>
          </div>

          <div className="annotation-panel">
            <div className="panel-headline small">
              <Highlighter size={16} />
              <span>勾画记录</span>
              <div className="header-actions">
                <button type="button" className="ghost-button compact-button" onClick={exportHighlights} disabled={!highlights.length}>
                  <Download size={15} />
                  导出摘录
                </button>
              </div>
            </div>
            <div className="result-list compact">
              {highlights.slice(0, 12).map((item) => (
                <div key={item.id} className="result-card static-card">
                  <div className="result-title">{item.kind === "underline" ? "下划线" : item.kind === "circle" ? "圈点" : "高亮"} · {formatTime(item.createdAt)}</div>
                  <div className="result-snippet">{item.text}</div>
                  <div className="inline-actions">
                    <button type="button" className="ghost-button" onClick={() => openLocation(item.cfiRange)}>
                      打开
                    </button>
                    <button type="button" className="ghost-button danger" onClick={() => removeHighlight(item)}>
                      删除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </aside>

      {selectionOverlay.visible && (
        <>
        {/*
          点 backdrop 仅折叠工具栏 UI，不清空选段（selectionText / cfi /
          OS-level range 都保留）。这样用户：
            - 选好段后想看右侧助理面板的具体动作（百科/史料比对等）—
              点空白处工具栏让位，但选段还在，按钮仍 hasSelection=true 可点
            - 之前我把 clearSelection 写到这儿，导致一点别处选段就被全清，
              和"再次勾画前不会自动清空"的产品预期相违。
          想真清空就用工具栏左侧的 ✕ 按钮（仍调 clearSelection）。
        */}
        <div className="selection-backdrop" onClick={() => setSelectionOverlay((p) => ({ ...p, visible: false }))} />
        <div className="selection-toolbar" style={{ top: selectionOverlay.top, left: selectionOverlay.left }}>
          <button type="button" className="toolbar-mini close-mini" onClick={clearSelection} title="关闭">
            <X size={14} />
          </button>
          {/* v1.2 toolbar 精简：颜色 / 形态选择移到设置面板的"默认勾画"，弹窗里只剩一个「标记」按钮。 */}
          <button
            type="button"
            className="toolbar-mini"
            onClick={() => {
              const { kind, color } = resolveMarkStyle(markStyle);
              addSelectionHighlight(kind, color);
            }}
          >
            <Highlighter size={14} />
            标记
          </button>
          {selectionHighlight && (
            <button type="button" className="toolbar-mini danger-mini" onClick={() => { removeHighlight(selectionHighlight); clearSelection(); }}>
              删除勾画
            </button>
          )}
          <button type="button" className="toolbar-mini" onClick={() => { setAssistantCollapsed(false); noteInputRef.current?.focus(); }}>札记</button>
          <button type="button" className="toolbar-mini" onClick={() => void requestAiAction("pronounce")} disabled={aiLoading}>读音</button>
          <button type="button" className="toolbar-mini" onClick={() => void handleResolveSelectionDate()}>识别日期</button>
          <button type="button" className="toolbar-mini" onClick={() => void handleReferenceLookup()} disabled={lookupLoading}>百科</button>
          <button type="button" className="toolbar-mini" onClick={() => void requestCrossCompare()} disabled={compareLoading}>史料比对</button>
          <button type="button" className="toolbar-mini" onClick={() => void requestAiAction("translate")} disabled={aiLoading}>现代文</button>
          <button type="button" className="toolbar-mini" onClick={() => void requestAiAction("punctuate")} disabled={aiLoading}>AI 句读</button>
          <button type="button" className="toolbar-mini" onClick={() => void speakText(selectionText)}>朗读</button>
          {ttsStatus && (
            <>
              <button type="button" className="toolbar-mini" onClick={pauseOrResumeSpeech}>{ttsStatus.includes("暂停") ? "继续" : "暂停"}</button>
              <button type="button" className="toolbar-mini" onClick={stopSpeech}>停止</button>
            </>
          )}
        </div>
        </>
      )}

      {openResourcePanel && (
        <div className="modal-backdrop" onClick={() => setOpenResourcePanel(null)}>
          <div className="modal-card resource-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">
                {openResourcePanel === "chronology" && "人物志"}
                {openResourcePanel === "reign" && "历史计算器"}
                {openResourcePanel === "free-chat" && "AI 对话"}
                {openResourcePanel === "familytree" && "主支三代谱系"}
                {openResourcePanel === "officials" && "职官/世系"}
                {openResourcePanel === "map" && "古今地名地图"}
                {openResourcePanel === "history-timeline" && "历史时间线"}
                {openResourcePanel === "custom-actions" && "自定义 AI 操作"}
              </span>
              <button type="button" className="ghost-button compact-button" onClick={() => setOpenResourcePanel(null)}>关闭</button>
            </div>

            {openResourcePanel === "chronology" && (
              <div className="stack-gap">
                <input
                  className="text-input"
                  value={personQuery}
                  onChange={(event) => setPersonQuery(event.target.value)}
                  placeholder="人物名 如 张居正、袁崇焕、王守仁"
                />
                <div className="inline-actions">
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => setBaikeQuery(personQuery.trim())}
                    disabled={!personQuery.trim()}
                    title="在内置窗口中打开百度百科条目"
                  >
                    百度百科
                  </button>
                </div>

                <div className="officials-tabs">
                  <button
                    type="button"
                    className={`tab-button ${personPanelTab === "biographies" ? "is-active" : ""}`}
                    onClick={() => setPersonPanelTab("biographies")}
                  >人物列传</button>
                  <button
                    type="button"
                    className={`tab-button ${personPanelTab === "conversation" ? "is-active" : ""}`}
                    onClick={() => setPersonPanelTab("conversation")}
                  >AI 对话</button>
                </div>

                {personPanelTab === "biographies" && (
                  <div className="stack-gap">
                    <div className="muted-text">在《明史》《石匮书后集》《东林列传》《罪惟录》4 部纪传体的传记索引中查找此人的列传切片（共 776 位人物入库）。</div>
                    <div className="inline-actions">
                      <button
                        type="button"
                        className="primary-button"
                        onClick={() => void loadPersonBiographies()}
                        disabled={biographiesLoading || !personQuery.trim()}
                      >
                        {biographiesLoading ? "查询中…" : "查询列传"}
                      </button>
                    </div>
                    {conversationError && personPanelTab === "biographies" && <div className="error-box">{conversationError}</div>}
                    {personBiographies && !personBiographies.has && (
                      <div className="muted-text" style={{ padding: "0.6rem 0" }}>
                        传记索引中没有「{personBiographies.person}」。可改用「AI 对话」 tab 让模型基于嵌入检索的相关史料回答。
                      </div>
                    )}
                    {personBiographies?.has && (
                      <div className="result-list compact">
                        {personBiographies.biographies.map((bio, i) => (
                          <div key={`${bio.bookSlug}-${i}`} className="result-card static-card">
                            <div className="result-title">《{bio.bookTitle}》{bio.chapterLabel}</div>
                            <div className="muted-text" style={{ fontSize: "0.78rem" }}>
                              共 {bio.paragraphCount} 段（章节内 #{bio.sliceFromIndex + 1}–#{bio.sliceToIndex} / 全章 {bio.chapterParagraphCount} 段）
                            </div>
                            <div className="result-snippet" style={{ marginTop: "0.4rem", whiteSpace: "pre-wrap" }}>
                              {bio.paragraphs.slice(0, 3).join("\n")}
                              {bio.paragraphs.length > 3 && (
                                <span className="muted-text"> … </span>
                              )}
                            </div>
                            {bio.anchor && (
                              <div className="inline-actions" style={{ marginTop: "0.3rem" }}>
                                <button
                                  type="button"
                                  className="ghost-button compact-button"
                                  onClick={() => { openLocation(bio.anchor); setOpenResourcePanel(null); }}
                                >
                                  跳转到原书章节
                                </button>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {personBiographies && personBiographies.related && personBiographies.related.length > 0 && (
                      <div className="stack-gap" style={{ marginTop: "0.6rem" }}>
                        <div className="muted-text" style={{ fontSize: "0.82rem" }}>
                          ▶ 其他史料中提及此人的段落（嵌入检索 + 人名实际命中过滤，共 {personBiographies.related.length} 条）
                        </div>
                        <div className="result-list compact">
                          {personBiographies.related.map((r, i) => (
                            <div key={`rel-${i}`} className="result-card static-card">
                              <div className="result-title">《{r.bookTitle}》{r.chapter}</div>
                              <div className="result-snippet" style={{ marginTop: "0.3rem", whiteSpace: "pre-wrap" }}>{r.snippet}</div>
                              {r.anchor && (
                                <div className="inline-actions" style={{ marginTop: "0.3rem" }}>
                                  <button
                                    type="button"
                                    className="ghost-button compact-button"
                                    onClick={() => { openLocation(r.anchor!); setOpenResourcePanel(null); }}
                                  >
                                    跳转原书
                                  </button>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {personPanelTab === "conversation" && (
                  <div className="stack-gap">
                    <div className="inline-actions" style={{ flexWrap: "wrap", gap: "0.4rem", alignItems: "center" }}>
                      <label className="muted-text" style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                        <input
                          type="radio"
                          name="conv-mode"
                          checked={conversationMode === "core-person"}
                          onChange={() => setConversationMode("core-person")}
                        />
                        核心人物模式
                      </label>
                      <label className="muted-text" style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                        <input
                          type="radio"
                          name="conv-mode"
                          checked={conversationMode === "open"}
                          onChange={() => setConversationMode("open")}
                        />
                        开放对话
                      </label>
                      <button
                        type="button"
                        className="ghost-button compact-button"
                        onClick={resetConversation}
                        disabled={conversationMessages.length === 0}
                      >
                        清空对话
                      </button>
                    </div>
                    <div className="muted-text" style={{ fontSize: "0.78rem" }}>
                      {conversationMode === "core-person"
                        ? `选定核心人物「${personQuery.trim() || "（未指定）"}」。若该人物在传记索引中，则以其列传为主要知识库；否则按嵌入检索补充。`
                        : "开放模式：每轮基于当前问题做嵌入检索，不限于核心人物。"}
                    </div>

                    {conversationMessages.length > 0 && (
                      <div className="stack-gap" style={{ maxHeight: "50vh", overflowY: "auto", border: "1px solid var(--ui-panel-border)", borderRadius: "0.4rem", padding: "0.6rem", background: "var(--ui-panel-bg)" }}>
                        {conversationMessages.map((m, i) => (
                          <div
                            key={i}
                            className={m.role === "user" ? "answer-card" : "answer-card markdown-body"}
                            style={{
                              alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                              background: m.role === "user" ? "rgba(212, 35, 27, 0.08)" : "transparent",
                              border: m.role === "user" ? "1px solid rgba(212, 35, 27, 0.2)" : "1px solid var(--ui-panel-border)",
                              borderRadius: "0.4rem",
                              padding: "0.5rem 0.7rem",
                              whiteSpace: m.role === "user" ? "pre-wrap" : undefined,
                            }}
                            dangerouslySetInnerHTML={m.role === "assistant" ? { __html: renderMarkdown(m.content) } : undefined}
                          >
                            {m.role === "user" ? m.content : null}
                          </div>
                        ))}
                        {conversationLoading && (
                          <div className="muted-text">AI 正在思考…（5-15 秒）</div>
                        )}
                      </div>
                    )}

                    {conversationSources.length > 0 && (
                      <div className="stack-gap" style={{ border: "1px solid var(--ui-panel-border)", borderRadius: "0.4rem", padding: "0.5rem" }}>
                        <div
                          className="inline-actions"
                          style={{ justifyContent: "space-between", cursor: "pointer" }}
                          onClick={() => setConversationSourcesExpanded(!conversationSourcesExpanded)}
                        >
                          <span className="muted-text">
                            本轮知识库来源：{conversationSourceMode === "biography" ? "传记索引"
                              : conversationSourceMode === "embedding" ? "嵌入检索"
                              : conversationSourceMode === "fts5" ? "全文检索" : "无"}（{conversationSources.length} 条）
                          </span>
                          <span className="muted-text">{conversationSourcesExpanded ? "收起 ▲" : "展开 ▼"}</span>
                        </div>
                        {conversationSourcesExpanded && (
                          <div className="result-list compact" style={{ marginTop: "0.4rem" }}>
                            {conversationSources.map((s, i) => (
                              <div key={i} className="result-card static-card">
                                <div className="result-title">[片段#{s.index ?? i + 1}] 《{s.bookTitle}》{s.chapter}</div>
                                <div className="result-snippet" style={{ whiteSpace: "pre-wrap" }}>
                                  {s.text.slice(0, 240)}{s.text.length > 240 ? "…" : ""}
                                </div>
                                {s.anchor && (
                                  <div className="inline-actions" style={{ marginTop: "0.3rem" }}>
                                    <button
                                      type="button"
                                      className="ghost-button compact-button"
                                      onClick={() => { openLocation(s.anchor!); setOpenResourcePanel(null); }}
                                    >
                                      跳转原书
                                    </button>
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {conversationError && personPanelTab === "conversation" && <div className="error-box">{conversationError}</div>}

                    <textarea
                      className="text-input"
                      value={conversationInput}
                      onChange={(e) => setConversationInput(e.target.value)}
                      placeholder={
                        conversationMessages.length === 0
                          ? `第一轮提问，如：「张居正改革的主要内容是什么？」/「袁崇焕为什么被诛？」`
                          : "继续追问…"
                      }
                      rows={3}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                          void sendConversationMessage();
                        }
                      }}
                    />
                    <div className="inline-actions">
                      <button
                        type="button"
                        className="primary-button"
                        onClick={() => void sendConversationMessage()}
                        disabled={conversationLoading || !conversationInput.trim()}
                      >
                        {conversationLoading ? "思考中…" : conversationMessages.length === 0 ? "开始对话" : "继续问"}
                      </button>
                      <span className="muted-text" style={{ fontSize: "0.72rem" }}>⌘/Ctrl + Enter 快捷发送</span>
                    </div>
                  </div>
                )}

                {baikeQuery && (
                  <div className="stack-gap" style={{ marginTop: "0.6rem" }}>
                    <div className="inline-actions" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: "0.4rem" }}>
                      <span className="muted-text">百度百科 · {baikeQuery}（嵌入预览）</span>
                      <div className="inline-actions" style={{ gap: "0.3rem" }}>
                        <button
                          type="button"
                          className="secondary-button compact-button"
                          onClick={() => window.open(`https://baike.baidu.com/item/${encodeURIComponent(baikeQuery)}`, "_blank", "noopener,noreferrer")}
                        >
                          新窗口打开
                        </button>
                        <button
                          type="button"
                          className="ghost-button compact-button"
                          onClick={() => setBaikeQuery("")}
                          title="关闭嵌入面板"
                        >
                          关闭
                        </button>
                      </div>
                    </div>
                    <iframe
                      key={baikeQuery}
                      src={`https://baike.baidu.com/item/${encodeURIComponent(baikeQuery)}`}
                      className="hgis-iframe"
                      title={`百度百科 - ${baikeQuery}`}
                      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation"
                      referrerPolicy="no-referrer-when-downgrade"
                    />
                  </div>
                )}
              </div>
            )}

            {openResourcePanel === "free-chat" && (() => {
              const activeChat = freeChats.find((c) => c.id === activeFreeChatId) || null;
              return (
                <div className="stack-gap" style={{ display: "grid", gridTemplateColumns: "200px 1fr", gap: "0.8rem", maxHeight: "70vh" }}>
                  {/* 左：会话列表 — flex 列：顶部 button+model（auto 高），下方 history（flex:1 撑满） */}
                  <div style={{ display: "flex", flexDirection: "column", borderRight: "1px solid var(--ui-panel-border)", paddingRight: "0.6rem", overflow: "hidden", height: "100%" }}>
                    {/* button + model 紧贴在一起 */}
                    <div style={{ display: "flex", flexDirection: "column", gap: "0.15rem", flexShrink: 0 }}>
                      <button
                        type="button"
                        className="new-chat-btn"
                        onClick={newFreeChat}
                        title="新建对话"
                      >+ 新建对话</button>
                      <label className="muted-text" style={{ display: "flex", flexDirection: "column", gap: "0.1rem", fontSize: "0.74rem" }}>
                        <span>模型</span>
                        <select
                          className="select-input"
                          style={{ fontSize: "0.78rem", padding: "0.25rem 0.4rem" }}
                          value={freeChatModel || aiSettings.defaultModel || aiSettings.model || ""}
                          onChange={(e) => setFreeChatModel(e.target.value)}
                        >
                          {(aiSettings.modelOptions || [])
                            .concat(
                              aiSettings.defaultModel && !aiSettings.modelOptions?.includes(aiSettings.defaultModel)
                                ? [aiSettings.defaultModel]
                                : []
                            )
                            .map((m) => (
                              <option key={m} value={m}>{m}</option>
                            ))}
                        </select>
                      </label>
                    </div>
                    {/* history 撑满剩余高度，内部 scroll；与上方 button+model 块紧贴 */}
                    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", marginTop: "0.4rem", display: "flex", flexDirection: "column", gap: "0.3rem" }}>
                    {freeChats.length === 0 && (
                      <div className="muted-text" style={{ fontSize: "0.78rem", padding: "0.3rem 0" }}>
                        还没有对话。开新对话开始问。
                      </div>
                    )}
                    {freeChats
                      .slice()
                      .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))
                      .map((c) => (
                        <div
                          key={c.id}
                          className={`result-card ${activeFreeChatId === c.id ? "static-card" : ""}`}
                          style={{ cursor: "pointer", padding: "0.4rem 0.5rem", borderColor: activeFreeChatId === c.id ? "rgba(212, 35, 27, 0.4)" : undefined, background: activeFreeChatId === c.id ? "rgba(212, 35, 27, 0.05)" : undefined }}
                          onClick={() => setActiveFreeChatId(c.id)}
                        >
                          <div className="result-title" style={{ fontSize: "0.84rem" }}>{c.title || "新对话"}</div>
                          <div className="muted-text" style={{ fontSize: "0.7rem" }}>
                            {c.messages.length} 条 · {new Date(c.updatedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                          </div>
                          <div className="inline-actions" style={{ marginTop: "0.2rem", gap: "0.2rem" }}>
                            <button
                              type="button"
                              className="ghost-button compact-button"
                              onClick={(e) => {
                                e.stopPropagation();
                                const next = window.prompt("重命名对话", c.title);
                                if (next !== null) renameFreeChat(c.id, next.trim() || "新对话");
                              }}
                              style={{ fontSize: "0.7rem", padding: "0.1rem 0.4rem" }}
                            >重命名</button>
                            <button
                              type="button"
                              className="ghost-button compact-button"
                              onClick={(e) => { e.stopPropagation(); if (window.confirm(`删除「${c.title}」？此操作不可撤销。`)) deleteFreeChat(c.id); }}
                              style={{ fontSize: "0.7rem", padding: "0.1rem 0.4rem", color: "#d4231b" }}
                            >删除</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* 右：消息流 + 输入 */}
                  <div className="stack-gap" style={{ display: "flex", flexDirection: "column", minHeight: "60vh" }}>
                    {activeChat && activeChat.messages.length > 0 && (
                      <div className="stack-gap" style={{ flex: 1, overflowY: "auto", border: "1px solid var(--ui-panel-border)", borderRadius: "0.4rem", padding: "0.6rem", background: "var(--ui-panel-bg)" }}>
                        {activeChat.messages.map((m, i) => (
                          <div
                            key={i}
                            className={m.role === "user" ? "answer-card" : "answer-card markdown-body"}
                            style={{
                              alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                              background: m.role === "user" ? "rgba(212, 35, 27, 0.08)" : "transparent",
                              border: m.role === "user" ? "1px solid rgba(212, 35, 27, 0.2)" : "1px solid var(--ui-panel-border)",
                              borderRadius: "0.4rem",
                              padding: "0.5rem 0.7rem",
                              whiteSpace: m.role === "user" ? "pre-wrap" : undefined,
                            }}
                            dangerouslySetInnerHTML={m.role === "assistant" ? { __html: renderMarkdown(m.content) } : undefined}
                          >
                            {m.role === "user" ? m.content : null}
                          </div>
                        ))}
                        {freeChatLoading && <div className="muted-text">AI 正在思考…（5-15 秒）</div>}
                      </div>
                    )}

                    {activeChat && activeChat.sources.length > 0 && (
                      <div className="stack-gap" style={{ border: "1px solid var(--ui-panel-border)", borderRadius: "0.4rem", padding: "0.5rem" }}>
                        <div
                          className="inline-actions"
                          style={{ justifyContent: "space-between", cursor: "pointer" }}
                          onClick={() => setFreeChatSourcesExpanded(!freeChatSourcesExpanded)}
                        >
                          <span className="muted-text">
                            上轮检索来源：{activeChat.sourceMode === "embedding" ? "嵌入检索" : activeChat.sourceMode === "fts5" ? "全文检索" : activeChat.sourceMode}（{activeChat.sources.length} 条）
                          </span>
                          <span className="muted-text">{freeChatSourcesExpanded ? "收起 ▲" : "展开 ▼"}</span>
                        </div>
                        {freeChatSourcesExpanded && (
                          <div className="result-list compact" style={{ marginTop: "0.4rem" }}>
                            {activeChat.sources.map((s, i) => (
                              <div key={i} className="result-card static-card">
                                <div className="result-title">[#{s.index ?? i + 1}] 《{s.bookTitle}》{s.chapter}</div>
                                <div className="result-snippet" style={{ whiteSpace: "pre-wrap" }}>
                                  {s.text.slice(0, 220)}{s.text.length > 220 ? "…" : ""}
                                </div>
                                {s.anchor && (
                                  <div className="inline-actions" style={{ marginTop: "0.3rem" }}>
                                    <button
                                      type="button"
                                      className="ghost-button compact-button"
                                      onClick={() => { openLocation(s.anchor!); setOpenResourcePanel(null); }}
                                    >跳转原书</button>
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {freeChatError && <div className="error-box">{freeChatError}</div>}

                    <textarea
                      className="text-input"
                      value={freeChatInput}
                      onChange={(e) => setFreeChatInput(e.target.value)}
                      placeholder={
                        !activeChat || activeChat.messages.length === 0
                          ? "提个问题，如「明朝初期的卫所制度是怎么运作的？」「张居正改革废除了哪些苛政？」"
                          : "继续追问…"
                      }
                      rows={3}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                          void sendFreeChatMessage();
                        }
                      }}
                    />
                    <div className="inline-actions">
                      <button
                        type="button"
                        className="primary-button"
                        onClick={() => void sendFreeChatMessage()}
                        disabled={freeChatLoading || !freeChatInput.trim()}
                      >
                        {freeChatLoading ? "思考中…" : "发送"}
                      </button>
                      <span className="muted-text" style={{ fontSize: "0.72rem" }}>⌘/Ctrl+Enter 快捷发送 · 历史记录自动存到本地</span>
                    </div>
                  </div>
                </div>
              );
            })()}

            {openResourcePanel === "reign" && (
              <div className="calc-modal-body">
                <HistoricalCalculator />
              </div>
            )}

            {openResourcePanel === "officials" && (
              <div className="stack-gap">
                <div className="officials-tabs">
                  {([
                    ["lineage", `世系`],
                    ["institutions", `官署（${officialsData?.institutions.length ?? 0}）`],
                    ["offices", `官职（${officialsData?.offices?.length ?? 0}）`],
                    ["chronology", `历任（${officialsData?.chronology?.length ?? 0}）`],
                    ["princes", `藩王（${officialsData?.princes?.length ?? 0}）`],
                  ] as const).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      className={`tab-button ${officialsTab === key ? "is-active" : ""}`}
                      onClick={() => setOfficialsTab(key)}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {officialsTab === "lineage" && (
                  <div className="shixi-modal-body">
                    <ShixiTree />
                  </div>
                )}

                {officialsTab === "institutions" && (
                  <>
                    <div className="muted-text">按品级与职责浏览，或检索"兵部尚书""巡抚""首辅"等职位线索。</div>
                    <input
                      className="text-input"
                      value={referenceFilter}
                      onChange={(event) => setReferenceFilter(event.target.value)}
                      placeholder="筛选官署名称或品级"
                    />
                    <div className="detail-grid">
                      {filteredInstitutions?.slice(0, 12).map((item) => (
                        <div key={item.id} className="detail-item">
                          <strong>{item.name}</strong>
                          <span>{item.rank}</span>
                          <span>{item.salaryReference}</span>
                          <span>{item.responsibilities.slice(0, 2).join("；")}</span>
                        </div>
                      ))}
                    </div>
                    <input
                      className="text-input"
                      value={officeSearchQuery}
                      onChange={(event) => setOfficeSearchQuery(event.target.value)}
                      placeholder="检索职位历任线索（穿透到明史/参考资料库）"
                    />
                    <div className="inline-actions">
                      <button type="button" className="primary-button" onClick={() => void handleOfficeSearch()} disabled={officeSearchLoading || !officeSearchQuery.trim()}>
                        {officeSearchLoading ? "检索中…" : "检索职位"}
                      </button>
                    </div>
                    {officeSearchResult && (
                      <div className="result-list compact">
                        {officeSearchResult.bookResults.slice(0, 4).map((item) => (
                          <button key={item.id} type="button" className="result-card" onClick={() => { openLocation(item.chapterHref); setOpenResourcePanel(null); }}>
                            <div className="result-title">{item.chapterTitle}</div>
                            <div className="result-snippet">{item.snippet}</div>
                          </button>
                        ))}
                        {officeSearchResult.referenceResults.slice(0, 4).map((item) => (
                          <div key={`${item.bookSlug}-${item.index}`} className="result-card static-card">
                            <div className="result-title">{item.bookTitle} · {item.chapter}</div>
                            <div className="result-snippet">{item.snippet}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}

                {officialsTab === "offices" && (
                  <>
                    <div className="muted-text">明代官职全表（共 {officialsData?.offices?.length ?? 0} 职），来自《明史·职官志》整理。可按官名/品级/部门筛选。</div>
                    <input
                      className="text-input"
                      value={officeRankFilter}
                      onChange={(event) => setOfficeRankFilter(event.target.value)}
                      placeholder="筛选 如：兵部 / 正二品 / 都察院"
                    />
                    <div className="office-table">
                      {(() => {
                        const q = officeRankFilter.trim();
                        const filtered = (officialsData?.offices ?? [])
                          .filter((o) => !q || `${o.name} ${o.rank} ${o.department} ${o.section}`.includes(q))
                          .slice()
                          .sort((a, b) => rankOrder(a.rank) - rankOrder(b.rank) || a.department.localeCompare(b.department) || a.name.localeCompare(b.name))
                          .slice(0, 200);
                        return filtered.map((o, i) => (
                          <div key={`${o.name}-${o.department}-${i}`} className="office-row">
                            <div className="office-row-name">{o.name}</div>
                            <div className="office-row-rank">{o.rank}</div>
                            <div className="office-row-count muted-text">{o.count}</div>
                            <div className="office-row-dept muted-text">{o.department}</div>
                            <div className="office-row-salary muted-text" title={o.salary}>{o.salary ? o.salary.split("，")[0] : ""}</div>
                          </div>
                        ));
                      })()}
                      {(officialsData?.offices?.length ?? 0) > 200 && officeRankFilter.trim() === "" && (
                        <div className="muted-text" style={{ textAlign: "center", padding: "0.5rem" }}>仅显示前 200 条，请用上方筛选。</div>
                      )}
                    </div>
                  </>
                )}

                {officialsTab === "chronology" && (
                  <>
                    <div className="muted-text">明代七卿/南京七卿/内阁辅臣 历任年表（{officialsData?.chronology?.length ?? 0} 条）。可按人名/职位/年号/公元年份筛选。</div>
                    <input
                      className="text-input"
                      value={chronologyFilter}
                      onChange={(event) => setChronologyFilter(event.target.value)}
                      placeholder="筛选 如：张居正 / 兵部尚书 / 1572 / 嘉靖"
                    />
                    <div className="chronology-list">
                      {(() => {
                        const q = chronologyFilter.trim();
                        const filtered = (officialsData?.chronology ?? []).filter((c) => {
                          if (!q) return true;
                          const haystack = `${c.era} ${c.yearLabel} ${c.gregorian} ${c.position} ${c.scope} ${c.people.join(" ")}`;
                          return haystack.includes(q);
                        }).slice(0, 200);
                        return filtered.map((c, i) => (
                          <div key={`${c.gregorian}-${c.scope}-${c.position}-${i}`} className="chronology-row">
                            <div className="chronology-year">{c.gregorian} <span className="muted-text">{c.era?.replace(/^附：/, "")}</span></div>
                            <div className="chronology-pos"><span className="chronology-scope">{c.scope}</span> {c.position}</div>
                            <div className="chronology-people">{c.people.join("、")}</div>
                          </div>
                        ));
                      })()}
                      {chronologyFilter.trim() === "" && (officialsData?.chronology?.length ?? 0) > 200 && (
                        <div className="muted-text" style={{ textAlign: "center", padding: "0.5rem" }}>仅显示前 200 条，请用上方筛选。</div>
                      )}
                    </div>
                  </>
                )}

                {officialsTab === "princes" && (
                  <>
                    <div className="muted-text">明代藩王列表（{officialsData?.princes?.length ?? 0} 人），含字辈命名诗 {Object.keys(officialsData?.poems ?? {}).length} 套。</div>
                    <input
                      className="text-input"
                      value={chronologyFilter}
                      onChange={(event) => setChronologyFilter(event.target.value)}
                      placeholder="筛选 如：朱棣 / 秦王 / 楚府"
                    />
                    <details className="prince-section">
                      <summary>字辈命名诗（{Object.keys(officialsData?.poems ?? {}).length}）</summary>
                      <div className="poem-grid">
                        {Object.entries(officialsData?.poems ?? {}).map(([k, v]) => (
                          <div key={k} className="poem-row">
                            <strong>{k}</strong>
                            <span>{v}</span>
                          </div>
                        ))}
                      </div>
                    </details>
                    <div className="prince-list">
                      {(() => {
                        const q = chronologyFilter.trim();
                        const grouped = new Map<string, Array<{ section: string; title: string; name: string }>>();
                        for (const p of officialsData?.princes ?? []) {
                          if (q && !`${p.name} ${p.title} ${p.section}`.includes(q)) continue;
                          const key = p.section || "未分类";
                          const arr = grouped.get(key) ?? [];
                          arr.push(p);
                          grouped.set(key, arr);
                        }
                        return [...grouped.entries()].slice(0, 30).map(([section, items]) => (
                          <details key={section} className="prince-section" open={Boolean(q)}>
                            <summary>{section}（{items.length}）</summary>
                            <div className="prince-grid">
                              {items.map((p, i) => (
                                <span key={`${p.name}-${i}`} className="prince-chip">
                                  {p.title && <em>{p.title}</em>}
                                  {p.name}
                                </span>
                              ))}
                            </div>
                          </details>
                        ));
                      })()}
                    </div>
                  </>
                )}
              </div>
            )}

            {openResourcePanel === "map" && (
              <div className="stack-gap">
                <div className="muted-text">输入古今地名（逗号或换行分隔），匹配本地明代府州数据库，未命中时使用 AI 推断现代对应地名后在线定位。</div>
                <textarea
                  className="text-input tall"
                  value={mapQuery}
                  onChange={(event) => setMapQuery(event.target.value)}
                  placeholder="如 应天府、蓟州、临清州、苏州府"
                />
                <div className="inline-actions">
                  <button type="button" className="primary-button" onClick={() => void handleMapSearch()} disabled={mapLoading || !mapQuery.trim()}>
                    {mapLoading ? "定位中…" : "在地图标点"}
                  </button>
                  <button type="button" className="secondary-button" onClick={() => setMapQuery("应天府、顺天府、临清州、蓟州")}>
                    示例
                  </button>
                </div>
                <MingGeographyMap places={mapResult?.results || []} />
                {mapResult?.results && mapResult.results.length > 0 && (
                  <div className="result-list compact">
                    {mapResult.results.map((place) => (
                      <div key={`${place.query}-${place.id}`} className="result-card static-card">
                        <div className="result-title">{place.name || place.query}</div>
                        <div className="result-snippet">{place.modernName || "未找到现代位置"} · {place.source}</div>
                        <div className="note-body">{place.note}</div>
                      </div>
                    ))}
                  </div>
                )}
                <div className="divider" />
                <div className="inline-actions" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: "0.4rem" }}>
                  <span className="muted-text">中央研究院历史地名检索 — 嵌入版（仅供预览）</span>
                  <button
                    type="button"
                    className="secondary-button compact-button"
                    onClick={() => window.open("https://newarchive.ihp.sinica.edu.tw/hplname/placename/basic", "_blank", "noopener,noreferrer")}
                  >
                    新窗口打开
                  </button>
                </div>
                <div className="muted-text" style={{ fontSize: "0.74rem", marginTop: "-0.4rem" }}>
                  若下方嵌入页查询后跳回首页（中研院反 iframe 第三方 cookie），请用「新窗口打开」按钮在浏览器外部访问。
                </div>
                <iframe
                  src="https://newarchive.ihp.sinica.edu.tw/hplname/placename/basic"
                  className="hgis-iframe"
                  title="中研院歷史地名查詢"
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation"
                  referrerPolicy="no-referrer-when-downgrade"
                />
              </div>
            )}

            {openResourcePanel === "history-timeline" && (
              <HistoryTimelinePanel
                notes={notes}
                readableBooks={readableBooks}
                onNoteOpenModal={(n) => setNoteExpandedFor(n.id)}
                onNoteClick={(n) => {
                  // Jump to the chapter at the note's saved CFI. If the note
                  // belongs to a different book, switch first; otherwise
                  // openLocation directly. Close the resource panel so the
                  // reader is immediately visible.
                  setOpenResourcePanel(null);
                  if (n.bookSlug && n.bookSlug !== currentBookSlug) {
                    void switchBook(n.bookSlug).then(() => {
                      // After the switchBook promise settles the new book's
                      // rendition should be ready; openLocation queues the
                      // CFI display.
                      window.setTimeout(() => openLocation(n.cfiRange), 200);
                    });
                  } else {
                    openLocation(n.cfiRange);
                  }
                  setExpandedNoteId(n.id);
                }}
              />
            )}

            {openResourcePanel === "custom-actions" && (
              <div className="stack-gap">
                <div className="muted-text">创建自定义 AI 操作，可在阅读器选段后使用。</div>
                <label className="field-label">
                  名称
                  <input className="text-input" value={newActionName} onChange={(e) => setNewActionName(e.target.value)} placeholder="如：人物关系梳理" />
                </label>
                <label className="field-label">
                  System Prompt
                  <textarea className="text-input tall" value={newActionSystem} onChange={(e) => setNewActionSystem(e.target.value)} placeholder="定义 AI 的角色和任务" />
                </label>
                <label className="field-label">
                  User Template
                  <textarea className="text-input tall" value={newActionTemplate} onChange={(e) => setNewActionTemplate(e.target.value)} placeholder="可使用 {{selection}}、{{context}} 变量" />
                </label>
                <button type="button" className="primary-button" onClick={() => { addCustomAction(); }}>添加</button>
                <div className="result-list compact">
                  {customActions.filter((a) => a.id !== "vernacular" && a.name !== "结构梳理" && a.name !== "翻译为现代文").map((action) => (
                    <div key={action.id} className="result-card static-card">
                      <div className="result-title">{action.name}</div>
                      <div className="result-snippet">{action.userTemplate?.slice(0, 60)}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {apiConfigOpen && (
        <div className="modal-backdrop" onClick={() => setApiConfigOpen(false)}>
          <div className="modal-card resource-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">API 配置</span>
              <div className="header-actions">
                <button
                  type="button"
                  className="ghost-button compact-button"
                  title="拉取后端 /api/settings/defaults，覆盖当前 API Key 列表。dev 期会拿到由 .env 注入的默认两条；打包版若 .env 为空则列表为空。"
                  onClick={async () => {
                    if (!confirm("从后端拉取默认 API 配置覆盖当前列表？\n（dev 期会恢复 DeepSeek 官方 + 百炼默认；打包版会清空让你重新填）")) return;
                    try {
                      const d = await fetchDefaults();
                      const baseProviders = d.ai.modelProviders || [];
                      setAiSettings((c) => {
                        const pool = [...new Set(baseProviders.flatMap((p) => p.models))];
                        const top = baseProviders[0];
                        return {
                          ...c,
                          modelProviders: baseProviders,
                          modelOptions: pool.length ? pool : c.modelOptions,
                          smallModelOptions: pool.length ? pool : c.smallModelOptions,
                          model: pool.includes(c.model) ? c.model : (d.ai.defaultModel || pool[0] || c.model),
                          smallModel: pool.includes(c.smallModel || "") ? c.smallModel : (d.ai.smallModel || pool[0] || c.smallModel),
                          baseURL: top ? top.baseURL : c.baseURL,
                          apiKey: top ? top.apiKey : c.apiKey,
                        };
                      });
                    } catch (err) {
                      alert("拉取后端默认失败：" + (err as Error)?.message);
                    }
                  }}
                >
                  恢复后端默认
                </button>
                <button type="button" className="ghost-button compact-button" onClick={() => setApiConfigOpen(false)}>关闭</button>
              </div>
            </div>
            <div className="stack-gap">
              {/* v1.2.1：API Key 列表式管理 —— 取代旧的「顶部单 baseURL/apiKey + 多 provider 补充」结构。
                  每条 API Key = 一个 (baseURL, apiKey, 激活模型列表) 三元组；列表顺序 = 调用优先级。 */}
              <ApiKeyListEditor
                providers={aiSettings.modelProviders || []}
                onChange={(next) => {
                  // 1) 写入 providers；2) 同步主/小模型池（自动派生）+ baseURL/apiKey 兼容老字段（用第一条）。
                  const pool = uniqueValues(next.flatMap((p) => p.models));
                  setAiSettings((c) => {
                    const top = next[0];
                    return {
                      ...c,
                      modelProviders: next,
                      modelOptions: pool.length ? pool : c.modelOptions,
                      smallModelOptions: pool.length ? pool : c.smallModelOptions,
                      model: pool.includes(c.model) ? c.model : (pool[0] || c.model),
                      smallModel: pool.includes(c.smallModel || "") ? c.smallModel : (pool[0] || c.smallModel),
                      // 兼容老调用链：把"优先使用"那条同步到顶层 baseURL/apiKey
                      baseURL: top ? top.baseURL : c.baseURL,
                      apiKey: top ? top.apiKey : c.apiKey,
                    };
                  });
                }}
              />
              <div className="divider" />
              <div className="muted-text" style={{ fontSize: "0.78rem" }}>
                TTS（朗读）单独配置 — 多数平台不提供 TTS，常用百炼 qwen3-tts。如果与上面同账号同平台，TTS Base URL / Key 留空即可继承。
              </div>
              <label className="field-label">
                TTS Base URL（留空则同主 URL）
                <input className="text-input" value={aiSettings.ttsBaseURL} onChange={(e) => setAiSettings((c) => ({ ...c, ttsBaseURL: e.target.value }))} placeholder={aiSettings.baseURL} />
              </label>
              <label className="field-label">
                TTS API Key（留空则同主 API Key）
                <input className="text-input" type="password" value={aiSettings.ttsApiKey || ""} onChange={(e) => setAiSettings((c) => ({ ...c, ttsApiKey: e.target.value }))} placeholder="留空继承主 API Key" />
              </label>
              <label className="field-label">
                TTS 模型
                <input className="text-input" value={aiSettings.ttsModel || ""} onChange={(e) => setAiSettings((c) => ({ ...c, ttsModel: e.target.value }))} placeholder="qwen3-tts-flash / gpt-4o-mini-tts 等" />
              </label>
              <div className="muted-text" style={{ fontSize: "0.72rem" }}>
                修改后点"保存设置并刷新页面"生效。
              </div>
            </div>
          </div>
        </div>
      )}

      {compareExpandOpen && referenceCompare?.reportMarkdown && (
        <div className="modal-backdrop" onClick={() => setCompareExpandOpen(false)}>
          <div className="modal-card compare-expand-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">史料交叉比对</span>
              <div className="header-actions">
                <button
                  type="button"
                  className="ghost-button compact-button"
                  onClick={saveCompareAsNote}
                  title="把当前比对报告保存为一条札记"
                >
                  札记
                </button>
                <button type="button" className="ghost-button compact-button" onClick={() => setCompareExpandOpen(false)}>关闭</button>
              </div>
            </div>
            <div
              className="compare-expand-body markdown-body"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(referenceCompare.reportMarkdown) }}
            />
          </div>
        </div>
      )}

      {noteExpandedFor && (() => {
        const noteData = notes.find((n) => n.id === noteExpandedFor);
        if (!noteData) return null;
        const isCC = noteData.note.startsWith("【史料交叉比对】");
        const md = isCC ? noteData.note.replace(/^【史料交叉比对】\s*/, "") : noteData.note;
        return (
          <div className="modal-backdrop" onClick={() => setNoteExpandedFor(null)}>
            <div className="modal-card compare-expand-modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <span className="modal-title">札记 · {isCC ? "史料交叉比对" : "随笔"}</span>
                <div className="header-actions">
                  <button type="button" className="ghost-button compact-button" onClick={() => { setOpenResourcePanel(null); openLocation(noteData.cfiRange); setNoteExpandedFor(null); }}>
                    回到原文
                  </button>
                  <button type="button" className="ghost-button compact-button" onClick={() => { setEditingNoteId(noteData.id); setNoteDraft(noteData.note); setNoteComposerOpen(true); setNoteExpandedFor(null); }}>
                    编辑
                  </button>
                  <button type="button" className="ghost-button compact-button" onClick={() => setNoteExpandedFor(null)}>关闭</button>
                </div>
              </div>
              <div className="compare-expand-body">
                <div className="note-source-block" style={{ marginBottom: "1rem" }}>
                  <div className="note-source-label">原选段 · 勾画位置</div>
                  <div className="note-source-text">{noteData.text || "（未记录原选段位置）"}</div>
                  {noteData.timelineTitle && (
                    <div style={{ marginTop: "0.4rem", fontWeight: 600, color: "#603d1b" }}>标题：{noteData.timelineTitle}</div>
                  )}
                  {noteData.historicalAt && (
                    <div className="muted-text" style={{ fontSize: "0.78rem", marginTop: "0.3rem" }}>史时：{noteData.historicalAt}</div>
                  )}
                </div>
                {isCC ? (
                  <div className="markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(md) }} />
                ) : (
                  <div className="note-body" style={{ whiteSpace: "pre-wrap" }}>{md}</div>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {sourceViewer && (
        <div className="modal-backdrop" onClick={() => setSourceViewer(null)}>
          <div className="modal-card source-viewer-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">{sourceViewer.bookTitle} · {sourceViewer.chapter}</span>
              <button type="button" className="ghost-button compact-button" onClick={() => setSourceViewer(null)}>关闭</button>
            </div>
            <div className="source-viewer-body">
              {sourceViewer.paragraphs.map((para, i) => {
                const isHighlighted = sourceViewer.highlight && para.includes(sourceViewer.highlight);
                return (
                  <p key={i} className={isHighlighted ? "source-highlight" : ""}>
                    {isHighlighted
                      ? para.split(sourceViewer.highlight).map((part, j, arr) => (
                          <span key={j}>
                            {part}
                            {j < arr.length - 1 && <mark>{sourceViewer.highlight}</mark>}
                          </span>
                        ))
                      : para}
                  </p>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {pendingAction && (
        <div className="modal-backdrop" onClick={() => setPendingAction(null)}>
          <div className="modal-card supplement-modal" onClick={(e) => e.stopPropagation()}>
            <div className="panel-headline">
              <Sparkles size={16} />
              <span>补充说明（可选）</span>
            </div>
            <div className="muted-text">
              即将执行「{pendingAction.handler === "compare" ? "史料比对" : pendingAction.type === "translate" ? "翻译" : pendingAction.type === "pronounce" ? "读音" : pendingAction.type === "explain" ? "解释" : pendingAction.customAction?.name || pendingAction.type}」，可在下方补充具体问题或关注点：
            </div>
            <textarea
              className="text-input"
              value={supplementDraft}
              onChange={(e) => setSupplementDraft(e.target.value)}
              placeholder="如：重点关注魏忠贤与崔呈秀的关系；或留空直接执行"
              rows={2}
              autoFocus
            />
            <div className="inline-actions">
              <button type="button" className="ghost-button" onClick={() => { setPendingAction(null); }}>取消</button>
              <button type="button" className="secondary-button" onClick={() => { setSupplementDraft(""); executePendingAction(); }}>跳过，直接执行</button>
              <button type="button" className="primary-button" onClick={executePendingAction}>带补充执行</button>
            </div>
          </div>
        </div>
      )}

      {noteComposerOpen && (
        <div className="modal-backdrop">
          <div className="modal-card" style={{ maxWidth: "36rem" }}>
            <div className="panel-headline">
              <NotebookPen size={18} />
              <span>{editingNoteId ? "编辑札记" : "添加札记"}</span>
            </div>
            {!editingNoteId && <div className="selection-body">{selectionText}</div>}
            {editingNoteId && <div className="muted-text">{notes.find((n) => n.id === editingNoteId)?.text?.slice(0, 60)}…</div>}
            <textarea
              className="text-input tall"
              value={noteDraft}
              onChange={(event) => setNoteDraft(event.target.value)}
              placeholder="写下你的理解、疑问或联想"
            />
            {/*
              历史时间线集成：用户可以勾选把这条笔记加进 历史时间线 panel。
              年/月/日 默认填的是从选段及其上下文自动检测出来的时间（基于
              resolveSelectionDate 的年号→公历换算），允许手工覆盖。
              重要度 1-5 与官方事件 scale 对齐，类别默认"我的札记"（暖橙色）。
            */}
            <details className="prince-section" open={tlDraftEnabled}>
              <summary style={{ cursor: "pointer" }}>
                <label className="inline-actions" style={{ gap: "0.4rem", alignItems: "center" }}>
                  <input
                    type="checkbox"
                    checked={tlDraftEnabled}
                    onChange={(e) => { e.stopPropagation(); setTlDraftEnabled(e.target.checked); }}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <span>在历史时间线中显示这条笔记</span>
                </label>
              </summary>
              <div className="stack-gap" style={{ paddingTop: "0.5rem" }}>
                <div className="muted-text" style={{ fontSize: "0.74rem" }}>
                  时间默认按选段上下文自动检测，可手工覆盖（只填年也可以）。
                </div>
                <div className="inline-actions" style={{ gap: "0.4rem", flexWrap: "wrap" }}>
                  <label className="field-label" style={{ flex: 1, minWidth: "5rem" }}>
                    <span className="muted-text" style={{ fontSize: "0.72rem" }}>年</span>
                    <input
                      type="number"
                      className="text-input"
                      value={tlDraftYear}
                      onChange={(e) => setTlDraftYear(e.target.value)}
                      placeholder="如 1573"
                    />
                  </label>
                  <label className="field-label" style={{ flex: 1, minWidth: "4rem" }}>
                    <span className="muted-text" style={{ fontSize: "0.72rem" }}>月（可选）</span>
                    <input
                      type="number"
                      className="text-input"
                      min={1}
                      max={12}
                      value={tlDraftMonth}
                      onChange={(e) => setTlDraftMonth(e.target.value)}
                    />
                  </label>
                  <label className="field-label" style={{ flex: 1, minWidth: "4rem" }}>
                    <span className="muted-text" style={{ fontSize: "0.72rem" }}>日（可选）</span>
                    <input
                      type="number"
                      className="text-input"
                      min={1}
                      max={31}
                      value={tlDraftDay}
                      onChange={(e) => setTlDraftDay(e.target.value)}
                    />
                  </label>
                </div>
                <div className="inline-actions" style={{ gap: "0.4rem", flexWrap: "wrap", alignItems: "flex-end" }}>
                  <label className="field-label" style={{ flex: 1, minWidth: "8rem" }}>
                    <span className="muted-text" style={{ fontSize: "0.72rem" }}>重要度（1-5，默认 1）</span>
                    <select
                      className="select-input"
                      value={String(tlDraftScale)}
                      onChange={(e) => setTlDraftScale(parseInt(e.target.value, 10))}
                    >
                      <option value="1">1 - 一般</option>
                      <option value="2">2 - 较重要</option>
                      <option value="3">3 - 重要</option>
                      <option value="4">4 - 很重要</option>
                      <option value="5">5 - 大事</option>
                    </select>
                  </label>
                  <label className="field-label" style={{ flex: 1, minWidth: "8rem" }}>
                    <span className="muted-text" style={{ fontSize: "0.72rem" }}>事件类别</span>
                    <select
                      className="select-input"
                      value={tlDraftCategory}
                      onChange={(e) => setTlDraftCategory(e.target.value)}
                    >
                      <option value="我的札记">我的笔记</option>
                      {HISTORY_CATEGORIES.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="field-label">
                  <span className="muted-text" style={{ fontSize: "0.72rem" }}>时间线显示标题（留空则用笔记前 20 字）</span>
                  <input
                    type="text"
                    className="text-input"
                    value={tlDraftTitle}
                    onChange={(e) => setTlDraftTitle(e.target.value)}
                    placeholder="可选 · 用于在时间线轴上展示"
                    maxLength={40}
                  />
                </label>
              </div>
            </details>
            <div className="inline-actions">
              <button type="button" className="ghost-button" onClick={() => { setNoteComposerOpen(false); setEditingNoteId(null); }}>
                取消
              </button>
              <button type="button" className="primary-button" onClick={saveNote}>
                {editingNoteId ? "保存修改" : "保存笔记"}
              </button>
            </div>
          </div>
        </div>
      )}

      {timelineOpen && (
        <TimelineModal
          timeline={timelineData}
          onClose={() => setTimelineOpen(false)}
        />
      )}

      {aboutOpen && (
        <div className="modal-backdrop" onClick={() => setAboutOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="panel-headline">
              <BookOpenText size={18} />
              <span>关于 明史阅读器</span>
            </div>
            <div className="about-content">
              <p><strong>版本：</strong>v1.3.1（2026-06-03）— 明实录、四库全书本明史、东林列传、菽园杂记实现基于jiayan的自动标点。新增明王室世系树，历史计算器，含日期换算、度量衡、货币汇率；修正了关于搜索结果跳转的bug。详见 <a href="https://github.com/CanhuiLiPhy/Reader-Mingshi" target="_blank" rel="noopener noreferrer">GitHub README</a></p>
              <p><strong>使用说明：</strong></p>
              <ul>
                <li>首次进入软件请打开左上「设置」面板填入 AI API Key（兼容 DashScope / 火山 / DeepSeek / Kimi 等 OpenAI 兼容平台），<strong>填完即生效，无需重启</strong>。</li>
                <li>翻译 / 解释 / 提问 / 史料比对 / AI 编年 / AI 朗读 / AI 地名推断 需要联网调 API。</li>
                <li>选段后会弹出操作工具栏。</li>
              </ul>
              <p><strong>主要功能：</strong></p>
              <ul>
                <li>22 部明代史籍多书阅读（12 部带 EPUB 原典翻页 + 10 部检索类章节阅读），AI 跨书检索 + 史料交叉比对 +自动日期识别</li>
                <li>职官 / 明王室世系交互树/ 人物志 / 历史计算器/ 古今地名地图</li>
                <li>4 套阅读主题、10 款字体、3 色高亮 + 下划线 + 古文圈点</li>
              </ul>
              <p><strong>数据声明：</strong></p>
              <ul>
                <li>正文/古籍文本来自互联网公开资源（Wikisource、CText 等）+ 个人整理 + 基于公开资源的 OCR 处理。版权归原始来源所有。</li>
                <li>历史时间线数据源：《中国历史大事年表 古代及中世纪史部分》OCR 扫描版本。</li>
                <li>字体：方正系列（永乐大典楷体 / 瘦金 / 礼器碑）仅个人非商用授权。具体许可请查发行方原始声明。</li>
                <li>AI 回答仅供参考。本软件仅供个人学习研究使用，不得用于商业用途。</li>
              </ul>
            </div>
            <div className="inline-actions">
              <button type="button" className="primary-button" onClick={() => setAboutOpen(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}

      {dateResult && (
        <div className="modal-backdrop" onClick={() => setDateResult(null)}>
          <div className="modal-card" style={{ maxWidth: "32rem" }} onClick={(e) => e.stopPropagation()}>
            <div className="panel-headline">
              <span>日期识别</span>
            </div>
            {"error" in dateResult ? (
              <div className="muted-text">{dateResult.error}</div>
            ) : (
              <div className="stack-gap">
                <div style={{ fontSize: "1.1rem", fontWeight: 600 }}>{dateResult.phrase}</div>
                {dateResult.gregorian && (
                  <div><strong>公历：</strong>{dateResult.gregorian}</div>
                )}
                {dateResult.lunar && (
                  <div><strong>农历：</strong>{dateResult.lunar}</div>
                )}
                {showEmperor && dateResult.emperor && (
                  <div><strong>在位：</strong>{dateResult.emperor}</div>
                )}
                {dateResult.rolledOver && (
                  <div className="muted-text" style={{ fontSize: "0.78rem" }}>
                    （干支日不在所述月份，已尝试下个月匹配）
                  </div>
                )}
                {dateResult.warning && (
                  <div className="muted-text" style={{ fontSize: "0.78rem" }}>{dateResult.warning}</div>
                )}
              </div>
            )}
            <div className="inline-actions">
              <button type="button" className="primary-button" onClick={() => setDateResult(null)}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// v1.2.1：API Key 列表 + 新增/编辑弹窗。
// 列表顺序 = 调用优先级（first match wins），可上移/下移调整。
// 单击条目打开编辑弹窗；编辑表单字段：简称、预设供应商、Base URL、Key（密码）、激活的模型名。
type PresetProviderKey =
  | "dashscope" | "ark" | "deepseek" | "moonshot" | "anthropic"
  | "google" | "openai" | "openrouter" | "minimax";
type PresetSpec = { label: string; baseURL: string; suggestedModels: string[] };
const API_PRESETS: Record<PresetProviderKey, PresetSpec> = {
  dashscope: { label: "百炼 (阿里云 DashScope)", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", suggestedModels: ["deepseek-v4-pro", "qwen3.6-flash-2026-04-16", "kimi-k2.6", "qwen3.6-max-preview"] },
  ark: { label: "火山引擎 (Volcengine Ark)", baseURL: "https://ark.cn-beijing.volces.com/api/v3", suggestedModels: ["doubao-1-5-pro-32k-250115"] },
  deepseek: { label: "DeepSeek 官方", baseURL: "https://api.deepseek.com/v1", suggestedModels: ["deepseek-v4-pro", "deepseek-v4-flash"] },
  moonshot: { label: "Kimi (Moonshot)", baseURL: "https://api.moonshot.cn/v1", suggestedModels: ["kimi-k2-0905-preview", "moonshot-v1-32k"] },
  anthropic: { label: "Anthropic Claude", baseURL: "https://api.anthropic.com/v1", suggestedModels: ["claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5"] },
  google: { label: "Google Gemini", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", suggestedModels: ["gemini-2.5-pro", "gemini-2.5-flash"] },
  openai: { label: "OpenAI", baseURL: "https://api.openai.com/v1", suggestedModels: ["gpt-5", "gpt-5-mini"] },
  openrouter: { label: "OpenRouter（聚合）", baseURL: "https://openrouter.ai/api/v1", suggestedModels: ["anthropic/claude-sonnet-4.5", "openai/gpt-5"] },
  minimax: { label: "MiniMax", baseURL: "https://api.minimax.io/v1", suggestedModels: ["MiniMax-M2", "abab6.5s-chat"] },
};

function ApiKeyListEditor({ providers, onChange }: {
  providers: import("./types").ModelProvider[];
  onChange: (next: import("./types").ModelProvider[]) => void;
}) {
  // editingIdx: -1 = 新增，>=0 = 编辑现有第 i 条，null = 关闭
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [draft, setDraft] = useState<import("./types").ModelProvider | null>(null);
  const [modelDraft, setModelDraft] = useState("");

  const openNew = () => {
    setEditingIdx(-1);
    setDraft({ id: `prov-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, alias: "", presetProvider: "", baseURL: "", apiKey: "", models: [] });
    setModelDraft("");
  };
  const openEdit = (idx: number) => {
    setEditingIdx(idx);
    setDraft({ ...providers[idx] });
    setModelDraft("");
  };
  const close = () => { setEditingIdx(null); setDraft(null); setModelDraft(""); };

  const commitDraft = () => {
    if (!draft) return;
    if (editingIdx === -1) onChange([...providers, draft]);
    else if (editingIdx !== null && editingIdx >= 0) onChange(providers.map((p, i) => (i === editingIdx ? draft : p)));
    close();
  };

  const removeAt = (idx: number) => {
    if (!confirm(`删除「${providers[idx].alias || providers[idx].baseURL || "未命名"}」？`)) return;
    onChange(providers.filter((_, i) => i !== idx));
  };
  const move = (idx: number, dir: -1 | 1) => {
    const target = idx + dir;
    if (target < 0 || target >= providers.length) return;
    const next = [...providers];
    [next[idx], next[target]] = [next[target], next[idx]];
    onChange(next);
  };

  const applyPreset = (key: PresetProviderKey | "") => {
    if (!draft) return;
    if (!key) { setDraft({ ...draft, presetProvider: "" }); return; }
    const preset = API_PRESETS[key];
    setDraft({
      ...draft,
      presetProvider: key,
      alias: draft.alias || preset.label,
      baseURL: draft.baseURL || preset.baseURL,
      models: draft.models.length ? draft.models : preset.suggestedModels,
    });
  };

  const addModelToDraft = () => {
    if (!draft) return;
    const name = modelDraft.trim();
    if (!name || draft.models.includes(name)) return;
    setDraft({ ...draft, models: [...draft.models, name] });
    setModelDraft("");
  };
  const removeModelFromDraft = (m: string) => {
    if (!draft) return;
    setDraft({ ...draft, models: draft.models.filter((x) => x !== m) });
  };

  return (
    <>
      <div className="field-label" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span>已加载的 API Key（顺序 = 调用优先级；同模型出现多次时取第一条）</span>
        <button type="button" className="ghost-button compact-button" onClick={openNew}>+ 新增 API Key</button>
      </div>
      {providers.length === 0 && (
        <div className="muted-text" style={{ fontSize: "0.78rem" }}>
          未加载任何 API Key。点「+ 新增 API Key」添加；至少一条后所有 AI 功能可用。
        </div>
      )}
      <div style={{ display: "grid", gap: "0.4rem" }}>
        {providers.map((p, i) => {
          const masked = p.apiKey ? `${p.apiKey.slice(0, 6)}…${p.apiKey.slice(-4)}` : "（未填）";
          return (
            <div
              key={p.id}
              className="result-card static-card"
              style={{ padding: "0.65rem 0.75rem", cursor: "pointer" }}
              onClick={() => openEdit(i)}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.3rem" }}>
                <strong style={{ color: "#603d1b" }}>{p.alias || p.baseURL || "未命名"}</strong>
                {i === 0 && (
                  <span style={{ background: "#c0903022", color: "#8a5a1d", fontSize: "0.68rem", padding: "0.1rem 0.4rem", borderRadius: "0.3rem", border: "1px solid #c0903055" }}>优先</span>
                )}
                <span className="muted-text" style={{ fontSize: "0.7rem" }}>{p.baseURL}</span>
                <span className="muted-text" style={{ fontSize: "0.7rem", marginLeft: "auto" }}>Key {masked}</span>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.25rem", marginBottom: "0.3rem" }}>
                {p.models.length === 0 && <span className="muted-text" style={{ fontSize: "0.7rem" }}>未激活任何模型</span>}
                {p.models.map((m) => (
                  <span key={m} style={{ background: "rgba(110,66,23,0.08)", borderRadius: "0.35rem", padding: "0.1rem 0.4rem", fontSize: "0.72rem" }}>{m}</span>
                ))}
              </div>
              <div style={{ display: "flex", gap: "0.3rem" }} onClick={(e) => e.stopPropagation()}>
                <button type="button" className="ghost-button compact-button" disabled={i === 0} onClick={() => move(i, -1)} title="上移（提高优先级）">↑</button>
                <button type="button" className="ghost-button compact-button" disabled={i === providers.length - 1} onClick={() => move(i, 1)} title="下移">↓</button>
                <button type="button" className="ghost-button compact-button" onClick={() => openEdit(i)}>编辑</button>
                <button type="button" className="ghost-button compact-button danger" onClick={() => removeAt(i)}>删除</button>
              </div>
            </div>
          );
        })}
      </div>

      {editingIdx !== null && draft && (
        <div className="modal-backdrop" onClick={close} style={{ zIndex: 1100 }}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: "32rem" }}>
            <div className="modal-header">
              <span className="modal-title">{editingIdx === -1 ? "新增 API Key" : "编辑 API Key"}</span>
              <button type="button" className="ghost-button compact-button" onClick={close}>关闭</button>
            </div>
            <div className="stack-gap">
              <label className="field-label">
                简称
                <input className="text-input" value={draft.alias || ""} placeholder="例如：DeepSeek 官方 / 百炼主账号" onChange={(e) => setDraft({ ...draft, alias: e.target.value })} />
              </label>
              <label className="field-label">
                预设供应商（可选，选中后自动填 Base URL 与建议模型，不会覆盖你已填的字段）
                <select className="select-input" value={draft.presetProvider || ""} onChange={(e) => applyPreset(e.target.value as PresetProviderKey | "")}>
                  <option value="">— 完全自定义 —</option>
                  {Object.entries(API_PRESETS).map(([k, v]) => (<option key={k} value={k}>{v.label}</option>))}
                </select>
              </label>
              <label className="field-label">
                Base URL（OpenAI 兼容）
                <input className="text-input" value={draft.baseURL} placeholder="https://api.example.com/v1" onChange={(e) => setDraft({ ...draft, baseURL: e.target.value })} />
              </label>
              <label className="field-label">
                API Key
                <input className="text-input" type="password" value={draft.apiKey} placeholder="sk-..." onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })} />
              </label>
              <div className="field-label">
                <span>激活模型（这些模型名将出现在「主模型 / 小模型」下拉里）</span>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.3rem", marginTop: "0.3rem" }}>
                  {draft.models.length === 0 && <span className="muted-text" style={{ fontSize: "0.74rem" }}>未添加任何模型</span>}
                  {draft.models.map((m) => (
                    <span key={m} style={{ background: "rgba(110,66,23,0.1)", borderRadius: "0.35rem", padding: "0.15rem 0.5rem", fontSize: "0.76rem", display: "inline-flex", alignItems: "center", gap: "0.3rem" }}>
                      {m}
                      <button type="button" onClick={() => removeModelFromDraft(m)} style={{ background: "transparent", border: "none", cursor: "pointer", color: "inherit", fontSize: "0.9rem", lineHeight: 1, padding: 0 }}>×</button>
                    </span>
                  ))}
                </div>
                <div className="custom-model-input" style={{ marginTop: "0.3rem", display: "flex", gap: "0.3rem" }}>
                  <input
                    className="text-input"
                    value={modelDraft}
                    placeholder="模型名（如 deepseek-v4-pro）"
                    onChange={(e) => setModelDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addModelToDraft(); } }}
                  />
                  <button type="button" className="ghost-button compact-button" onClick={addModelToDraft}>+ 添加</button>
                </div>
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.4rem" }}>
                <button type="button" className="ghost-button" onClick={close}>取消</button>
                <button type="button" className="primary-button" onClick={commitDraft} disabled={!draft.baseURL.trim() || !draft.apiKey.trim()}>
                  {editingIdx === -1 ? "添加" : "保存"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}




function TocNode({ item, onSelect }: { item: TocItem; onSelect: (href: string) => void }) {
  return (
    <div className="toc-node">
      <button type="button" className="toc-link" onClick={() => onSelect(item.href)}>
        {item.label}
      </button>
      {item.children.length > 0 && (
        <div className="toc-children">
          {item.children.map((child) => (
            <TocNode key={child.href} item={child} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  );
}

function MingGeographyMap({ places }: { places: GeocodePlace[] }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerLayerRef = useRef<L.LayerGroup | null>(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, { center: [33.5, 108], zoom: 4, minZoom: 3, maxZoom: 12 });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors", maxZoom: 19,
    }).addTo(map);
    const markerLayer = L.layerGroup().addTo(map);
    mapRef.current = map;
    markerLayerRef.current = markerLayer;
    return () => { map.remove(); mapRef.current = null; markerLayerRef.current = null; };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const layer = markerLayerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    const valid = places.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    const bounds: L.LatLngTuple[] = [];
    for (const p of valid) {
      const ll: L.LatLngTuple = [Number(p.lat), Number(p.lng)];
      bounds.push(ll);
      L.marker(ll, {
        icon: L.divIcon({ className: "ming-marker", html: `<span>${p.source === "local" ? "古" : "今"}</span>`, iconSize: [30, 30], iconAnchor: [15, 15] }),
      }).bindPopup(`<strong>${p.name}</strong><br/>今：${p.modernName || "未定"}<br/>${p.note || ""}`).addTo(layer);
    }
    if (bounds.length === 1) map.setView(bounds[0], 8);
    else if (bounds.length > 1) map.fitBounds(bounds, { padding: [28, 28] });
  }, [places]);

  return (
    <div className="map-shell">
      <div ref={containerRef} className="leaflet-map" />
      {!places.length && <div className="map-empty">输入地名后将在这里标点显示。</div>}
    </div>
  );
}

// Map a Ming reign name → its (startYear, endYear) for the "按年号" filter.
const MING_REIGN_RANGES: { reign: string; from: number; to: number }[] = [
  { reign: "洪武", from: 1368, to: 1398 },
  { reign: "建文", from: 1399, to: 1402 },
  { reign: "永乐", from: 1403, to: 1424 },
  { reign: "洪熙", from: 1425, to: 1425 },
  { reign: "宣德", from: 1426, to: 1435 },
  { reign: "正统", from: 1436, to: 1449 },
  { reign: "景泰", from: 1450, to: 1456 },
  { reign: "天顺", from: 1457, to: 1464 },
  { reign: "成化", from: 1465, to: 1487 },
  { reign: "弘治", from: 1488, to: 1505 },
  { reign: "正德", from: 1506, to: 1521 },
  { reign: "嘉靖", from: 1522, to: 1566 },
  { reign: "隆庆", from: 1567, to: 1572 },
  { reign: "万历", from: 1573, to: 1620 },
  { reign: "泰昌", from: 1620, to: 1620 },
  { reign: "天启", from: 1621, to: 1627 },
  { reign: "崇祯", from: 1628, to: 1644 },
];

// Stable color per category, used by both the filter chips and the per-event
// badge so the user can visually scan the timeline by topic.
const CATEGORY_COLORS: Record<string, string> = {
  皇室: "#c8262d",
  政争: "#8d5a3f",
  制度: "#6e7c8e",
  军事: "#3a6f4f",
  民变: "#c9963a",
  外交: "#4f78a3",
  经济: "#7a8a4a",
  灾异: "#a04d8a",
  文化: "#5b6e9c",
  人物: "#7a6a5a",
  其他: "#9aa3aa",
  // 用户笔记单独着色（暖橙），方便和官修史事件视觉区分
  我的笔记: "#d97a3a",
};

function HistoryTimelinePanel({
  notes,
  readableBooks,
  onNoteClick,
  onNoteOpenModal,
}: {
  notes: ReaderNote[];
  readableBooks: ReadableBook[];
  onNoteClick?: (note: ReaderNote) => void;
  onNoteOpenModal?: (note: ReaderNote) => void;
}) {
  // Two interchangeable input modes:
  //   "center" — pick a center year and a ± halfRange (good for "show me a
  //              decade around this year")
  //   "range"  — give explicit start/end years (good for "show me 1573–1620"
  //              or matching a reign exactly). Reign quick-pick fills both
  //              underlying state pairs so toggling modes stays consistent.
  const [mode, setMode] = useState<"center" | "range" | "reign">("range");
  const [centerYear, setCenterYear] = useState<number>(1500);
  const [halfRange, setHalfRange] = useState<number>(40);
  // v1.2.1：默认从 1340 开始，覆盖元末至正年间（明史太祖纪一记的事件，
  //          至正元年=1341 起；之前固定 1368 会把元末札记挡在范围外）。
  const [rangeFrom, setRangeFrom] = useState<number>(1340);
  const [rangeTo, setRangeTo] = useState<number>(1644);
  const [selectedReign, setSelectedReign] = useState<string>("");
  // Importance filter — multi-select. Empty = no restriction (all 5 levels shown).
  // Clicking a chip ADDS that level to the filter; "全部" clears back to empty.
  const [selectedScales, setSelectedScales] = useState<number[]>([]);
  // Double-click event → edit modal
  const [editingEventId, setEditingEventId] = useState<number | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  // Category filter — empty = all categories shown.
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [events, setEvents] = useState<HistoryTimelineEvent[]>([]);
  const [loading, setLoading] = useState(false);
  // Keyword search applied client-side on top of the year/category/scale
  // filters — matches against event description and reign label so the user
  // can narrow within the loaded window without re-querying the backend.
  const [keyword, setKeyword] = useState("");

  const from = mode === "center"
    ? Math.max(1368, centerYear - halfRange)
    : Math.max(1368, Math.min(rangeFrom, rangeTo));
  const to = mode === "center"
    ? Math.min(1644, centerYear + halfRange)
    : Math.min(1644, Math.max(rangeFrom, rangeTo));

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchHistoryTimeline({ from, to, scales: selectedScales, categories: selectedCategories, limit: 5000 })
      .then((res) => { if (!cancelled) setEvents(res.events); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [from, to, selectedScales, selectedCategories, refreshKey]);

  // Compute the effective timeline year for a note: manual override wins,
  // otherwise fall back to auto-detected historicalYear.
  const noteYear = (n: ReaderNote): number | null => {
    if (typeof n.manualYear === "number" && Number.isFinite(n.manualYear)) return n.manualYear;
    if (typeof n.historicalYear === "number") return n.historicalYear;
    return null;
  };

  // Only notes the user has explicitly opted into the timeline are surfaced.
  // Auto-detected notes still need an explicit `inTimeline === true` to show.
  const notesInRange = notes.filter((n) => {
    if (!n.inTimeline) return false;
    const y = noteYear(n);
    return y != null && y >= from && y <= to;
  });

  // Apply client-side keyword filter on top of the year/category/scale window.
  const kw = keyword.trim();
  const filteredEvents = kw
    ? events.filter(
        (e) =>
          (e.description || "").includes(kw) ||
          (e.reign || "").includes(kw) ||
          (e.category || "").includes(kw)
      )
    : events;
  const filteredNotes = kw
    ? notesInRange.filter(
        (n) =>
          (n.text || "").includes(kw) ||
          (n.note || "").includes(kw)
      )
    : notesInRange;

  // Build a year-indexed list of axis points (event or note) for rendering.
  type Item =
    | { kind: "event"; year: number; data: HistoryTimelineEvent }
    | { kind: "note"; year: number; data: ReaderNote };
  const items: Item[] = [
    ...filteredEvents.map((e) => ({ kind: "event" as const, year: e.year, data: e })),
    ...filteredNotes.map((n) => ({ kind: "note" as const, year: noteYear(n)!, data: n })),
  ].sort((a, b) => a.year - b.year);

  const scaleColor = (s: number) => ["#9aa3aa", "#7080a0", "#5a8b6c", "#c9963a", "#c8262d"][Math.max(0, Math.min(4, s - 1))];
  const scaleSize = (s: number) => 6 + s * 2;

  // Click an event/note to recenter on its year. In "center" mode this is just
  // setCenterYear; in "range" mode we keep the current span width and shift
  // both endpoints so the clicked year lands at the middle.
  const recenterOn = (year: number) => {
    if (mode === "center") {
      setCenterYear(year);
    } else {
      // range / reign mode — keep the current span, shift endpoints to center
      // on the clicked year. In reign mode this also clears the active reign
      // pill since the window no longer matches a named reign.
      const halfSpan = Math.max(5, Math.round((rangeTo - rangeFrom) / 2));
      setRangeFrom(Math.max(1368, year - halfSpan));
      setRangeTo(Math.min(1644, year + halfSpan));
      if (mode === "reign") setSelectedReign("");
    }
  };

  return (
    <div className="stack-gap">
      <div className="muted-text" style={{ fontSize: "0.78rem" }}>
        以《明代大事年表》为底，按重要级别分级展示。可按中心年份+范围、起止年份或年号三种方式查询。笔记会按照其历史时间叠加在轴上。
      </div>

      {/* Row 1: three compact dropdowns — mode / category / scale */}
      <div
        className="inline-actions"
        style={{ flexWrap: "wrap", gap: "0.4rem", alignItems: "center" }}
      >
        <label className="field-label" style={{ flex: 1, minWidth: "10rem" }}>
          <span className="muted-text" style={{ fontSize: "0.72rem" }}>查询方式</span>
          <select
            className="select-input"
            value={mode}
            onChange={(e) => setMode(e.target.value as "center" | "range" | "reign")}
          >
            <option value="center">中心年份+范围</option>
            <option value="range">起止年份</option>
            <option value="reign">按年号</option>
          </select>
        </label>
      </div>

      {/* Multi-select chip rows for category and importance. */}
      <div className="stack-gap" style={{ gap: "0.35rem" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.3rem", alignItems: "center" }}>
          <span className="muted-text" style={{ fontSize: "0.72rem", marginRight: "0.2rem" }}>事件类别</span>
          <button
            type="button"
            className={`chip-button${selectedCategories.length === 0 ? " chip-button-active" : ""}`}
            onClick={() => setSelectedCategories([])}
            style={{ fontSize: "0.7rem", padding: "0.18rem 0.55rem" }}
          >全部</button>
          {HISTORY_CATEGORIES.map((c) => {
            const active = selectedCategories.includes(c);
            return (
              <button
                key={c}
                type="button"
                className={`chip-button${active ? " chip-button-active" : ""}`}
                onClick={() => {
                  setSelectedCategories((cur) =>
                    cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c]
                  );
                }}
                style={{
                  fontSize: "0.7rem",
                  padding: "0.18rem 0.55rem",
                  borderColor: active ? CATEGORY_COLORS[c] ?? "#9aa3aa" : undefined,
                  color: active ? CATEGORY_COLORS[c] ?? "#9aa3aa" : undefined,
                }}
              >{c}</button>
            );
          })}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.3rem", alignItems: "center" }}>
          <span className="muted-text" style={{ fontSize: "0.72rem", marginRight: "0.2rem" }}>重要性</span>
          <button
            type="button"
            className={`chip-button${selectedScales.length === 0 ? " chip-button-active" : ""}`}
            onClick={() => setSelectedScales([])}
            style={{ fontSize: "0.7rem", padding: "0.18rem 0.55rem" }}
          >全部</button>
          {[1, 2, 3, 4, 5].map((s) => {
            const active = selectedScales.includes(s);
            const labelMap: Record<number, string> = { 1: "1 细", 2: "2 较细", 3: "3 中", 4: "4 重要", 5: "5 大事" };
            return (
              <button
                key={s}
                type="button"
                className={`chip-button${active ? " chip-button-active" : ""}`}
                onClick={() => {
                  setSelectedScales((cur) =>
                    cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]
                  );
                }}
                style={{ fontSize: "0.7rem", padding: "0.18rem 0.55rem" }}
              >{labelMap[s]}</button>
            );
          })}
        </div>
      </div>

      {/* Row 2: mode-specific filter on the left, keyword search on the right */}
      <div
        className="inline-actions"
        style={{ flexWrap: "wrap", gap: "0.6rem", alignItems: "flex-end" }}
      >
        <div style={{ flex: 2, minWidth: "16rem" }}>
          {mode === "center" && (
            <div className="inline-actions" style={{ flexWrap: "wrap", gap: "0.4rem" }}>
              <label className="field-label" style={{ flex: 1, minWidth: "9rem" }}>
                中心年份 {centerYear}
                <input
                  type="range"
                  min={1368}
                  max={1644}
                  step={1}
                  value={centerYear}
                  onChange={(e) => setCenterYear(parseInt(e.target.value, 10))}
                />
              </label>
              <label className="field-label" style={{ flex: 1, minWidth: "9rem" }}>
                范围 ±{halfRange} 年（{from}–{to}）
                <input
                  type="range"
                  min={5}
                  max={140}
                  step={1}
                  value={halfRange}
                  onChange={(e) => setHalfRange(parseInt(e.target.value, 10))}
                />
              </label>
            </div>
          )}

          {mode === "range" && (
            <div className="inline-actions" style={{ flexWrap: "wrap", gap: "0.4rem" }}>
              <label className="field-label" style={{ flex: 1, minWidth: "8rem" }}>
                起始年份
                <input
                  type="number"
                  min={1368}
                  max={1644}
                  step={1}
                  value={rangeFrom}
                  onChange={(e) => setRangeFrom(parseInt(e.target.value, 10) || 1368)}
                />
              </label>
              <label className="field-label" style={{ flex: 1, minWidth: "8rem" }}>
                结束年份
                <input
                  type="number"
                  min={1368}
                  max={1644}
                  step={1}
                  value={rangeTo}
                  onChange={(e) => setRangeTo(parseInt(e.target.value, 10) || 1644)}
                />
              </label>
              <div className="muted-text" style={{ fontSize: "0.74rem", width: "100%" }}>
                实际范围：{from}–{to}（共 {to - from + 1} 年）
              </div>
            </div>
          )}

          {mode === "reign" && (
            <div className="inline-actions" style={{ flexWrap: "wrap", gap: "0.3rem" }}>
              {MING_REIGN_RANGES.map((r) => (
                <button
                  key={r.reign}
                  type="button"
                  className={`ghost-button compact-button ${selectedReign === r.reign ? "is-active" : ""}`}
                  style={selectedReign === r.reign ? { background: "rgba(110,66,23,0.16)", borderColor: "rgba(110,66,23,0.22)" } : {}}
                  onClick={() => {
                    setSelectedReign(r.reign);
                    setRangeFrom(r.from);
                    setRangeTo(r.to);
                    setCenterYear(Math.round((r.from + r.to) / 2));
                    setHalfRange(Math.max(5, Math.ceil((r.to - r.from) / 2) + 2));
                  }}
                >
                  {r.reign}
                </button>
              ))}
              <div className="muted-text" style={{ fontSize: "0.74rem", width: "100%" }}>
                {selectedReign ? `${selectedReign}（${from}–${to}，共 ${to - from + 1} 年）` : "选择一个年号以载入对应的起止年份。"}
              </div>
            </div>
          )}
        </div>

        <label className="field-label" style={{ flex: 1, minWidth: "12rem" }}>
          <span className="muted-text" style={{ fontSize: "0.72rem" }}>关键词搜索</span>
          <input
            type="search"
            placeholder="如「张居正」「倭寇」"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            className="text-input"
          />
        </label>
      </div>

      <div className="muted-text" style={{ fontSize: "0.74rem" }}>
        {loading
          ? "加载中…"
          : `${filteredEvents.length}/${events.length} 条年表事件 · ${filteredNotes.length}/${notesInRange.length} 条笔记${
              selectedScales.length > 0 && selectedScales.length < 5
                ? " · 重要性: " + [...selectedScales].sort().join(",")
                : ""
            }${selectedCategories.length > 0 ? " · 类别: " + selectedCategories.join("、") : ""}${kw ? ` · 关键词: ${kw}` : ""}`}
      </div>

      <div className="history-timeline">
        {items.map((item, i) => {
          if (item.kind === "event") {
            const e = item.data;
            return (
              <div
                key={`e-${i}`}
                className="ht-row"
                onClick={() => {
                  // v1.2.1：单击 → 打开事件查看/编辑弹窗（可改 title/时间/重要性 + 史料比对 + embedding 检索相关史料）
                  if (e.id) setEditingEventId(e.id);
                  else recenterOn(e.year);
                }}
                title="单击查看/编辑事件并检索相关史料"
              >
                <div className="ht-axis">
                  <span className="ht-year">{e.year}</span>
                  <span
                    className="ht-dot"
                    style={{
                      background: scaleColor(e.scale),
                      width: `${scaleSize(e.scale)}px`,
                      height: `${scaleSize(e.scale)}px`,
                    }}
                  />
                </div>
                <div className="ht-content">
                  <div className="ht-meta">
                    <span className="ht-reign">{e.reign}{e.reignYearText}年</span>
                    <span
                      className="ht-category"
                      style={{
                        background: CATEGORY_COLORS[e.category] + "22",
                        color: CATEGORY_COLORS[e.category],
                        border: `1px solid ${CATEGORY_COLORS[e.category]}55`,
                      }}
                    >
                      {e.category}
                    </span>
                    <span className="ht-scale" style={{ color: scaleColor(e.scale) }}>★{e.scale}</span>
                  </div>
                  <div>{e.description}</div>
                </div>
              </div>
            );
          }
          const n = item.data;
          const bookTitle = readableBooks.find((b) => b.slug === n.bookSlug)?.title || n.bookSlug;
          const noteScale = clamp(n.timelineScale ?? 1, 1, 5);
          const noteCategory = n.timelineCategory ?? "我的札记";
          const noteColor = CATEGORY_COLORS[noteCategory] ?? CATEGORY_COLORS["我的札记"] ?? "#d97a3a";
          const displayTitle = (n.timelineTitle && n.timelineTitle.trim()) || (n.note || "").slice(0, 20);
          // v1.2.1 点击 = 打开"札记 viewer/editor"弹窗（onNoteOpenModal）。
          // 没传时退回旧行为 onNoteClick（跳回原文）或 recenter。
          const handleNoteClick = () => {
            if (onNoteOpenModal) onNoteOpenModal(n);
            else if (onNoteClick) onNoteClick(n);
            else recenterOn(item.year);
          };
          // Also display the resolved date (manual override > auto-detect)
          // — gives the user a quick visual confirmation of when the note
          // is anchored on the axis.
          const dateLabel = (() => {
            if (typeof n.manualYear === "number") {
              let s = `${n.manualYear}年`;
              if (typeof n.manualMonth === "number") s += `${n.manualMonth}月`;
              if (typeof n.manualDay === "number") s += `${n.manualDay}日`;
              return s;
            }
            return n.historicalAt || `${n.historicalYear}年`;
          })();
          return (
            <div key={`n-${i}`} className="ht-row ht-row-note" onClick={handleNoteClick} style={{ cursor: "pointer" }}>
              <div className="ht-axis">
                <span className="ht-year">{item.year}</span>
                <span
                  className="ht-dot ht-dot-note"
                  style={{
                    background: noteColor,
                    width: `${6 + noteScale * 2}px`,
                    height: `${6 + noteScale * 2}px`,
                  }}
                />
              </div>
              <div className="ht-content">
                <div className="ht-meta">
                  <span
                    className="ht-category"
                    style={{
                      background: noteColor + "22",
                      color: noteColor,
                      border: `1px solid ${noteColor}55`,
                    }}
                  >
                    {noteCategory}
                  </span>
                  {bookTitle && <span className="muted-text" style={{ fontSize: "0.7rem" }}>《{bookTitle}》</span>}
                  {dateLabel && <span className="muted-text" style={{ fontSize: "0.7rem" }}>{dateLabel}</span>}
                  <span className="ht-scale" style={{ color: noteColor }}>★{noteScale}</span>
                </div>
                <div style={{ fontWeight: 600 }}>{displayTitle}</div>
                {/* v1.2.1：「有 timelineTitle 的札记只显标题」—— 没 timelineTitle 时仍 fallback 显 note 副内容 + 选段，
                    避免没标题的札记在时间线上没信息。 */}
                {!n.timelineTitle?.trim() && n.note && n.note !== displayTitle && (
                  <div className="muted-text" style={{ fontSize: "0.78rem" }}>{n.note.slice(0, 60)}{n.note.length > 60 ? "…" : ""}</div>
                )}
                {!n.timelineTitle?.trim() && (
                  <div className="muted-text" style={{ fontSize: "0.7rem" }}>选段：{n.text.slice(0, 40)}{n.text.length > 40 ? "…" : ""}</div>
                )}
              </div>
            </div>
          );
        })}
        {items.length === 0 && !loading && <div className="empty-state">当前范围 / 详细级别下没有可显示的事件或笔记。</div>}
      </div>
      {editingEventId != null && (
        <TimelineEventEditModal
          eventId={editingEventId}
          allEvents={events}
          onClose={() => setEditingEventId(null)}
          onSaved={() => { setEditingEventId(null); setRefreshKey((k) => k + 1); }}
        />
      )}
    </div>
  );
}

// (TimelineAdminPanel removed; double-click modal still in TimelineEventEditModal below)

function TimelineEventEditModal({
  eventId,
  allEvents,
  onClose,
  onSaved,
}: {
  eventId: number;
  allEvents: HistoryTimelineEvent[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const initial = allEvents.find((e) => e.id === eventId);
  const [draft, setDraft] = useState<HistoryTimelineEvent | null>(initial || null);
  const [saving, setSaving] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [comparisonResult, setComparisonResult] = useState<string | null>(null);
  const [comparisonError, setComparisonError] = useState<string | null>(null);
  // v1.2.1: embedding 史料检索
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const [evidenceHits, setEvidenceHits] = useState<SearchResult[] | null>(null);

  useEffect(() => {
    if (!initial) {
      // fallback: fetch the single row
      fetchAllTimelineEvents()
        .then((d) => {
          const fresh = d.events.find((x) => x.id === eventId);
          if (fresh) setDraft(fresh);
        })
        .catch(() => {});
    }
  }, [eventId, initial]);

  if (!draft) return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: "32rem", padding: "1.5rem" }}>
        <div>加载中…</div>
      </div>
    </div>
  );

  const save = async () => {
    setSaving(true);
    try {
      await patchTimelineEventApi(eventId, {
        description: draft.description,
        category: draft.category,
        scale: draft.scale,
        hidden: draft.hidden ?? 0,
        year: draft.year,
        reign: draft.reign,
        reignYearText: draft.reignYearText,
      });
      onSaved();
    } catch (err) {
      alert("保存失败：" + (err as Error)?.message);
    } finally {
      setSaving(false);
    }
  };

  const runCompare = async () => {
    setComparing(true);
    setComparisonError(null);
    setComparisonResult(null);
    try {
      // Reuse the existing /api/reference/compare endpoint — it expects a
      // free-form text snippet and returns AI-summarized cross-book hits.
      const response = await fetch("/api/reference/compare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selectedText: draft.description }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      // The compare endpoint returns either a markdown summary or a list of
      // matched paragraphs with snippets — render whatever shape comes back.
      if (typeof data === "string") {
        setComparisonResult(data);
      } else if (data.summary) {
        setComparisonResult(data.summary);
      } else if (Array.isArray(data.results) || Array.isArray(data.hits)) {
        const hits = data.results || data.hits;
        setComparisonResult(
          hits.map((h: any, i: number) =>
            `[${i + 1}] 《${h.bookTitle || h.book || "?"}》 ${h.chapter || ""}\n${h.snippet || h.content || ""}`
          ).join("\n\n")
        );
      } else {
        setComparisonResult(JSON.stringify(data, null, 2));
      }
    } catch (err) {
      setComparisonError((err as Error)?.message || "比对失败");
    } finally {
      setComparing(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: "44rem", maxHeight: "85vh", overflowY: "auto", padding: "1.2rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.6rem" }}>
          <h3 style={{ margin: 0 }}>编辑事件 #{eventId}</h3>
          <button type="button" className="ghost-button compact-button" onClick={onClose}>关闭</button>
        </div>

        <div className="stack-gap">
          <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
            <label className="field-label" style={{ flex: 1, minWidth: "6rem" }}>
              <span className="muted-text" style={{ fontSize: "0.72rem" }}>公元年</span>
              <input className="text-input" type="number" value={draft.year} onChange={(e) => setDraft({ ...draft, year: parseInt(e.target.value, 10) })} />
            </label>
            <label className="field-label" style={{ flex: 1, minWidth: "6rem" }}>
              <span className="muted-text" style={{ fontSize: "0.72rem" }}>年号</span>
              <input className="text-input" value={draft.reign} onChange={(e) => setDraft({ ...draft, reign: e.target.value })} />
            </label>
            <label className="field-label" style={{ flex: 1, minWidth: "6rem" }}>
              <span className="muted-text" style={{ fontSize: "0.72rem" }}>年号年（汉字）</span>
              <input className="text-input" value={draft.reignYearText} onChange={(e) => setDraft({ ...draft, reignYearText: e.target.value })} />
            </label>
          </div>

          <label className="field-label">
            <span className="muted-text" style={{ fontSize: "0.72rem" }}>描述</span>
            <textarea
              className="text-input tall"
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              rows={4}
            />
          </label>

          <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
            <label className="field-label" style={{ flex: 1, minWidth: "8rem" }}>
              <span className="muted-text" style={{ fontSize: "0.72rem" }}>类别</span>
              <select className="select-input" value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })}>
                {HISTORY_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label className="field-label" style={{ flex: 1, minWidth: "8rem" }}>
              <span className="muted-text" style={{ fontSize: "0.72rem" }}>重要性</span>
              <select className="select-input" value={String(draft.scale)} onChange={(e) => setDraft({ ...draft, scale: parseInt(e.target.value, 10) })}>
                {[1, 2, 3, 4, 5].map((s) => <option key={s} value={String(s)}>★{s}</option>)}
              </select>
            </label>
            <label className="field-label" style={{ flex: 0, minWidth: "5rem", justifyContent: "center" }}>
              <span className="muted-text" style={{ fontSize: "0.72rem" }}>隐藏</span>
              <input type="checkbox" checked={Boolean(draft.hidden)} onChange={(e) => setDraft({ ...draft, hidden: e.target.checked ? 1 : 0 })} />
            </label>
          </div>

          <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", marginTop: "0.4rem" }}>
            <button type="button" className="primary-button" onClick={save} disabled={saving}>
              {saving ? "保存中…" : "保存改动"}
            </button>
            <button type="button" className="secondary-button" onClick={runCompare} disabled={comparing} title="调 AI 跨书比对生成报告">
              {comparing ? "比对中…" : "AI 史料比对"}
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={evidenceLoading}
              title="用事件描述做 embedding 相似度检索，列出本地史料里最接近的段落（无需 AI）"
              onClick={async () => {
                setEvidenceLoading(true);
                setEvidenceError(null);
                setEvidenceHits(null);
                try {
                  // semantic search via the existing /api/book/search?mode=semantic endpoint.
                  // aiSettings 字段后端在 semantic 路径下不会用，传空对象即可。
                  const res = await searchBook(draft.description, "semantic", {} as AiSettings, 12);
                  setEvidenceHits(res.results || []);
                } catch (err) {
                  setEvidenceError((err as Error)?.message || "检索失败");
                } finally {
                  setEvidenceLoading(false);
                }
              }}
            >
              {evidenceLoading ? "检索中…" : "相关史料 (embedding)"}
            </button>
          </div>

          {(comparisonResult || comparisonError) && (
            <div style={{ marginTop: "0.6rem", padding: "0.6rem", background: "rgba(110,66,23,0.04)", borderRadius: "0.4rem", maxHeight: "20rem", overflowY: "auto" }}>
              <div style={{ fontSize: "0.74rem", color: "var(--text-muted, #6f6557)", marginBottom: "0.3rem" }}>AI 史料比对结果：</div>
              {comparisonError && <div style={{ color: "#c8262d" }}>{comparisonError}</div>}
              {comparisonResult && <div style={{ whiteSpace: "pre-wrap", fontSize: "0.8rem", lineHeight: 1.5 }}>{comparisonResult}</div>}
            </div>
          )}

          {(evidenceHits || evidenceError) && (
            <div style={{ marginTop: "0.6rem", padding: "0.6rem", background: "rgba(110,66,23,0.04)", borderRadius: "0.4rem", maxHeight: "24rem", overflowY: "auto" }}>
              <div style={{ fontSize: "0.74rem", color: "var(--text-muted, #6f6557)", marginBottom: "0.3rem" }}>
                相关史料（embedding 相似度，{evidenceHits?.length ?? 0} 条）：
              </div>
              {evidenceError && <div style={{ color: "#c8262d" }}>{evidenceError}</div>}
              {evidenceHits && evidenceHits.length === 0 && <div className="muted-text">无命中段落。</div>}
              {evidenceHits && evidenceHits.map((h, i) => (
                <div key={`${h.bookSlug ?? "?"}-${h.id ?? i}`} style={{ marginBottom: "0.5rem", padding: "0.4rem 0.5rem", background: "rgba(255,252,248,0.7)", borderRadius: "0.4rem", border: "1px solid rgba(119,80,41,0.1)" }}>
                  <div style={{ fontSize: "0.72rem", fontWeight: 600, color: "#603d1b" }}>
                    《{h.bookTitle ?? "?"}》· {h.chapterTitle}
                  </div>
                  <div style={{ fontSize: "0.8rem", lineHeight: 1.55, marginTop: "0.2rem", whiteSpace: "pre-wrap" }}>
                    {h.snippet || h.text || ""}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TimelineModal({
  timeline,
  onClose,
}: {
  timeline: TimelineResponse | null;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop">
      <div className="modal-card timeline-modal">
        <div className="panel-headline">
          <History size={18} />
          <span>明代时间轴</span>
        </div>
        <div className="timeline-current">
          {timeline?.current ? (
            <>
              <strong>{timeline.current.templeName}</strong>
              <span>
                {timeline.current.name} · {timeline.current.reignTitles.join(" / ")} · {timeline.current.startYear}-{timeline.current.endYear}
              </span>
              <small>{timeline.current.summary}</small>
            </>
          ) : (
            <span className="muted-text">当前章节未匹配到明确皇帝时期，可继续依靠年号换算与原文上下文判断。</span>
          )}
        </div>

        <div className="timeline-list">
          {timeline?.timeline.map((item) => (
            <div key={item.id} className={`timeline-item ${timeline.current?.id === item.id ? "is-current" : ""}`}>
              <strong>{item.templeName}</strong>
              <span>{item.reignTitles.join(" / ")}</span>
              <small>
                {item.startYear}-{item.endYear}
              </small>
            </div>
          ))}
        </div>

        <div className="inline-actions">
          <button type="button" className="primary-button" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

export default App;
