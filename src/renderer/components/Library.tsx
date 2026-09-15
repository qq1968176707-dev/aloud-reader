import { useMemo, useState } from 'react';
import type { BookIndexEntry, BuiltinShelf, LibrarySort } from '@shared/types';
import { useStore } from '../state/store';
import { bookAssetUrl, coverGradient, cx, relativeDate, uid } from '../lib/util';
import { exportAnnotations } from '../lib/annotationsExport';
import { ContextMenu, Icon, Segmented } from './ui';
import { ConfirmDialog } from './Overlays';
import { useDragSize } from '../lib/useDragSize';

type ShelfKey = BuiltinShelf | 'all' | `collection:${string}`;

const SHELVES: { key: ShelfKey; label: string; icon: string }[] = [
  { key: 'reading', label: '现在阅读', icon: 'book' },
  { key: 'want', label: '想读', icon: 'bookmark' },
  { key: 'finished', label: '已读完', icon: 'check' },
  { key: 'all', label: '全部图书', icon: 'library' },
];

const SORTS: { value: LibrarySort; label: string }[] = [
  { value: 'manual', label: '自定义顺序' },
  { value: 'recent', label: '最近打开' },
  { value: 'added', label: '添加时间' },
  { value: 'title', label: '书名' },
  { value: 'author', label: '作者' },
];

