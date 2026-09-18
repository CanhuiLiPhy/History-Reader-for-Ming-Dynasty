export type TocItem = {
  label: string;
  href: string;
  children: TocItem[];
};

export type YearMention = {
  type: "reign" | "gregorian";
  text: string;
  gregorian: number;
  reign?: string;
  emperor?: string;
  note: string;
};

export type ChapterSummary = {
  id: string;
  href: string;
  label: string;
  title: string;
  order: number;
  words: number;
};

export type BookMeta = {
  slug?: string;
  metadata: {
    title: string;
    creator: string;
    language: string;
  };
  tocTree: TocItem[];
  inPageToc: TocItem[];
  chapters: ChapterSummary[];
  stats: {
    chapterCount: number;
    segmentCount: number;
    totalChars: number;
  };
};

export type ReadableBook = {
  slug: string;
  title: string;
  author: string;
  dynasty: string;
  category: string;
  description: string;
  chapterCount: number;
  paragraphCount: number;
  charCount: number;
  hasEpub: boolean;
};

export type DbReaderChapterSummary = {
  order: number;
  rawOrder: number;
  label: string;
  paragraphCount: number;
  charCount: number;
};

export type DbReaderChaptersPayload = {
  slug: string;
  title: string;
  author: string;
  chapters: DbReaderChapterSummary[];
};

export type DbReaderParagraph = {
  id: number;
  content: string;
  hash: string;
  anchor: string;
};

export type DbReaderChapterPayload = {
  slug: string;
  bookTitle: string;
  chapter: string;
  chapterIndex: number;
  rawOrder: number;
  chapterCount: number;
  paragraphs: DbReaderParagraph[];
};

export type SearchResult = {
  id: string;
  chapterId: string;
  chapterHref: string;
  chapterTitle: string;
  score: number;
  snippet: string;
  text: string;
  years: YearMention[];
  // 跨书检索：标记结果属于哪本书 + 章节序号；同书检索时这两项可缺省。
  bookSlug?: string;
  bookTitle?: string;
  chapterOrder?: number | null;
  // EPUB 段落锚（原始 anchor 的 # 后部分，如 filepos0003788693）。
  // chapterHref 现在指向 split-EPUB 的某一章文件（不含 #），所以单独把
  // 段落锚拆出来给前端按 ID 精确滚动用。
  paragraphAnchor?: string;
};

export type SearchResponse = {
  query: string;
  expandedQueries: string[];
  total: number;
  results: SearchResult[];
  aiExpansion?: {
    keywords?: string[];
    people?: string[];
    timeHints?: string[];
    events?: string[];
    searchQueries?: string[];
    note?: string;
  } | null;
};

export type ChronologyItem = {
  id: string;
  chapterTitle: string;
  chapterHref: string;
  snippet: string;
  years: YearMention[];
};

export type ChronologyResponse = {
  person: string;
  total: number;
  items: ChronologyItem[];
  summary?: string;
  model?: string;
};

export type CustomAction = {
  id: string;
  name: string;
  systemPrompt: string;
  userTemplate: string;
};

export type ModelProvider = {
  id: string;
  // v1.2.1：简称（用户自定义短名，列表里显示），可空但建议填
  alias?: string;
  // 预设供应商 key（"dashscope" / "deepseek" / "ark" / ...），可空表示完全自定义
  presetProvider?: string;
  baseURL: string;
  // 网站版下发的永远是空串：密钥只在服务端流动。填了新值才会覆盖，
  // 留空表示「保持不变」。桌面版仍是真实值。
  // On the web build this is always "" — credentials never reach the browser.
  // A non-empty value means "replace it"; empty means "leave it alone".
  apiKey: string;
  // 服务端标记：该条已配置密钥（值不下发）/ 该条是系统内置、前端不可编辑。
  // Server-set flags: a credential exists for this entry (value withheld) /
  // this entry comes from the server environment and is read-only in the UI.
  apiKeyConfigured?: boolean;
  builtin?: boolean;
  // 该 provider 激活的模型名列表 —— 这些会被合并进主/小模型下拉
  models: string[];
};

