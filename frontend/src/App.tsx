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
  GitBranch,
  History,
  Highlighter,
  Landmark,
  LibraryBig,
  Languages,
  MapPinned,
  Mic,
  NotebookPen,
  Search,
  Settings2,
  Sparkles,
  UserRound,
  X,
} from "lucide-react";
import "./App.css";
import {
  compareReference,
  convertReignTerm,
  fetchAiChronology,
  fetchChapterContext,
  fetchBookMeta,
  fetchDefaults,
  fetchEmperors,
  fetchLibraryBooks,
  fetchOfficials,
  fetchPersonChronology,
  fetchReaderChapters,
  fetchReaderChapter,
  fetchTimeline,
  geocodePlaces,
  libraryEpubUrl,
  lookupReference,
  runAiAction,
  searchBook,
  searchOfficeReferences,
  synthesizeSpeech,
} from "./lib/api";
import { renderMarkdown } from "./lib/markdown";
import { readPersistedState, writePersistedState } from "./lib/storage";
import { annotateYearMentions, injectReaderDocumentStyles, refreshAnnotationDates } from "./lib/yearAnnotator";
import { resolveSelectionDate, type ResolvedSelectionDate } from "./lib/reign";
import type {
  AiActionResponse,
  AiSettings,
  BookMeta,
  ChronologyResponse,
  CustomAction,
  DbReaderChaptersPayload,
  DbReaderChapterPayload,
  DefaultsPayload,
  EmperorPayload,
  GeocodePlace,
  GeocodeResponse,
  FamilyTreeNode,
  OfficialsPayload,
  OfficeSearchPayload,
  ReadableBook,
  ReignConversionResponse,
  ReaderBookmark,
  ReaderHighlight,
  ReaderNote,
  ReferenceCompareResponse,
  ReferenceLookupResponse,
  SearchResponse,
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
  modelOptions: ["deepseek-v4-pro", "kimi-k2.6", "qwen3.6-max-preview", "MiniMax-M2.5", "qwen3.5-plus-2026-04-20"],
  smallModel: "deepseek-v4-flash",
  smallModelOptions: ["deepseek-v4-flash", "qwen3.6-flash", "qwen3.6-27b"],
  ttsBaseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  ttsModel: "qwen3-tts-flash",
  ttsVoice: "Cherry",
  systemPrompt: "",
  customActions: [],
  modelProviders: [],
};

const highlightPalette = [
  { label: "金笺", color: "#efc24f" },
  { label: "青玉", color: "#67b7a8" },
  { label: "绛砂", color: "#d97c5b" },
];

const CHAPTER_LOCATION_BREAK_SIZE = 650;
const toTraditional = OpenCC.Converter({ from: "cn", to: "tw" });

