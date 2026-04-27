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
  fetchOfficials,
  fetchPersonChronology,
  fetchTimeline,
  geocodePlaces,
  lookupReference,
  runAiAction,
  searchBook,
  searchOfficeReferences,
  synthesizeSpeech,
} from "./lib/api";
import { renderMarkdown } from "./lib/markdown";
import { readPersistedState, writePersistedState } from "./lib/storage";
import { annotateYearMentions, injectReaderDocumentStyles } from "./lib/yearAnnotator";
import type {
  AiActionResponse,
  AiSettings,
  BookMeta,
  ChronologyResponse,
  CustomAction,
  DefaultsPayload,
  EmperorPayload,
  GeocodePlace,
  GeocodeResponse,
  FamilyTreeNode,
  OfficialsPayload,
  OfficeSearchPayload,
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
  modelOptions: ["deepseek-v4-pro"],
  smallModel: "deepseek-v4-flash",
  smallModelOptions: ["deepseek-v4-flash", "qwen3.6-flash", "qwen3.6-27b"],
  ttsBaseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  ttsModel: "gpt-4o-mini-tts",
  ttsVoice: "alloy",
  systemPrompt: "",
  customActions: [],
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
  };
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
  const [highlightStyle, setHighlightStyle] = useState<{ kind: "highlight" | "underline"; color: string }>({ kind: "highlight", color: "#efc24f" });
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
  const [openResourcePanel, setOpenResourcePanel] = useState<string | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [assistantCollapsed, setAssistantCollapsed] = useState(true);
  const [selectedTreeEmperor, setSelectedTreeEmperor] = useState<FamilyTreeNode | null>(null);
  const [readerLayout, setReaderLayout] = useState<"horizontal" | "vertical">("horizontal");
  const [scriptVariant, setScriptVariant] = useState<"simplified" | "traditional">("traditional");
  const [pageSpread, setPageSpread] = useState<"single" | "double">("single");
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
          metaData,
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
        ] =
          await Promise.all([
            fetchDefaults(),
            fetchBookMeta(),
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

        setDefaults(defaultsData);
        setMeta(metaData);
        setCustomActions(nextCustomActions);
        setAiSettings(mergeAiSettings(defaultsData, savedAiSettings, nextCustomActions));
        setHighlights(savedHighlights);
        setNotes(savedNotes);
        setBookmarks(savedBookmarks);
        setAutoAnnotate(savedAutoAnnotate);
        setLastLocation(savedLastLocation);
        setReaderLayout(savedReaderLayout);
        setScriptVariant(savedScriptVariant);
        setPageSpread(savedPageSpread);
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
      annotateYearMentions(doc, { layoutMode: readerLayoutRef.current });
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

    // href target — pass directly to epubjs.
    // After EPUB splitting, each chapter is its own file, so display(href) works reliably.
    const candidates = uniqueValues([target, normalizedTarget, `OEBPS/${normalizedTarget.replace(/^OEBPS\//, "")}`]);
    for (const candidate of candidates) {
      try {
        await renditionRef.current.display(candidate);


        window.setTimeout(() => scrollPendingAnchorIntoView(), 60);
        return;
      } catch {
        // Try next candidate
      }
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

    const book = ePub("/book/source.epub") as EpubBookLike;
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
      },
      p: {
        "text-indent": "2em",
      },
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

    // Resize handler: update epubjs dimensions so pagination recalculates
    const onResize = () => {
      const rect = host.getBoundingClientRect();
      const w = Math.round(rect.width) || 800;
      const h = Math.round(rect.height) || 600;
      rendition.resize?.(w, h);
    };
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
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
  // EPUB 初始化必须只随书籍元数据与本地状态加载完成而运行；加入内部回调依赖会销毁并重建 reader。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta, hasLoadedLocalState]);

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
    for (const item of highlights) {
      const type = item.kind === "underline" ? "underline" : "highlight";
      rendition.annotations.remove(item.cfiRange, type);
    }

    for (const item of highlights) {
      const type = item.kind === "underline" ? "underline" : "highlight";
      const styles =
        item.kind === "underline"
          ? { stroke: item.color, "stroke-width": "2", "stroke-opacity": "0.95" }
          : { fill: item.color, "fill-opacity": "0.28", "mix-blend-mode": "multiply" };

      rendition.annotations.add(type, item.cfiRange, {}, undefined, `reader-${type}`, styles);
    }
  }, [highlights, readerReady]);

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
    const timer = window.setTimeout(() => {
      const rect = readerHostRef.current?.getBoundingClientRect();
      if (rect) {
        renditionRef.current?.resize?.(Math.round(rect.width), Math.round(rect.height));
      }
    }, 300); // delay to let CSS transition finish
    return () => window.clearTimeout(timer);
  }, [sidebarCollapsed, assistantCollapsed, readerReady]);

  function clearSelection() {
    selectionContentsRef.current?.window?.getSelection()?.removeAllRanges();
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

  function addSelectionHighlight(kind: "highlight" | "underline", color: string) {
    if (!selectionCfi || !selectionText.trim()) return;
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
    renditionRef.current?.annotations?.remove(target.cfiRange, target.kind === "underline" ? "underline" : "highlight");
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
      const result = await geocodePlaces(mapQuery.trim());
      setMapResult(result);
    } catch (error) {
      setReferenceError(error instanceof Error ? error.message : "地名定位失败。");
    } finally {
      setMapLoading(false);
    }
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
      const response = await compareReference(effectiveText, aiSettings);
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
        `## ${index + 1}. ${highlight.kind === "underline" ? "下划线" : "高亮"} · ${formatTime(highlight.createdAt)}`,
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

  const readingStats = meta
    ? `${meta.metadata.creator} · ${meta.stats.chapterCount} 个原书章节 · 约 ${meta.stats.totalChars.toLocaleString()} 字`
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
            <div className="brand-chip">明史</div>
            <button type="button" className="ghost-button compact-button sidebar-collapse-btn" onClick={() => setSidebarCollapsed(true)} title="折叠侧边栏">
              &lsaquo;
            </button>
          </div>
          <h1>
            {"明史阅读器"}
            <button type="button" className="version-badge" onClick={() => setAboutOpen(true)}>v0.2</button>
          </h1>
          <p>{"以本书为底本的本地阅读与智能研读工具"}</p>
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
                {(meta?.inPageToc?.length ?? 0) > 0
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
                  虚拟翻页分栏
                  <select className="select-input" value={pageSpread} onChange={(event) => setPageSpread(event.target.value as "single" | "double")}>
                    <option value="single">单栏分页</option>
                    <option value="double">双栏对开分页</option>
                  </select>
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
          <div>
            <div className="current-label">{currentSectionLabel || meta?.metadata.title || "载入中…"}</div>
            <div className="muted-text">
              第 {currentChapterIndex + 1}/333 章 · 本章 {chapterPageCurrent}/{chapterPageTotal} 页 · {meta?.metadata.creator}
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
        </header>

        <section className="reader-card">
          {loadingBoot && <div className="overlay-message">正在载入书籍与本地资料…</div>}
          {bootError && <div className="overlay-message error-box">{bootError}</div>}
          <div ref={readerHostRef} className="reader-host" />
          <div className="page-turn-zone page-turn-left" onClick={goPrevPage} />
          <div className="page-turn-zone page-turn-right" onClick={goNextPage} />
        </section>

        <footer className="reader-footer">
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
                  <div className="result-title">{item.kind === "underline" ? "下划线" : "高亮"} · {formatTime(item.createdAt)}</div>
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
              <button type="button" className={`color-pick ${highlightStyle.kind === "underline" ? "is-active" : ""}`} onClick={() => setHighlightStyle({ kind: "underline", color: "#9b4d2d" })} title="下划线">
                <span className="underline-icon">U</span>
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
                    AI 编年
                  </button>
                </div>
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
                  placeholder="检索职位历任线索"
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
                <div className="muted-text">中央研究院历史地名检索（可直接在下方搜索古地名）：</div>
                <iframe
                  src="https://newarchive.ihp.sinica.edu.tw/hplname/placename/basic"
                  className="hgis-iframe"
                  title="中研院歷史地名查詢"
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
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
                OpenAI 兼容 Base URL
                <input className="text-input" value={aiSettings.baseURL} onChange={(e) => setAiSettings((c) => ({ ...c, baseURL: e.target.value }))} />
              </label>
              <label className="field-label">
                API Key
                <input className="text-input" type="password" value={aiSettings.apiKey} onChange={(e) => setAiSettings((c) => ({ ...c, apiKey: e.target.value }))} />
              </label>
              <label className="field-label">
                TTS Base URL（留空则同主 URL）
                <input className="text-input" value={aiSettings.ttsBaseURL} onChange={(e) => setAiSettings((c) => ({ ...c, ttsBaseURL: e.target.value }))} placeholder={aiSettings.baseURL} />
              </label>
              <label className="field-label">
                TTS 模型
                <input className="text-input" value={aiSettings.ttsModel || ""} onChange={(e) => setAiSettings((c) => ({ ...c, ttsModel: e.target.value }))} placeholder="gpt-4o-mini-tts" />
              </label>
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
              <p><strong>版本：</strong>v0.2（内测版）</p>
              <p>以《明史》为底本的交互式本地阅读与 AI 研读工具。</p>
              <p><strong>v0.2 更新内容：</strong></p>
              <ul>
                <li>EPUB 按章节自动拆分，修复目录跳转和章内翻页</li>
                <li>史料交叉比对优化：AI 引导书目定位 + 查看原文弹窗</li>
                <li>资料库扩充至 23 部、约 43.6 万段（完整导入国榷、罪惟录、明实录14部、明通鉴、大明律、皇明经世文编等）</li>
                <li>古今地名地图：AI 推断古地名坐标 + 中研院历史地名查询</li>
                <li>皇帝世系图（可交互，含19帝 + 唐王/淮王支系）</li>
                <li>笔记折叠与编辑、书签命名、导出功能</li>
                <li>AI 操作前可附加补充说明</li>
                <li>模型选择支持自定义模型名称，兼容多平台 API</li>
                <li>繁简体切换（默认繁体）、竖排模式（实验性）</li>
                <li>Safari 选段兼容修复、朗读暂停/停止控件</li>
              </ul>
              <p><strong>数据来源声明：</strong></p>
              <ul>
                <li>古籍文本数据均来自互联网公开资源（Wikisource、CText 等公共数字图书馆及公开电子书），版权归原始来源所有。</li>
                <li>AI 辅助功能由第三方大语言模型 API 提供，回答仅供参考。</li>
                <li>本软件仅供个人学习研究使用，不得用于商业用途。</li>
              </ul>
            </div>
            <div className="inline-actions">
              <button type="button" className="primary-button" onClick={() => setAboutOpen(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}
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
