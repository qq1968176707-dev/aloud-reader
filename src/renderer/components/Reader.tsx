import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  Annotation,
  InkImage,
  InkItem,
  InkShapeKind,
  InkStroke,
  InkText,
  PenStyle,
  RecordingMark,
  BookManifest,
  DictEntry,
  HighlightColor,
  PlainIndex,
  ReadAloudSegment,
  ReadingPosition,
  ReadingState,
  TextAnchor,
  TtsVoice,
} from '@shared/types';
import { countWords, detectLang, makeSegments, minutesFor } from '@shared/text';
import { useStore } from '../state/store';
import {
  anchorAt,
  anchorFromRange,
  positionFromPoint,
  rangeIn,
  resolveAnchor,
  type BlockModel,
} from '../lib/anchors';
import { setFallbackLayer, setHighlight } from '../lib/highlight';
import { usePaginator } from '../lib/paginator';
import { createTurner, runPageTurn, snapshotWindow, type PageTurner } from '../lib/pageTurn';
import { playPageTurn } from '../lib/pageSound';
import { exportAnnotations } from '../lib/annotationsExport';
import { ReadAloudController, type RaStatus, type ReadAloudHost } from '../tts/controller';
import { IS_MAC, cx, debounce, formatMinutes, inkImageUrl, kbd, uid } from '../lib/util';
import ChapterView from './ChapterView';
import ReadAloudBar from './ReadAloudBar';
import { AnnotationsPanel, AppearancePanel, PanelShell, SearchPanel, TocPanel } from './ReaderPanels';
import RecordingsPanel from './RecordingsPanel';
import { RecordingSession } from '../lib/recorder';
import {
  MARKER_COLORS,
  PEN_COLORS,
  paintInk,
  ensureInkLayer,
  fountainOutline,
  isImage,
  isText,
  itemBBox,
  itemsInLasso,
  itemsNear,
  moveItem,
  pathFrom,
  pickAnchorBlock,
  renderInk,
  shapePath,
} from '../lib/ink';
import { DictCard, Lightbox, NoteEditor, SelectionMenu } from './Overlays';
import { Icon } from './ui';

/**
 * The table of contents docks left; everything else docks right. They used to share one
 * slot, so opening the contents silently closed your notes — two panels on opposite
 * edges never actually competed for space.
 */
type LeftPanel = 'toc' | null;
type RightPanel = 'search' | 'annotations' | 'appearance' | 'recordings' | null;

interface SelectionState {
  rect: DOMRect;
  anchor: TextAnchor;
  text: string;
  annotationId?: string;
}

