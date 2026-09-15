import { useMemo, useState } from 'react';
import type {
  Annotation,
  BookManifest,
  HighlightColor,
  PlainIndex,
  SearchHit,
  Settings,
  TextAnchor,
  ThemeName,
  TocItem,
} from '@shared/types';
import { makeSnippet, searchBlocks } from '@shared/text';
import { cx, relativeDate } from '../lib/util';
import { useDragSize } from '../lib/useDragSize';
import { Icon, Segmented, Slider, Switch } from './ui';

const HIGHLIGHT_HEX: Record<HighlightColor, string> = {
  yellow: 'var(--hl-yellow)',
  green: 'var(--hl-green)',
  blue: 'var(--hl-blue)',
  pink: 'var(--hl-pink)',
  purple: 'var(--hl-purple)',
};

export function PanelShell({
  title,
  side,
  onClose,
  children,
  actions,
  width,
  onWidth,
}: {
  title: string;
  side?: 'left' | 'right';
  onClose: () => void;
  children: React.ReactNode;
  actions?: React.ReactNode;
  width?: number;
  onWidth?: (n: number) => void;
}): JSX.Element {
  const grip = useDragSize({
    value: width ?? 340,
    min: 240,
    max: 620,
    // The grip is always on the side facing the text, so it grows toward the reader.
    edge: side === 'left' ? 'right' : 'left',
    onCommit: (n) => onWidth?.(n),
  });
  return (
    <aside
      className={cx('panel', side === 'left' && 'left', grip.dragging && 'resizing')}
      style={{ width: onWidth ? grip.size : undefined }}
    >
      {onWidth ? <div className="panel-grip" onMouseDown={grip.onMouseDown} /> : null}
      <header>
        <span>{title}</span>
        <span className="spacer" />
        {actions}
        <button className="btn icon" onClick={onClose} title="关闭 (Esc)">
          <Icon name="close" size={16} />
        </button>
      </header>
      <div className="body">{children}</div>
    </aside>
  );
}

/* -------------------------------------------------------------- TOC */

export function TocPanel({
  manifest,
  currentChapterId,
  onJump,
  onClose,
  width,
  onWidth,
}: {
  manifest: BookManifest;
  currentChapterId: string;
  onJump: (chapterId: string) => void;
  onClose: () => void;
  width: number;
  onWidth: (n: number) => void;
}): JSX.Element {
  const flat = manifest.toc?.length
    ? manifest.toc
    : manifest.readingOrder.map<TocItem>((c, i) => ({ title: c.title ?? `第 ${i + 1} 节`, chapterId: c.id }));

  const render = (items: TocItem[], depth: number): JSX.Element[] =>
    items.flatMap((item, i) => [
      <button
        key={`${item.chapterId}-${depth}-${i}`}
        className={cx('toc-item', item.chapterId === currentChapterId && 'current')}
        style={{ paddingLeft: 10 + depth * 14 }}
        onClick={() => onJump(item.chapterId)}
      >
        {depth === 0 ? (
          <span className="num">{manifest.readingOrder.findIndex((c) => c.id === item.chapterId) + 1}</span>
        ) : null}
        {item.title}
      </button>,
      ...(item.children ? render(item.children, depth + 1) : []),
    ]);

  return (
    <PanelShell title="目录" side="left" onClose={onClose} width={width} onWidth={onWidth}>
      {render(flat, 0)}
    </PanelShell>
  );
}

/* ----------------------------------------------------------- search */