export type AiSettings = {
  baseURL: string;
  apiKey: string;
  defaultModel?: string;
  model: string;
  modelOptions: string[];
  smallModel?: string;
  smallModelOptions?: string[];
  ttsBaseURL: string;
  ttsApiKey?: string;
  // 同上：只写不读，服务端只告诉前端「配没配」。
  // Write-only as above; the server reports only whether a key exists.
  apiKeyConfigured?: boolean;
  ttsApiKeyConfigured?: boolean;
  ttsModel: string;
  ttsVoice: string;
  systemPrompt: string;
  customActions: CustomAction[];
  // Optional per-model credential overrides. Each entry binds a (baseURL,
  // apiKey) pair to a list of model names; when any of those models is
  // dispatched, it uses this entry's credentials instead of the default.
  // A model name appearing in any entry means: that entry wins. If the user
  // adds a model that already lives in another entry, the older entry has
  // it removed (newest add wins).
  modelProviders?: ModelProvider[];
};

export type DefaultsPayload = {
  app: {
    title: string;
    subtitle: string;
    bookPath: string;
    version: string;
    autoAnnotation: boolean;
    customActions: CustomAction[];
  };
  ai: AiSettings & {
    defaultModel: string;
  };
};

export type ReaderNote = {
  id: string;
  cfiRange: string;
  text: string;
  note: string;
  createdAt: string;
  // Historical timestamp inferred from the note's selection / surrounding
  // context (e.g. "1457-02-11" if a 干支日 was resolved, or "嘉靖三年八月"
  // if only year+month was found). Empty string when nothing matched.
  historicalAt?: string;
  // Sortable Gregorian year derived from historicalAt (for "按历史时间排序"
  // and date-range filtering). Stored separately so we don't have to re-parse
  // historicalAt on every list re-render.
  historicalYear?: number;
  // Which book the note was taken in (book slug). Used to group notes by book.
  bookSlug?: string;
  // Timeline integration — when true, the note shows up as an entry in the
  // 历史时间线 panel alongside dynasty events. Defaults to false (opt-in).
  inTimeline?: boolean;
  // Manual override for historical timing. When set, takes priority over the
  // auto-detected `historicalAt` / `historicalYear` for timeline placement.
  manualYear?: number;
  manualMonth?: number;
  manualDay?: number;
  // Importance score 1–5 (aligns with 历史时间线 event scale). Default 1.
  timelineScale?: number;
  // Category label for timeline rendering. Default "我的笔记" — gets its own
  // accent color so user notes stand out from dynasty events.
  timelineCategory?: string;
  // Short title used as the note's display label on the timeline. Falls back
  // to the first ~20 chars of `note` when empty.
  timelineTitle?: string;
};

export type ReaderHighlight = {
  id: string;
  cfiRange: string;
  text: string;
  color: string;
  kind: "highlight" | "underline" | "circle";
  createdAt: string;
};

export type ReaderBookmark = {
  id: string;
  cfi: string;
  href: string;
  label: string;
  createdAt: string;
};

export type AiActionResponse = {
  answer: string;
  model: string;
  contextSnippets: Array<{
    index: number;
    chapterTitle: string;
    chapterHref: string;
    snippet: string;
  }>;
};

export type ReferenceLibraryBook = {
  id: number;
  slug: string;
  title: string;
  author: string;
  category: string;
  sourceType: string;
  sourceUrl: string;
  chapterCount: number;
  paragraphCount: number;
  importedAt: string;
  description: string;
};

export type ReferenceLookupMatch = {
  type: "official" | "emperor" | "geography" | "character";
  title: string;
  subtitle: string;
  summary: string;
  details: Record<string, unknown>;
};

export type ReferenceLookupResponse = {
  query: string;
  localMatches: ReferenceLookupMatch[];
  reignMatch?: {
    reign: string;
    emperor: string;
    year: number;
    gregorian: number;
    label: string;
    note: string;
  } | null;
  aiExplanation: string;
  model?: string;
  library: ReferenceLibraryBook[];
};

export type ReferenceCompareContext = {
  index: number;
  bookSlug: string;
  bookTitle: string;
  chapter: string;
  anchor: string;
  sourceUrl?: string;
  sourceLink?: string;
  snippet: string;
  content: string;
  score: number;
};

export type ReferenceCompareResponse = {
  selectedText: string;
  keywords: string[];
  contexts: ReferenceCompareContext[];
  reportMarkdown: string;
  model?: string;
};

export type PersonBiographySlice = {
  bookSlug: string;
  bookTitle: string;
  chapterLabel: string;
  anchor: string;
  paragraphs: string[];
  paragraphCount: number;
  sliceFromIndex: number;
  sliceToIndex: number;
  chapterParagraphCount: number;
};

