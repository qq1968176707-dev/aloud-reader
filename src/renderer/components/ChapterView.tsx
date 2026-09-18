import { useLayoutEffect, useMemo } from 'react';
import DOMPurify from 'dompurify';
import { buildBlocks, type BlockModel } from '../lib/anchors';

/** Default DOMPurify URI whitelist plus our own book-asset scheme. */
const URI_REGEXP = /^(?:(?:https?|mailto|tel|aloud):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

interface Props {
  html: string;
  contentRef: React.RefObject<HTMLDivElement>;
  className?: string;
  onBlocks: (blocks: BlockModel[]) => void;
  onImage: (src: string, caption: string) => void;
  onChapterLink: (chapterId: string) => void;
}

export default function ChapterView({
  html,
  contentRef,
  className,
  onBlocks,
  onImage,
  onChapterLink,
}: Props): JSX.Element {
  // Second line of defence: the importer already rebuilt this markup from a whitelist.
  const safe = useMemo(
    () =>
      DOMPurify.sanitize(html, {
        ALLOWED_URI_REGEXP: URI_REGEXP,
        // `data-paper` / `data-sheet` carry a created notebook's ruling; the CSS draws
        // it from those, so stripping them would leave blank sheets.
        ADD_ATTR: ['data-blk', 'data-page', 'data-paper', 'data-sheet'],
      }),
    [html],
  );

  useLayoutEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    onBlocks(buildBlocks(root));
  }, [safe, contentRef, onBlocks]);

  return (
    <div
      ref={contentRef}
      className={className}
      // Belt and braces with the CSS rule: Chromium still starts a native drag for
      // images in some paths, and that would eat the page-turn gesture.
      onDragStart={(event) => {
        const tag = (event.target as HTMLElement).tagName;
        if (tag === 'IMG' || tag === 'A') event.preventDefault();
      }}
      onClick={(event) => {
        const target = event.target as HTMLElement;
        if (target.tagName === 'IMG') {
          const img = target as HTMLImageElement;
          const caption = img.closest('figure')?.querySelector('figcaption')?.textContent ?? img.alt ?? '';
          onImage(img.currentSrc || img.src, caption);
          // Don't let the reader treat this as "start reading from this line" as well.
          event.stopPropagation();
          return;
        }
        const link = target.closest('a');
        const href = link?.getAttribute('href');
        if (!href) return;
        event.preventDefault();
        event.stopPropagation();
        if (href.startsWith('#chapter:')) onChapterLink(href.slice('#chapter:'.length));
        else if (/^https?:/i.test(href)) void window.aloud.app.openExternal(href);
      }}
      dangerouslySetInnerHTML={{ __html: safe }}
    />
  );
}