const sidebarTabs = [
  { key: "toc", label: "目录", icon: BookOpenText },
  { key: "search", label: "搜索", icon: Search },
  { key: "notes", label: "笔记", icon: NotebookPen },
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
  return {
    ...base,
    ...persisted,
    baseURL: persistedBaseUrl,
    ttsBaseURL: persistedTtsBaseUrl,
    model: persisted?.model || base.defaultModel || base.model || "deepseek-v4-pro",
    modelOptions: persisted?.modelOptions?.length ? persisted.modelOptions : base.modelOptions,
    smallModel: persisted?.smallModel || base.smallModel || "deepseek-v4-flash",
    smallModelOptions: persisted?.smallModelOptions?.length ? persisted.smallModelOptions : base.smallModelOptions,
    customActions: customActions.length ? customActions : persisted?.customActions?.length ? persisted.customActions : base.customActions,
    modelProviders: persisted?.modelProviders ?? base.modelProviders ?? [],
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
  const pendingAnchorRef = useRef("");
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
  const [highlightStyle, setHighlightStyle] = useState<{ kind: "highlight" | "underline" | "circle"; color: string }>({ kind: "highlight", color: "#efc24f" });
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
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMode, setSearchMode] = useState<"hybrid" | "ai">("hybrid");
  const [searchResponse, setSearchResponse] = useState<SearchResponse | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState("");
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
  const [bookmarkNameDraft, setBookmarkNameDraft] = useState("");
  const [noteDraft, setNoteDraft] = useState("");
  const [questionDraft, setQuestionDraft] = useState("");
  const [aiResponse, setAiResponse] = useState<AiActionResponse | null>(null);
  const [aiPanelTitle, setAiPanelTitle] = useState("选段助理");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState("");
  const [personQuery, setPersonQuery] = useState("");
  const [personChronology, setPersonChronology] = useState<ChronologyResponse | null>(null);
  const [personLoading, setPersonLoading] = useState(false);
  const [ttsStatus, setTtsStatus] = useState("");
  const [referenceLookup, setReferenceLookup] = useState<ReferenceLookupResponse | null>(null);
  const [referenceCompare, setReferenceCompare] = useState<ReferenceCompareResponse | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [compareLoading, setCompareLoading] = useState(false);
  const [referenceError, setReferenceError] = useState("");
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [, setTimelineLoading] = useState(false);
  const [timelineData, setTimelineData] = useState<TimelineResponse | null>(null);
  const [emperorsData, setEmperorsData] = useState<EmperorPayload | null>(null);
  const [officialsData, setOfficialsData] = useState<OfficialsPayload | null>(null);
  const [officeSearchQuery, setOfficeSearchQuery] = useState("");
  const [officeSearchResult, setOfficeSearchResult] = useState<OfficeSearchPayload | null>(null);
  const [officeSearchLoading, setOfficeSearchLoading] = useState(false);
  const [reignDraft, setReignDraft] = useState("");
  const [reignResult, setReignResult] = useState<ReignConversionResponse | null>(null);
  const [reignLoading, setReignLoading] = useState(false);
  const [referenceFilter, setReferenceFilter] = useState("");
  // Officials panel sub-tabs (v0.3 extended data)
  const [officialsTab, setOfficialsTab] = useState<"institutions" | "offices" | "chronology" | "princes">("institutions");
  const [officeRankFilter, setOfficeRankFilter] = useState("");
  const [chronologyFilter, setChronologyFilter] = useState("");
  const [openResourcePanel, setOpenResourcePanel] = useState<string | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  // Default collapsed — main reading area gets full width on launch.
  // The footer (page slider + status) follows this same flag.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [assistantCollapsed, setAssistantCollapsed] = useState(true);
  const [selectedTreeEmperor, setSelectedTreeEmperor] = useState<FamilyTreeNode | null>(null);
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
  const [readerFontFamily, setReaderFontFamily] = useState<"serif" | "fangsong" | "kaiti" | "lishu" | "shoujin">("fangsong");
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
          savedReaderFontSize,
          savedReaderFontColor,
          savedDateDisplay,
          savedShowEmperor,
          savedUiScriptVariant,
        ] =
          await Promise.all([
            fetchDefaults(),
            fetchLibraryBooks(),
            readPersistedState<AiSettings | null>(storageKey("ai-settings"), null),
            readPersistedState<ReaderHighlight[]>(storageKey("highlights"), []),
            readPersistedState<ReaderNote[]>(storageKey("notes"), []),
            readPersistedState<ReaderBookmark[]>(storageKey("bookmarks"), []),
            readPersistedState<boolean>(storageKey("auto-annotate"), true),
            readPersistedState<string>(storageKey("last-location"), ""),
            readPersistedState<CustomAction[]>(storageKey("custom-actions"), []),
            readPersistedState<"horizontal" | "vertical">(storageKey("reader-layout"), "horizontal"),
            readPersistedState<"simplified" | "traditional">(storageKey("script-variant"), "traditional"),
            readPersistedState<"single" | "double">(storageKey("page-spread"), "single"),
            readPersistedState<string>(storageKey("current-book-slug"), "ming-shi"),
            readPersistedState<"default" | "sepia" | "dark" | "green">(storageKey("reader-theme"), "default"),
            readPersistedState<"serif" | "fangsong" | "kaiti" | "lishu" | "shoujin">(storageKey("reader-font-family"), "fangsong"),
            readPersistedState<number>(storageKey("reader-font-size"), 20),
            readPersistedState<string>(storageKey("reader-font-color"), ""),
            readPersistedState<"gregorian" | "lunar" | "both">(storageKey("date-display"), "lunar"),
            readPersistedState<boolean>(storageKey("show-emperor"), false),
            readPersistedState<"simplified" | "traditional">(storageKey("ui-script-variant"), "traditional"),
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
        // Drop legacy unanchored db-cfis (just `db:slug:idx` — 3 parts) that
        // were saved before paragraph-anchored cfis (5 parts) existed. Those
        // can't be rendered and would pollute the highlight effect.
        setHighlights(
          savedHighlights.filter((h) => !h.cfiRange.startsWith("db:") || h.cfiRange.split(":").length >= 5)
        );
        setNotes(savedNotes);
        setBookmarks(savedBookmarks);
        setAutoAnnotate(savedAutoAnnotate);
        setLastLocation(savedLastLocation);
        setReaderLayout(savedReaderLayout);
        setScriptVariant(savedScriptVariant);
        setPageSpread(savedPageSpread);
        setReaderTheme(savedReaderTheme);
        setReaderFontFamily(savedReaderFontFamily);
        setReaderFontSize(savedReaderFontSize);
        setReaderFontColor(savedReaderFontColor);
        setDateDisplay(savedDateDisplay);
        dateDisplayRef.current = savedDateDisplay;
        setShowEmperor(savedShowEmperor);
        showEmperorRef.current = savedShowEmperor;
        setUiScriptVariant(savedUiScriptVariant);
        readerLayoutRef.current = savedReaderLayout;
        scriptVariantRef.current = savedScriptVariant;
        pageSpreadRef.current = savedPageSpread;
        initialLocationRef.current = savedLastLocation;
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
    void writePersistedState(storageKey("last-location"), lastLocation);
  }, [lastLocation, hasLoadedLocalState]);

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
    const families: Record<typeof readerFontFamily, string> = {
      serif: '"Source Han Serif SC", "Noto Serif SC", "Songti SC", "SimSun", "宋体", serif',
      fangsong: '"FangSong", "STFangsong", "FangSong_GB2312", "仿宋", "Source Han Serif SC", serif',
      kaiti: '"LXGWWenKai", "FZHanWZKJ", "KaiTi", "STKaiti", "BiauKai", "楷体", serif',
      lishu: '"LiSu", "STLiti", "SimLi", "隶书", "FZHanWZKJ", serif',
      shoujin: '"ShoujinTi", "FZHanWZKJ", "LXGWWenKai", "KaiTi", "STKaiti", serif',
    };
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
    element.scrollIntoView({ block: "start" });
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
    const range = sel?.rangeCount ? sel.getRangeAt(0) : null;
    const rect = range?.getBoundingClientRect();
    const popupHeight = 60;
    const belowY = rect ? rect.bottom + window.scrollY + 12 : event.clientY + 12;
    const aboveY = rect ? rect.top + window.scrollY - popupHeight - 12 : belowY;
    const top = (belowY + popupHeight < window.innerHeight + window.scrollY) ? belowY : Math.max(8, aboveY);
    const left = rect ? rect.left + window.scrollX + (rect.width / 2) : event.clientX;
    setSelectionText(text);
    // Build a paragraph-anchored cfi when possible:
    //   db:<slug>:<chapter_idx>:<paragraph_id>:<start>-<end>
    // so we can re-render highlights on the right span on chapter load.
    let pid = "";
    let charStart = -1;
    let charEnd = -1;
    if (range) {
      const findPara = (node: Node | null): HTMLElement | null => {
        let n: Node | null = node;
        while (n && n.nodeType !== 1) n = n.parentNode;
        let el = n as HTMLElement | null;
        while (el && !el.dataset?.paragraphId) el = el.parentElement;
        return el;
      };
      const startPara = findPara(range.startContainer);
      const endPara = findPara(range.endContainer);
      if (startPara && startPara === endPara) {
        pid = startPara.dataset.paragraphId || "";
        // Compute character offset from para start to range start/end.
        const offsetIn = (target: Node, off: number) => {
          const walker = document.createTreeWalker(startPara, NodeFilter.SHOW_TEXT);
          let pos = 0;
          while (walker.nextNode()) {
            const tn = walker.currentNode;
            if (tn === target) return pos + off;
            pos += (tn.nodeValue || "").length;
          }
          return pos;
        };
        charStart = offsetIn(range.startContainer, range.startOffset);
        charEnd = offsetIn(range.endContainer, range.endOffset);
      }
    }
    const cfi = pid && charStart >= 0 && charEnd > charStart
      ? `db:${currentBookSlug}:${dbReaderIndex}:${pid}:${charStart}-${charEnd}`
      : `db:${currentBookSlug}:${dbReaderIndex}`;
    setSelectionCfi(cfi);
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
      initialLocationRef.current = "";
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

    const loc = renditionRef.current.currentLocation?.() as EpubLocationLike | null;
    const liveTotal = loc?.start?.displayed?.total || 1;
    const livePage = loc?.start?.displayed?.page || 1;

    if (liveTotal <= 1) return;

    const safePage = clamp(targetPage, 1, liveTotal);
    if (safePage === livePage) return;

    const stepsNeeded = safePage - livePage;
    const rendition = renditionRef.current;
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
    const FONT_FACE_CSS = `
      @font-face { font-family: "ShoujinTi"; src: url("${window.location.origin}/fonts/shoujin-simplified.ttf") format("truetype"); font-display: swap; unicode-range: U+4E00-9FFF, U+3000-303F, U+FF00-FFEF; }
      @font-face { font-family: "ShoujinTi"; src: url("${window.location.origin}/fonts/shoujin-traditional.ttf") format("truetype"); font-display: swap; unicode-range: U+3400-4DBF, U+F900-FAFF, U+20000-2A6DF; }
      @font-face { font-family: "LXGWWenKai"; src: url("${window.location.origin}/fonts/lxgw-wenkai.ttf") format("truetype"); font-display: swap; }
      @font-face { font-family: "FZHanWZKJ"; src: url("${window.location.origin}/fonts/kaiti.ttf") format("truetype"); font-display: swap; }
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

    rendition.on("rendered", (_section: unknown, contents: EpubContentsLike) => {
      const doc = contents.document as Document;
      applyReaderDocumentPreferences(doc);
      scrollPendingAnchorIntoView(doc);
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
        rendition.resize?.(w, h);
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
      // db : slug : chapterIdx : pid : start-end
      return parts[1] === currentBookSlug && Number(parts[2]) === dbReaderIndex;
    });
    if (!dbHighlights.length) return;

    // Defer one frame so the fresh paragraphs from `dbReaderChapter` are in
    // the DOM before we try to walk them.
    const id = requestAnimationFrame(() => {
      for (const item of dbHighlights) {
        const parts = item.cfiRange.split(":");
        const pid = parts[3];
        const offsets = parts[4] || "";
        const [a, b] = offsets.split("-").map(Number);
        if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) continue;
        const para = host.querySelector(`[data-paragraph-id="${pid}"]`) as HTMLElement | null;
        if (!para) continue;

        // Walk text nodes to translate (charStart, charEnd) → (textNode, offset).
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
        if (!startNode || !endNode) continue;

        const range = document.createRange();
        try {
          range.setStart(startNode, startOff);
          range.setEnd(endNode, endOff);
        } catch {
          continue;
        }

        const span = document.createElement("span");
        span.className = `db-mark-wrap db-mark-${item.kind}`;
        span.dataset.highlightId = item.id;
        if (item.kind === "highlight") {
          span.style.backgroundColor = item.color || "#efc24f";
          span.style.opacity = "1";
          // Match epub.js highlight feel: semi-transparent rect over text.
          span.style.background = `${item.color || "#efc24f"}66`; // 66 = ~40% alpha
          span.style.padding = "0 0.05em";
        } else if (item.kind === "underline") {
          span.style.borderBottom = `2px solid ${item.color || "#d4231b"}`;
          span.style.paddingBottom = "0.05em";
        } else if (item.kind === "circle") {
          // 古文圈点 — dotted underline (matches the EPUB-side style)
          span.style.borderBottom = `2px dotted ${item.color || "#d4231b"}`;
          span.style.paddingBottom = "0.05em";
        }
        try {
          range.surroundContents(span);
        } catch {
          // Range crosses element boundaries inside the paragraph (rare; we
          // already filter for same-paragraph at save time). Skip silently.
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
        renditionRef.current.resize?.(Math.round(rect.width), Math.round(rect.height));
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
    // DB-reader cfi without paragraph anchor (just `db:slug:idx`) means the
    // selection spanned multiple paragraphs — can't reliably re-render. Warn
    // and bail. Properly-anchored cfis (`db:slug:idx:pid:start-end`) save fine.
    if (selectionCfi.startsWith("db:") && selectionCfi.split(":").length < 5) {
      setAiError("跨段勾画暂不支持，请在单个段落内选段后再标记。");
      clearSelection();
      return;
    }
    const item: ReaderHighlight = {
      id: crypto.randomUUID(),
      cfiRange: selectionCfi,
      text: selectionText,
      color,
      kind,
      createdAt: new Date().toISOString(),
    };
    setHighlights((current) => [item, ...current]);
    clearSelection();
  }

  function startNoteComposer() {
    if (!selectionText.trim()) return;
    setNoteDraft("");
    setNoteComposerOpen(true);
  }

  function saveNote() {
    if (!noteDraft.trim()) return;

    // Editing an existing note
    if (editingNoteId) {
      setNotes((current) => current.map((n) => n.id === editingNoteId ? { ...n, note: noteDraft.trim() } : n));
      setEditingNoteId(null);
      setNoteDraft("");
      setNoteComposerOpen(false);
      return;
    }

    // Creating a new note
    if (!selectionText.trim() || !selectionCfi) return;
    const note: ReaderNote = {
      id: crypto.randomUUID(),
      cfiRange: selectionCfi,
      text: selectionText,
      note: noteDraft.trim(),
      createdAt: new Date().toISOString(),
    };
    setNotes((current) => [note, ...current]);

    if (!highlights.some((item) => item.cfiRange === selectionCfi)) {
      setHighlights((current) => [
        {
          id: crypto.randomUUID(),
          cfiRange: selectionCfi,
          text: selectionText,
          color: "#efc24f",
          kind: "highlight",
          createdAt: new Date().toISOString(),
        },
        ...current,
      ]);
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

  async function handleReignConvert() {
    if (!reignDraft.trim()) return;
    try {
      setReignLoading(true);
      setReferenceError("");
      const result = await convertReignTerm(reignDraft.trim());
      setReignResult(result);
    } catch (error) {
      setReferenceError(error instanceof Error ? error.message : "年号换算失败。");
    } finally {
      setReignLoading(false);
    }
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
  function handleResolveSelectionDate() {
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

    const resolved = resolveSelectionDate(selectionText, contextBefore, dateDisplay, showEmperor);
    if (!resolved) {
      setDateResult({ error: "选段及其前文中未找到可识别的明代年号 / 月份 / 干支日。" });
      return;
    }
    setDateResult(resolved);
  }

  async function handleReferenceLookup(targetText = selectionText) {
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

  async function handleCrossCompare(targetText = selectionText, supplement = "") {
    if (!targetText.trim()) {
      setReferenceError("请先选中一段《明史》原文。");
      return;
    }

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

  async function openTimelinePanel() {
    try {
      setTimelineLoading(true);
      setReferenceError("");
      const hint = currentSectionLabel || selectionText;
      const timeline = await fetchTimeline(hint);
      setTimelineData(timeline);
      setTimelineOpen(true);
    } catch (error) {
      setReferenceError(error instanceof Error ? error.message : "时间轴加载失败。");
    } finally {
      setTimelineLoading(false);
    }
  }

  function requestAiAction(type: "translate" | "pronounce" | "explain" | "qa" | "custom", customAction?: CustomAction) {
    if (type !== "qa" && !selectionText.trim()) {
      setAiError("请先在正文里选中一段文字。");
      return;
    }
    if (type === "qa" && !questionDraft.trim()) {
      setAiError("请输入要提问的内容。");
      return;
    }
    if (promptSupplementEnabled && type !== "qa") {
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
      void handleCrossCompare(selectionText, supplement);
    } else {
      const { type, customAction } = pendingAction;
      setPendingAction(null);
      void performAiAction(type as any, customAction, supplement);
    }
  }

  async function performAiAction(type: "translate" | "pronounce" | "explain" | "qa" | "custom", customAction?: CustomAction, supplement = "") {
    if (type !== "qa" && !selectionText.trim()) {
      setAiError("请先在正文里选中一段文字。");
      return;
    }
    if (type === "qa" && !questionDraft.trim()) {
      setAiError("请输入要提问的内容。");
      return;
    }

    const effectiveQuestion = supplement ? `${questionDraft}\n补充说明：${supplement}` : questionDraft;

    try {
      setAiLoading(true);
      setAiError("");
      setAiResponse(null);
      setAiPanelTitle(
        type === "custom" ? customAction?.name || "自定义操作" : type === "qa" ? "问答" : type === "translate" ? "翻译为现代文" : type === "pronounce" ? "读音标注" : "解释",
      );
      const response = await runAiAction({
        type,
        selection: supplement ? `${selectionText}\n【用户补充】${supplement}` : selectionText,
        question: effectiveQuestion,
        aiSettings: {
          ...aiSettings,
          customActions,
        },
        customAction,
      });
      setAiResponse(response);
      clearSelection();
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
      const response = await searchBook(searchQuery.trim(), searchMode, aiSettings);
      startTransition(() => {
        setSearchResponse(response);
      });
    } catch (error) {
      setSearchError(error instanceof Error ? error.message : "搜索失败。");
    } finally {
      setSearchLoading(false);
    }
  }

  async function loadPersonChronology(useAi: boolean) {
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
      setAiError(error instanceof Error ? error.message : "人物编年加载失败。");
    } finally {
      setPersonLoading(false);
    }
  }

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
      `# ${meta?.metadata.title || "明史"}阅读笔记`,
      "",
      `导出时间：${new Date().toLocaleString("zh-CN")}`,
      "",
      ...notes.flatMap((note, index) => [
        `## ${index + 1}. ${formatTime(note.createdAt)}`,
        "",
        `原文：${note.text}`,
        "",
        `笔记：${note.note}`,
        "",
        `位置：${note.cfiRange}`,
        "",
      ]),
    ];
    downloadTextFile("明史-阅读笔记.md", lines.join("\n"));
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
                  {readableBooks.map((book) => (
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
                  ))}
                </div>
              )}
            </div>
            <button type="button" className="ghost-button compact-button sidebar-collapse-btn" onClick={() => setSidebarCollapsed(true)} title="折叠侧边栏">
              &lsaquo;
            </button>
          </div>
          <h1>
            {"明史阅读器"}
            <button type="button" className="version-badge" onClick={() => setAboutOpen(true)}>v0.4.1</button>
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
                  <select value={searchMode} onChange={(event) => setSearchMode(event.target.value as "hybrid" | "ai")} className="select-input">
                    <option value="hybrid">本地模糊检索</option>
                    <option value="ai">AI 意图检索</option>
                  </select>
                  <button type="button" className="primary-button" onClick={handleSearch} disabled={searchLoading}>
                    {searchLoading ? "检索中…" : "开始搜索"}
                  </button>
                </div>
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
                          onClick={() => openLocation(result.chapterHref)}
                        >
                          <div className="result-title">{result.chapterTitle}</div>
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
                <span>随手笔记</span>
                <div className="header-actions">
                  <button type="button" className="ghost-button compact-button" onClick={exportNotes} disabled={!notes.length}>
                    <Download size={15} />
                    导出
                  </button>
                </div>
              </div>
              <div className="result-list">
                {notes.length === 0 && <div className="empty-state">先在正文里选段，再点"记笔记"。</div>}
                {notes.map((note) => {
                  const isExpanded = expandedNoteId === note.id;
                  const preview = note.note.length > 30 ? note.note.slice(0, 30) + "…" : note.note;
                  return (
                    <div key={note.id} className="result-card static-card">
                      <button type="button" className="note-summary-row" onClick={() => setExpandedNoteId(isExpanded ? null : note.id)}>
                        <span className="note-time">{formatTime(note.createdAt)}</span>
                        <span className="note-preview">{preview}</span>
                        <span className="note-expand-icon">{isExpanded ? "▾" : "▸"}</span>
                      </button>
                      {isExpanded && (
                        <div className="note-detail">
                          <div className="result-snippet">{note.text}</div>
                          <div className="note-body">{note.note}</div>
                          <div className="inline-actions">
                            <button type="button" className="ghost-button" onClick={() => openLocation(note.cfiRange)}>回到原文</button>
                            <button type="button" className="ghost-button" onClick={() => { setEditingNoteId(note.id); setNoteDraft(note.note); setNoteComposerOpen(true); }}>编辑</button>
                            <button type="button" className="ghost-button danger" onClick={() => { setNotes((current) => current.filter((item) => item.id !== note.id)); setExpandedNoteId(null); }}>删除</button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
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
                <button type="button" className="resource-entry-button" onClick={() => setOpenResourcePanel("chronology")}>
                  <UserRound size={16} />
                  <span>人物编年</span>
                </button>
                <button type="button" className="resource-entry-button" onClick={() => setOpenResourcePanel("reign")}>
                  <Calculator size={16} />
                  <span>年号换算</span>
                </button>
                <button type="button" className="resource-entry-button" onClick={() => setOpenResourcePanel("familytree")}>
                  <GitBranch size={16} />
                  <span>主支谱系</span>
                </button>
                <button type="button" className="resource-entry-button" onClick={() => setOpenResourcePanel("officials")}>
                  <Landmark size={16} />
                  <span>职官检索</span>
                </button>
                <button type="button" className="resource-entry-button" onClick={() => setOpenResourcePanel("map")}>
                  <MapPinned size={16} />
                  <span>古今地名地图</span>
                </button>
                <button type="button" className="resource-entry-button" onClick={() => void openTimelinePanel()}>
                  <History size={16} />
                  <span>时间轴</span>
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
                <label className="field-label">
                  虚拟翻页分栏
                  <select className="select-input" value={pageSpread} onChange={(event) => setPageSpread(event.target.value as "single" | "double")}>
                    <option value="single">单栏分页</option>
                    <option value="double">双栏对开分页</option>
                  </select>
                </label>
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
                <label className="field-label">
                  正文字体
                  <select className="select-input" value={readerFontFamily} onChange={(e) => setReaderFontFamily(e.target.value as "serif" | "fangsong" | "kaiti" | "lishu" | "shoujin")}>
                    <option value="serif">宋体（系统）</option>
                    <option value="fangsong">仿宋（系统）</option>
                    <option value="kaiti">楷书（霞鹜文楷·内置）</option>
                    <option value="lishu">隶书（系统）</option>
                    <option value="shoujin">瘦金体（方正·内置）</option>
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
            <div className="selection-title">当前选段</div>
            <div className="selection-body">{selectionText || "在正文中选中一段内容后，可一键翻译为现代文、标音、解释、做笔记或进行史料比对。"}</div>
            <div className="action-grid">
              <button type="button" className="ghost-button" onClick={() => void requestAiAction("translate")} disabled={!hasSelection || aiLoading}>
                <Languages size={15} />
                现代文
              </button>
              <button type="button" className="ghost-button" onClick={() => void requestAiAction("pronounce")} disabled={!hasSelection || aiLoading}>
                <Mic size={15} />
                读音
              </button>
              <button type="button" className="ghost-button" onClick={() => void requestAiAction("explain")} disabled={!hasSelection || aiLoading}>
                <Brain size={15} />
                解释
              </button>
              <button type="button" className="ghost-button" onClick={() => void handleReferenceLookup()} disabled={!hasSelection || lookupLoading}>
                <MapPinned size={15} />
                百科
              </button>
              <button type="button" className="ghost-button" onClick={() => void requestCrossCompare()} disabled={!hasSelection || compareLoading}>
                <LibraryBig size={15} />
                史料比对
              </button>
              <button type="button" className="ghost-button" onClick={startNoteComposer} disabled={!hasSelection}>
                <NotebookPen size={15} />
                记笔记
              </button>
            </div>
            {customActions.filter((a) => a.id !== "vernacular" && a.name !== "结构梳理" && a.name !== "翻译为现代文").slice(0, 3).map((action) => (
              <button
                key={action.id}
                type="button"
                className="secondary-button full-width"
                onClick={() => void requestAiAction("custom", action)}
                disabled={!hasSelection || aiLoading}
              >
                <Sparkles size={15} />
                {action.name}
              </button>
            ))}
          </div>

          <div className="question-box">
            <label className="field-label">
              直接提问
              <textarea
                className="text-input tall"
                value={questionDraft}
                onChange={(event) => setQuestionDraft(event.target.value)}
                placeholder="例如：这段到底在讲什么？相关人物是谁？若不看选段，直接回答'土木之变的转折点是什么'也可以。"
              />
            </label>
            <button
              type="button"
              className="primary-button full-width"
              onClick={() => void requestAiAction("qa")}
              disabled={aiLoading || !questionDraft.trim()}
            >
              {aiLoading ? "AI 思考中…" : "开始问答"}
            </button>
          </div>

          {aiError && <div className="error-box">{aiError}</div>}
          {referenceError && <div className="error-box">{referenceError}</div>}

          {(aiLoading || aiResponse) && (
          <div className="answer-panel">
            <div className="panel-headline small">
              <Sparkles size={16} />
              <span>{aiPanelTitle}</span>
            </div>
            <div className="answer-card">{aiLoading ? "AI 正在思考…" : aiResponse?.answer || ""}</div>
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
            <div className="answer-card">
              {lookupLoading
                ? "正在检索本地资料并请求 AI 释义…"
                : referenceLookup?.aiExplanation || "选中官职、人物、地名、年号后，可一键查看百科说明。"}
            </div>
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
              <span>记笔记</span>
            </div>
            {selectionText.trim() && <div className="muted-text" style={{ fontSize: "0.75rem" }}>选段：{selectionText.slice(0, 40)}{selectionText.length > 40 ? "…" : ""}</div>}
            <textarea
              ref={noteInputRef}
              className="text-input"
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              placeholder={selectionText.trim() ? "为选中的文段写笔记…" : "先在正文中选段，再写笔记"}
              rows={2}
            />
            <button
              type="button"
              className="primary-button"
              disabled={!noteDraft.trim() || !selectionText.trim() || !selectionCfi}
              onClick={saveNote}
              style={{ alignSelf: "flex-end" }}
            >
              保存笔记
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
        <div className="selection-backdrop" onClick={clearSelection} />
        <div className="selection-toolbar" style={{ top: selectionOverlay.top, left: selectionOverlay.left }}>
          <button type="button" className="toolbar-mini close-mini" onClick={clearSelection} title="关闭">
            <X size={14} />
          </button>
          <div className="mark-group">
            <div className="mark-style-picker">
              {highlightPalette.map((item) => (
                <button key={item.label} type="button" className={`color-pick ${highlightStyle.kind === "highlight" && highlightStyle.color === item.color ? "is-active" : ""}`} onClick={() => setHighlightStyle({ kind: "highlight", color: item.color })} title={item.label}>
                  <span className="color-dot" style={{ backgroundColor: item.color }} />
                </button>
              ))}
              <button type="button" className={`color-pick ${highlightStyle.kind === "underline" ? "is-active" : ""}`} onClick={() => setHighlightStyle({ kind: "underline", color: "#d4231b" })} title="下划线（正红）">
                <span className="underline-icon">U</span>
              </button>
              <button type="button" className={`color-pick ${highlightStyle.kind === "circle" ? "is-active" : ""}`} onClick={() => setHighlightStyle({ kind: "circle", color: "#d4231b" })} title="圈点（正红 · 古文勾画法）">
                <span className="circle-icon">⠿</span>
              </button>
            </div>
            <button type="button" className="toolbar-mini" onClick={() => addSelectionHighlight(highlightStyle.kind, highlightStyle.color)}>
              <Highlighter size={14} />
              标记
            </button>
          </div>
          {selectionHighlight && (
            <button type="button" className="toolbar-mini danger-mini" onClick={() => { removeHighlight(selectionHighlight); clearSelection(); }}>
              删除勾画
            </button>
          )}
          <button type="button" className="toolbar-mini" onClick={() => { setAssistantCollapsed(false); noteInputRef.current?.focus(); }}>笔记</button>
          <button type="button" className="toolbar-mini" onClick={() => void requestAiAction("pronounce")} disabled={aiLoading}>读音</button>
          <button type="button" className="toolbar-mini" onClick={handleResolveSelectionDate}>识别日期</button>
          <button type="button" className="toolbar-mini" onClick={() => void handleReferenceLookup()} disabled={lookupLoading}>百科</button>
          <button type="button" className="toolbar-mini" onClick={() => void requestCrossCompare()} disabled={compareLoading}>史料比对</button>
          <button type="button" className="toolbar-mini" onClick={() => void requestAiAction("translate")} disabled={aiLoading}>现代文</button>
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
                {openResourcePanel === "chronology" && "人物编年"}
                {openResourcePanel === "reign" && "年号 / 公元换算"}
                {openResourcePanel === "familytree" && "主支三代谱系"}
                {openResourcePanel === "officials" && "职官制度与检索"}
                {openResourcePanel === "map" && "古今地名地图"}
                {openResourcePanel === "custom-actions" && "自定义 AI 操作"}
              </span>
              <button type="button" className="ghost-button compact-button" onClick={() => setOpenResourcePanel(null)}>关闭</button>
            </div>

            {openResourcePanel === "chronology" && (
              <div className="stack-gap">
                <div className="muted-text">输入人物名，检索《明史》编年与 AI 整理。</div>
                <input
                  className="text-input"
                  value={personQuery}
                  onChange={(event) => setPersonQuery(event.target.value)}
                  placeholder="如 朱元璋、王守仁、张居正"
                />
                <div className="inline-actions">
                  <button type="button" className="primary-button" onClick={() => void loadPersonChronology(false)} disabled={personLoading}>
                    本地整理
                  </button>
                  <button type="button" className="secondary-button" onClick={() => void loadPersonChronology(true)} disabled={personLoading}>
                    {personLoading ? "AI 编年中…" : "AI 编年"}
                  </button>
                </div>
                {aiError && <div className="error-box">{aiError}</div>}
                {personLoading && <div className="muted-text">检索《明史》并请 AI 整理中，通常 30–60 秒…</div>}
                {personChronology?.summary && <div className="answer-card">{personChronology.summary}</div>}
                <div className="result-list compact">
                  {personChronology?.items.slice(0, 8).map((item) => (
                    <button key={item.id} type="button" className="result-card" onClick={() => { openLocation(item.chapterHref); setOpenResourcePanel(null); }}>
                      <div className="result-title">{item.chapterTitle}</div>
                      <div className="result-snippet">{item.snippet}</div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {openResourcePanel === "reign" && (
              <div className="stack-gap">
                <input
                  className="text-input"
                  value={reignDraft}
                  onChange={(event) => setReignDraft(event.target.value)}
                  placeholder="如 弘治三年 / 公元1490年 / 1490"
                />
                <div className="inline-actions">
                  <button type="button" className="primary-button" onClick={() => void handleReignConvert()} disabled={reignLoading || !reignDraft.trim()}>
                    {reignLoading ? "换算中…" : "立即换算"}
                  </button>
                </div>
                {reignResult && (
                  <div className="detail-grid">
                    <div className="detail-item">
                      <strong>结果</strong>
                      <span>{reignResult.reignLabel ? `${reignResult.reignLabel} ⇄ 公元${reignResult.gregorian}年` : `${reignResult.label} ⇄ ${reignResult.reign} ${reignResult.year} 年`}</span>
                    </div>
                    <div className="detail-item"><strong>皇帝</strong><span>{reignResult.emperor}</span></div>
                    <div className="detail-item"><strong>说明</strong><span>{reignResult.note}</span></div>
                  </div>
                )}
              </div>
            )}

            {openResourcePanel === "familytree" && (
              <div className="dynasty-tree-container">
                {selectedTreeEmperor ? (
                  <div className="emperor-detail-card">
                    <button type="button" className="ghost-button compact-button" onClick={() => setSelectedTreeEmperor(null)}>
                      &larr; 返回世系图
                    </button>
                    <h3>{selectedTreeEmperor.seq ? `(${selectedTreeEmperor.seq}) ` : ""}{selectedTreeEmperor.name}</h3>
                    <div className="emperor-detail-meta">
                      {selectedTreeEmperor.isEmperor && <span className="soft-tag emperor-tag">皇帝</span>}
                      {selectedTreeEmperor.reign && <span className="soft-tag">在位 {selectedTreeEmperor.reign}</span>}
                      {selectedTreeEmperor.life && <span className="soft-tag">生卒 {selectedTreeEmperor.life}</span>}
                      <span className="soft-tag">{selectedTreeEmperor.relation}</span>
                    </div>
                    <p className="emperor-detail-summary">{selectedTreeEmperor.summary || "暂无简介。"}</p>
                    {(() => {
                      const profile = emperorsData?.list.find((entry) => entry.id === selectedTreeEmperor.id);
                      if (!profile) return null;
                      return (
                        <div className="detail-grid">
                          <div className="detail-item"><strong>庙号</strong><span>{profile.templeName}</span></div>
                          <div className="detail-item"><strong>谥号</strong><span>{profile.posthumousTitle}</span></div>
                          <div className="detail-item"><strong>年号</strong><span>{profile.reignTitles?.join(" / ")}</span></div>
                          <div className="detail-item"><strong>生卒</strong><span>{profile.birthYear ?? "不详"} - {profile.deathYear ?? "不详"}</span></div>
                          {profile.father && <div className="detail-item"><strong>父</strong><span>{profile.father}</span></div>}
                          {profile.mother && <div className="detail-item"><strong>母</strong><span>{profile.mother}</span></div>}
                        </div>
                      );
                    })()}
                  </div>
                ) : (
                  <DynastyTree node={emperorsData?.familyTree} onSelect={setSelectedTreeEmperor} />
                )}
              </div>
            )}

            {openResourcePanel === "officials" && (
              <div className="stack-gap">
                <div className="officials-tabs">
                  {([
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
              <span className="modal-title">自定义 API 配置</span>
              <button type="button" className="ghost-button compact-button" onClick={() => setApiConfigOpen(false)}>关闭</button>
            </div>
            <div className="stack-gap">
              <label className="field-label">
                预设供应商（选择后自动填 Base URL + 常用模型名；不会覆盖已填的 API Key）
                <select
                  className="select-input"
                  value=""
                  onChange={(e) => {
                    const key = e.target.value;
                    if (!key) return;
                    const presets: Record<string, Partial<typeof aiSettings>> = {
                      dashscope: {
                        baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
                        modelOptions: ["deepseek-v4-pro", "kimi-k2.6", "qwen3.6-max-preview", "MiniMax-M2.5", "qwen3.5-plus-2026-04-20"],
                        model: "deepseek-v4-pro",
                        smallModelOptions: ["deepseek-v4-flash", "qwen3.6-flash", "qwen3.6-27b"],
                        smallModel: "deepseek-v4-flash",
                        ttsBaseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
                        ttsModel: "qwen3-tts-flash",
                      },
                      ark: {
                        baseURL: "https://ark.cn-beijing.volces.com/api/v3",
                        modelOptions: ["doubao-1-5-pro-32k-250115", "doubao-1-5-pro-256k-250115"],
                        model: "doubao-1-5-pro-32k-250115",
                        smallModelOptions: ["doubao-1-5-lite-32k-250115"],
                        smallModel: "doubao-1-5-lite-32k-250115",
                      },
                      deepseek: {
                        baseURL: "https://api.deepseek.com/v1",
                        modelOptions: ["deepseek-chat", "deepseek-reasoner"],
                        model: "deepseek-chat",
                        smallModelOptions: ["deepseek-chat"],
                        smallModel: "deepseek-chat",
                      },
                      moonshot: {
                        baseURL: "https://api.moonshot.cn/v1",
                        modelOptions: ["kimi-k2-0905-preview", "moonshot-v1-32k"],
                        model: "kimi-k2-0905-preview",
                        smallModelOptions: ["moonshot-v1-8k"],
                        smallModel: "moonshot-v1-8k",
                      },
                      anthropic: {
                        // Native /v1/messages endpoint. Anthropic provides an
                        // OpenAI-compat shim at /v1 for the chat-completions
                        // shape; works for most clients.
                        baseURL: "https://api.anthropic.com/v1",
                        modelOptions: ["claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5"],
                        model: "claude-sonnet-4-5",
                        smallModelOptions: ["claude-haiku-4-5"],
                        smallModel: "claude-haiku-4-5",
                      },
                      google: {
                        // Gemini's OpenAI-compatible endpoint
                        baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
                        modelOptions: ["gemini-2.5-pro", "gemini-2.5-flash"],
                        model: "gemini-2.5-pro",
                        smallModelOptions: ["gemini-2.5-flash-lite", "gemini-2.5-flash"],
                        smallModel: "gemini-2.5-flash",
                      },
                      openai: {
                        baseURL: "https://api.openai.com/v1",
                        modelOptions: ["gpt-5", "gpt-5-mini", "gpt-4.1"],
                        model: "gpt-5",
                        smallModelOptions: ["gpt-5-mini", "gpt-4.1-mini"],
                        smallModel: "gpt-5-mini",
                      },
                      openrouter: {
                        baseURL: "https://openrouter.ai/api/v1",
                        // OpenRouter routes use `provider/model-name` slugs.
                        modelOptions: [
                          "anthropic/claude-sonnet-4.5",
                          "openai/gpt-5",
                          "google/gemini-2.5-pro",
                          "deepseek/deepseek-v3.2-exp",
                        ],
                        model: "anthropic/claude-sonnet-4.5",
                        smallModelOptions: ["anthropic/claude-haiku-4.5", "openai/gpt-5-mini"],
                        smallModel: "anthropic/claude-haiku-4.5",
                      },
                      minimax: {
                        baseURL: "https://api.minimax.io/v1",
                        modelOptions: ["MiniMax-M2", "MiniMax-Text-01", "abab6.5s-chat"],
                        model: "MiniMax-M2",
                        smallModelOptions: ["abab6.5s-chat"],
                        smallModel: "abab6.5s-chat",
                      },
                    };
                    const next = presets[key];
                    if (next) setAiSettings((c) => ({ ...c, ...next }));
                  }}
                >
                  <option value="">— 选择预设 —</option>
                  <option value="dashscope">百炼 (阿里云 DashScope)</option>
                  <option value="ark">火山引擎 (Volcengine Ark)</option>
                  <option value="deepseek">DeepSeek</option>
                  <option value="moonshot">Kimi (Moonshot)</option>
                  <option value="anthropic">Anthropic Claude</option>
                  <option value="google">Google Gemini</option>
                  <option value="openai">OpenAI</option>
                  <option value="openrouter">OpenRouter（聚合）</option>
                  <option value="minimax">MiniMax</option>
                </select>
              </label>
              <div className="muted-text" style={{ fontSize: "0.72rem" }}>
                填好后还要在下方填入对应平台的 API Key（部分海外平台国内访问需自备网络）。火山引擎自定义模型须用 endpoint ID（ep-xxx）。
              </div>
              <label className="field-label">
                OpenAI 兼容 Base URL
                <input className="text-input" value={aiSettings.baseURL} onChange={(e) => setAiSettings((c) => ({ ...c, baseURL: e.target.value }))} />
              </label>
              <label className="field-label">
                API Key
                <input className="text-input" type="password" value={aiSettings.apiKey} onChange={(e) => setAiSettings((c) => ({ ...c, apiKey: e.target.value }))} />
              </label>
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
              <div className="divider" />
              <ModelListEditor
                label="主模型列表（勾选的模型将出现在设置页下拉框中）"
                selected={aiSettings.modelOptions}
                onChange={(opts) => setAiSettings((c) => ({ ...c, modelOptions: opts, model: opts.includes(c.model) ? c.model : (opts[0] || c.model) }))}
              />
              <ModelListEditor
                label="小模型列表"
                selected={aiSettings.smallModelOptions || []}
                onChange={(opts) => setAiSettings((c) => ({ ...c, smallModelOptions: opts, smallModel: opts.includes(c.smallModel || "") ? c.smallModel : (opts[0] || c.smallModel) }))}
              />
              <ModelProviderEditor
                providers={aiSettings.modelProviders || []}
                onChange={(next) => setAiSettings((c) => ({ ...c, modelProviders: next }))}
                onAddModelToPool={(modelName, pool) => setAiSettings((c) => {
                  if (pool === "large") {
                    if (c.modelOptions.includes(modelName)) return c;
                    return { ...c, modelOptions: [...c.modelOptions, modelName] };
                  }
                  const small = c.smallModelOptions || [];
                  if (small.includes(modelName)) return c;
                  return { ...c, smallModelOptions: [...small, modelName] };
                })}
              />
              <div className="muted-text" style={{ fontSize: "0.75rem" }}>
                勾选的模型会出现在设置页的主模型/小模型下拉框中。点"保存设置并刷新页面"后生效。
              </div>
            </div>
          </div>
        </div>
      )}

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
          <div className="modal-card">
            <div className="panel-headline">
              <NotebookPen size={18} />
              <span>{editingNoteId ? "编辑笔记" : "添加笔记"}</span>
            </div>
            {!editingNoteId && <div className="selection-body">{selectionText}</div>}
            {editingNoteId && <div className="muted-text">{notes.find((n) => n.id === editingNoteId)?.text?.slice(0, 60)}…</div>}
            <textarea
              className="text-input tall"
              value={noteDraft}
              onChange={(event) => setNoteDraft(event.target.value)}
              placeholder="写下你的理解、疑问或联想"
            />
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
              <p><strong>版本：</strong>v0.4.1</p>
              <p><strong>使用说明：</strong></p>
              <ul>
                <li>首次进入软件请打开右上「设置」面板填入 AI API Key（兼容 DashScope / 火山 / DeepSeek / Kimi 等 OpenAI 兼容平台），<strong>填完即生效，无需重启</strong>。</li>
                <li>纯阅读 / 检索 / 字体 / 主题 / 圈点 / 笔记 / 地图本地数据 不需要 API；翻译 / 解释 / 提问 / 史料比对 / AI 编年 / AI 朗读 / AI 地名推断 需要联网调 API。</li>
                <li>选段后会弹出操作工具栏（翻译 / 解释 / 圈点 / 高亮 / 笔记等）。左右侧栏可折叠。</li>
              </ul>
              <p><strong>主要功能：</strong></p>
              <ul>
                <li>22 部明代史籍多书阅读（12 部带 EPUB 原典翻页 + 10 部检索类章节阅读），AI 跨书检索 + 史料交叉比对</li>
                <li>职官检索 / 人物编年 / 皇帝世系 / 年号公元换算 / 古今地名地图</li>
                <li>农历⇄公历精确换算（含干支日）；选段「识别日期」按钮自动追溯前文上下文</li>
                <li>4 套阅读主题、5 款字体、界面/正文简繁可选、字号字色自定义、3 色高亮 + 下划线 + 古文圈点</li>
                <li>自定义 AI 供应商（URL + Key + 模型组）— 不同模型用不同家的 key</li>
              </ul>
              <p><strong>数据声明：</strong>古籍文本来自互联网公开资源，版权归原始来源所有。AI 回答仅供参考。本软件仅供个人学习研究使用。</p>
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

function ModelProviderEditor({ providers, onChange, onAddModelToPool }: {
  providers: import("./types").ModelProvider[];
  onChange: (next: import("./types").ModelProvider[]) => void;
  onAddModelToPool: (modelName: string, pool: "large" | "small") => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const newId = () => `prov-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const addProvider = () => {
    onChange([...providers, { id: newId(), baseURL: "", apiKey: "", models: [] }]);
  };

  const updateProvider = (id: string, patch: Partial<import("./types").ModelProvider>) => {
    onChange(providers.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  };

  const removeProvider = (id: string) => {
    onChange(providers.filter((p) => p.id !== id));
  };

  // Add model M to provider P as either a large- or small-model. Per spec:
  // (a) if M already lives in another provider, remove it from there
  //     (newest add wins);
  // (b) sync M to the corresponding top-level modelOptions / smallModelOptions
  //     so it shows up in the settings dropdown automatically.
  const addModelAs = (id: string, pool: "large" | "small") => {
    const draft = (drafts[id] || "").trim();
    if (!draft) return;
    const next = providers.map((p) => {
      if (p.id === id) {
        return p.models.includes(draft) ? p : { ...p, models: [...p.models, draft] };
      }
      return p.models.includes(draft) ? { ...p, models: p.models.filter((m) => m !== draft) } : p;
    });
    onChange(next);
    onAddModelToPool(draft, pool);
    setDrafts((d) => ({ ...d, [id]: "" }));
  };

  const removeModel = (id: string, model: string) => {
    onChange(providers.map((p) => (p.id === id ? { ...p, models: p.models.filter((m) => m !== model) } : p)));
  };

  return (
    <div className="model-list-editor">
      <div className="field-label">自定义供应商（可选 — 让特定模型使用不同的 Base URL / API Key）</div>
      {providers.length === 0 && (
        <div className="muted-text" style={{ fontSize: "0.78rem", marginBottom: "0.5rem" }}>
          未配置。所有模型默认走顶部的「Base URL + API Key」。
        </div>
      )}
      {providers.map((p) => (
        <div key={p.id} className="provider-row" style={{
          border: "1px solid var(--ui-panel-border)",
          borderRadius: "0.6rem",
          padding: "0.65rem 0.75rem",
          marginBottom: "0.5rem",
          display: "grid",
          gap: "0.4rem",
        }}>
          <input
            className="text-input"
            value={p.baseURL}
            placeholder="Base URL（如 https://ark.cn-beijing.volces.com/api/v3）"
            onChange={(e) => updateProvider(p.id, { baseURL: e.target.value })}
          />
          <input
            className="text-input"
            type="password"
            value={p.apiKey}
            placeholder="API Key"
            onChange={(e) => updateProvider(p.id, { apiKey: e.target.value })}
          />
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.3rem" }}>
            {p.models.map((m) => (
              <span key={m} style={{
                background: "rgba(110, 66, 23, 0.1)",
                color: "var(--ui-text)",
                borderRadius: "0.4rem",
                padding: "0.18rem 0.55rem",
                fontSize: "0.78rem",
                display: "inline-flex",
                alignItems: "center",
                gap: "0.35rem",
              }}>
                {m}
                <button type="button" onClick={() => removeModel(p.id, m)} style={{
                  background: "transparent", border: "none", cursor: "pointer",
                  color: "inherit", fontSize: "0.9rem", lineHeight: 1, padding: 0,
                }}>×</button>
              </span>
            ))}
          </div>
          <div className="custom-model-input" style={{ flexWrap: "wrap" }}>
            <input
              className="text-input"
              value={drafts[p.id] || ""}
              placeholder="模型名"
              onChange={(e) => setDrafts((d) => ({ ...d, [p.id]: e.target.value }))}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addModelAs(p.id, "large"); } }}
            />
            <button type="button" className="ghost-button compact-button" onClick={() => addModelAs(p.id, "large")}>+ 主模型</button>
            <button type="button" className="ghost-button compact-button" onClick={() => addModelAs(p.id, "small")}>+ 小模型</button>
            <button type="button" className="ghost-button compact-button" onClick={() => removeProvider(p.id)}>删除供应商</button>
          </div>
          <div className="muted-text" style={{ fontSize: "0.7rem" }}>
            添加后会自动写入上面对应的「主模型/小模型列表」并勾选。
          </div>
        </div>
      ))}
      <button type="button" className="ghost-button compact-button" onClick={addProvider}>+ 添加供应商</button>
    </div>
  );
}

function ModelListEditor({ label, selected, onChange }: {
  label: string;
  selected: string[];
  onChange: (opts: string[]) => void;
}) {
  const [customInput, setCustomInput] = useState("");
  const allModels = [...new Set([...ALL_BUILTIN_MODELS, ...selected])];

  const toggle = (model: string) => {
    if (selected.includes(model)) {
      onChange(selected.filter(m => m !== model));
    } else {
      onChange([...selected, model]);
    }
  };

  const addCustom = () => {
    const name = customInput.trim();
    if (!name) return;
    if (!selected.includes(name)) onChange([...selected, name]);
    setCustomInput("");
  };

  return (
    <div className="model-list-editor">
      <div className="field-label">{label}</div>
      <div className="model-checkbox-list">
        {allModels.map(m => (
          <label key={m} className="toggle-row compact">
            <input type="checkbox" checked={selected.includes(m)} onChange={() => toggle(m)} />
            <span>{m}</span>
          </label>
        ))}
      </div>
      <div className="custom-model-input">
        <input className="text-input" value={customInput} onChange={e => setCustomInput(e.target.value)} placeholder="添加自定义模型名" onKeyDown={e => { if (e.key === "Enter") addCustom(); }} />
        <button type="button" className="ghost-button compact-button" onClick={addCustom}>添加</button>
      </div>
    </div>
  );
}

const ALL_BUILTIN_MODELS = [
  "deepseek-v4-pro", "deepseek-v4-flash",
  "qwen3.5-plus", "qwen3.6-max-preview", "qwen3.6-flash", "qwen3.6-27b",
  "kimi-k2.6", "MiniMax-M2.5",
  "Doubao-Seed-2.0-pro", "Doubao-Seed-2.0-mini", "Doubao-Seed-2.0-lite",
  "Doubao-1.5-pro-32k", "Doubao-Seed-1.8", "GLM-4.7",
];



function DynastyTree({ node, onSelect }: { node?: FamilyTreeNode | null; onSelect: (n: FamilyTreeNode) => void }) {
  if (!node) return <div className="muted-text">加载中...</div>;
  return (
    <div className="dynasty-tree-scroll">
      <div className="dt-root">
        <DynastyTreeNode node={node} onSelect={onSelect} />
      </div>
    </div>
  );
}

function DynastyTreeNode({ node, onSelect }: { node: FamilyTreeNode; onSelect: (n: FamilyTreeNode) => void }) {
  const kids = node.children?.length ? node.children : [];
  const label = node.seq ? `(${node.seq}) ${node.name}` : node.name;
  const reign = node.reign || node.years || "";
  return (
    <div className="dt-branch">
      <div className="dt-node-wrap">
        <button
          type="button"
          className={`dt-node ${node.isEmperor ? "dt-emperor" : "dt-prince"}`}
          onClick={() => onSelect(node)}
        >
          <span className="dt-label">{label}</span>
          {reign && <span className="dt-reign">{node.isEmperor ? `在位${reign}` : reign}</span>}
        </button>
      </div>
      {kids.length > 0 && (
        <>
          <div className="dt-vline" />
          <div className="dt-children">
            {kids.map((child) => (
              <DynastyTreeNode key={child.id} node={child} onSelect={onSelect} />
            ))}
          </div>
        </>
      )}
    </div>
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