export function SearchPanel({
  manifest,
  plain,
  onJump,
  onClose,
  width,
  onWidth,
}: {
  manifest: BookManifest;
  plain: PlainIndex | null;
  onJump: (anchor: TextAnchor) => void;
  onClose: () => void;
  width: number;
  onWidth: (n: number) => void;
}): JSX.Element {
  const [query, setQuery] = useState('');

  const hits = useMemo<SearchHit[]>(() => {
    if (!plain || query.trim().length < 1) return [];
    const out: SearchHit[] = [];
    plain.chapters.forEach((chapter, chapterIndex) => {
      const raw = searchBlocks(chapter.blocks, query, 200);
      for (const hit of raw) {
        const block = chapter.blocks[hit.blockIndex];
        const { snippet, matchStart, matchEnd } = makeSnippet(block, hit.start, hit.end);
        out.push({
          chapterId: chapter.id,
          chapterIndex,
          chapterTitle: chapter.title ?? manifest.readingOrder[chapterIndex]?.title,
          anchor: {
            chapterId: chapter.id,
            blockIndex: hit.blockIndex,
            start: hit.start,
            end: hit.end,
            exact: block.slice(hit.start, hit.end),
            prefix: block.slice(Math.max(0, hit.start - 24), hit.start),
            suffix: block.slice(hit.end, hit.end + 24),
          },
          snippet,
          matchStart,
          matchEnd,
        });
        if (out.length >= 400) return;
      }
    });
    return out;
  }, [manifest.readingOrder, plain, query]);

  return (
    <PanelShell title="搜索本书" onClose={onClose} width={width} onWidth={onWidth}>
      <div style={{ padding: '0 2px 10px' }}>
        <div className="search-box" style={{ width: '100%' }}>
          <Icon name="search" size={15} />
          <input
            // Focus without scroll: plain autoFocus scroll-reveals the input and drags
            // the paginated viewport sideways — the "page jolts when search opens" bug.
            ref={(el) => el?.focus({ preventScroll: true })}
            placeholder="输入关键词"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {query ? (
          <div style={{ padding: '8px 4px 0', fontSize: 11.5, color: 'var(--app-fg-faint)' }}>
            {hits.length ? `${hits.length} 处匹配${hits.length >= 400 ? '（已截断）' : ''}` : '没有找到'}
          </div>
        ) : null}
      </div>
      {hits.map((hit, i) => (
        <button key={`${hit.chapterId}-${i}`} className="result" onClick={() => onJump(hit.anchor)}>
          <div className="where">{hit.chapterTitle ?? hit.chapterId}</div>
          <div>
            {hit.snippet.slice(0, hit.matchStart)}
            <mark>{hit.snippet.slice(hit.matchStart, hit.matchEnd)}</mark>
            {hit.snippet.slice(hit.matchEnd)}
          </div>
        </button>
      ))}
    </PanelShell>
  );
}

/* ------------------------------------------------------ annotations */

