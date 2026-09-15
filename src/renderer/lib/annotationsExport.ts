import type { Annotation, BookManifest } from '@shared/types';
import { collapse } from '@shared/text';

const COLOR_LABEL: Record<string, string> = {
  yellow: '黄',
  green: '绿',
  blue: '蓝',
  pink: '粉',
  purple: '紫',
};

const chapterOrder = (manifest: BookManifest): Map<string, { index: number; title: string }> =>
  new Map(
    manifest.readingOrder.map((c, index) => [c.id, { index, title: c.title ?? `第 ${index + 1} 节` }]),
  );

export function sortAnnotations(annotations: Annotation[], manifest: BookManifest): Annotation[] {
  const order = chapterOrder(manifest);
  return [...annotations].sort((a, b) => {
    const ca = order.get(a.anchor.chapterId)?.index ?? 0;
    const cb = order.get(b.anchor.chapterId)?.index ?? 0;
    if (ca !== cb) return ca - cb;
    if (a.anchor.blockIndex !== b.anchor.blockIndex) return a.anchor.blockIndex - b.anchor.blockIndex;
    return a.anchor.start - b.anchor.start;
  });
}

export function toMarkdown(manifest: BookManifest, annotations: Annotation[]): string {
  const order = chapterOrder(manifest);
  const sorted = sortAnnotations(annotations, manifest);
  const lines: string[] = [
    `# ${manifest.title}`,
    '',
    manifest.authors.length ? `作者：${manifest.authors.join('、')}` : '',
    `导出时间：${new Date().toLocaleString('zh-CN')}`,
    `条目：${sorted.length}`,
    '',
  ].filter((l) => l !== '');

  let lastChapter = '';
  for (const a of sorted) {
    const chapter = order.get(a.anchor.chapterId)?.title ?? a.anchor.chapterId;
    if (chapter !== lastChapter) {
      lines.push('', `## ${chapter}`, '');
      lastChapter = chapter;
    }
    if (a.kind === 'bookmark') {
      lines.push(`- 🔖 **书签** — ${collapse(a.text).slice(0, 80) || '（本页）'}`);
      continue;
    }
    const mark = a.kind === 'underline' ? '下划线' : `${COLOR_LABEL[a.color ?? 'yellow']}色标注`;
    lines.push(`> ${collapse(a.text)}`, '', `*（${mark}）*`);
    if (a.note?.trim()) lines.push('', ...a.note.trim().split('\n').map((l) => `**笔记：** ${l}`));
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

export function toPlainText(manifest: BookManifest, annotations: Annotation[]): string {
  const sorted = sortAnnotations(annotations, manifest);
  const out = [`${manifest.title}`, `${manifest.authors.join('、')}`, ''];
  for (const a of sorted) {
    out.push(collapse(a.text));
    if (a.note?.trim()) out.push(`  笔记：${a.note.trim()}`);
    out.push('');
  }
  return out.join('\n');
}

export async function exportAnnotations(
  bookId: string,
  format: 'md' | 'txt' = 'md',
): Promise<string | null> {
  const [manifest, file] = await Promise.all([
    window.aloud.books.manifest(bookId),
    window.aloud.annotations.get(bookId),
  ]);
  if (!manifest) return null;
  const content = format === 'md' ? toMarkdown(manifest, file.annotations) : toPlainText(manifest, file.annotations);
  const safeTitle = manifest.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
  return window.aloud.dialog.saveText(`${safeTitle}-批注.${format}`, content);
}
