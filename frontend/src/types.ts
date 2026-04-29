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

export type AiSettings = {
  baseURL: string;
  apiKey: string;
  defaultModel?: string;
  model: string;
  modelOptions: string[];
  smallModel?: string;
  smallModelOptions?: string[];
  ttsBaseURL: string;
  ttsModel: string;
  ttsVoice: string;
  systemPrompt: string;
  customActions: CustomAction[];
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
