/**
 * Default values for every persisted file.
 *
 * These live in shared/ rather than beside the Electron store because the browser
 * build needs the exact same defaults — a second copy would drift the moment either
 * host gained a setting, and settings are merged against these on every read.
 */
import {
  ANNOTATIONS_SCHEMA,
  LIBRARY_SCHEMA,
  SETTINGS_SCHEMA,
  STATE_SCHEMA,
  STATS_SCHEMA,
  type AnnotationFile,
  type Library,
  type LocalTtsConfig,
  type ReadingState,
  type Settings,
  type StatsFile,
} from './types';

export const defaultLocalTts = (): LocalTtsConfig => ({
  preset: 'kokoro',
  baseUrl: 'http://127.0.0.1:8973',
  voice: 'zf_001',
  model: 'tts-1',
  refText: '',
  refLang: 'zh',
  instruct: '用温柔平静的语气朗读',
  refAudio: '',
  cosyMode: 'sft',
  samples: [],
  method: 'POST',
  path: '/tts',
  bodyTemplate: '{\n  "text": "{{text}}",\n  "voice": "{{voice}}",\n  "speed": {{speed}}\n}',
  headers: {},
  timeoutSec: 60,
});

export const defaultSettings = (): Settings => ({
  schema: SETTINGS_SCHEMA,
  theme: 'white',
  fontFamily: 'serif-cn',
  fontSizePx: 19,
  lineHeight: 1.75,
  marginPct: 12,
  brightness: 1,
  justify: false,
  bold: false,
  letterSpacing: 0,
  paragraphSpacing: 0,
  layout: 'paginated',
  spread: 'double',
  pageAnimation: 'curl',
  toolbarScale: 1,
  sidebarWidth: 232,
  panelWidth: 320,
  inkDock: 'top',
  pageSound: true,
  pageSoundVolume: 0.6,
  readAloud: {
    engine: 'system',
    rate: 1,
    voiceByLang: {},
    linePauseMs: 120,
    stopAtChapterEnd: false,
    // Off by default: the solid word box is distracting while reading along. The line
    // highlight alone is what makes 逐行导读 work.
    highlightWords: false,
    estimateWordTiming: true,
    autoScroll: true,
    local: defaultLocalTts(),
  },
  goals: { dailyMinutes: 20 },
  library: { view: 'grid', sort: 'manual' },
});

export const defaultLibrary = (): Library => ({
  schema: LIBRARY_SCHEMA,
  order: [],
  books: [],
  collections: [],
});

export const defaultState = (bookId: string): ReadingState => ({
  schema: STATE_SCHEMA,
  bookId,
  history: [],
  updatedAt: new Date().toISOString(),
});

export const defaultAnnotations = (bookId: string): AnnotationFile => ({
  schema: ANNOTATIONS_SCHEMA,
  bookId,
  annotations: [],
});

export const defaultStats = (): StatsFile => ({
  schema: STATS_SCHEMA,
  days: {},
  byBook: {},
  finished: [],
});