export default function Library(): JSX.Element {
  const library = useStore((s) => s.library);
  const settings = useStore((s) => s.settings);
  const setLibrary = useStore((s) => s.setLibrary);
  const updateBook = useStore((s) => s.updateBook);
  const patchSettings = useStore((s) => s.patchSettings);
  const navigate = useStore((s) => s.navigate);
  const importBooks = useStore((s) => s.importBooks);
  const removeBook = useStore((s) => s.removeBook);
  const importing = useStore((s) => s.importing);
  const importProgress = useStore((s) => s.importProgress);
  const toast = useStore((s) => s.toast);

  const [shelf, setShelf] = useState<ShelfKey>('reading');
  const sidebar = useDragSize({
    value: settings.sidebarWidth ?? 232,
    min: 180,
    max: 420,
    edge: 'right',
    onCommit: (sidebarWidth) => patchSettings({ sidebarWidth }),
  });
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState<{ x: number; y: number; book: BookIndexEntry } | null>(null);
  const [confirm, setConfirm] = useState<{
    title: string;
    body?: string;
    confirmLabel: string;
    danger?: boolean;
    action: () => void;
  } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; after: boolean } | null>(null);

  const counts = useMemo(() => {
    const map: Record<string, number> = { all: library.books.length };
    for (const b of library.books) map[b.shelf] = (map[b.shelf] ?? 0) + 1;
    return map;
  }, [library.books]);

  const books = useMemo(() => {
    const orderIndex = new Map(library.order.map((id, i) => [id, i]));
    let list = library.books.slice();

    if (shelf.startsWith('collection:')) {
      const id = shelf.slice('collection:'.length);
      const ids = new Set(library.collections.find((c) => c.id === id)?.bookIds ?? []);
      list = list.filter((b) => ids.has(b.id));
    } else if (shelf !== 'all') {
      list = list.filter((b) => b.shelf === shelf);
    }

    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (b) => b.title.toLowerCase().includes(q) || b.authors.join(' ').toLowerCase().includes(q),
      );
    }

    const sort = settings.library.sort;
    list.sort((a, b) => {
      switch (sort) {
        case 'title':
          return a.title.localeCompare(b.title, 'zh-CN');
        case 'author':
          return (a.authors[0] ?? '').localeCompare(b.authors[0] ?? '', 'zh-CN');
        case 'recent':
          return (b.lastOpenedAt ?? '').localeCompare(a.lastOpenedAt ?? '');
        case 'added':
          return b.addedAt.localeCompare(a.addedAt);
        default:
          return (orderIndex.get(a.id) ?? 1e9) - (orderIndex.get(b.id) ?? 1e9);
      }
    });
    return list;
  }, [library, query, settings.library.sort, shelf]);

  const reorder = (fromId: string, toId: string, after: boolean): void => {
    const order = library.order.filter((id) => library.books.some((b) => b.id === id));
    for (const b of library.books) if (!order.includes(b.id)) order.push(b.id);
    const without = order.filter((id) => id !== fromId);
    const at = without.indexOf(toId);
    if (at < 0) return;
    without.splice(after ? at + 1 : at, 0, fromId);
    setLibrary({ ...library, order: without });
    if (settings.library.sort !== 'manual') {
      patchSettings({ library: { ...settings.library, sort: 'manual' } });
    }
  };

  const open = (book: BookIndexEntry): void => {
    updateBook(book.id, {
      lastOpenedAt: new Date().toISOString(),
      shelf: book.shelf === 'want' ? 'reading' : book.shelf,
    });
    navigate({ name: 'reader', bookId: book.id });
  };

  const addCollection = (): void => {
    const name = window.prompt('新建收藏集');
    if (!name?.trim()) return;
    setLibrary({
      ...library,
      collections: [...library.collections, { id: uid(), name: name.trim(), bookIds: [] }],
    });
  };

  const toggleInCollection = (collectionId: string, bookId: string): void => {
    setLibrary({
      ...library,
      collections: library.collections.map((c) =>
        c.id !== collectionId
          ? c
          : {
              ...c,
              bookIds: c.bookIds.includes(bookId)
                ? c.bookIds.filter((id) => id !== bookId)
                : [...c.bookIds, bookId],
            },
      ),
    });
  };

  return (
    <>
      <aside
        className={cx('sidebar titlebar-drag', sidebar.dragging && 'resizing')}
        style={{ width: sidebar.size }}
      >
        <div className="side-grip" onMouseDown={sidebar.onMouseDown} />
        <div className="brand">书架</div>
        <nav>
          {SHELVES.map((s) => (
            <button
              key={s.key}
              className={cx('side-item', shelf === s.key && 'selected')}
              onClick={() => setShelf(s.key)}
            >
              <Icon name={s.icon} size={16} />
              {s.label}
              <span className="count">{counts[s.key] ?? 0}</span>
            </button>
          ))}

          <div className="group-title">收藏集</div>
          {library.collections.map((c) => (
            <button
              key={c.id}
              className={cx('side-item', shelf === `collection:${c.id}` && 'selected')}
              onClick={() => setShelf(`collection:${c.id}`)}
              onContextMenu={(e) => {
                e.preventDefault();
                setConfirm({
                  title: `删除收藏集「${c.name}」？`,
                  body: '只移除这个收藏集，里面的图书都还在书架上。',
                  confirmLabel: '删除收藏集',
                  danger: true,
                  action: () => {
                    setLibrary({ ...library, collections: library.collections.filter((x) => x.id !== c.id) });
                    if (shelf === `collection:${c.id}`) setShelf('all');
                  },
                });
              }}
            >
              <Icon name="folder" size={16} />
              {c.name}
              <span className="count">{c.bookIds.length}</span>
            </button>
          ))}
          <button className="side-item" onClick={addCollection}>
            <Icon name="plus" size={16} />
            新建收藏集
          </button>
        </nav>
        <footer>
          <button className="side-item" onClick={() => navigate({ name: 'stats' })}>
            <Icon name="chart" size={16} />
            阅读统计
          </button>
        </footer>
      </aside>

      <main className="main">
        <header className="topbar bordered titlebar-drag">
          <button className="btn primary" onClick={() => void importBooks()} disabled={importing}>
            <Icon name="plus" size={15} />
            {importing
              ? importProgress
                ? `导入中 ${Math.min(importProgress.done + 1, importProgress.total)}/${importProgress.total}`
                : '导入中…'
              : '导入图书'}
          </button>
          <div className="spacer" />
          <div className="search-box">
            <Icon name="search" size={15} />
            <input
              placeholder="搜索书名或作者"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <select
            className="control"
            value={settings.library.sort}
            onChange={(e) =>
              patchSettings({ library: { ...settings.library, sort: e.target.value as LibrarySort } })
            }
          >
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          <Segmented
            value={settings.library.view}
            options={[
              { value: 'grid', label: '封面' },
              { value: 'list', label: '列表' },
            ]}
            onChange={(view) => patchSettings({ library: { ...settings.library, view } })}
          />
        </header>

        <div className="library">
          {books.length === 0 ? (
            <div className="empty" style={{ minHeight: '60vh' }}>
              <Icon name="library" size={34} />
              <h2>{query ? '没有匹配的书' : '这里还没有书'}</h2>
              <p>把 EPUB / MOBI / AZW3 / PDF 拖进窗口，或点右上角「导入图书」。书站的 zip 合集包也能直接放进来。</p>
            </div>
          ) : settings.library.view === 'grid' ? (
            <>
            <div className="shelf-head">
              <h2>{SHELVES.find((x) => x.key === shelf)?.label ?? '收藏集'}</h2>
              <span>{books.length} 本</span>
            </div>
            <div className="shelf">
              {books.map((book) => (
                <button
                  key={book.id}
                  className={cx(
                    'book-card',
                    dragId === book.id && 'dragging',
                    dropTarget?.id === book.id && (dropTarget.after ? 'drop-after' : 'drop-before'),
                  )}
                  draggable
                  onDragStart={() => setDragId(book.id)}
                  onDragEnd={() => {
                    setDragId(null);
                    setDropTarget(null);
                  }}
                  onDragOver={(e) => {
                    if (!dragId || dragId === book.id) return;
                    e.preventDefault();
                    const rect = e.currentTarget.getBoundingClientRect();
                    setDropTarget({ id: book.id, after: e.clientX > rect.left + rect.width / 2 });
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragId && dropTarget) reorder(dragId, dropTarget.id, dropTarget.after);
                    setDragId(null);
                    setDropTarget(null);
                  }}
                  onClick={() => open(book)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ x: e.clientX, y: e.clientY, book });
                  }}
                >
                  <div className="cover-wrap">
                    <Cover book={book} />
                    {book.progress > 0.01 && book.progress < 0.99 ? (
                      <span className="progress-pill">
                        <i style={{ width: `${Math.round(book.progress * 100)}%` }} />
                      </span>
                    ) : null}
                    {!book.lastOpenedAt ? <span className="badge-new">新</span> : null}
                  </div>
                  <div className="book-meta">
                    {/* Two lines is all a card gets; the tooltip carries the rest. */}
                    <div className="title" title={book.title}>
                      {book.title}
                    </div>
                    <div className="author">{book.authors.join('、') || '未知作者'}</div>
                  </div>
                </button>
              ))}
            </div>
            </>
          ) : (
            <div className="book-rows">
              {books.map((book) => (
                <button
                  key={book.id}
                  className="book-row"
                  onClick={() => open(book)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ x: e.clientX, y: e.clientY, book });
                  }}
                >
                  <Cover book={book} mini />
                  <div>
                    <div>{book.title}</div>
                    <div className="sub">{book.authors.join('、') || '未知作者'}</div>
                  </div>
                  <div className="sub">{Math.round(book.progress * 100)}% · {book.chapterCount} 节</div>
                  <div className="sub">{relativeDate(book.lastOpenedAt) || '未打开'}</div>
                  <div className="sub">{book.sourceType.toUpperCase()}</div>
                </button>
              ))}
            </div>
          )}
          <p style={{ marginTop: 26, fontSize: 12, color: 'var(--app-fg-faint)' }}>
            点击封面开始阅读，右键查看更多操作，拖动封面可自定义排序
          </p>
        </div>
      </main>

      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <button onClick={() => open(menu.book)}>
            <Icon name="book" size={15} /> 打开
          </button>
          <hr />
          {(
            [
              ['reading', '移到「现在阅读」'],
              ['want', '移到「想读」'],
              ['finished', '标记为已读完'],
            ] as [BuiltinShelf, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => {
                updateBook(menu.book.id, {
                  shelf: key,
                  finishedAt: key === 'finished' ? new Date().toISOString() : undefined,
                });
                if (key === 'finished') void window.aloud.stats.finish(menu.book.id, menu.book.title);
              }}
            >
              <Icon name={key === 'finished' ? 'check' : 'bookmark'} size={15} /> {label}
            </button>
          ))}
          {library.collections.length ? <hr /> : null}
          {library.collections.map((c) => (
            <button key={c.id} onClick={() => toggleInCollection(c.id, menu.book.id)}>
              <Icon name="folder" size={15} />
              {c.bookIds.includes(menu.book.id) ? `移出「${c.name}」` : `加入「${c.name}」`}
            </button>
          ))}
          <hr />
          <button
            onClick={() =>
              void exportAnnotations(menu.book.id).then((p) => p && toast(`已导出到 ${p}`))
            }
          >
            <Icon name="export" size={15} /> 导出批注 (Markdown)
          </button>
          <button onClick={() => void window.aloud.app.revealBook(menu.book.id)}>
            <Icon name="folder" size={15} /> 在文件夹中显示
          </button>
          <hr />
          <button
            className="danger"
            onClick={() => {
              const book = menu.book;
              setConfirm({
                title: `从书架删除《${book.title}》？`,
                body: '这本书的批注和阅读进度会一并删除，删除后无法恢复。',
                confirmLabel: '删除图书',
                danger: true,
                action: () => void removeBook(book.id),
              });
            }}
          >
            <Icon name="trash" size={15} /> 删除
          </button>
        </ContextMenu>
      ) : null}

      {confirm ? (
        <ConfirmDialog
          title={confirm.title}
          body={confirm.body}
          confirmLabel={confirm.confirmLabel}
          danger={confirm.danger}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            confirm.action();
            setConfirm(null);
          }}
        />
      ) : null}
    </>
  );
}

function Cover({ book, mini }: { book: BookIndexEntry; mini?: boolean }): JSX.Element {
  const url = bookAssetUrl(book.id, book.cover);
  if (url) return <img className={mini ? 'mini' : 'cover'} src={url} alt="" draggable={false} />;
  const [a, b] = coverGradient(book.id);
  return (
    <div
      className={mini ? 'mini' : 'cover generated'}
      style={{ background: `linear-gradient(150deg, ${a}, ${b})` }}
    >
      {!mini ? (
        <>
          <div className="t">{book.title}</div>
          <div className="a">{book.authors.join('、')}</div>
        </>
      ) : null}
    </div>
  );
}
