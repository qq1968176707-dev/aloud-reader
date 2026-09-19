/**
 * Types shared by the Electron main process and the renderer.
 * Everything persisted to disk is one of these shapes, serialised as pretty-printed JSON.
 */

export const BOOK_SCHEMA = 'aloud-book/1';
export const LIBRARY_SCHEMA = 'aloud-library/1';
export const ANNOTATIONS_SCHEMA = 'aloud-annotations/1';
export const STATE_SCHEMA = 'aloud-state/1';
export const SETTINGS_SCHEMA = 'aloud-settings/1';
export const STATS_SCHEMA = 'aloud-stats/1';
export const PLAIN_SCHEMA = 'aloud-plain/1';
export const INK_SCHEMA = 'aloud-ink/1';

/* ------------------------------------------------------------------ book */

export type ChapterFormat = 'html' | 'markdown';
export type SourceType = 'zip' | 'epub' | 'pdf' | 'mobi' | 'notebook';

/**
 * Ruling of a created notebook's pages.
 *
 * A notebook is a book whose "chapters" hold blank sheets instead of text, so every
 * reading feature (page turns, handwriting, recordings, position memory) applies to it
 * unchanged. The ruling is drawn in CSS from this token — never baked into the page —
 * so it stays crisp at any zoom and can be restyled later without touching saved data.
 */
export type PaperStyle = 'blank' | 'lined' | 'grid' | 'dotted';

export interface NotebookOptions {
  title: string;
  paper: PaperStyle;
  pages: number;
}

export interface ChapterRef {
  /** Stable, unique within the book. Used as the first component of every anchor. */
  id: string;
  /** Path inside the package, relative to book.json. */
  href: string;
  title?: string;
  format?: ChapterFormat;
}

export interface TocItem {
  title: string;
  /** Chapter id this entry points at. */
  chapterId: string;
  children?: TocItem[];
}

export interface BookManifest {
  schema: string;
  id: string;
  title: string;
  authors: string[];
  /** BCP-47 tag, e.g. "zh-CN" / "en-US". Used to pick the default TTS voice. */
  language: string;
  description?: string;
  /** Package-relative path, e.g. "images/cover.jpg". */
  cover?: string;
  published?: string;
  source?: { type: SourceType; originalFile?: string; importedAt?: string };
  readingOrder: ChapterRef[];
  toc?: TocItem[];
  meta?: Record<string, unknown>;
}

/** Precomputed plain text per chapter: powers search, word counts and "minutes left". */
export interface PlainChapter {
  id: string;
  title?: string;
  words: number;
  /** Text of every leaf block, in document order. Index === blockIndex in anchors. */
  blocks: string[];
}
export interface PlainIndex {
  schema: string;
  bookId: string;
  chapters: PlainChapter[];
}

/* --------------------------------------------------------------- library */

export type BuiltinShelf = 'reading' | 'want' | 'finished';

export interface BookIndexEntry {
  id: string;
  title: string;
  authors: string[];
  language: string;
  /** Package-relative cover path (renderer turns it into an aloud:// URL). */
  cover?: string;
  addedAt: string;
  lastOpenedAt?: string;
  finishedAt?: string;
  wordCount: number;
  chapterCount: number;
  /** 0..1, derived from the reading position. */
  progress: number;
  shelf: BuiltinShelf;
  sourceType: SourceType;
  /** Notebooks only: lets the shelf draw the cover in the paper's own ruling. */
  paper?: PaperStyle;
}

export interface Collection {
  id: string;
  name: string;
  bookIds: string[];
}

export interface Library {
  schema: string;
  /** Manual (drag) ordering of book ids; books not listed sort after, by addedAt. */
  order: string[];
  books: BookIndexEntry[];
  collections: Collection[];
}

/* --------------------------------------------------------------- anchors */

/**
 * A location in a book that survives font/theme/layout changes.
 *
 * `blockIndex` indexes the *leaf block elements* of a chapter in document order;
 * `start`/`end` are character offsets into that block's concatenated text nodes.
 * `exact`/`prefix`/`suffix` are only used to re-anchor if the chapter text changed.
 */
export interface TextAnchor {
  chapterId: string;
  blockIndex: number;
  start: number;
  end: number;
  exact?: string;
  prefix?: string;
  suffix?: string;
}

/* ----------------------------------------------------------- annotations */

