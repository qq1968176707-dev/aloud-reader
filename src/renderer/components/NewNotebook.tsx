import { useEffect, useRef, useState } from 'react';
import type { NotebookOptions, PaperStyle } from '@shared/types';
import { DEFAULT_NOTEBOOK_PAGES, MAX_NOTEBOOK_PAGES, PAPER_LABELS } from '@shared/notebook';
import { cx } from '../lib/util';

/**
 * "New notebook" sheet.
 *
 * The paper choice is made by looking, not by reading a label: each option renders its
 * own ruling with the same CSS the real page uses, so what you pick is literally what
 * you get.
 */

const PAPERS: { value: PaperStyle; hint: string }[] = [
  { value: 'blank', hint: '草稿纸、速记、随手画' },
  { value: 'lined', hint: '写字最稳' },
  { value: 'grid', hint: '图表、公式' },
  { value: 'dotted', hint: '子弹笔记' },
];

export default function NewNotebook({
  onCreate,
  onCancel,
}: {
  onCreate: (opts: NotebookOptions) => void;
  onCancel: () => void;
}): JSX.Element {
  const [title, setTitle] = useState('');
  const [paper, setPaper] = useState<PaperStyle>('lined');
  const [pages, setPages] = useState(DEFAULT_NOTEBOOK_PAGES);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  const submit = (): void => {
    onCreate({
      title: title.trim() || '未命名笔记本',
      paper,
      pages: Math.max(1, Math.min(MAX_NOTEBOOK_PAGES, pages || DEFAULT_NOTEBOOK_PAGES)),
    });
  };

  return (
    <div className="confirm-veil" onMouseDown={onCancel} role="presentation">
      <div
        className="confirm-sheet new-notebook"
        role="dialog"
        aria-modal="true"
        aria-label="新建笔记本"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') onCancel();
          else if (e.key === 'Enter') submit();
        }}
      >
        <h3>新建</h3>

        <label className="field">
          <span>名称</span>
          <input
            ref={inputRef}
            value={title}
            placeholder="未命名笔记本"
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>

        <div className="field">
          <span>纸张</span>
          <div className="paper-picker">
            {PAPERS.map((p) => (
              <button
                key={p.value}
                type="button"
                className={cx('paper-option', paper === p.value && 'on')}
                onClick={() => setPaper(p.value)}
                aria-pressed={paper === p.value}
              >
                <span className="paper-swatch" data-paper={p.value} />
                <b>{PAPER_LABELS[p.value]}</b>
                <i>{p.hint}</i>
              </button>
            ))}
          </div>
        </div>

        <label className="field">
          <span>页数</span>
          <div className="pages-field">
            <input
              type="number"
              min={1}
              max={MAX_NOTEBOOK_PAGES}
              value={pages}
              onChange={(e) => setPages(Number(e.target.value))}
            />
            <small>之后还能随时加页</small>
          </div>
        </label>

        <div className="confirm-actions">
          <button className="btn" onClick={onCancel}>
            取消
          </button>
          <button className="btn primary" onClick={submit}>
            新建
          </button>
        </div>
      </div>
    </div>
  );
}