export function AnnotationsPanel({
  annotations,
  manifest,
  onJump,
  onDelete,
  onExport,
  onClose,
  width,
  onWidth,
}: {
  annotations: Annotation[];
  manifest: BookManifest;
  onJump: (anchor: TextAnchor) => void;
  onDelete: (id: string) => void;
  onExport: (format: 'md' | 'txt') => void;
  onClose: () => void;
  width: number;
  onWidth: (n: number) => void;
}): JSX.Element {
  const [filter, setFilter] = useState<'all' | 'highlight' | 'note' | 'bookmark'>('all');
  const titles = useMemo(
    () => new Map(manifest.readingOrder.map((c, i) => [c.id, c.title ?? `第 ${i + 1} 节`])),
    [manifest.readingOrder],
  );

  const list = annotations.filter((a) => {
    if (filter === 'all') return true;
    if (filter === 'note') return !!a.note?.trim();
    if (filter === 'bookmark') return a.kind === 'bookmark';
    return a.kind === 'highlight' || a.kind === 'underline';
  });

  return (
    <PanelShell
      title="标注与书签"
      onClose={onClose}
      width={width}
      onWidth={onWidth}
      actions={
        <>
          <button className="btn icon" title="导出 Markdown" onClick={() => onExport('md')}>
            <Icon name="export" size={16} />
          </button>
          <button className="btn icon" title="导出纯文本" onClick={() => onExport('txt')}>
            <Icon name="copy" size={16} />
          </button>
        </>
      }
    >
      <div style={{ padding: '0 2px 10px' }}>
        <Segmented
          value={filter}
          options={[
            { value: 'all', label: `全部 ${annotations.length}` },
            { value: 'highlight', label: '标注' },
            { value: 'note', label: '笔记' },
            { value: 'bookmark', label: '书签' },
          ]}
          onChange={setFilter}
        />
      </div>
      {list.length === 0 ? (
        <p style={{ padding: 16, color: 'var(--app-fg-faint)', fontSize: 12.5, lineHeight: 1.6 }}>
          选中正文即可标注。标注锚定在「章节 + 段落 + 字符区间」上，换字号、换主题、换排版都不会错位。
        </p>
      ) : null}
      {list.map((a) => (
        <div
          key={a.id}
          className="anno"
          style={{ ['--swatch' as string]: a.kind === 'bookmark' ? 'var(--accent)' : HIGHLIGHT_HEX[a.color ?? 'yellow'] }}
          onClick={() => onJump(a.anchor)}
        >
          <div className="quote">
            {a.kind === 'bookmark' ? '🔖 ' : ''}
            {a.text.trim().replace(/\s+/g, ' ') || '（此页）'}
          </div>
          {a.note?.trim() ? <div className="note">{a.note}</div> : null}
          <div className="when">
            {titles.get(a.anchor.chapterId) ?? ''} · {relativeDate(a.createdAt)}
            <button
              className="btn icon"
              style={{ float: 'right', height: 20, width: 20 }}
              title="删除"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(a.id);
              }}
            >
              <Icon name="trash" size={13} />
            </button>
          </div>
        </div>
      ))}
    </PanelShell>
  );
}

/* ------------------------------------------------------ appearance */

const THEMES: { value: ThemeName; label: string; bg: string; fg: string }[] = [
  { value: 'white', label: '白', bg: '#ffffff', fg: '#1c1c1e' },
  { value: 'sepia', label: '褐', bg: '#f6ecd8', fg: '#3a2d1c' },
  { value: 'gray', label: '灰', bg: '#3c3d40', fg: '#e2e1de' },
  { value: 'night', label: '夜', bg: '#0b0b0d', fg: '#b9b8b6' },
];

const FONTS = [
  { value: 'serif-cn', label: '宋体 / Serif' },
  { value: 'sans-cn', label: '黑体 / Sans' },
  { value: 'kai', label: '楷体' },
  { value: 'charter', label: 'Charter' },
  { value: 'palatino', label: 'Palatino' },
  { value: 'system', label: '系统界面字体' },
];

/**
 * What "恢复默认" restores. Deliberately only the typography and page-behaviour keys —
 * resetting here should not silently throw away the read-aloud voice, the cloned samples
 * or the reading goal, none of which are on this panel.
 */
const TYPOGRAPHY_DEFAULTS: Partial<Settings> = {
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
  pageSound: true,
  pageSoundVolume: 0.6,
};