export type PersonRelatedSnippet = {
  paragraphId?: number;
  bookSlug: string;
  bookTitle: string;
  chapter: string;
  anchor?: string;
  snippet: string;
};

export type PersonBiographiesResponse = {
  person: string;
  has: boolean;
  biographies: PersonBiographySlice[];
  related: PersonRelatedSnippet[];
};

export type ConversationMessage = { role: "user" | "assistant"; content: string };

export type ConversationSource = {
  paragraphId?: number;
  bookSlug?: string;
  bookTitle: string;
  chapter: string;
  anchor?: string;
  text: string;
  biographical?: boolean;
  index?: number;
};

export type PersonConversationResponse = {
  assistant: string;
  sources: ConversationSource[];
  sourceMode: "biography" | "embedding" | "fts5" | "empty";
  sourceNote?: string;
  model?: string;
};

export type TimelineEntry = {
  id: string;
  name: string;
  templeName: string;
  posthumousTitle: string;
  reignTitles: string[];
  startYear: number;
  endYear: number;
  yearsInPower: number;
  aliases: string[];
  summary: string;
};

export type TimelineResponse = {
  current: TimelineEntry | null;
  timeline: TimelineEntry[];
  reigns: Array<{
    reign: string;
    emperor: string;
    startYear: number;
    endYear: number;
  }>;
};

export type GeographyRegion = {
  id: string;
  name: string;
  kind: string;
  aliases: string[];
  modernEquivalent: string;
  summary: string;
  lat?: number;
  lng?: number;
  x: number;
  y: number;
};

export type GeographyPayload = {
  mapMeta: {
    title: string;
    canvasWidth: number;
    canvasHeight: number;
    note: string;
  };
  regions: GeographyRegion[];
};

export type ReignConversionResponse = {
  reign: string;
  emperor: string;
  year: number;
  gregorian: number;
  label: string;
  reignLabel?: string;
  note: string;
};

export type EmperorRecord = TimelineEntry & {
  birthYear?: number | null;
  deathYear?: number | null;
  accessionDate?: string;
  deathDate?: string;
  father?: string;
  mother?: string;
  predecessor?: string;
  successor?: string;
  reignRangeLabel?: string;
};

export type FamilyTreeNode = {
  id: string;
  name: string;
  relation: string;
  years?: string;
  reign?: string;
  life?: string;
  seq?: number;
  isEmperor?: boolean;
  summary?: string;
  children: FamilyTreeNode[];
};

export type EmperorPayload = {
  list: EmperorRecord[];
  familyTree: FamilyTreeNode;
};

export type OfficialInstitution = {
  id: string;
  name: string;
  aliases: string[];
  rank: string;
  responsibilities: string[];
  subunits: string[];
  keywords: string[];
  salaryReference: string;
};

export type CharacterRecord = {
  id: string;
  name: string;
  aliases: string[];
  summary: string;
  career: Array<{
    year: number;
    label: string;
    office: string;
    note: string;
  }>;
  keywords: string[];
};

export type OfficeRecord = {
  name: string;
  count: string;
  rank: string;
  department: string;
  notes: string;
  section: string;
  salary: string;
};

export type OfficeChronologyEntry = {
  scope: string;
  era: string;
  yearLabel: string;
  gregorian: number;
  position: string;
  people: string[];
};

export type OfficeSection = {
  name: string;
  description: string;
};

export type PrinceRecord = {
  section: string;
  title: string;
  name: string;
};

export type OfficialsPayload = {
  institutions: OfficialInstitution[];
  characters: CharacterRecord[];
  offices?: OfficeRecord[];
  sections?: OfficeSection[];
  chronology?: OfficeChronologyEntry[];
  princes?: PrinceRecord[];
  poems?: Record<string, string>;
};

export type OfficeSearchPayload = {
  query: string;
  bookResults: SearchResult[];
  referenceResults: ReferenceCompareContext[];
};

export type GeocodePlace = {
  id: string;
  query: string;
  name: string;
  aliases: string[];
  modernName: string;
  kind: string;
  note: string;
  lat: number | null;
  lng: number | null;
  source: "local" | "nominatim" | "none" | string;
};

export type GeocodeResponse = {
  query: string;
  results: GeocodePlace[];
};

export type ReaderStateSnapshot = {
  aiSettings: AiSettings | null;
  highlights: ReaderHighlight[];
  notes: ReaderNote[];
  bookmarks: ReaderBookmark[];
  autoAnnotate: boolean;
  lastLocation: string;
  customActions: CustomAction[];
};