export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink' | 'purple';
export type AnnotationKind = 'highlight' | 'underline' | 'bookmark';

export interface Annotation {
  id: string;
  kind: AnnotationKind;
  color?: HighlightColor;
  note?: string;
  anchor: TextAnchor;
  /** Snapshot of the anchored text, for the panel and for re-anchoring. */
  text: string;
  createdAt: string;
  updatedAt: string;
}

export interface AnnotationFile {
  schema: string;
  bookId: string;
  annotations: Annotation[];
}

/* --------------------------------------------------------- reading state */

export interface ReadingPosition {
  anchor: TextAnchor;
  chapterIndex: number;
  /** 0..1 through the whole book. */
  progress: number;
  at: string;
}

export interface ReadingState {
  schema: string;
  bookId: string;
  position?: ReadingPosition;
  /** Position when the book was last closed — powers "jump back to where you were". */
  autoBookmark?: ReadingPosition;
  /** Ring buffer of jump origins (TOC clicks, search jumps) for the back affordance. */
  history: ReadingPosition[];
  /** Last segment spoken by read-aloud. */
  lastSegmentId?: string;
  updatedAt: string;
}

/* ------------------------------------------------------------- read aloud */

export type SegLang = 'zh' | 'en' | 'other';

export interface ReadAloudSegment {
  /** `${chapterId}|${blockIndex}|${index}` — stable while the chapter text is stable. */
  id: string;
  chapterId: string;
  blockIndex: number;
  /** Index of this segment inside its block. */
  index: number;
  /** Character offsets into the block text (same coordinate space as TextAnchor). */
  start: number;
  end: number;
  text: string;
  lang: SegLang;
}

export interface TtsVoice {
  id: string;
  name: string;
  lang: string;
  engine: TtsEngineId;
  /** true / false / 'unknown' — whether word-boundary events are available. */
  wordBoundary: boolean | 'unknown';
}

/**
 * A speech engine supplied by the host instead of by the browser.
 *
 * Only Android needs this: its WebView has a `speechSynthesis` object with nothing
 * behind it, so the Capacitor shell hands the renderer a bridge to the system TTS
 * (see src/web/nativeSpeech.ts). When the host provides none, the renderer uses the
 * Web Speech API as before.
 */
export interface HostSpeechRequest {
  text: string;
  lang: string;
  voiceId?: string;
  rate: number;
  onStart?: () => void;
  onBoundary?: (charIndex: number, charLength: number) => void;
  signal: AbortSignal;
}

export interface HostSpeech {
  listVoices(): Promise<TtsVoice[]>;
  speak(req: HostSpeechRequest): Promise<void>;
  pause(): void;
  resume(): void;
  cancel(): void;
  /** Whether this engine reports character ranges while speaking. */
  wordBoundary: boolean;
}

/**
 * Self-update, the same shape on every host.
 *
 * Each platform gets there differently — electron-updater on Windows, a bundle swap on
 * macOS (Squirrel.Mac refuses ad-hoc-signed apps), the system package installer on
 * Android, the service worker on iPad — but the renderer only ever sees these states
 * and three verbs, so one banner serves all four.
 */
export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  /** Newer version found; `download()` fetches it (hosts that download by themselves skip this). */
  | { kind: 'available'; version: string }
  | { kind: 'downloading'; version: string; percent: number | null }
  /** Downloaded and verified; `apply()` restarts into it / opens the installer / reloads. */
  | { kind: 'ready'; version: string }
  /** Only reported for a check the user asked for — a silent check that finds nothing stays idle. */
  | { kind: 'latest'; version: string }
  | { kind: 'error'; message: string }
  /** This build cannot update itself (portable exe, dev run); `url` is where the new one is. */
  | { kind: 'manual'; version: string; url: string };

export interface HostUpdater {
  /** `manual` = the user asked: report "already latest" and errors instead of staying quiet. */
  check(manual?: boolean): Promise<void>;
  download(): Promise<void>;
  apply(): Promise<void>;
  onState(cb: (state: UpdateState) => void): () => void;
}

/** Release metadata the checkers share: where the newest build lives. */
export const UPDATE_REPO = 'qq1968176707-dev/aloud-reader';

