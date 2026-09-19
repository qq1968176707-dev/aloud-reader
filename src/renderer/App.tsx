import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from './state/store';
import Library from './components/Library';
import Reader from './components/Reader';
import Stats from './components/Stats';
import UpdateBanner from './components/UpdateBanner';

const DARK_THEMES = new Set(['night', 'gray']);

export default function App(): JSX.Element {
  const ready = useStore((s) => s.ready);
  const init = useStore((s) => s.init);
  const route = useStore((s) => s.route);
  const navigate = useStore((s) => s.navigate);
  const theme = useStore((s) => s.settings.theme);
  const importBooks = useStore((s) => s.importBooks);
  const importFiles = useStore((s) => s.importFiles);
  const toasts = useStore((s) => s.toasts);
  const dismissToast = useStore((s) => s.dismissToast);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  useEffect(() => {
    void init();
  }, [init]);

  /* Chrome follows the reading theme so the window never looks half-lit. */
  useEffect(() => {
    if (!theme) return;
    const dark = DARK_THEMES.has(theme);
    document.documentElement.dataset.appDark = String(dark);
    document.documentElement.dataset.theme = theme;
    const styles = getComputedStyle(document.documentElement);
    void window.aloud.app
      .setTitlebar({
        color: styles.getPropertyValue('--app-bg').trim() || (dark ? '#17171a' : '#f4f3f0'),
        symbolColor: styles.getPropertyValue('--app-fg').trim() || (dark ? '#edecea' : '#1f1e1c'),
      })
      .catch(() => undefined);
  }, [theme]);

  /* Menu commands from the native menu bar. */
  useEffect(() => {
    return window.aloud.onMenu((command, payload) => {
      if (command === 'import') void importBooks();
      else if (command === 'import-files') void importBooks(payload as string[]);
      else if (command === 'library') navigate({ name: 'library' });
      else window.dispatchEvent(new CustomEvent('aloud:menu', { detail: { command, payload } }));
    });
  }, [importBooks, navigate]);

  /* Drop books anywhere in the window. */
  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      // File objects, not paths: the browser host has no paths, and the desktop host
      // turns them back into paths in preload.
      const files = Array.from(event.dataTransfer.files);
      if (files.length) void importFiles(files);
    },
    [importFiles],
  );

  if (!ready) return <div className="empty">正在打开书架…</div>;

  return (
    <div
      className="app"
      onDragEnter={(e) => {
        if (!Array.from(e.dataTransfer.types).includes('Files')) return;
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => {
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) setDragging(false);
      }}
      onDrop={onDrop}
    >
      {route.name === 'reader' ? <Reader bookId={route.bookId} /> : null}
      {route.name === 'library' ? <Library /> : null}
      {route.name === 'stats' ? <Stats /> : null}

      {dragging ? <div className="dropzone">松手导入 EPUB / PDF / .zip 图书包</div> : null}

      <UpdateBanner />

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`} onClick={() => dismissToast(t.id)}>
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}