export function AppearancePanel({
  settings,
  patch,
  onClose,
}: {
  settings: Settings;
  patch: (p: Partial<Settings>) => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <PanelShell title="外观" onClose={onClose}>
      <div className="theme-swatches" style={{ marginBottom: 16 }}>
        {THEMES.map((t) => (
          <button
            key={t.value}
            className="theme-swatch"
            aria-pressed={settings.theme === t.value}
            style={{ background: t.bg, color: t.fg }}
            onClick={() => patch({ theme: t.value })}
          >
            {t.label}
          </button>
        ))}
      </div>

      <Slider
        label="字号"
        value={settings.fontSizePx}
        min={13}
        max={34}
        format={(v) => `${v}px`}
        onChange={(fontSizePx) => patch({ fontSizePx })}
      />
      <Slider
        label="行距"
        value={settings.lineHeight}
        min={1.3}
        max={2.4}
        step={0.05}
        format={(v) => v.toFixed(2)}
        onChange={(lineHeight) => patch({ lineHeight })}
      />
      <Slider
        label="页边距"
        value={settings.marginPct}
        min={0}
        max={34}
        format={(v) => `${v}%`}
        onChange={(marginPct) => patch({ marginPct })}
      />
      <Slider
        label="屏幕亮度"
        value={Math.round(settings.brightness * 100)}
        min={30}
        max={100}
        format={(v) => `${v}%`}
        onChange={(v) => patch({ brightness: v / 100 })}
      />

      <div className="field">
        <label>
          <span>排版</span>
        </label>
        <Segmented
          value={settings.layout}
          options={[
            { value: 'paginated', label: '分页' },
            { value: 'scroll', label: '滚动' },
          ]}
          onChange={(layout) => patch({ layout })}
        />
      </div>
      {settings.layout === 'paginated' ? (
        <>
          <div className="field">
            <label>
              <span>页面</span>
            </label>
            <Segmented
              value={settings.spread}
              options={[
                { value: 'auto', label: '自动' },
                { value: 'single', label: '单页' },
                { value: 'double', label: '双页' },
              ]}
              onChange={(spread) => patch({ spread })}
            />
          </div>
          <div className="field">
            <label>
              <span>翻页效果</span>
            </label>
            <Segmented
              value={settings.pageAnimation}
              options={[
                { value: 'curl', label: '卷页' },
                { value: 'slide', label: '滑动' },
                { value: 'fade', label: '淡入淡出' },
                { value: 'none', label: '无' },
              ]}
              onChange={(pageAnimation) => patch({ pageAnimation })}
            />
          </div>
        </>
      ) : null}

      <Switch label="翻页音效" checked={settings.pageSound} onChange={(pageSound) => patch({ pageSound })} />
      {settings.pageSound ? (
        <Slider
          label="音效音量"
          value={Math.round(settings.pageSoundVolume * 100)}
          min={5}
          max={100}
          format={(v) => `${v}%`}
          onChange={(v) => patch({ pageSoundVolume: v / 100 })}
        />
      ) : null}

      <Slider
        label="工具栏大小"
        value={Math.round((settings.toolbarScale ?? 1) * 100)}
        min={80}
        max={130}
        step={5}
        format={(v) => `${v}%`}
        onChange={(v) => patch({ toolbarScale: v / 100 })}
      />

      <Switch label="两端对齐" checked={settings.justify} onChange={(justify) => patch({ justify })} />
      <Switch label="加粗正文" checked={!!settings.bold} onChange={(bold) => patch({ bold })} />

      <Slider
        label="字距"
        value={Math.round((settings.letterSpacing ?? 0) * 1000)}
        min={0}
        max={80}
        step={5}
        format={(v) => (v === 0 ? '标准' : `+${(v / 1000).toFixed(3)}em`)}
        onChange={(v) => patch({ letterSpacing: v / 1000 })}
      />
      <Slider
        label="段距"
        value={Math.round((settings.paragraphSpacing ?? 0) * 100)}
        min={0}
        max={160}
        step={10}
        format={(v) => (v === 0 ? '标准' : `+${(v / 100).toFixed(1)}em`)}
        onChange={(v) => patch({ paragraphSpacing: v / 100 })}
      />

      <div className="field" style={{ marginTop: 14 }}>
        <label>
          <span>字体</span>
        </label>
        <div className="font-list">
          {FONTS.map((f) => (
            <button
              key={f.value}
              aria-pressed={settings.fontFamily === f.value}
              data-font={f.value}
              style={{ fontFamily: 'var(--reader-font)' }}
              onClick={() => patch({ fontFamily: f.value })}
            >
              <span>{f.label}</span>
              {settings.fontFamily === f.value ? <Icon name="check" size={15} /> : null}
            </button>
          ))}
        </div>
      </div>

      <div className="panel-footer">
        <button className="btn wide" onClick={() => patch(TYPOGRAPHY_DEFAULTS)}>
          <Icon name="reset" size={15} /> 恢复默认排版
        </button>
      </div>
    </PanelShell>
  );
}