/** `0.1.10` > `0.1.9`; missing parts count as 0; anything non-numeric compares as 0. */
export function newerVersion(candidate: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

export interface EdgeSynthRequest {
  text: string;
  voice: string;
  /** 1 = normal. */
  rate: number;
  pitch?: number;
}

export interface EdgeWordBoundary {
  /** ms from the start of the clip. */
  offsetMs: number;
  durationMs: number;
  text: string;
}

export interface EdgeSynthResult {
  /** base64 mp3. */
  audio: string;
  boundaries: EdgeWordBoundary[];
}

/* ---------------------------------------------------------------- settings */

export type ThemeName = 'white' | 'sepia' | 'gray' | 'night';
export type LayoutMode = 'paginated' | 'scroll';
export type SpreadMode = 'auto' | 'single' | 'double';
/** 滑动 / 卷页 / 快速淡入淡出 / 无 */
export type PageAnimation = 'slide' | 'curl' | 'fade' | 'none';
export type LibraryView = 'grid' | 'list';
export type LibrarySort = 'manual' | 'title' | 'author' | 'recent' | 'added';

export type TtsEngineId = 'system' | 'edge' | 'local';

/** Which locally-running model server the `local` engine is talking to. */
export type LocalTtsPreset = 'kokoro' | 'voxcpm' | 'openai' | 'gpt-sovits' | 'cosyvoice' | 'custom';

/** A reference recording used to clone a voice. */
export interface VoiceSample {
  id: string;
  name: string;
  /** Absolute path to the wav on disk. */
  path: string;
  /** What was said in the recording — cloning quality depends on this being accurate. */
  transcript: string;
  durationSec: number;
  createdAt: string;
}

export interface LocalTtsConfig {
  preset: LocalTtsPreset;
  /** e.g. http://127.0.0.1:9880 */
  baseUrl: string;
  /** OpenAI: voice name · GPT-SoVITS: ref_audio_path · CosyVoice(sft): spk_id */
  voice: string;
  /** OpenAI-compatible servers only. */
  model: string;
  /** GPT-SoVITS: the transcript of the reference clip (prompt_text). */
  refText: string;
  refLang: string;
  /** CosyVoice instruct2 / any server that accepts a style instruction. 情感就靠它。 */
  instruct: string;
  /** CosyVoice / VoxCPM: local path to the reference wav for zero-shot cloning. */
  refAudio: string;
  cosyMode: 'sft' | 'instruct2' | 'zero_shot';
  /** Recorded voice samples (VoxCPM); `voice` holds the selected sample id. */
  samples: VoiceSample[];
  /** custom preset only */
  method: 'POST' | 'GET';
  path: string;
  bodyTemplate: string;
  headers: Record<string, string>;
  /** Seconds; local models can be slow on a cold start. */
  timeoutSec: number;
}

export interface ReadAloudSettings {
  engine: TtsEngineId;
  /** 0.5 – 2.0 */
  rate: number;
  /** language bucket -> voice id */
  voiceByLang: Record<string, string>;
  linePauseMs: number;
  stopAtChapterEnd: boolean;
  highlightWords: boolean;
  /** Fake word timings from clip duration when the engine reports no boundaries. */
  estimateWordTiming: boolean;
  autoScroll: boolean;
  local: LocalTtsConfig;
}

export interface LocalTtsResult {
  /** base64 audio */
  audio: string;
  mime: string;
  ms: number;
}

export interface Settings {
  schema: string;
  theme: ThemeName;
  fontFamily: string;
  fontSizePx: number;
  lineHeight: number;
  /** Horizontal margin as a percentage of the reading column. */
  marginPct: number;
  /** 0.3 – 1.0 screen brightness overlay. */
  brightness: number;
  justify: boolean;
  /** Heavier body weight, for low-contrast screens and small type. */
  bold: boolean;
  /** Extra tracking in em, 0–0.08. Kept small: wide CJK tracking reads as AI-generated. */
  letterSpacing: number;
  /** Space between paragraphs in em; 0 keeps the classic indent-only book look. */
  paragraphSpacing: number;
  layout: LayoutMode;
  spread: SpreadMode;
  pageAnimation: PageAnimation;
  /** Reader toolbar scale, 0.8 – 1.3. */
  toolbarScale: number;
  /** Draggable widths, in px, remembered across sessions. */
  sidebarWidth: number;
  panelWidth: number;
  /** Where the ink toolbar docks: top pill, or a vertical rail on either side. */
  inkDock?: 'top' | 'left' | 'right';
  pageSound: boolean;
  /** 0 – 1 */
  pageSoundVolume: number;
  readAloud: ReadAloudSettings;
  goals: { dailyMinutes: number };
  library: { view: LibraryView; sort: LibrarySort };
  /** One-shot migrations applied by getSettings(); each key is applied at most once. */
  migrations?: Record<string, boolean>;
  window?: { width: number; height: number; x?: number; y?: number; maximized?: boolean };
}

/* --------------------------------------------------------------------- ink */

export type InkTool = 'pen' | 'marker';
/** Pen looks: constant ballpoint · pressure/speed-widened fountain · grainy pencil. */
export type PenStyle = 'ball' | 'fountain' | 'pencil';
export type InkShapeKind = 'line' | 'arrow' | 'rect' | 'ellipse';

/**
 * Every ink item is anchored to a leaf block so it survives reflow.
 *
 * Coordinates are stored relative to the anchor block's top-left, divided by the
 * block's WIDTH on both axes (width-normalised keeps aspect ratio when the column
 * width changes). `w0` is the block width at creation, so thickness and font sizes
 * can scale proportionally.
 */
interface InkItemBase {
  id: string;
  chapterId: string;
  blockIndex: number;
  createdAt: string;
}

/** One handwritten stroke. `kind` is absent on files written before shapes existed. */
export interface InkStroke extends InkItemBase {
  kind?: 'stroke';
  tool: InkTool;
  style?: PenStyle;
  /** Colour token key: pen → ink/red/blue/orange · marker → yellow/green/blue/pink. */
  color: string;
  /** Base stroke width in px at creation width. */
  size: number;
  /** Block width in px when the stroke was made. */
  w0: number;
  /** Flat [x, y, x, y, …] in block-width units. */
  points: number[];
  /** Per-point width multipliers (fountain pressure/speed); same length as points/2. */
  ws?: number[];
}

/** A perfect shape dragged out with the shape tool. */
export interface InkShape extends InkItemBase {
  kind: 'shape';
  shape: InkShapeKind;
  color: string;
  size: number;
  w0: number;
  /** [x0, y0, x1, y1] drag corners in block-width units. */
  points: number[];
}

/** A pasted or imported picture. The binary lives in userData/ink/<bookId>/<file>. */
export interface InkImage extends InkItemBase {
  kind: 'image';
  file: string;
  nx: number;
  ny: number;
  /** Width and height in block-width units (aspect fixed at insert). */
  nw: number;
  nh: number;
}

/** A typed text box. Font size is in block-width units so it reflows with the page. */
export interface InkText extends InkItemBase {
  kind: 'text';
  text: string;
  color: string;
  nx: number;
  ny: number;
  nsize: number;
}

export type InkItem = InkStroke | InkShape | InkImage | InkText;

export interface InkFile {
  schema: string;
  bookId: string;
  strokes: InkItem[];
}

/* -------------------------------------------------------------- recordings */

/** One sampled "where the reader was" moment inside a recording. */
export interface RecordingMark {
  /** Milliseconds from recording start. */
  t: number;
  chapterIndex: number;
  chapterId: string;
  blockIndex: number;
}

export interface RecordingMeta {
  id: string;
  bookId: string;
  title: string;
  durationSec: number;
  createdAt: string;
  /** Reading positions over time — playback lets the book follow the audio. */
  timeline: RecordingMark[];
}

/* ------------------------------------------------------------------ stats */

export interface FinishedRecord {
  bookId: string;
  title: string;
  at: string;
}

export interface StatsFile {
  schema: string;
  /** "YYYY-MM-DD" -> seconds read that day. */
  days: Record<string, number>;
  /** bookId -> total seconds. */
  byBook: Record<string, number>;
  finished: FinishedRecord[];
}

/* -------------------------------------------------------------- ipc types */

export interface ImportResult {
  ok: boolean;
  file: string;
  bookId?: string;
  title?: string;
  error?: string;
}

export interface SearchHit {
  anchor: TextAnchor;
  chapterId: string;
  chapterTitle?: string;
  chapterIndex: number;
  /** Snippet with the match, plus offsets of the match inside the snippet. */
  snippet: string;
  matchStart: number;
  matchEnd: number;
}

export interface DictEntry {
  word: string;
  phonetic?: string;
  defs: string[];
  source: string;
}
