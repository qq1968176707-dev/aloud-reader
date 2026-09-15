import { useEffect, useRef, useState } from 'react';
import type { DictEntry, HighlightColor } from '@shared/types';
import { Icon, useDismiss } from './ui';

const COLORS: HighlightColor[] = ['yellow', 'green', 'blue', 'pink', 'purple'];

/**
 * In-app confirmation, replacing `window.confirm`.
 *
 * The native dialog was the last piece of foreign chrome in the app: OS-styled, ignores
 * the theme, blocks the process. This one speaks the system's language — material sheet,
 * sheet spring, the danger token for destructive actions — and keeps the keyboard
 * contract: Esc cancels, Enter confirms, focus starts on the SAFE button.
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
}: {
  title: string;
  body?: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      } else if (e.key === 'Enter') {
        e.stopPropagation();
        onConfirm();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel, onConfirm]);

  return (
    <div className="confirm-veil" onMouseDown={onCancel} role="presentation">
      <div
        className="confirm-sheet"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3>{title}</h3>
        {body ? <p>{body}</p> : null}
        <div className="confirm-actions">
          <button ref={cancelRef} className="btn" onClick={onCancel}>
            取消
          </button>
          <button className={danger ? 'btn danger-fill' : 'btn primary'} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Places a floating card near a text rect without letting it leave the window. */
function anchorStyle(rect: DOMRect, width: number, height: number): React.CSSProperties {
  const left = Math.min(Math.max(12, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 12);
  const above = rect.top - height - 10;
  const top = above > 56 ? above : Math.min(rect.bottom + 10, window.innerHeight - height - 12);
  return { left, top, width };
}

export function SelectionMenu({
  rect,
  hasAnnotation,
  onColor,
  onUnderline,
  onNote,
  onCopy,
  onSearch,
  onSpeak,
  onRemove,
  onDismiss,
}: {
  rect: DOMRect;
  hasAnnotation: boolean;
  onColor: (color: HighlightColor) => void;
  onUnderline: () => void;
  onNote: () => void;
  onCopy: () => void;
  onSearch: () => void;
  onSpeak: () => void;
  onRemove: () => void;
  onDismiss: () => void;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onDismiss);
  return (
    <div className="selection-menu" ref={ref} style={{ ...anchorStyle(rect, 286, 40), width: 'auto' }}>
      {COLORS.map((c) => (
        <button
          key={c}
          className="swatch"
          style={{ background: `var(--hl-${c})` }}
          title={`${c} 标注`}
          onClick={() => onColor(c)}
        />
      ))}
      <span className="divider" style={{ width: 1, height: 18, background: 'var(--app-line)' }} />
      <button className="btn icon" title="下划线" onClick={onUnderline}>
        <span style={{ textDecoration: 'underline', fontSize: 13 }}>U</span>
      </button>
      <button className="btn icon" title="添加笔记" onClick={onNote}>
        <Icon name="note" size={16} />
      </button>
      <button className="btn icon" title="从这里开始朗读" onClick={onSpeak}>
        <Icon name="speaker" size={16} />
      </button>
      <button className="btn icon" title="复制" onClick={onCopy}>
        <Icon name="copy" size={16} />
      </button>
      <button className="btn icon" title="搜索本书" onClick={onSearch}>
        <Icon name="search" size={16} />
      </button>
      {hasAnnotation ? (
        <button className="btn icon ghost-danger" title="删除标注" onClick={onRemove}>
          <Icon name="trash" size={16} />
        </button>
      ) : null}
    </div>
  );
}

export function NoteEditor({
  rect,
  initial,
  onSave,
  onCancel,
}: {
  rect: DOMRect;
  initial: string;
  onSave: (note: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState(initial);
  useDismiss(ref, onCancel);
  return (
    <div className="note-editor" ref={ref} style={anchorStyle(rect, 300, 170)}>
      {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
      <textarea
        autoFocus
        value={value}
        placeholder="写点什么…（Ctrl+Enter 保存）"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) onSave(value);
          if (e.key === 'Escape') onCancel();
        }}
      />
      <div className="row">
        <span style={{ flex: 1, fontSize: 11, color: 'var(--app-fg-faint)' }}>笔记会随标注一起保存</span>
        <button className="btn" onClick={onCancel}>
          取消
        </button>
        <button className="btn primary" onClick={() => onSave(value)}>
          保存
        </button>
      </div>
    </div>
  );
}

export function DictCard({
  rect,
  word,
  entry,
  onClose,
  onSearchInBook,
}: {
  rect: DOMRect;
  word: string;
  entry: DictEntry | null;
  onClose: () => void;
  onSearchInBook: () => void;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose);
  return (
    <div className="dict-card" ref={ref} style={anchorStyle(rect, 288, 170)}>
      <h3>{entry?.word ?? word}</h3>
      {entry?.phonetic ? <div className="phonetic">{entry.phonetic}</div> : null}
      {entry ? (
        <ul>
          {entry.defs.map((d, i) => (
            <li key={i}>{d}</li>
          ))}
        </ul>
      ) : (
        <p style={{ margin: '4px 0 0', color: 'var(--app-fg-muted)' }}>
          本地词库里没有这个词。可以在数据目录的 <code>dictionary.json</code> 里补充。
        </p>
      )}
      <footer>
        <span style={{ flex: 1 }}>{entry?.source ?? '离线词典'}</span>
        <button className="btn" onClick={onSearchInBook}>
          <Icon name="search" size={14} /> 全书搜索
        </button>
      </footer>
    </div>
  );
}

export function Lightbox({
  src,
  caption,
  onClose,
}: {
  src: string;
  caption: string;
  onClose: () => void;
}): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="lightbox" onClick={onClose}>
      <img src={src} alt={caption} />
      {caption ? <figcaption>{caption}</figcaption> : null}
    </div>
  );
}
