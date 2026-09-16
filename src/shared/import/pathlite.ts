/**
 * The three `node:path` operations the importers need, on plain strings.
 *
 * Paths inside a book package are always POSIX-style (zip entries, EPUB hrefs), so
 * these deliberately do NOT understand Windows separators — callers normalise to
 * forward slashes when they open the archive.
 */

export const basename = (p: string, ext?: string): string => {
  const base = p.slice(p.lastIndexOf('/') + 1);
  return ext && base.endsWith(ext) && base !== ext ? base.slice(0, -ext.length) : base;
};

export const extname = (p: string): string => {
  const base = basename(p);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot);
};

export const dirname = (p: string): string => {
  const cut = p.lastIndexOf('/');
  return cut <= 0 ? '' : p.slice(0, cut);
};

/** Resolve `rel` against the directory of `from`, collapsing `.` and `..`. */
export const joinRelative = (from: string, rel: string): string => {
  if (rel.startsWith('/')) return rel.slice(1);
  const parts = dirname(from).split('/').filter(Boolean);
  for (const seg of rel.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
};