export default function Reader({ bookId }: { bookId: string }): JSX.Element {
  const settings = useStore((s) => s.settings);
  const patchSettings = useStore((s) => s.patchSettings);
  const patchReadAloud = useStore((s) => s.patchReadAloud);
  const navigate = useStore((s) => s.navigate);
  const updateBook = useStore((s) => s.updateBook);
  const toast = useStore((s) => s.toast);

  /* --------------------------------------------------------- book data */

  const [manifest, setManifest] = useState<BookManifest | null>(null);
  const [plain, setPlain] = useState<PlainIndex | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [chapterIndex, setChapterIndex] = useState(0);
  const [chapterHtml, setChapterHtml] = useState('');
  const [blocksVersion, setBlocksVersion] = useState(0);
  const [loading, setLoading] = useState(true);

  const blocksRef = useRef<BlockModel[]>([]);
  const segmentsRef = useRef(new Map<string, ReadAloudSegment[]>());
  /* Keyed by `${bookId}|${chapterId}`: chapter ids are unique only within a book,
     and every created notebook names its single chapter 'pages'. Keying by chapter
     alone showed one notebook's sheets inside another. */
  const htmlCache = useRef(new Map<string, string>());
  const cacheKey = useCallback((chapter: string) => `${bookId}|${chapter}`, [bookId]);
  const stateRef = useRef<ReadingState | null>(null);
  const chapterReady = useRef<{ chapterId: string; resolve: () => void } | null>(null);
  const pendingAnchor = useRef<TextAnchor | null>(null);
  const lastAnchor = useRef<TextAnchor | null>(null);

  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);

  const chapter = manifest?.readingOrder[chapterIndex];
  /* A created notebook: sheets to write on rather than text to read. The reading
     chrome that has no meaning here (minutes left, chapter ticks) gives way to the
     page count and an "add pages" button. */
  const isNotebook = !!manifest?.meta?.notebook;
  const chapterId = chapter?.id ?? '';

  /* ------------------------------------------------------------- ui */

  const [leftPanel, setLeftPanel] = useState<LeftPanel>(null);
  const [rightPanel, setRightPanel] = useState<RightPanel>(null);
  const closePanels = useCallback((): void => {
    setLeftPanel(null);
    setRightPanel(null);
  }, []);
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [noteFor, setNoteFor] = useState<SelectionState | null>(null);
  const [dict, setDict] = useState<{ rect: DOMRect; word: string; entry: DictEntry | null } | null>(null);
  const [lightbox, setLightbox] = useState<{ src: string; caption: string } | null>(null);
  const [jumpBack, setJumpBack] = useState<ReadingPosition | null>(null);
  const [progress, setProgress] = useState(0);
  const [edgeHint, setEdgeHint] = useState<'left' | 'right' | null>(null);
  const [dragging, setDragging] = useState(false);
  /**
   * Apple Books' quietest trick: while you read, the chrome gets out of the way. After a
   * few idle seconds the top and bottom bars dim to a whisper; moving the mouse — or
   * opening anything — brings them back.
   */
  const [chromeIdle, setChromeIdle] = useState(false);
  /* GoodNotes-style reading recording: audio + a timeline of where you were. */
  const recSessionRef = useRef<RecordingSession | null>(null);
  const [recActive, setRecActive] = useState(false);
  const [recElapsed, setRecElapsed] = useState(0);
  const [recRefresh, setRecRefresh] = useState(0);
  const [accMenu, setAccMenu] = useState<{ x: number; y: number } | null>(null);
  /* Handwriting: the GoodNotes toolset over the reflowable page. */
  const [inkMode, setInkMode] = useState(false);
  const [inkTool, setInkTool] = useState<'select' | 'pen' | 'marker' | 'eraser' | 'shape' | 'text'>('pen');
  const [penStyle, setPenStyle] = useState<PenStyle>('fountain');
  const [shapeKind, setShapeKind] = useState<InkShapeKind>('line');
  const [penColor, setPenColor] = useState<string>('ink');
  const [markerColor, setMarkerColor] = useState<string>('yellow');
  const [inkSize, setInkSize] = useState(2.2);
  const [inkItems, setInkItems] = useState<InkItem[]>([]);
  const [selIds, setSelIds] = useState<string[]>([]);
  const [inkTextEdit, setInkTextEdit] = useState<{
    left: number;
    top: number;
    lx: number;
    ly: number;
    value: string;
    id: string | null;
  } | null>(null);
  const [inkDrag, setInkDrag] = useState<{ x: number; y: number } | null>(null);
  const inkItemsRef = useRef(inkItems);
  inkItemsRef.current = inkItems;
  const inkUndoRef = useRef<InkItem[][]>([]);
  const inkRedoRef = useRef<InkItem[][]>([]);
  const inkLoadedRef = useRef(false);
  // Palm rejection: once a real stylus has been seen, finger touches stop drawing
  // (they'd otherwise scribble every time the palm rests on a tablet screen).
  const penSeenRef = useRef(false);
  const liveInkRef = useRef<{
    pointerId: number;
    mode: 'draw' | 'erase' | 'lasso' | 'move' | 'resize' | 'shape';
    pts: number[];
    ws: number[];
    t: number;
    el: SVGElement | null;
    erased: Set<string>;
    start: { x: number; y: number };
    resizeBase?: { it: InkImage; box: { x: number; y: number; w: number; h: number } };
    /** Which kind of pointer owns this gesture, and when it last reported — see onInkDown. */
    kind?: string;
    seen?: number;
  } | null>(null);
  /** The capture overlay, for the native (non-passive) touch listeners iOS needs. */
  const inkCaptureRef = useRef<HTMLDivElement>(null);
  const wheelTurnAt = useRef(0);
  const wheelGesture = useRef({ t: 0, sum: 0, fired: false });
  /**
   * Off by default: the page behaves like paper — dragging anywhere turns it and nothing
   * selects. Turn it on (cursor button, top right) to select text for highlights, notes
   * and dictionary lookups; page turning then goes through the arrows and keys.
   */
  const [selectMode, setSelectMode] = useState(false);
  /** Block index the reader is currently on — drives the bookmark button's filled state. */
  const [anchorBlock, setAnchorBlock] = useState(0);

  /* ------------------------------------------------------ read aloud */

  const [raOpen, setRaOpen] = useState(false);
  const [raStatus, setRaStatus] = useState<RaStatus>('idle');
  const [raSegment, setRaSegment] = useState<ReadAloudSegment | null>(null);
  const [word, setWord] = useState<{ charIndex: number; charLength: number } | null>(null);
  const [voices, setVoices] = useState<TtsVoice[]>([]);
  const controllerRef = useRef<ReadAloudController | null>(null);

  /* ================================================== layout metrics */

  const columns =
    settings.layout !== 'paginated'
      ? 1
      : settings.spread === 'double'
        ? 2
        : settings.spread === 'single'
          ? 1
          : window.innerWidth >= 1180
            ? 2
            : 1;

  const paginator = usePaginator({
    viewportRef,
    contentRef,
    enabled: settings.layout === 'paginated',
    columns,
    gap: 64,
    deps: [
      blocksVersion,
      settings.fontSizePx,
      settings.lineHeight,
      settings.marginPct,
      settings.fontFamily,
      settings.justify,
      settings.letterSpacing,
      settings.paragraphSpacing,
      settings.bold,
      settings.layout,
      columns,
    ],
    onMeasured: () => {
      const anchor = pendingAnchor.current ?? lastAnchor.current;
      if (anchor) requestAnimationFrame(() => scrollToAnchorRef.current?.(anchor, false));
    },
  });
  const paginatorRef = useRef(paginator);
  paginatorRef.current = paginator;

  /* ================================================== word statistics */

  const stats = useMemo(() => {
    if (!plain) return null;
    const blockWords = plain.chapters.map((c) => c.blocks.map(countWords));
    const chapterWords = blockWords.map((b) => b.reduce((a, x) => a + x, 0));
    const before: number[] = [];
    let sum = 0;
    for (const w of chapterWords) {
      before.push(sum);
      sum += w;
    }
    return { blockWords, chapterWords, before, total: Math.max(1, sum) };
  }, [plain]);

  const progressAt = useCallback(
    (ci: number, blockIndex: number): number => {
      if (!stats) return 0;
      const within = (stats.blockWords[ci] ?? []).slice(0, blockIndex).reduce((a, x) => a + x, 0);
      return Math.min(1, ((stats.before[ci] ?? 0) + within) / stats.total);
    },
    [stats],
  );

  const minutesLeft = useCallback(
    (ci: number, blockIndex: number): number => {
      if (!stats || !plain) return 0;
      const rest = (stats.blockWords[ci] ?? []).slice(blockIndex).reduce((a, x) => a + x, 0);
      const sample = plain.chapters[ci]?.blocks.slice(blockIndex, blockIndex + 3).join(' ') ?? '';
      return minutesFor(rest, detectLang(sample));
    },
    [plain, stats],
  );

  const locateByProgress = useCallback(
    (p: number): { chapterIndex: number; blockIndex: number } => {
      if (!stats) return { chapterIndex: 0, blockIndex: 0 };
      const target = p * stats.total;
      let ci = 0;
      while (ci + 1 < stats.before.length && stats.before[ci + 1] <= target) ci++;
      let rest = target - stats.before[ci];
      const blocks = stats.blockWords[ci] ?? [];
      let bi = 0;
      while (bi < blocks.length && rest > blocks[bi]) {
        rest -= blocks[bi];
        bi++;
      }
      return { chapterIndex: ci, blockIndex: Math.min(bi, Math.max(0, blocks.length - 1)) };
    },
    [stats],
  );

  /* ==================================================== chapter loading */

  const loadChapter = useCallback(
    (index: number, anchor?: TextAnchor | null): Promise<void> => {
      return new Promise((resolve) => {
        const ref = manifest?.readingOrder[index];
        if (!ref) return resolve();
        pendingAnchor.current = anchor ?? { chapterId: ref.id, blockIndex: 0, start: 0, end: 0 };
        if (ref.id === chapterId && chapterHtml) {
          const target = pendingAnchor.current;
          requestAnimationFrame(() => {
            if (target) scrollToAnchorRef.current?.(target, false);
          });
          return resolve();
        }
        // A newer load supersedes the old one — settle the old waiter instead of
        // abandoning it. A cross-chapter page turn awaits this promise with an
        // animation lock held; a promise that never settles is a lock never released,
        // and every turn after that silently loses its animation.
        chapterReady.current?.resolve();
        chapterReady.current = { chapterId: ref.id, resolve };
        lastAnchor.current = null;
        // Reset the page index HERE, synchronously — the paginator's clamp otherwise
        // carries the previous chapter's page into the new chapter's first (often
        // provisional) layout. Doing this in an effect raced the anchor landing and
        // occasionally yanked a deliberate end-of-chapter landing back to page 1.
        paginatorRef.current.goTo(0, false);
        setChapterIndex(index);
      });
    },
    [chapterHtml, chapterId, manifest],
  );

  useEffect(() => {
    let cancelled = false;
    const ref = manifest?.readingOrder[chapterIndex];
    if (!ref) return;
    const cached = htmlCache.current.get(cacheKey(ref.id));
    if (cached != null) {
      setChapterHtml(cached);
      return;
    }
    void window.aloud.books
      .chapter(bookId, ref.id)
      .then((html) => {
        if (cancelled) return;
        htmlCache.current.set(cacheKey(ref.id), html);
        if (htmlCache.current.size > 6) {
          const oldest = htmlCache.current.keys().next().value as string | undefined;
          if (oldest && oldest !== cacheKey(ref.id)) htmlCache.current.delete(oldest);
        }
        setChapterHtml(html);
      })
      .catch((err) => toast(String(err), 'error'));
    return () => {
      cancelled = true;
    };
  }, [bookId, cacheKey, chapterIndex, manifest, toast]);

  const onBlocks = useCallback(
    (blocks: BlockModel[]) => {
      blocksRef.current = blocks;
      if (chapterId) {
        segmentsRef.current.clear();
        segmentsRef.current.set(
          chapterId,
          makeSegments(
            chapterId,
            blocks.map((b) => b.text),
          ),
        );
      }
      setBlocksVersion((v) => v + 1);
      const ready = chapterReady.current;
      if (ready && ready.chapterId === chapterId) {
        chapterReady.current = null;
        ready.resolve();
      }
    },
    [chapterId],
  );

  /* ====================================================== positioning */

  // Chrome-idle timer: dims after 3.5s of stillness. Anything open (panels, read-aloud,
  // a selection) pins the chrome visible — dimming controls someone is using is hostile.
  useEffect(() => {
    const pinned = !!leftPanel || !!rightPanel || raOpen || !!selection || !!noteFor;
    if (pinned) {
      setChromeIdle(false);
      return;
    }
    let timer = window.setTimeout(() => setChromeIdle(true), 3500);
    const wake = (): void => {
      setChromeIdle(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setChromeIdle(true), 3500);
    };
    window.addEventListener('mousemove', wake);
    window.addEventListener('keydown', wake);
    window.addEventListener('mousedown', wake);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('mousemove', wake);
      window.removeEventListener('keydown', wake);
      window.removeEventListener('mousedown', wake);
    };
  }, [leftPanel, rightPanel, raOpen, selection, noteFor]);

  // Recording clock, one tick a second while live.
  useEffect(() => {
    if (!recActive) return;
    const t = window.setInterval(() => {
      setRecElapsed(recSessionRef.current?.elapsedMs() ?? 0);
    }, 1000);
    return () => window.clearInterval(t);
  }, [recActive]);

  // Every position change while recording becomes a timeline mark.
  useEffect(() => {
    recSessionRef.current?.mark(chapterIndex, chapterId, anchorBlock);
  }, [recActive, chapterIndex, chapterId, anchorBlock, paginator.page]);

  // Leaving the book finalises a live recording instead of orphaning the file.
  useEffect(
    () => () => {
      const session = recSessionRef.current;
      if (session) {
        recSessionRef.current = null;
        void session.stop('阅读录音');
      }
    },
    [],
  );

  const toggleRecording = useCallback(async (): Promise<void> => {
    const live = recSessionRef.current;
    if (live) {
      recSessionRef.current = null;
      setRecActive(false);
      await live.stop(`${chapter?.title ?? '阅读'} · 录音`);
      setRecRefresh((n) => n + 1);
      toast('录音已保存');
      return;
    }
    try {
      const session = await RecordingSession.start(bookId);
      recSessionRef.current = session;
      session.mark(chapterIndex, chapterId, anchorBlock);
      setRecElapsed(0);
      setRecActive(true);
    } catch (err) {
      toast(err instanceof Error ? `拿不到麦克风：${err.message}` : String(err), 'error');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, chapter?.title, chapterId, chapterIndex, anchorBlock, toast]);

  // Ink: load once per book, save debounced, flush on unmount.
  useEffect(() => {
    inkLoadedRef.current = false;
    inkUndoRef.current = [];
    inkRedoRef.current = [];
    setSelIds([]);
    void window.aloud.ink.get(bookId).then((f) => {
      setInkItems(f.strokes ?? []);
      inkLoadedRef.current = true;
    });
  }, [bookId]);
  /* Dirty flag: set on every items change, cleared when the debounced save lands.
     The unmount/close flushes only write when a save is actually pending — an
     unconditional flush at exit once resurrected items that a probe had already
     restored on disk behind React's back. */
  const inkDirtyRef = useRef(false);
  const saveInk = useMemo(
    () =>
      debounce(() => {
        if (!inkLoadedRef.current) return;
        inkDirtyRef.current = false;
        void window.aloud.ink.save({ schema: 'aloud-ink/1', bookId, strokes: inkItemsRef.current });
      }, 800),
    [bookId],
  );
  useEffect(() => {
    if (inkLoadedRef.current) inkDirtyRef.current = true;
    saveInk();
  }, [inkItems, saveInk]);
  const flushInk = (): void => {
    if (inkLoadedRef.current && inkDirtyRef.current) {
      inkDirtyRef.current = false;
      void window.aloud.ink.save({ schema: 'aloud-ink/1', bookId, strokes: inkItemsRef.current });
    }
  };
  const flushInkRef = useRef(flushInk);
  flushInkRef.current = flushInk;
  useLayoutEffect(() => () => flushInkRef.current(), [bookId]);
  // Closing the app never unmounts React, so a save still sitting in the 800 ms
  // debounce would be lost — flush it when the window goes away.
  useEffect(() => {
    const onUnload = (): void => flushInkRef.current();
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, []);

  /* Every mutation goes through commitInk so undo/redo see one step per gesture. */
  const commitInk = (next: InkItem[]): void => {
    inkUndoRef.current.push(inkItemsRef.current);
    if (inkUndoRef.current.length > 100) inkUndoRef.current.shift();
    inkRedoRef.current = [];
    setInkItems(next);
  };
  const undoInk = (): void => {
    const prev = inkUndoRef.current.pop();
    if (!prev) return;
    inkRedoRef.current.push(inkItemsRef.current);
    setInkItems(prev);
    setSelIds([]);
  };
  const redoInk = (): void => {
    const next = inkRedoRef.current.pop();
    if (!next) return;
    inkUndoRef.current.push(inkItemsRef.current);
    setInkItems(next);
    setSelIds([]);
  };

  // Repaint the ink layer (plus the selection box) whenever layout could have moved
  // the blocks, or the items/selection changed.
  useEffect(() => {
    const content = contentRef.current;
    if (!content || !blocksRef.current.length) return;
    const frame = requestAnimationFrame(() => {
      renderInk(content, blocksRef.current, inkItems, chapterId, bookId);
      const svg = ensureInkLayer(content);
      svg.querySelector(':scope > g.ink-selbox')?.remove();
      if (selIds.length) {
        let x0 = Infinity;
        let y0 = Infinity;
        let x1 = -Infinity;
        let y1 = -Infinity;
        const sel = inkItems.filter((it) => selIds.includes(it.id));
        for (const it of sel) {
          const b = itemBBox(content, blocksRef.current, it);
          if (!b) continue;
          x0 = Math.min(x0, b.x);
          y0 = Math.min(y0, b.y);
          x1 = Math.max(x1, b.x + b.w);
          y1 = Math.max(y1, b.y + b.h);
        }
        if (x1 > x0) {
          const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
          g.setAttribute('class', 'ink-selbox');
          const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
          rect.setAttribute('x', String(x0 - 4));
          rect.setAttribute('y', String(y0 - 4));
          rect.setAttribute('width', String(x1 - x0 + 8));
          rect.setAttribute('height', String(y1 - y0 + 8));
          g.appendChild(rect);
          if (sel.length === 1 && isImage(sel[0])) {
            const h = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            h.setAttribute('class', 'ink-handle');
            h.setAttribute('cx', String(x1 + 4));
            h.setAttribute('cy', String(y1 + 4));
            h.setAttribute('r', '7');
            g.appendChild(h);
          }
          svg.appendChild(g);
        }
      }
    });
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    inkItems,
    selIds,
    chapterId,
    blocksVersion,
    paginator.pages,
    columns,
    settings.fontSizePx,
    settings.lineHeight,
    settings.marginPct,
    settings.letterSpacing,
    settings.paragraphSpacing,
    settings.bold,
    settings.justify,
    settings.fontFamily,
    settings.layout,
  ]);

  // Keyboard while writing: undo/redo, delete selection, Esc backs out one level.
  useEffect(() => {
    if (!inkMode) return;
    const onKey = (e: KeyboardEvent): void => {
      if (inkTextEdit) return; // the textarea owns the keyboard
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 'z') {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) redoInk();
        else undoInk();
      } else if ((e.ctrlKey || e.metaKey) && k === 'y') {
        e.preventDefault();
        e.stopPropagation();
        redoInk();
      } else if ((k === 'delete' || k === 'backspace') && selIds.length) {
        e.preventDefault();
        e.stopPropagation();
        commitInk(inkItemsRef.current.filter((it) => !selIds.includes(it.id)));
        setSelIds([]);
      } else if (k === 'escape') {
        e.stopPropagation();
        if (selIds.length) setSelIds([]);
        else setInkMode(false);
      } else if ((e.ctrlKey || e.metaKey) && k === 'v') {
        e.stopPropagation();
        void window.aloud.ink.pasteImage(bookId).then((file) => {
          if (file) void insertInkImages([file]);
        });
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inkMode, selIds, inkTextEdit, bookId]);

  /* Pointer coords → layout space: client minus content rect (both carry the
     page-turn translate, so the difference is pure layout space). */
  const inkPoint = (e: { clientX: number; clientY: number }): { x: number; y: number } | null => {
    const content = contentRef.current;
    if (!content) return null;
    const r = content.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  /** Place imported/pasted pictures on the visible page, selected and movable. */
  const insertInkImages = async (files: string[]): Promise<void> => {
    const content = contentRef.current;
    const vp = viewportRef.current;
    if (!content || !vp || !files.length) return;
    const vr = vp.getBoundingClientRect();
    const added: InkItem[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const dims = await new Promise<{ w: number; h: number } | null>((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth || 300, h: img.naturalHeight || 200 });
        img.onerror = () => resolve(null);
        img.src = inkImageUrl(bookId, file);
      });
      if (!dims) continue;
      const pt = inkPoint({ clientX: vr.left + vr.width / 2 + i * 26, clientY: vr.top + vr.height / 2 + i * 26 });
      if (!pt) continue;
      const block = pickAnchorBlock(content, blocksRef.current, pt.x, pt.y);
      if (!block) continue;
      const c = content.getBoundingClientRect();
      const b = block.el.getBoundingClientRect();
      const bw = Math.max(1, b.width);
      const w = Math.min(dims.w, bw * 0.5);
      const h = (w / dims.w) * dims.h;
      added.push({
        id: uid(),
        kind: 'image',
        chapterId,
        blockIndex: block.index,
        file,
        nx: (pt.x - (b.left - c.left)) / bw - w / bw / 2,
        ny: (pt.y - (b.top - c.top)) / bw - h / bw / 2,
        nw: w / bw,
        nh: h / bw,
        createdAt: new Date().toISOString(),
      });
    }
    if (!added.length) return;
    commitInk([...inkItemsRef.current, ...added]);
    setInkTool('select');
    setSelIds(added.map((a) => a.id));
  };

  /** Commit or cancel the floating text editor. */
  const commitInkText = (): void => {
    const edit = inkTextEdit;
    if (!edit) return;
    setInkTextEdit(null);
    const content = contentRef.current;
    if (!content) return;
    const value = edit.value.replace(/\s+$/, '');
    if (edit.id) {
      const el = content.querySelector(`[data-ink-id="${edit.id}"]`) as SVGElement | null;
      if (el) el.style.display = '';
      if (!value) {
        commitInk(inkItemsRef.current.filter((it) => it.id !== edit.id));
        return;
      }
      commitInk(inkItemsRef.current.map((it) => (it.id === edit.id ? { ...(it as InkText), text: value } : it)));
      return;
    }
    if (!value) return;
    const block = pickAnchorBlock(content, blocksRef.current, edit.lx, edit.ly);
    if (!block) return;
    const c = content.getBoundingClientRect();
    const b = block.el.getBoundingClientRect();
    const bw = Math.max(1, b.width);
    commitInk([
      ...inkItemsRef.current,
      {
        id: uid(),
        kind: 'text',
        chapterId,
        blockIndex: block.index,
        text: value,
        color: penColor,
        nx: (edit.lx - (b.left - c.left)) / bw,
        ny: (edit.ly - (b.top - c.top)) / bw,
        nsize: (11 + inkSize * 5.4) / bw,
        createdAt: new Date().toISOString(),
      },
    ]);
  };

  const selectionBBox = (): { x: number; y: number; w: number; h: number } | null => {
    const content = contentRef.current;
    if (!content || !selIds.length) return null;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const it of inkItemsRef.current) {
      if (!selIds.includes(it.id)) continue;
      const b = itemBBox(content, blocksRef.current, it);
      if (!b) continue;
      x0 = Math.min(x0, b.x);
      y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.w);
      y1 = Math.max(y1, b.y + b.h);
    }
    return x1 > x0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  };

  /** Drag the toolbar by its grip; releasing docks it top, left or right. */
  const onInkGripDown = (e: React.PointerEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    const move = (ev: PointerEvent): void => setInkDrag({ x: ev.clientX, y: ev.clientY });
    const up = (ev: PointerEvent): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      setInkDrag(null);
      const frac = ev.clientX / window.innerWidth;
      patchSettings({ inkDock: frac < 0.33 ? 'left' : frac > 0.67 ? 'right' : 'top' });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    setInkDrag({ x: e.clientX, y: e.clientY });
  };

  // iPad: `touch-action: none` stops scrolling but not iOS's own reading of a stylus
  // press — Safari still treats it as the start of a long-press / text selection and
  // sends pointercancel a few points into the stroke, so nothing gets written. Only
  // preventing the touch default takes the gesture away from the system, and that needs
  // a native listener: React registers touch handlers as passive, where preventDefault
  // is silently ignored. The pointer events we draw with are unaffected.
  useEffect(() => {
    const el = inkCaptureRef.current;
    if (!inkMode || !el) return;
    const keep = (ev: TouchEvent): void => {
      if (ev.cancelable) ev.preventDefault();
    };
    el.addEventListener('touchstart', keep, { passive: false });
    el.addEventListener('touchmove', keep, { passive: false });
    return () => {
      el.removeEventListener('touchstart', keep);
      el.removeEventListener('touchmove', keep);
    };
  }, [inkMode]);

  const onInkDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    // One gesture at a time: while the pen is down, a second pointer is a resting palm.
    // But a gesture whose end never arrived (iOS can swallow pointerup/pointercancel when
    // it takes a gesture over) must not block every stroke after it — that is exactly
    // "the pen stopped working". A pen cannot be down twice, and a palm does not rest
    // motionless for seconds mid-stroke, so either of those means the old one is dead.
    const stale = liveInkRef.current;
    if (stale) {
      const dead =
        stale.pointerId === e.pointerId ||
        (e.pointerType === 'pen' && stale.kind === 'pen') ||
        performance.now() - (stale.seen ?? 0) > 1500;
      if (!dead) return;
      if (stale.mode !== 'draw' || !stale.pts.length) stale.el?.remove();
      liveInkRef.current = null;
    }
    if (e.pointerType === 'pen') penSeenRef.current = true;
    else if (e.pointerType === 'touch' && penSeenRef.current && inkTool !== 'select') return;
    const content = contentRef.current;
    const pt = inkPoint(e);
    if (!content || !pt) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointers have no capture */
    }
    const svg = ensureInkLayer(content);
    // Every gesture records who owns it and when it last moved (the stale check above).
    const begin = (g: NonNullable<typeof liveInkRef.current>): void => {
      liveInkRef.current = { ...g, kind: e.pointerType, seen: performance.now() };
    };
    if (inkTool === 'text') {
      // Click places (or reopens) a text box — handled on pointer up via this marker.
      begin({ pointerId: e.pointerId, mode: 'draw', pts: [pt.x, pt.y], ws: [], t: 0, el: null, erased: new Set(), start: pt });
      return;
    }
    if (inkTool === 'eraser') {
      begin({ pointerId: e.pointerId, mode: 'erase', pts: [], ws: [], t: 0, el: null, erased: new Set(), start: pt });
      eraseAt(pt.x, pt.y);
      return;
    }
    if (inkTool === 'select') {
      const box = selectionBBox();
      const sel = inkItemsRef.current.filter((it) => selIds.includes(it.id));
      if (box && sel.length === 1 && isImage(sel[0])) {
        const hx = box.x + box.w + 4;
        const hy = box.y + box.h + 4;
        if ((pt.x - hx) ** 2 + (pt.y - hy) ** 2 <= 196) {
          begin({
            pointerId: e.pointerId, mode: 'resize', pts: [], ws: [], t: 0, el: null, erased: new Set(), start: pt,
            resizeBase: { it: sel[0] as InkImage, box },
          });
          return;
        }
      }
      if (box && pt.x >= box.x - 6 && pt.x <= box.x + box.w + 6 && pt.y >= box.y - 6 && pt.y <= box.y + box.h + 6) {
        begin({ pointerId: e.pointerId, mode: 'move', pts: [], ws: [], t: 0, el: null, erased: new Set(), start: pt });
        return;
      }
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      el.setAttribute('class', 'ink-lasso');
      svg.appendChild(el);
      begin({ pointerId: e.pointerId, mode: 'lasso', pts: [pt.x, pt.y], ws: [], t: 0, el, erased: new Set(), start: pt });
      return;
    }
    if (inkTool === 'shape') {
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      el.setAttribute('class', 'ink-pen ink-shape');
      paintInk(el, 'stroke', `var(--pen-${penColor})`);
      el.setAttribute('stroke-width', String(inkSize));
      el.setAttribute('fill', 'none');
      svg.appendChild(el);
      begin({ pointerId: e.pointerId, mode: 'shape', pts: [pt.x, pt.y, pt.x, pt.y], ws: [], t: 0, el, erased: new Set(), start: pt });
      return;
    }
    // pen / marker
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const isMarker = inkTool === 'marker';
    const style = isMarker ? 'marker' : penStyle;
    const pressure = e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.7;
    const width = inkSize * (isMarker ? 1 : 0.6 + 0.8 * pressure);
    if (style === 'fountain') {
      el.setAttribute('class', 'ink-pen ink-fountain');
      paintInk(el, 'fill', `var(--pen-${penColor})`);
    } else {
      paintInk(el, 'stroke', isMarker ? `var(--hl-${markerColor})` : `var(--pen-${penColor})`);
      el.setAttribute('fill', 'none');
      el.setAttribute('stroke-width', String(isMarker ? width * 4.5 : width));
      el.setAttribute('class', isMarker ? 'ink-marker' : style === 'pencil' ? 'ink-pen ink-pencil' : 'ink-pen');
      if (style === 'pencil') el.setAttribute('filter', 'url(#ink-grain)');
    }
    svg.appendChild(el);
    begin({
      pointerId: e.pointerId, mode: 'draw', pts: [pt.x, pt.y], ws: [1], t: performance.now(), el, erased: new Set(), start: pt,
    });
  };

  const eraseAt = (x: number, y: number): void => {
    const live = liveInkRef.current;
    const content = contentRef.current;
    if (!live || !content) return;
    const gone = itemsNear(content, blocksRef.current, inkItemsRef.current, chapterId, x, y).filter(
      (id) => !live.erased.has(id),
    );
    for (const id of gone) {
      live.erased.add(id);
      const el = content.querySelector(`[data-ink-id="${id}"]`) as SVGElement | null;
      if (el) el.style.display = 'none';
    }
  };

  const onInkMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const live = liveInkRef.current;
    if (!live || e.pointerId !== live.pointerId) return;
    live.seen = performance.now();
    const content = contentRef.current;
    const pt = inkPoint(e);
    if (!content || !pt) return;
    if (live.mode === 'erase') {
      eraseAt(pt.x, pt.y);
      return;
    }
    if (live.mode === 'move') {
      const dx = pt.x - live.start.x;
      const dy = pt.y - live.start.y;
      for (const id of selIds) {
        const el = content.querySelector(`[data-ink-id="${id}"]`) as SVGElement | null;
        if (el) el.setAttribute('transform', `translate(${dx} ${dy})`);
      }
      const box = content.querySelector(':scope > svg.ink-layer > g.ink-selbox') as SVGElement | null;
      if (box) box.setAttribute('transform', `translate(${dx} ${dy})`);
      return;
    }
    if (live.mode === 'resize' && live.resizeBase) {
      const { box } = live.resizeBase;
      const factor = Math.max(0.15, (pt.x - box.x) / Math.max(1, box.w));
      const it = live.resizeBase.it;
      const el = content.querySelector(`[data-ink-id="${it.id}"]`) as SVGElement | null;
      if (el) {
        el.setAttribute('width', String(box.w * factor));
        el.setAttribute('height', String(box.h * factor));
      }
      live.ws = [factor];
      return;
    }
    if (live.mode === 'shape') {
      live.pts[2] = pt.x;
      live.pts[3] = pt.y;
      live.el?.setAttribute('d', shapePath(shapeKind, live.pts, inkSize));
      return;
    }
    if (live.mode === 'lasso') {
      live.pts.push(pt.x, pt.y);
      live.el?.setAttribute('d', pathFrom(live.pts));
      return;
    }
    if (inkTool === 'text') return;
    // draw — every sample the browser coalesced into this event, not just the last one.
    // Apple Pencil reports at 240Hz but pointermove fires once per frame (60Hz), so
    // without this three of every four points of a fast stroke are thrown away and
    // curves come out as polygons.
    const native = e.nativeEvent as PointerEvent & { getCoalescedEvents?: () => PointerEvent[] };
    const coalesced = native.getCoalescedEvents?.();
    let grew = false;
    for (const sample of coalesced?.length ? coalesced : [native]) {
      const sp = inkPoint(sample);
      if (sp && drawSample(live, sp, sample.pointerType, sample.pressure, sample.timeStamp || performance.now())) {
        grew = true;
      }
    }
    if (!grew) return;
    if (inkTool !== 'marker' && penStyle === 'fountain') {
      live.el?.setAttribute('d', fountainOutline(live.pts, live.ws, inkSize));
    } else {
      live.el?.setAttribute('d', pathFrom(live.pts));
    }
  };

  /**
   * Extend the live pen/marker stroke by one input sample; false when the sample was
   * too close to the last point to keep. `now` is the sample's own timestamp, so the
   * speed-based nib width stays right when several samples arrive in one event.
   */
  const drawSample = (
    live: NonNullable<typeof liveInkRef.current>,
    pt: { x: number; y: number },
    pointerType: string,
    pressure: number,
    now: number,
  ): boolean => {
    const last = live.pts.length - 2;
    const dx = pt.x - live.pts[last];
    const dy = pt.y - live.pts[last + 1];
    const dist2 = dx * dx + dy * dy;
    if (dist2 < 4) return false; // 2px minimum step keeps paths light
    const isMarker = inkTool === 'marker';
    const style = isMarker ? 'marker' : penStyle;
    if (style === 'fountain') {
      // Width follows real pressure when the stylus reports it, else stroke speed
      // (slow = wide, like a real nib laying more ink).
      const target =
        pointerType === 'pen' && pressure > 0 && pressure !== 0.5
          ? 0.5 + pressure
          : Math.min(1.35, Math.max(0.55, 1.4 - Math.sqrt(dist2) / Math.max(1, now - live.t) / 0.9));
      const prev = live.ws[live.ws.length - 1] ?? 1;
      live.ws.push(prev * 0.65 + target * 0.35);
    }
    live.t = now;
    live.pts.push(pt.x, pt.y);
    return true;
  };

  const onInkUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    const live = liveInkRef.current;
    if (!live || e.pointerId !== live.pointerId) return;
    liveInkRef.current = null;
    const content = contentRef.current;
    if (!content) return;
    if (inkTool === 'text') {
      // A click, not a drag: open the editor (reopening an existing box if hit).
      const lx = live.start.x;
      const ly = live.start.y;
      const stage = (e.currentTarget as HTMLElement).getBoundingClientRect();
      let editing: InkText | null = null;
      for (const it of inkItemsRef.current) {
        if (!isText(it) || it.chapterId !== chapterId) continue;
        const b = itemBBox(content, blocksRef.current, it);
        if (b && lx >= b.x - 4 && lx <= b.x + b.w + 8 && ly >= b.y - 4 && ly <= b.y + b.h + 4) {
          editing = it;
          break;
        }
      }
      if (editing) {
        const el = content.querySelector(`[data-ink-id="${editing.id}"]`) as SVGElement | null;
        if (el) el.style.display = 'none';
        const b = itemBBox(content, blocksRef.current, editing);
        const c = content.getBoundingClientRect();
        setInkTextEdit({
          left: (b ? b.x : lx) + c.left - stage.left,
          top: (b ? b.y : ly) + c.top - stage.top,
          lx,
          ly,
          value: editing.text,
          id: editing.id,
        });
      } else {
        setInkTextEdit({ left: e.clientX - stage.left, top: e.clientY - stage.top, lx, ly, value: '', id: null });
      }
      return;
    }
    if (live.mode === 'erase') {
      if (live.erased.size) {
        commitInk(inkItemsRef.current.filter((it) => !live.erased.has(it.id)));
        setSelIds((ids) => ids.filter((id) => !live.erased.has(id)));
      }
      return;
    }
    if (live.mode === 'lasso') {
      live.el?.remove();
      const ids = itemsInLasso(content, blocksRef.current, inkItemsRef.current, chapterId, live.pts);
      setSelIds(ids);
      return;
    }
    if (live.mode === 'move') {
      const pt = inkPoint(e);
      const dx = (pt?.x ?? live.start.x) - live.start.x;
      const dy = (pt?.y ?? live.start.y) - live.start.y;
      for (const id of selIds) {
        const el = content.querySelector(`[data-ink-id="${id}"]`) as SVGElement | null;
        if (el) el.removeAttribute('transform');
      }
      if (Math.abs(dx) < 2 && Math.abs(dy) < 2) {
        setSelIds([]); // a plain click outside items clears via lasso; on box = deselect
        return;
      }
      commitInk(
        inkItemsRef.current.map((it) =>
          selIds.includes(it.id) ? moveItem(content, blocksRef.current, it, dx, dy) : it,
        ),
      );
      return;
    }
    if (live.mode === 'resize' && live.resizeBase) {
      const factor = live.ws[0] ?? 1;
      const it = live.resizeBase.it;
      commitInk(
        inkItemsRef.current.map((x) =>
          x.id === it.id ? { ...(x as InkImage), nw: it.nw * factor, nh: it.nh * factor } : x,
        ),
      );
      return;
    }
    if (live.mode === 'shape') {
      live.el?.remove();
      const [x0, y0, x1, y1] = live.pts;
      if (Math.hypot(x1 - x0, y1 - y0) < 5) return;
      const block = pickAnchorBlock(content, blocksRef.current, x0, y0);
      if (!block) return;
      const c = content.getBoundingClientRect();
      const b = block.el.getBoundingClientRect();
      const bw = Math.max(1, b.width);
      const bx = b.left - c.left;
      const by = b.top - c.top;
      commitInk([
        ...inkItemsRef.current,
        {
          id: uid(),
          kind: 'shape',
          chapterId,
          blockIndex: block.index,
          shape: shapeKind,
          color: penColor,
          size: inkSize,
          w0: bw,
          points: [(x0 - bx) / bw, (y0 - by) / bw, (x1 - bx) / bw, (y1 - by) / bw].map(
            (v) => Math.round(v * 10000) / 10000,
          ),
          createdAt: new Date().toISOString(),
        },
      ]);
      return;
    }
    // draw: commit the stroke
    live.el?.remove();
    if (live.pts.length < 2) return;
    const block = pickAnchorBlock(content, blocksRef.current, live.pts[0], live.pts[1]);
    if (!block) return;
    const c = content.getBoundingClientRect();
    const b = block.el.getBoundingClientRect();
    const bx = b.left - c.left;
    const by = b.top - c.top;
    const bw = Math.max(1, b.width);
    const points: number[] = [];
    for (let i = 0; i < live.pts.length; i += 2) {
      points.push(
        Math.round(((live.pts[i] - bx) / bw) * 10000) / 10000,
        Math.round(((live.pts[i + 1] - by) / bw) * 10000) / 10000,
      );
    }
    const isMarker = inkTool === 'marker';
    const pressure = e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.7;
    const stroke: InkStroke = {
      id: uid(),
      chapterId,
      blockIndex: block.index,
      tool: isMarker ? 'marker' : 'pen',
      style: isMarker ? undefined : penStyle,
      color: isMarker ? markerColor : penColor,
      size: inkSize * (isMarker ? 1 : 0.6 + 0.8 * pressure),
      w0: bw,
      points,
      ws: !isMarker && penStyle === 'fountain' ? live.ws.map((w) => Math.round(w * 100) / 100) : undefined,
      createdAt: new Date().toISOString(),
    };
    commitInk([...inkItemsRef.current, stroke]);
  };

  // Ctrl+scroll adjusts the type size, like every browser and every desktop reader.
  useEffect(() => {
    let lastStep = 0;
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey || !e.deltaY) return;
      e.preventDefault();
      // Trackpads fire dozens of small deltas per gesture; one step per 80ms is a
      // comfortable ramp for both mouse notches and pinch-scroll.
      const now = performance.now();
      if (now - lastStep < 80) return;
      lastStep = now;
      const current = useStore.getState().settings.fontSizePx;
      const next = Math.max(13, Math.min(34, current + (e.deltaY > 0 ? -1 : 1)));
      if (next !== current) patchSettings({ fontSizePx: next });
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => window.removeEventListener('wheel', onWheel);
  }, [patchSettings]);

  const scrollToAnchor = useCallback(
    (anchor: TextAnchor, animate = true) => {
      const blocks = blocksRef.current;
      if (!blocks.length) return;
      let range = resolveAnchor(blocks, anchor) ?? (blocks[0] ? rangeIn(blocks[0], 0, 0) : null);
      if (!range) return;
      // A collapsed range can report no rects at all mid-layout (images still decoding),
      // and a landing that silently fails leaves the page wherever the previous chapter
      // left it. Give the range one real character so it always has a rect.
      if (range.collapsed) {
        const block = blocks[anchor.blockIndex] ?? blocks[0];
        const widened = block ? rangeIn(block, anchor.start, Math.min(block.text.length, anchor.start + 1)) : null;
        if (widened) range = widened;
      }
      if (settings.layout === 'paginated') {
        const moved = paginator.ensureVisible(range, animate);
        // Belt and braces for the chapter head: if the rect probe still failed, "the
        // start of the chapter" is unambiguous without any geometry.
        if (!moved && anchor.blockIndex === 0 && anchor.start === 0 && paginator.pageOf(range) == null) {
          paginator.goTo(0, false);
        }
      } else {
        const viewport = viewportRef.current;
        if (!viewport) return;
        const rect = range.getBoundingClientRect();
        const top = viewport.scrollTop + rect.top - viewport.getBoundingClientRect().top - viewport.clientHeight * 0.24;
        viewport.scrollTo({ top: Math.max(0, top), behavior: animate ? 'smooth' : 'auto' });
      }
      lastAnchor.current = anchor;
      // Paginated: pendingAnchor deliberately SURVIVES this landing. Fonts and images
      // keep reflowing the chapter for a while, and every re-measure re-anchors to it;
      // clearing it here let a position write on a provisional layout hijack the
      // landing (back-cross "last page" turned into page 1 after images decoded).
      // User navigation — a turn, a drag — is what releases it.
      if (settings.layout !== 'paginated') pendingAnchor.current = null;
    },
    [paginator, settings.layout],
  );
  const scrollToAnchorRef = useRef(scrollToAnchor);
  scrollToAnchorRef.current = scrollToAnchor;

  /** First block currently visible — the definition of "where the reader is". */
  const currentAnchor = useCallback((): TextAnchor | null => {
    const blocks = blocksRef.current;
    const viewport = viewportRef.current;
    if (!blocks.length || !viewport) return null;
    if (settings.layout === 'paginated') {
      // The character actually sitting at the top-left of the page.
      //
      // Anchoring on the first block that *starts* on this page is off by a page whenever
      // a paragraph spans the boundary: a page filled with the middle of a long paragraph
      // contains no block start at all, so the search ran past it and the reader came back
      // to the neighbouring page. A caret hit-test cannot miss, because it asks the layout
      // engine what is at that point rather than guessing from block starts.
      const rect = viewport.getBoundingClientRect();
      const cs = getComputedStyle(viewport);
      const px = rect.left + parseFloat(cs.paddingLeft || '0') + 6;
      const py = rect.top + parseFloat(cs.paddingTop || '0') + 6;
      let hit = positionFromPoint(blocks, px, py);
      if (!hit) {
        // Mid page-turn the probe point is covered by the animation overlay, which the
        // hit-test refuses (its clones carry data-blk but lie about offsets). The real
        // content underneath is already ON the target page — it moves before the fold
        // runs — so one probe with the overlay hidden reads the true landing position.
        const overlay = viewport.querySelector<HTMLElement>('.pt-overlay');
        if (overlay) {
          const prevVisibility = overlay.style.visibility;
          overlay.style.visibility = 'hidden';
          hit = positionFromPoint(blocks, px, py);
          overlay.style.visibility = prevVisibility;
        }
      }
      if (hit) {
        // One character wide, never collapsed: a collapsed caret range at a page's first
        // character sits on a column boundary, and the browser reports its rect with
        // upstream affinity — the end of the PREVIOUS column — so restoring landed one
        // page back every time. A range that contains the character has an unambiguous
        // rect on this page.
        const end = Math.min(hit.offset + 1, hit.block.text.length);
        return anchorAt(chapterId, blocks, hit.block.index, hit.offset, end);
      }
      // No caret there (an image, a gap between columns): fall back to block starts.
      const from = paginator.page * paginator.stride - 4;
      for (const block of blocks) {
        const range = rangeIn(block, 0, Math.min(1, block.text.length));
        const x = range ? paginator.offsetXOf(range) : null;
        if (x != null && x >= from) return anchorAt(chapterId, blocks, block.index, 0, 0);
      }
      return anchorAt(chapterId, blocks, blocks[blocks.length - 1].index, 0, 0);
    }
    const top = viewport.getBoundingClientRect().top;
    for (const block of blocks) {
      const rect = block.el.getBoundingClientRect();
      if (rect.bottom > top + 8) return anchorAt(chapterId, blocks, block.index, 0, 0);
    }
    return anchorAt(chapterId, blocks, blocks[blocks.length - 1].index, 0, 0);
  }, [chapterId, paginator, settings.layout]);

  /** Write where we are, right now. */
  const writePosition = useCallback(() => {
    const anchor = pendingAnchor.current ?? currentAnchor();
    if (!anchor || !stateRef.current) return;
    lastAnchor.current = anchor;
    setAnchorBlock(anchor.blockIndex);
    const p = progressAt(chapterIndex, anchor.blockIndex);
    setProgress(p);
    const position: ReadingPosition = {
      anchor,
      chapterIndex,
      progress: p,
      at: new Date().toISOString(),
    };
    const next: ReadingState = { ...stateRef.current, position, updatedAt: position.at };
    stateRef.current = next;
    void window.aloud.state.save(next);
    updateBook(bookId, { progress: p, lastOpenedAt: position.at });
  }, [bookId, chapterIndex, currentAnchor, progressAt, updateBook]);

  const writePositionRef = useRef(writePosition);
  writePositionRef.current = writePosition;

  // Stable across renders, deliberately: `currentAnchor` changes identity on every render
  // (it closes over the paginator), and a debounce that is rebuilt that often is a
  // debounce whose pending write keeps getting thrown away.
  const persistPosition = useMemo(() => debounce(() => writePositionRef.current(), 700), []);

  // Images decode after the chapter has already been measured, and every late arrival
  // reflows the columns: the page count changes and the text under the current page
  // index silently becomes different text. Re-measure as they land — onMeasured then
  // re-anchors the view to the position the reader was actually at, so a chapter full
  // of pictures no longer restores to the wrong page.
  const measureRef = useRef(paginator.measure);
  measureRef.current = paginator.measure;
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const pending = Array.from(content.querySelectorAll('img')).filter((img) => !img.complete);
    if (!pending.length) return;
    let frame = 0;
    const onSettled = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => measureRef.current());
    };
    for (const img of pending) {
      img.addEventListener('load', onSettled);
      img.addEventListener('error', onSettled);
    }
    return () => {
      cancelAnimationFrame(frame);
      for (const img of pending) {
        img.removeEventListener('load', onSettled);
        img.removeEventListener('error', onSettled);
      }
    };
  }, [blocksVersion]);

  // A page turn writes its position on the very next frame, not through the debounce.
  // Debounced writes died twice here: the pending write was cancelled by this effect's
  // own cleanup on the next turn, and any turn made <700ms before leaving the book was
  // simply never recorded — reopening landed a page back. Page turns are discrete and
  // rare; one small JSON write each is nothing. The debounce stays only for scroll mode,
  // where positions change at 60Hz.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      // While images are still decoding the layout is provisional: writing now would
      // overwrite a deliberate landing anchor (say, "the chapter's end") with whatever
      // character happens to be top-left of the provisional page, and the post-decode
      // re-measure would then re-anchor to that instead. Once the images settle, the
      // re-measure changes the page and this effect fires again on stable ground.
      const content = contentRef.current;
      const pendingImages = content
        ? Array.from(content.querySelectorAll('img')).some((img) => !img.complete)
        : false;
      if (!pendingImages) writePositionRef.current();
    });
    return () => cancelAnimationFrame(frame);
  }, [blocksVersion, paginator.page]);

  /* ========================================================= book load */

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const [m, p, a, s] = await Promise.all([
        window.aloud.books.manifest(bookId),
        window.aloud.books.plain(bookId),
        window.aloud.annotations.get(bookId),
        window.aloud.state.get(bookId),
      ]);
      if (cancelled || !m) return;
      setManifest(m);
      setPlain(p);
      setAnnotations(a.annotations);
      stateRef.current = s;
      const resume = s.position ?? s.autoBookmark;
      const index = resume ? Math.max(0, m.readingOrder.findIndex((c) => c.id === resume.anchor.chapterId)) : 0;
      pendingAnchor.current = resume?.anchor ?? null;
      setChapterIndex(index);
      setProgress(resume?.progress ?? 0);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [bookId]);

  /* Automatic bookmark when the book is closed. */
  // useLayoutEffect, deliberately: a passive (useEffect) cleanup on unmount runs AFTER
  // the reader's DOM has left the document, so the position probe measured a detached
  // viewport — rects of zero, a hit-test into whatever screen came next — and the "final
  // save" silently recorded garbage or nothing. Layout cleanups run while the DOM is
  // still attached, so this one can still see where the reader actually was.
  useLayoutEffect(() => {
    return () => {
      writePositionRef.current();
      const state = stateRef.current;
      if (!state?.position) return;
      void window.aloud.state.save({
        ...state,
        autoBookmark: state.position,
        updatedAt: new Date().toISOString(),
      });
    };
  }, [bookId]);

  /* ================================================= highlight painting */

  useEffect(() => {
    setFallbackLayer(layerRef.current);
    return () => {
      setFallbackLayer(null);
      // CSS.highlights is a document-global registry, so anything painted here would
      // survive navigating back to the library and reappear over the next book.
      for (const name of [
        'ra-line',
        'ra-word',
        'search-hit',
        'anno-underline',
        'anno-yellow',
        'anno-green',
        'anno-blue',
        'anno-pink',
        'anno-purple',
      ]) {
        setHighlight(name, []);
      }
    };
  }, []);

  useEffect(() => {
    const blocks = blocksRef.current;
    const byName: Record<string, Range[]> = {
      'anno-yellow': [],
      'anno-green': [],
      'anno-blue': [],
      'anno-pink': [],
      'anno-purple': [],
      'anno-underline': [],
    };
    for (const a of annotations) {
      if (a.anchor.chapterId !== chapterId || a.kind === 'bookmark') continue;
      const range = resolveAnchor(blocks, a.anchor);
      if (!range) continue;
      if (a.kind === 'underline') byName['anno-underline'].push(range);
      else byName[`anno-${a.color ?? 'yellow'}`].push(range);
    }
    for (const [name, ranges] of Object.entries(byName)) setHighlight(name, ranges);
  }, [annotations, blocksVersion, chapterId]);

  /* Active read-aloud line: highlight + auto-scroll + page turn. */
  useEffect(() => {
    const blocks = blocksRef.current;
    if (!raSegment || raSegment.chapterId !== chapterId || !blocks.length) {
      setHighlight('ra-line', []);
      return;
    }
    const block = blocks[raSegment.blockIndex];
    const range = block ? rangeIn(block, raSegment.start, raSegment.end) : null;
    setHighlight('ra-line', range ? [range] : []);
    if (range && settings.readAloud.autoScroll) {
      if (settings.layout === 'paginated') {
        // Through the same path as a manual turn, so following the voice uses the page
        // animation the user picked instead of always sliding.
        const target = paginator.pageOf(range);
        if (target != null) animateTurnToRef.current?.(target, false);
      } else {
        const viewport = viewportRef.current;
        if (viewport) {
          const rect = range.getBoundingClientRect();
          const box = viewport.getBoundingClientRect();
          if (rect.top < box.top + box.height * 0.15 || rect.bottom > box.top + box.height * 0.72) {
            viewport.scrollTo({
              top: viewport.scrollTop + rect.top - box.top - box.height * 0.38,
              behavior: 'smooth',
            });
          }
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raSegment, blocksVersion, chapterId, settings.layout, settings.readAloud.autoScroll]);

  /* Karaoke word inside the active line — and the page follows the voice, not the line.
     A sentence that straddles a page break used to hold the old page until it finished:
     the turn was keyed to the segment's START. Keyed to the word being spoken, the page
     flips at the exact boundary word. */
  useEffect(() => {
    const blocks = blocksRef.current;
    if (!raSegment || !word || raSegment.chapterId !== chapterId) {
      setHighlight('ra-word', []);
      return;
    }
    const block = blocks[raSegment.blockIndex];
    if (!block) return;
    const start = raSegment.start + word.charIndex;
    const end = Math.min(raSegment.end, start + Math.max(1, word.charLength));
    const range = rangeIn(block, start, end);
    setHighlight('ra-word', settings.readAloud.highlightWords && range ? [range] : []);
    if (range && settings.readAloud.autoScroll && settings.layout === 'paginated') {
      const target = paginator.pageOf(range);
      if (target != null) {
        // The voice sitting on a page beyond the page count is the one sure sign the
        // count has gone stale (late reflow with no trigger) — remeasure and the
        // follow lands on the recovered page at the next boundary.
        if (target > paginator.pages - 1) measureRef.current();
        else animateTurnToRef.current?.(target, false); // no-op on this page
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [word, raSegment, chapterId, blocksVersion, settings.readAloud.highlightWords, settings.readAloud.autoScroll, settings.layout]);

  useEffect(() => setWord(null), [raSegment]);

  /* Verification probe: lets the harness push word boundaries through the real host
     path (segment state -> word state -> highlight + page follow) without an engine.
     Inert unless something calls it. */
  useEffect(() => {
    const w = window as unknown as { __aloudRaProbe?: unknown };
    w.__aloudRaProbe = {
      /** First segment in this chapter whose first and last characters sit on different pages. */
      findStraddler: () => {
        const segs = segmentsRef.current.get(chapterId) ?? [];
        const blocks = blocksRef.current;
        const pageOfChar = (block: BlockModel, at: number): number | null => {
          const r = rangeIn(block, at, at + 1);
          const x = r ? paginator.offsetXOf(r) : null;
          return x == null ? null : Math.floor((x + 4) / Math.max(1, paginator.stride));
        };
        for (const seg of segs) {
          const block = blocks[seg.blockIndex];
          const len = seg.end - seg.start;
          if (!block || len < 8) continue;
          const pa = pageOfChar(block, seg.start);
          const pb = pageOfChar(block, seg.end - 1);
          if (pa == null || pb == null || pb <= pa) continue;
          let cross = len - 1;
          for (let i = 1; i < len; i++) {
            const p = pageOfChar(block, seg.start + i);
            if (p != null && p > pa) {
              cross = i;
              break;
            }
          }
          return { id: seg.id, length: len, cross };
        }
        return null;
      },
      begin: (id: string): boolean => {
        const seg = (segmentsRef.current.get(chapterId) ?? []).find((s) => s.id === id) ?? null;
        setRaSegment(seg);
        setWord(null);
        return !!seg;
      },
      feed: (charIndex: number): void => setWord({ charIndex, charLength: 1 }),
      end: (): void => {
        setRaSegment(null);
        setWord(null);
      },
      /** What would turning back into chapter (chapterIndex+offset) anchor to? */
      probeEndAnchor: (offset: number): unknown => {
        try {
          const a = endAnchorOf(chapterIndex + offset);
          return a ? `${a.blockIndex}@${a.start} "${(a.exact ?? '').slice(0, 8)}"` : 'undefined';
        } catch (err) {
          return 'ERR ' + String(err);
        }
      },
      /** Do the imported plain-text blocks and the rendered DOM blocks agree, index by index? */
      parity: (): unknown => {
        const dom = blocksRef.current;
        const pb = plain?.chapters[chapterIndex]?.blocks ?? [];
        let firstDiff = -1;
        for (let i = 0; i < Math.max(dom.length, pb.length); i++) {
          if ((dom[i]?.text ?? ' ') !== (pb[i] ?? ' ')) {
            firstDiff = i;
            break;
          }
        }
        return {
          domBlocks: dom.length,
          plainBlocks: pb.length,
          firstDiff,
          domAt: firstDiff >= 0 ? (dom[firstDiff]?.text ?? '(none)').slice(0, 24) : null,
          plainAt: firstDiff >= 0 ? (pb[firstDiff] ?? '(none)').slice(0, 24) : null,
          lastAnchor: lastAnchor.current
            ? `${lastAnchor.current.blockIndex}@${lastAnchor.current.start}`
            : null,
          pendingAnchor: pendingAnchor.current
            ? `${pendingAnchor.current.blockIndex}@${pendingAnchor.current.start}`
            : null,
        };
      },
      /** What would be saved as the reading position right now, and how it was found. */
      whereAmI: (): unknown => {
        const viewport = viewportRef.current;
        if (!viewport) return { error: 'no viewport' };
        const rect = viewport.getBoundingClientRect();
        const cs = getComputedStyle(viewport);
        const x = rect.left + parseFloat(cs.paddingLeft || '0') + 6;
        const y = rect.top + parseFloat(cs.paddingTop || '0') + 6;
        const hit = positionFromPoint(blocksRef.current, x, y);
        const anchor = currentAnchor();
        return {
          page: pageNowRef.current,
          probePoint: [Math.round(x), Math.round(y)],
          hit: hit ? `${hit.block.index}@${hit.offset}` : null,
          hitText: hit ? hit.block.text.slice(hit.offset, hit.offset + 12) : null,
          anchor: anchor ? `${anchor.blockIndex}@${anchor.start}` : null,
        };
      },
    };
    return () => {
      delete w.__aloudRaProbe;
    };
  }, [chapterId, chapterIndex, currentAnchor, paginator, plain]);

  /* ==================================================== read-aloud host */

  const manifestRef = useRef<BookManifest | null>(null);
  manifestRef.current = manifest;
  const loadChapterRef = useRef(loadChapter);
  loadChapterRef.current = loadChapter;

  useEffect(() => {
    const host: ReadAloudHost = {
      getSegments: (id) => segmentsRef.current.get(id) ?? null,
      openChapter: async (id) => {
        const index = manifestRef.current?.readingOrder.findIndex((c) => c.id === id) ?? -1;
        if (index >= 0) await loadChapterRef.current(index);
      },
      nextChapterId: (id) => {
        const order = manifestRef.current?.readingOrder ?? [];
        const index = order.findIndex((c) => c.id === id);
        return index >= 0 && index + 1 < order.length ? order[index + 1].id : null;
      },
      onSegment: setRaSegment,
      onWord: (charIndex, charLength) => setWord({ charIndex, charLength }),
      onStatus: setRaStatus,
      onError: (message) => toast(message, 'error'),
      bookLanguage: () => manifestRef.current?.language ?? 'en-US',
    };
    const controller = new ReadAloudController(host, settings.readAloud);
    controllerRef.current = controller;
    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, toast]);

  useEffect(() => {
    controllerRef.current?.updateSettings(settings.readAloud);
  }, [settings.readAloud]);

  useEffect(() => {
    if (!raOpen) return;
    void controllerRef.current?.loadVoices(settings.readAloud.engine).then(setVoices);
  }, [raOpen, settings.readAloud.engine]);

  const startReadingAt = useCallback((segmentId: string) => {
    setRaOpen(true);
    void controllerRef.current?.start(segmentId);
  }, []);

  const segmentAt = useCallback(
    (blockIndex: number, offset: number): ReadAloudSegment | null => {
      const list = segmentsRef.current.get(chapterId) ?? [];
      return (
        list.find((s) => s.blockIndex === blockIndex && offset >= s.start && offset <= s.end) ??
        list.find((s) => s.blockIndex === blockIndex) ??
        null
      );
    },
    [chapterId],
  );

  /* ========================================================= annotating */

  const persistAnnotations = useCallback(
    (next: Annotation[]) => {
      setAnnotations(next);
      void window.aloud.annotations.save({ schema: 'aloud-annotations/1', bookId, annotations: next });
    },
    [bookId],
  );

  const annotationAt = useCallback(
    (blockIndex: number, offset: number): Annotation | undefined =>
      annotations.find(
        (a) =>
          a.anchor.chapterId === chapterId &&
          a.anchor.blockIndex === blockIndex &&
          offset >= a.anchor.start &&
          offset <= a.anchor.end &&
          a.kind !== 'bookmark',
      ),
    [annotations, chapterId],
  );

  const upsertAnnotation = useCallback(
    (base: SelectionState, patch: Partial<Annotation>) => {
      const now = new Date().toISOString();
      if (base.annotationId) {
        persistAnnotations(
          annotations.map((a) => (a.id === base.annotationId ? { ...a, ...patch, updatedAt: now } : a)),
        );
        return base.annotationId;
      }
      const created: Annotation = {
        id: uid(),
        kind: 'highlight',
        color: 'yellow',
        anchor: base.anchor,
        text: base.text,
        createdAt: now,
        updatedAt: now,
        ...patch,
      };
      persistAnnotations([...annotations, created]);
      return created.id;
    },
    [annotations, persistAnnotations],
  );

  const toggleBookmark = useCallback(() => {
    const anchor = currentAnchor();
    if (!anchor) return;
    const existing = annotations.find(
      (a) => a.kind === 'bookmark' && a.anchor.chapterId === anchor.chapterId && a.anchor.blockIndex === anchor.blockIndex,
    );
    if (existing) {
      persistAnnotations(annotations.filter((a) => a.id !== existing.id));
      toast('已移除书签');
      return;
    }
    const block = blocksRef.current[anchor.blockIndex];
    const now = new Date().toISOString();
    persistAnnotations([
      ...annotations,
      {
        id: uid(),
        kind: 'bookmark',
        anchor,
        text: (block?.text ?? '').trim().slice(0, 90),
        createdAt: now,
        updatedAt: now,
      },
    ]);
    toast('已添加书签');
  }, [annotations, currentAnchor, persistAnnotations, toast]);

  const bookmarkHere = useMemo(
    () =>
      annotations.some(
        (a) => a.kind === 'bookmark' && a.anchor.chapterId === chapterId && a.anchor.blockIndex === anchorBlock,
      ),
    [annotations, chapterId, anchorBlock],
  );

  /* ========================================================= navigation */

  const jumpTo = useCallback(
    (anchor: TextAnchor) => {
      const index = manifest?.readingOrder.findIndex((c) => c.id === anchor.chapterId) ?? -1;
      if (index < 0) return;
      const from = stateRef.current?.position;
      if (from) {
        setJumpBack(from);
        setTimeout(() => setJumpBack((v) => (v === from ? null : v)), 10_000);
        stateRef.current = {
          ...stateRef.current!,
          history: [from, ...(stateRef.current?.history ?? [])].slice(0, 20),
        };
      }
      void loadChapter(index, anchor);
    },
    [loadChapter, manifest],
  );

  const turningRef = useRef(false);
  /** turnPage is defined further down; the drag handler reaches it through this ref. */
  const turnPageRef = useRef<((direction: 1 | -1) => void) | null>(null);

  const pageNowRef = useRef(0);
  pageNowRef.current = paginator.page;

  /**
   * EVERY sequential page turn goes through here — arrows, keys, read-aloud following —
   * so they all play the ONE animation the user picked. If a turn is already animating,
   * the page still moves (instantly) rather than swallowing the click.
   */
  const animateTurnTo = useCallback(
    (target: number, sound: boolean): void => {
      const from = pageNowRef.current;
      if (target === from || target < 0 || target >= paginator.pages) return;
      pendingAnchor.current = null;
      const direction: 1 | -1 = target > from ? 1 : -1;
      const animation = settings.pageAnimation;
      if (sound && settings.pageSound) playPageTurn(settings.pageSoundVolume, direction);
      const viewport = viewportRef.current;
      const content = contentRef.current;
      if (animation === 'slide' || animation === 'none' || turningRef.current || !viewport || !content) {
        paginator.goTo(target, animation === 'slide' && !turningRef.current);
        return;
      }
      // Move the real content first so what the fold uncovers is already correct,
      // then run the fold on top of it.
      paginator.goTo(target, false);
      turningRef.current = true;
      void runPageTurn({
        mode: animation,
        direction,
        viewport,
        content,
        stride: paginator.stride,
        fromPage: from,
        toPage: target,
        columns,
        gap: 64,
      }).finally(() => {
        turningRef.current = false;
      });
    },
    [columns, paginator, settings.pageAnimation, settings.pageSound, settings.pageSoundVolume],
  );
  const animateTurnToRef = useRef(animateTurnTo);
  animateTurnToRef.current = animateTurnTo;

  /** Where turning BACK into a chapter should land: on its last readable text. */
  const endAnchorOf = useCallback(
    (index: number): TextAnchor | undefined => {
      const ch = plain?.chapters[index];
      const id = manifest?.readingOrder[index]?.id;
      if (!ch || !id) return undefined;
      for (let b = ch.blocks.length - 1; b >= 0; b--) {
        const text = ch.blocks[b];
        if (!text.trim()) continue;
        const len = text.length;
        return {
          chapterId: id,
          blockIndex: b,
          start: Math.max(0, len - 1),
          end: len,
          exact: text.slice(Math.max(0, len - 1)),
          prefix: text.slice(Math.max(0, len - 25), Math.max(0, len - 1)),
          suffix: '',
        };
      }
      return undefined;
    },
    [manifest, plain],
  );

  const turnPage = useCallback(
    (direction: 1 | -1) => {
      if (settings.layout !== 'paginated') {
        viewportRef.current?.scrollBy({
          top: direction * (viewportRef.current.clientHeight - 60),
          behavior: 'smooth',
        });
        return;
      }
      const target = paginator.page + direction;
      if (target >= 0 && target < paginator.pages) {
        animateTurnTo(target, true);
        return;
      }

      /* -------- crossing a chapter boundary -------- */
      const nextIndex = chapterIndex + direction;
      if (nextIndex < 0 || nextIndex >= (manifest?.readingOrder.length ?? 0)) return;
      if (settings.pageSound) playPageTurn(settings.pageSoundVolume, direction);

      const animation = settings.pageAnimation;
      const viewport = viewportRef.current;
      const content = contentRef.current;
      // The outgoing page must be captured NOW — the chapter switch destroys it. It then
      // covers the viewport until the fold takes over, so the new chapter never flashes.
      let snap: HTMLElement | null = null;
      let veil: HTMLElement | null = null;
      if ((animation === 'curl' || animation === 'fade') && viewport && content && !turningRef.current) {
        snap = snapshotWindow(viewport, content, paginator.page, paginator.stride, columns, 64);
        veil = document.createElement('div');
        veil.className = 'pt-overlay';
        const frame = document.createElement('div');
        frame.className = 'pt-frame pt-flat';
        const cs = getComputedStyle(viewport);
        frame.style.left = cs.paddingLeft;
        frame.style.top = cs.paddingTop;
        frame.style.width = `${viewport.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)}px`;
        frame.style.height = `${viewport.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)}px`;
        frame.appendChild(snap.cloneNode(true));
        veil.appendChild(frame);
        viewport.appendChild(veil);
        turningRef.current = true;
      }

      // Backward lands on the previous chapter's LAST page. It used to land on its first:
      // loadChapter's default anchor is the chapter head, and the post-measure anchor
      // restore overrode any page set here.
      const anchor = direction === -1 ? endAnchorOf(nextIndex) : undefined;
      // Whatever happens — a superseded load, an exception, a teardown — the animation
      // lock and the veil must not outlive this turn. A stuck lock silently downgrades
      // every later page turn to an instant jump.
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        veil?.remove();
        if (snap) turningRef.current = false;
      };
      const failsafe = window.setTimeout(release, 2500);
      void loadChapter(nextIndex, anchor)
        .then(() => {
          // Landing runs inside onMeasured's rAF; give it two frames to settle.
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              window.clearTimeout(failsafe);
              const v = viewportRef.current;
              const c = contentRef.current;
              if (released || !snap || !v || !c) {
                release();
                return;
              }
              const landed = pageNowRef.current;
              released = true; // the fold owns the lock from here
              void runPageTurn({
                mode: animation as 'curl' | 'fade',
                direction,
                viewport: v,
                content: c,
                stride: paginator.stride,
                fromPage: landed,
                toPage: landed,
                columns,
                gap: 64,
                oldSnapshot: snap,
              }).finally(() => {
                turningRef.current = false;
              });
              // The fold overlay mounted synchronously above the veil; safe to drop it.
              veil?.remove();
            }),
          );
        })
        .catch(() => {
          window.clearTimeout(failsafe);
          release();
        });
    },
    [
      animateTurnTo,
      chapterIndex,
      columns,
      endAnchorOf,
      loadChapter,
      manifest,
      paginator,
      settings.layout,
      settings.pageAnimation,
      settings.pageSound,
      settings.pageSoundVolume,
    ],
  );
  turnPageRef.current = turnPage;

  /* ====================================================== drag to turn */

  /**
   * Press and drag sideways to turn the page: the paper is pinned to the cursor
   * (single column folds at the midpoint between edge and cursor; double spread hinges
   * about the spine with the free edge tracking the cursor). The raw cursor position is
   * smoothed through an exponential spring in a rAF loop, so choppy mousemove events
   * never reach the paper directly — that is what makes it feel silky.
   *
   * A drag only becomes a page turn when it is decisively horizontal and starts within
   * 400ms of pressing; hold still first (or drag mostly vertically) and it stays an
   * ordinary text selection.
   */
  const dragRef = useRef<{
    startX: number;
    startY: number;
    at: number;
    direction: 1 | -1;
    fromPage: number;
    turner: PageTurner | null;
    target: number;
    current: number;
    raf: number;
    lastFrame: number;
    lastX: number;
    lastAt: number;
    velocity: number;
  } | null>(null);

  const selectModeRef = useRef(selectMode);
  selectModeRef.current = selectMode;

  const onStageMouseDown = useCallback(
    (event: React.MouseEvent) => {
      if (event.button !== 0 || selectMode) return;
      if (settings.layout !== 'paginated' || settings.pageAnimation !== 'curl') return;
      // A single-page chapter used to refuse the gesture outright, which made short
      // chapters feel broken — there was nothing to fold, but there is still a next
      // chapter to go to. The move handler hands those to turnPage.
      if (turningRef.current) return;
      // Note: `a` is deliberately NOT excluded — a table-of-contents page is nothing but
      // links, and refusing to drag there would make whole pages feel stuck. A plain
      // click still follows the link; only a real drag turns the page.
      const target = event.target as HTMLElement;
      if (target.closest('button, input, select, textarea, .ra-bar, .panel, .selection-menu')) return;
      // Writing, not turning: on a tablet the browser follows every pen/finger touch with
      // a compatibility mousedown, which would otherwise start a page-curl mid-stroke.
      if (target.closest('.ink-capture, .ink-toolbar, .ink-text-editor')) return;
      pendingAnchor.current = null;
      dragRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        at: performance.now(),
        direction: 1,
        fromPage: paginator.page,
        turner: null,
        target: 0,
        current: 0,
        raf: 0,
        lastFrame: 0,
        lastX: event.clientX,
        lastAt: performance.now(),
        velocity: 0,
      };
    },
    [paginator.page, paginator.pages, selectMode, settings.layout, settings.pageAnimation],
  );

  useEffect(() => {
    /** Exponential spring: the paper eases toward the cursor instead of jumping. */
    const startSpring = (drag: NonNullable<typeof dragRef.current>): void => {
      drag.lastFrame = performance.now();
      const step = (now: number): void => {
        if (dragRef.current !== drag || !drag.turner) return;
        const dt = now - drag.lastFrame;
        drag.lastFrame = now;
        const alpha = 1 - Math.exp(-dt / 40);
        drag.current += (drag.target - drag.current) * alpha;
        drag.turner.set(drag.current);
        drag.raf = requestAnimationFrame(step);
      };
      drag.raf = requestAnimationFrame(step);
    };

    const onMove = (event: MouseEvent): void => {
      const drag = dragRef.current;
      if (!drag) return;
      // The button was released somewhere we never heard about (outside the window, over
      // another app). Without this the drag would stay "in progress" forever and every
      // later gesture would be refused.
      if (event.buttons === 0) {
        onUp();
        return;
      }
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;

      if (!drag.turner) {
        // In selection mode dragging belongs to the text, so page turning is off here.
        if (selectModeRef.current) {
          dragRef.current = null;
          return;
        }
        if (Math.abs(dx) < 8 || Math.abs(dx) <= Math.abs(dy) * 1.2) return;

        const direction: 1 | -1 = dx < 0 ? 1 : -1;
        const target = paginator.page + direction;
        const viewport = viewportRef.current;
        const content = contentRef.current;
        if (target < 0 || target >= paginator.pages) {
          // At a chapter edge there is no next page in this flow to fold onto, so hand
          // the gesture to turnPage, which knows how to cross into the next chapter.
          // Without this the drag simply died at every chapter end — and this book has
          // hundreds of chapters only two or three pages long.
          dragRef.current = null;
          turnPageRef.current?.(direction);
          return;
        }
        if (!viewport || !content) {
          dragRef.current = null;
          return;
        }
        const from = paginator.page;
        paginator.goTo(target, false);
        window.getSelection()?.removeAllRanges();
        setDragging(true);
        drag.direction = direction;
        drag.fromPage = from;
        drag.turner = createTurner({
          direction,
          viewport,
          content,
          stride: paginator.stride,
          fromPage: from,
          toPage: target,
          columns,
          gap: 64,
        });
        turningRef.current = true;
        startSpring(drag);
      }

      const now = performance.now();
      const dt = now - drag.lastAt;
      if (dt > 0) {
        // px/ms, smoothed — a quick flick should turn even if it was short
        const instant = ((drag.lastX - event.clientX) * drag.direction) / dt;
        drag.velocity = drag.velocity * 0.6 + instant * 0.4;
        drag.lastX = event.clientX;
        drag.lastAt = now;
      }
      drag.target = drag.turner.progressFromCursor(event.clientX);
      event.preventDefault();
    };

    const onUp = (): void => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (!drag?.turner) return;
      cancelAnimationFrame(drag.raf);
      const turner = drag.turner;
      const flicked = drag.velocity > 0.55 && turner.getProgress() > 0.06;
      const committed = turner.getProgress() > turner.commitThreshold || flicked;
      if (committed && settings.pageSound) playPageTurn(settings.pageSoundVolume, drag.direction);
      if (!committed) paginator.goTo(drag.fromPage, false);
      void turner.settle(committed ? 1 : 0, committed ? 340 : 280).finally(() => {
        turningRef.current = false;
        setDragging(false);
      });
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    // Losing focus mid-drag (alt-tab, a dialog) must also end it cleanly.
    window.addEventListener('blur', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onUp);
    };
  }, [columns, paginator, settings.pageSound, settings.pageSoundVolume]);

  /**
   * Teardown on unmount ONLY.
   *
   * This must not live in the listener effect above: that effect depends on `paginator`,
   * which is a fresh object every render, so its cleanup runs constantly — and tearing
   * the drag down there killed the fold on the very first mousemove (the page still
   * jumped, because the paginator had already been moved, but the animation vanished and
   * the "dragging" latch was never released).
   */
  useEffect(
    () => () => {
      const drag = dragRef.current;
      if (!drag) return;
      cancelAnimationFrame(drag.raf);
      drag.turner?.destroy();
      dragRef.current = null;
      turningRef.current = false;
    },
    [],
  );

  /* =========================================================== keyboard */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
      switch (e.key) {
        case 'ArrowRight':
        case 'PageDown':
          e.preventDefault();
          turnPage(1);
          break;
        case 'ArrowLeft':
        case 'PageUp':
          e.preventDefault();
          turnPage(-1);
          break;
        case 'Home':
          e.preventDefault();
          animateTurnToRef.current?.(0, true);
          break;
        case 'End':
          e.preventDefault();
          animateTurnToRef.current?.(paginator.pages - 1, true);
          break;
        case ' ':
          e.preventDefault();
          if (raOpen) controllerRef.current?.toggle(segmentAt(lastAnchor.current?.blockIndex ?? 0, 0)?.id);
          else turnPage(1);
          break;
        case 'Escape':
          if (leftPanel || rightPanel) closePanels();
          else if (raOpen) setRaOpen(false);
          else navigate({ name: 'library' });
          break;
        case 'f':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            setRightPanel('search');
          }
          break;
        case 'b':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            toggleBookmark();
          }
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closePanels, leftPanel, navigate, raOpen, rightPanel, segmentAt, toggleBookmark, turnPage]);

  /* Commands coming from the native menu bar. */
  useEffect(() => {
    const onMenu = (event: Event) => {
      const { command } = (event as CustomEvent<{ command: string }>).detail;
      if (command.startsWith('theme:')) patchSettings({ theme: command.slice(6) as never });
      else if (command === 'layout:paginated') patchSettings({ layout: 'paginated' });
      else if (command === 'layout:scroll') patchSettings({ layout: 'scroll' });
      else if (command === 'font:bigger') patchSettings({ fontSizePx: Math.min(34, settings.fontSizePx + 1) });
      else if (command === 'font:smaller') patchSettings({ fontSizePx: Math.max(13, settings.fontSizePx - 1) });
      else if (command === 'ra:toggle') {
        setRaOpen(true);
        controllerRef.current?.toggle(segmentAt(lastAnchor.current?.blockIndex ?? 0, 0)?.id);
      } else if (command === 'ra:next') controllerRef.current?.next();
      else if (command === 'ra:prev') controllerRef.current?.prev();
      else if (command === 'ra:faster') patchReadAloud({ rate: Math.min(2, settings.readAloud.rate + 0.1) });
      else if (command === 'ra:slower') patchReadAloud({ rate: Math.max(0.5, settings.readAloud.rate - 0.1) });
      else if (command === 'export-annotations') {
        void exportAnnotations(bookId).then((p) => p && toast(`已导出到 ${p}`));
      }
    };
    window.addEventListener('aloud:menu', onMenu);
    return () => window.removeEventListener('aloud:menu', onMenu);
  }, [bookId, patchReadAloud, patchSettings, segmentAt, settings.fontSizePx, settings.readAloud.rate, toast]);

  /* ====================================================== reading time */

  useEffect(() => {
    let lastInput = Date.now();
    const bump = () => {
      lastInput = Date.now();
    };
    for (const ev of ['mousemove', 'keydown', 'wheel', 'click']) window.addEventListener(ev, bump);
    const timer = setInterval(() => {
      const active = document.hasFocus() && (Date.now() - lastInput < 90_000 || raStatus === 'playing');
      if (active) void window.aloud.stats.add(bookId, 5);
    }, 5000);
    return () => {
      clearInterval(timer);
      for (const ev of ['mousemove', 'keydown', 'wheel', 'click']) window.removeEventListener(ev, bump);
    };
  }, [bookId, raStatus]);

  /* ========================================================== rendering */

  if (loading || !manifest) {
    // A skeleton in the shape of the page that is coming: two columns of text lines,
    // one soft shimmer. A bare "正在打开…" told the user nothing about what to expect
    // and read as a stall on big books.
    return (
      <main className="main reader">
        <header className="topbar" />
        <div className="skeleton-page" aria-label="正在打开" role="status">
          {[0, 1].map((col) => (
            <div className="skeleton-col" key={col}>
              {Array.from({ length: 13 }, (_, i) => (
                <i
                  key={i}
                  style={{ width: `${[96, 100, 93, 98, 88, 100, 95, 90, 99, 94, 97, 86, 58][i]}%` }}
                />
              ))}
            </div>
          ))}
        </div>
      </main>
    );
  }

  const remaining = minutesLeft(chapterIndex, anchorBlock);

  const handleMouseUp = (): void => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!contentRef.current?.contains(range.commonAncestorContainer)) return;
    const anchor = anchorFromRange(chapterId, blocksRef.current, range);
    if (!anchor) return;
    setDict(null);
    setSelection({ rect: range.getBoundingClientRect(), anchor, text: sel.toString() });
  };

  const handleClick = (e: React.MouseEvent): void => {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const hit = positionFromPoint(blocksRef.current, e.clientX, e.clientY);
    if (!hit) return;
    const existing = annotationAt(hit.block.index, hit.offset);
    if (existing) {
      const range = resolveAnchor(blocksRef.current, existing.anchor);
      if (range) {
        setSelection({
          rect: range.getBoundingClientRect(),
          anchor: existing.anchor,
          text: existing.text,
          annotationId: existing.id,
        });
      }
      return;
    }
    setSelection(null);
    if (raOpen) {
      const segment = segmentAt(hit.block.index, hit.offset);
      if (segment) startReadingAt(segment.id);
    }
  };

  const handleDoubleClick = (e: React.MouseEvent): void => {
    const sel = window.getSelection();
    const wordText = sel?.toString().trim() ?? '';
    if (!wordText || wordText.length > 24 || !sel || sel.rangeCount === 0) return;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    void window.aloud.dict.lookup(wordText).then((entry) => setDict({ rect, word: wordText, entry }));
    e.preventDefault();
  };

  return (
    <main className={cx('main reader', chromeIdle && 'chrome-idle')}>
      <header
        className="topbar titlebar-drag"
        style={{ ['--tb-scale' as string]: settings.toolbarScale ?? 1 }}
      >
        <button className="btn icon" title="返回书架 (Esc)" onClick={() => navigate({ name: 'library' })}>
          <Icon name="back" />
        </button>
        <button
          className={cx('btn icon', leftPanel === 'toc' && 'on')}
          title="目录"
          onClick={() => setLeftPanel(leftPanel === 'toc' ? null : 'toc')}
        >
          <Icon name="toc" />
        </button>
        <span className="book-title">
          {manifest.title}
          {chapter?.title ? ` · ${chapter.title}` : ''}
        </span>
        {recActive ? (
          <button className="rec-chip" title="停止录音" onClick={() => void toggleRecording()}>
            <i />
            {Math.floor(recElapsed / 60000)}:{String(Math.floor(recElapsed / 1000) % 60).padStart(2, '0')}
          </button>
        ) : null}
        <span className="spacer" />
        {raOpen ? (
          <ReadAloudBar
            status={raStatus}
            current={raSegment}
            settings={settings.readAloud}
            patch={patchReadAloud}
            voices={voices}
            wordHighlightLive={controllerRef.current?.wordHighlightAvailable() ?? true}
            onToggle={() =>
              controllerRef.current?.toggle(segmentAt(lastAnchor.current?.blockIndex ?? 0, 0)?.id)
            }
            onPrev={() => controllerRef.current?.prev()}
            onNext={() => controllerRef.current?.next()}
            onClose={() => {
              controllerRef.current?.stop();
              setRaOpen(false);
            }}
          />
        ) : null}
        <span className="spacer" />
        <div className="tool-cluster">
        <button
          className={cx('btn', 'icon', raOpen && 'active')}
          title="逐行朗读"
          onClick={() => {
            if (raOpen) {
              controllerRef.current?.stop();
              setRaOpen(false);
            } else {
              setRaOpen(true);
            }
          }}
        >
          <Icon name="speaker" />
        </button>
        <button
          className={cx('btn icon', rightPanel === 'search' && 'on')}
          title={`搜索 (${kbd('F')})`}
          onClick={() => setRightPanel(rightPanel === 'search' ? null : 'search')}
        >
          <Icon name="search" />
        </button>
        <button
          className={cx('btn', 'icon', selectMode && 'active')}
          title={selectMode ? '选中模式：开（可以选字，翻页用箭头/方向键）' : '选中模式：关（拖动即翻页）'}
          onClick={() => setSelectMode((v) => !v)}
        >
          <Icon name="cursor" filled={selectMode} />
        </button>
        <button
          className={cx('btn', 'icon', bookmarkHere && 'on')}
          title={`${bookmarkHere ? '移除书签' : '添加书签'} (${kbd('B')})`}
          onClick={toggleBookmark}
        >
          <Icon name="bookmark" filled={bookmarkHere} />
        </button>
        <button
          className={cx('btn icon', rightPanel === 'annotations' && 'on')}
          title="标注与书签"
          onClick={() => setRightPanel(rightPanel === 'annotations' ? null : 'annotations')}
        >
          <Icon name="note" />
        </button>
        <button
          className={cx('btn', 'icon', inkMode && 'on')}
          title={inkMode ? '退出手写' : '手写标注'}
          onClick={() => setInkMode((v) => !v)}
        >
          <Icon name="pen" filled={inkMode} />
        </button>
        <button
          className={cx('btn', 'icon', recActive && 'recording-live')}
          title={recActive ? '录音中' : '录音'}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setAccMenu(accMenu ? null : { x: Math.max(12, r.right - 200), y: r.bottom + 8 });
          }}
        >
          <Icon name="mic" filled={recActive} />
        </button>
        <button
          className={cx('btn icon', rightPanel === 'appearance' && 'on')}
          title="外观"
          onClick={() => setRightPanel(rightPanel === 'appearance' ? null : 'appearance')}
        >
          <Icon name="aa" size={19} />
        </button>
        </div>
      </header>

      <div
        className={cx(
          'stage',
          edgeHint === 'left' && 'near-left',
          edgeHint === 'right' && 'near-right',
          dragging && 'dragging',
        )}
        // tokens.css keys the font stacks off [data-font]; without this attribute the
        // picker in the appearance panel changed a setting nothing ever read.
        data-font={settings.fontFamily}
        style={
          {
            '--reader-pad': `${settings.marginPct}%`,
            '--reader-size': `${settings.fontSizePx}px`,
            '--reader-leading': settings.lineHeight,
            '--reader-indent': manifest.language.startsWith('zh') ? '2em' : '0',
            '--reader-weight': settings.bold ? 600 : 400,
            '--reader-tracking': `${settings.letterSpacing ?? 0}em`,
            '--reader-parasp': `${0.85 + (settings.paragraphSpacing ?? 0)}em`,
          } as React.CSSProperties
        }
        onMouseDown={onStageMouseDown}
        onWheel={(e) => {
          // Plain wheel turns the page — Ctrl+wheel stays the type-size control. Both
          // axes count (tilt wheels and trackpads page sideways). Two device families,
          // two disciplines:
          //   · notched wheels send big discrete deltas → one notch, one page;
          //   · trackpads and tilt-repeat send a TRAIN of small deltas with momentum —
          //     treated as ONE gesture that turns ONE page, ended by a pause. The old
          //     per-event throttle let a single sideways flick land 2-3 turns.
          if (e.ctrlKey || settings.layout !== 'paginated') return;
          const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
          if (!delta) return;
          const g = wheelGesture.current;
          const now = performance.now();
          const isNotch = e.deltaMode === 1 || Math.abs(delta) >= 100;
          if (isNotch) {
            g.t = now;
            g.fired = true; // a notch claims the gesture: momentum tails cannot re-fire
            if (now - wheelTurnAt.current < 400) return;
            wheelTurnAt.current = now;
            turnPage(delta > 0 ? 1 : -1);
            return;
          }
          if (now - g.t > 220) {
            g.sum = 0;
            g.fired = false;
          }
          g.t = now;
          g.sum += delta;
          if (!g.fired && Math.abs(g.sum) >= 40) {
            g.fired = true;
            wheelTurnAt.current = now;
            turnPage(g.sum > 0 ? 1 : -1);
          }
        }}
        onMouseMove={(e) => {
          // Edge arrows appear only when the cursor is genuinely near that side.
          // This is React state rather than a classList toggle: the stage is rendered by
          // React, so any re-render would wipe an imperatively-added class.
          const rect = e.currentTarget.getBoundingClientRect();
          const next =
            e.clientX - rect.left < 90 ? 'left' : rect.right - e.clientX < 90 ? 'right' : null;
          setEdgeHint((prev) => (prev === next ? prev : next));
        }}
        onMouseLeave={() => setEdgeHint(null)}
      >
        <div
          ref={viewportRef}
          className={cx('viewport', settings.layout === 'scroll' && 'scroll')}
          onMouseUp={handleMouseUp}
          onClick={handleClick}
          onDoubleClick={handleDoubleClick}
          onScroll={settings.layout === 'scroll' ? () => persistPosition() : undefined}
        >
          <ChapterView
            html={chapterHtml}
            contentRef={contentRef}
            className={cx(
            'chapter',
            settings.justify && 'justify',
            raStatus !== 'idle' && 'dim',
            !selectMode && 'no-select',
          )}
            onBlocks={onBlocks}
            onImage={(src, caption) => setLightbox({ src, caption })}
            onChapterLink={(id) => {
              const index = manifest.readingOrder.findIndex((c) => c.id === id);
              if (index >= 0) jumpTo({ chapterId: id, blockIndex: 0, start: 0, end: 0 });
            }}
          />
          <div ref={layerRef} className="hl-layer" aria-hidden="true" />
        </div>

        {inkMode ? (
          <div
            ref={inkCaptureRef}
            className={cx('ink-capture', `tool-${inkTool}`)}
            onPointerDown={onInkDown}
            onPointerMove={onInkMove}
            onPointerUp={onInkUp}
            onPointerCancel={onInkUp}
            // The capture can end without a pointerup (the OS took the gesture over);
            // closing the stroke here is what keeps the next one from being refused.
            onLostPointerCapture={onInkUp}
          />
        ) : null}
        {inkMode && inkTextEdit ? (
          <textarea
            className="ink-text-editor"
            style={{ left: inkTextEdit.left, top: inkTextEdit.top, color: `var(--pen-${penColor})` }}
            autoFocus
            rows={Math.max(1, inkTextEdit.value.split('\n').length)}
            value={inkTextEdit.value}
            placeholder="输入文字…"
            onChange={(e) => setInkTextEdit((t) => (t ? { ...t, value: e.target.value } : t))}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') setInkTextEdit(null);
              else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commitInkText();
            }}
            onBlur={commitInkText}
          />
        ) : null}

        {settings.brightness < 1 ? (
          <div className="brightness-veil" style={{ opacity: 1 - settings.brightness }} />
        ) : null}

        {settings.layout === 'paginated' ? (
          <>
            <button className="page-edge left" onClick={() => turnPage(-1)} title="上一页 (←)">
              <Icon name="chevronLeft" size={22} />
            </button>
            <button className="page-edge right" onClick={() => turnPage(1)} title="下一页 (→)">
              <Icon name="chevronRight" size={22} />
            </button>
          </>
        ) : null}

        {jumpBack ? (
          <div className="jump-back">
            <Icon name="back" size={15} />
            <span>已跳转，可返回原处</span>
            <button
              className="btn primary"
              onClick={() => {
                const target = jumpBack;
                setJumpBack(null);
                const index = manifest.readingOrder.findIndex((c) => c.id === target.anchor.chapterId);
                if (index >= 0) void loadChapter(index, target.anchor);
              }}
            >
              返回
            </button>
          </div>
        ) : null}

      </div>

      <footer className="bottombar">
        <span>
          {settings.layout === 'paginated' ? `第 ${paginator.page + 1} / ${paginator.pages} 页` : '滚动模式'}
        </span>
        <div className="scrubber">
          <input
            className="slider"
            type="range"
            min={0}
            max={1000}
            value={Math.round(progress * 1000)}
            onChange={(e) => {
              const p = Number(e.target.value) / 1000;
              setProgress(p);
            }}
            onMouseUp={(e) => {
              const p = Number((e.target as HTMLInputElement).value) / 1000;
              const target = locateByProgress(p);
              void loadChapter(target.chapterIndex, {
                chapterId: manifest.readingOrder[target.chapterIndex].id,
                blockIndex: target.blockIndex,
                start: 0,
                end: 0,
              });
            }}
          />
          <div className="ticks">
            {stats
              ? stats.before.map((w, i) => (
                  <i key={i} style={{ left: `${(w / stats.total) * 100}%` }} title={manifest.readingOrder[i]?.title} />
                ))
              : null}
          </div>
        </div>
        {isNotebook ? (
          <button
            className="btn small"
            title="在末尾追加 10 页"
            onClick={() => {
              void window.aloud.books
                .addPages(bookId, 10)
                .then(async (total) => {
                  // The chapter is cached by id; drop it so the new sheets appear.
                  htmlCache.current.delete(cacheKey(chapterId));
                  const fresh = await window.aloud.books.chapter(bookId, chapterId);
                  htmlCache.current.set(cacheKey(chapterId), fresh);
                  setChapterHtml(fresh);
                  setManifest(await window.aloud.books.manifest(bookId));
                  toast(`已加到 ${total} 页`);
                })
                .catch((err) => toast(err instanceof Error ? err.message : String(err), 'error'));
            }}
          >
            <Icon name="plus" size={14} />
            加页
          </button>
        ) : (
          <span>本章还剩 {formatMinutes(remaining)}</span>
        )}
        <span>{Math.round(progress * 100)}%</span>
      </footer>

      {leftPanel === 'toc' ? (
        <TocPanel
          manifest={manifest}
          currentChapterId={chapterId}
          width={settings.panelWidth}
          onWidth={(n) => patchSettings({ panelWidth: n })}
          onJump={(id) => jumpTo({ chapterId: id, blockIndex: 0, start: 0, end: 0 })}
          onClose={() => setLeftPanel(null)}
        />
      ) : null}

      {rightPanel === 'search' ? (
        <SearchPanel
          manifest={manifest}
          plain={plain}
          width={settings.panelWidth}
          onWidth={(n) => patchSettings({ panelWidth: n })}
          onJump={(anchor) => jumpTo(anchor)}
          onClose={() => setRightPanel(null)}
        />
      ) : null}

      {rightPanel === 'annotations' ? (
        <AnnotationsPanel
          manifest={manifest}
          annotations={annotations}
          onJump={(anchor) => jumpTo(anchor)}
          onDelete={(id) => persistAnnotations(annotations.filter((a) => a.id !== id))}
          onExport={(format) =>
            void exportAnnotations(bookId, format).then((p) => p && toast(`已导出到 ${p}`))
          }
          width={settings.panelWidth}
          onWidth={(n) => patchSettings({ panelWidth: n })}
          onClose={() => setRightPanel(null)}
        />
      ) : null}

      {rightPanel === 'recordings' ? (
        <PanelShell
          title="阅读录音"
          onClose={() => setRightPanel(null)}
          width={settings.panelWidth}
          onWidth={(n) => patchSettings({ panelWidth: n })}
        >
          <RecordingsPanel
            bookId={bookId}
            refreshKey={recRefresh}
            onFollow={(mark: RecordingMark) =>
              jumpTo({ chapterId: mark.chapterId, blockIndex: mark.blockIndex, start: 0, end: 0 })
            }
          />
        </PanelShell>
      ) : null}

      {rightPanel === 'appearance' ? (
        <AppearancePanel settings={settings} patch={patchSettings} onClose={() => setRightPanel(null)} />
      ) : null}

      {inkMode ? (
        <div
          className={cx('ink-toolbar', `dock-${settings.inkDock ?? 'top'}`, inkDrag && 'dragging')}
          style={
            inkDrag
              ? { left: inkDrag.x, top: inkDrag.y, right: 'auto', transform: 'translate(-50%, -50%)' }
              : undefined
          }
        >
          <span className="ink-grip" title="拖动工具条" onPointerDown={onInkGripDown}>
            <Icon name="grip" size={14} />
          </span>
          {(
            [
              ['select', '选择', 'lasso'],
              ['pen', '笔', 'pen'],
              ['marker', '荧光笔', 'marker'],
              ['eraser', '橡皮', 'eraser'],
              ['shape', '形状', 'shapes'],
              ['text', '文字', 'textTool'],
            ] as const
          ).map(([tool, label, icon]) => (
            <button
              key={tool}
              className={cx('btn icon', inkTool === tool && 'on')}
              title={label}
              onClick={() => {
                setInkTool(tool);
                if (tool !== 'select') setSelIds([]);
              }}
            >
              <Icon name={icon} size={16} />
            </button>
          ))}
          <button
            className="btn icon"
            title="图片"
            onClick={() => void window.aloud.ink.importImages(bookId).then((fs) => insertInkImages(fs))}
          >
            <Icon name="image" size={16} />
          </button>
          {inkTool === 'pen' ? (
            <>
              <span className="divider" />
              {(
                [
                  ['ball', '圆珠笔'],
                  ['fountain', '钢笔'],
                  ['pencil', '铅笔'],
                ] as const
              ).map(([styleKey, label]) => (
                <button
                  key={styleKey}
                  className={cx('ink-style-btn', penStyle === styleKey && 'on')}
                  title={label}
                  onClick={() => setPenStyle(styleKey)}
                >
                  {label.slice(0, 2)}
                </button>
              ))}
            </>
          ) : null}
          {inkTool === 'shape' ? (
            <>
              <span className="divider" />
              {(
                [
                  ['line', '直线', 'shapeLine'],
                  ['arrow', '箭头', 'shapeArrow'],
                  ['rect', '矩形', 'shapeRect'],
                  ['ellipse', '椭圆', 'shapeEllipse'],
                ] as const
              ).map(([kind, label, icon]) => (
                <button
                  key={kind}
                  className={cx('btn icon', shapeKind === kind && 'on')}
                  title={label}
                  onClick={() => setShapeKind(kind)}
                >
                  <Icon name={icon} size={15} />
                </button>
              ))}
            </>
          ) : null}
          {inkTool !== 'select' && inkTool !== 'eraser' ? (
            <>
              <span className="divider" />
              {(inkTool === 'marker' ? MARKER_COLORS : PEN_COLORS).map((c) => (
                <button
                  key={c}
                  className={cx('ink-swatch', (inkTool === 'marker' ? markerColor : penColor) === c && 'on')}
                  style={{
                    background: inkTool === 'marker' ? `var(--hl-${c})` : `var(--pen-${c})`,
                  }}
                  title={c}
                  onClick={() => (inkTool === 'marker' ? setMarkerColor(c) : setPenColor(c))}
                />
              ))}
              <span className="divider" />
              {(
                [
                  [1.4, '细'],
                  [2.2, '中'],
                  [3.4, '粗'],
                ] as const
              ).map(([size, label]) => (
                <button
                  key={size}
                  className={cx('ink-dot-btn', inkSize === size && 'on')}
                  title={label}
                  onClick={() => setInkSize(size)}
                >
                  <i style={{ width: 4 + size * 2.2, height: 4 + size * 2.2 }} />
                </button>
              ))}
            </>
          ) : null}
          <span className="divider" />
          <button className="btn icon" title={`撤销 (${kbd('Z')})`} onClick={undoInk}>
            <Icon name="undo" size={15} />
          </button>
          <button className="btn icon" title={`重做 (${IS_MAC ? kbd('Z', true) : kbd('Y')})`} onClick={redoInk}>
            <Icon name="redo" size={15} />
          </button>
          <button className="btn icon" title="完成" onClick={() => setInkMode(false)}>
            <Icon name="check" size={16} />
          </button>
        </div>
      ) : null}

      {accMenu ? (
        <div
          className="context-menu"
          style={{ left: accMenu.x, top: accMenu.y, position: 'fixed' }}
          onMouseLeave={() => setAccMenu(null)}
        >
          <button
            onClick={() => {
              setAccMenu(null);
              void toggleRecording();
            }}
          >
            <Icon name="mic" size={15} /> {recActive ? '停止录音' : '开始录音'}
          </button>
          <button
            onClick={() => {
              setAccMenu(null);
              setRightPanel(rightPanel === 'recordings' ? null : 'recordings');
            }}
          >
            <Icon name="list" size={15} /> 录音列表
          </button>
        </div>
      ) : null}

      {selection ? (
        <SelectionMenu
          rect={selection.rect}
          hasAnnotation={!!selection.annotationId}
          onColor={(color) => {
            upsertAnnotation(selection, { kind: 'highlight', color });
            window.getSelection()?.removeAllRanges();
            setSelection(null);
          }}
          onUnderline={() => {
            upsertAnnotation(selection, { kind: 'underline' });
            window.getSelection()?.removeAllRanges();
            setSelection(null);
          }}
          onNote={() => {
            setNoteFor(selection);
            setSelection(null);
          }}
          onCopy={() => {
            void navigator.clipboard.writeText(selection.text);
            toast('已复制');
            setSelection(null);
          }}
          onSearch={() => {
            setRightPanel('search');
            setSelection(null);
          }}
          onSpeak={() => {
            const segment = segmentAt(selection.anchor.blockIndex, selection.anchor.start);
            if (segment) startReadingAt(segment.id);
            setSelection(null);
          }}
          onRemove={() => {
            persistAnnotations(annotations.filter((a) => a.id !== selection.annotationId));
            setSelection(null);
          }}
          onDismiss={() => setSelection(null)}
        />
      ) : null}

      {noteFor ? (
        <NoteEditor
          rect={noteFor.rect}
          initial={annotations.find((a) => a.id === noteFor.annotationId)?.note ?? ''}
          onSave={(note) => {
            // Attaching a note to a fresh selection also creates the highlight it hangs off.
            upsertAnnotation(
              noteFor,
              noteFor.annotationId ? { note } : { note, kind: 'highlight', color: 'yellow' },
            );
            window.getSelection()?.removeAllRanges();
            setNoteFor(null);
          }}
          onCancel={() => setNoteFor(null)}
        />
      ) : null}

      {dict ? (
        <DictCard
          rect={dict.rect}
          word={dict.word}
          entry={dict.entry}
          onClose={() => setDict(null)}
          onSearchInBook={() => {
            setRightPanel('search');
            setDict(null);
          }}
        />
      ) : null}

      {lightbox ? (
        <Lightbox src={lightbox.src} caption={lightbox.caption} onClose={() => setLightbox(null)} />
      ) : null}
    </main>
  );
}
