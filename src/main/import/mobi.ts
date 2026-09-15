/**
 * Mobipocket (.mobi / .prc / .azw) importer.
 *
 * A MOBI file is a Palm database: record 0 holds the headers, records 1..n hold the
 * (usually compressed) book markup as one long HTML stream, and the records after
 * `firstImageIndex` hold raw JPEG/PNG/GIF bytes. Chapters are found by splitting the
 * markup at <mbp:pagebreak>, images are referenced by record index rather than by path,
 * and internal links are byte offsets ("filepos") into the *uncompressed* stream.
 *
 * Because filepos values are byte offsets, all splitting is done on the raw Buffer and
 * each section is decoded separately — decoding first would shift every offset on any
 * book that isn't pure ASCII.
 *
 * KF8 (.azw3, and the KF8 half of a dual-format .mobi) is a different container built
 * from a skeleton/fragment index; it is not parsed here. Dual files fall back to their
 * MOBI6 half, which is complete.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BOOK_SCHEMA, type BookManifest, type ChapterRef, type TocItem } from '@shared/types';
import { collapse } from '@shared/text';
import { sanitizeChapter } from './html';
import type { ImportedBook } from './index';

/* ------------------------------------------------------------- palm db */

interface Palm {
  buf: Buffer;
  offsets: number[]; // length numRecords + 1, last entry = file size
  count: number;
}

function readPalm(buf: Buffer): Palm {
  if (buf.length < 78) throw new Error('文件太小，不是 MOBI');
  const type = buf.subarray(60, 64).toString('latin1');
  const creator = buf.subarray(64, 68).toString('latin1');
  if (creator !== 'MOBI' && creator !== 'TEXt') {
    throw new Error(`不是 Mobipocket 文件（creator=${creator || '?'}）`);
  }
  const count = buf.readUInt16BE(76);
  if (!count) throw new Error('MOBI 文件里没有记录');
  const offsets: number[] = [];
  for (let i = 0; i < count; i++) offsets.push(buf.readUInt32BE(78 + i * 8));
  offsets.push(buf.length);
  void type;
  return { buf, offsets, count };
}

const record = (palm: Palm, i: number): Buffer =>
  i >= 0 && i < palm.count ? palm.buf.subarray(palm.offsets[i], palm.offsets[i + 1]) : Buffer.alloc(0);

/* -------------------------------------------------------------- header */

interface MobiHeader {
  compression: number;
  textLength: number;
  textRecords: number;
  encoding: number;
  mobiType: number;
  headerLength: number;
  firstImage: number;
  lastContent: number;
  huffOffset: number;
  huffCount: number;
  extraFlags: number;
  title: string;
  exth: Map<number, Buffer[]>;
}

function readHeader(rec0: Buffer): MobiHeader {
  const compression = rec0.readUInt16BE(0);
  const textLength = rec0.readUInt32BE(4);
  const textRecords = rec0.readUInt16BE(8);
  const encryption = rec0.readUInt16BE(12);
  if (encryption !== 0) throw new Error('这本书有 DRM 加密，无法导入');

  if (rec0.subarray(16, 20).toString('latin1') !== 'MOBI') throw new Error('缺少 MOBI 头');
  const headerLength = rec0.readUInt32BE(20);
  const mobiType = rec0.readUInt32BE(24);
  const encoding = rec0.readUInt32BE(28);
  const fullNameOffset = rec0.readUInt32BE(84);
  const fullNameLength = rec0.readUInt32BE(88);
  const firstImage = rec0.readUInt32BE(108);
  const huffOffset = rec0.readUInt32BE(112);
  const huffCount = rec0.readUInt32BE(116);
  const exthFlags = rec0.readUInt32BE(128);
  const lastContent = headerLength >= 176 ? rec0.readUInt16BE(194) : 0;
  const extraFlags = headerLength + 16 >= 244 ? rec0.readUInt16BE(242) : 0;

  const decode = (b: Buffer): string => decodeText(b, encoding);
  const title = decode(rec0.subarray(fullNameOffset, fullNameOffset + fullNameLength));

  const exth = new Map<number, Buffer[]>();
  if (exthFlags & 0x40) {
    const start = 16 + headerLength;
    if (rec0.subarray(start, start + 4).toString('latin1') === 'EXTH') {
      const count = rec0.readUInt32BE(start + 8);
      let p = start + 12;
      for (let i = 0; i < count && p + 8 <= rec0.length; i++) {
        const type = rec0.readUInt32BE(p);
        const len = rec0.readUInt32BE(p + 4);
        if (len < 8) break;
        const list = exth.get(type) ?? [];
        list.push(rec0.subarray(p + 8, p + len));
        exth.set(type, list);
        p += len;
      }
    }
  }

  return {
    compression, textLength, textRecords, encoding, mobiType, headerLength,
    firstImage, lastContent, huffOffset, huffCount, extraFlags, title, exth,
  };
}

function decodeText(buf: Buffer, encoding: number): string {
  if (encoding === 65001) return buf.toString('utf8');
  try {
    return new TextDecoder('windows-1252').decode(buf);
  } catch {
    return buf.toString('latin1');
  }
}

const exthText = (h: MobiHeader, type: number): string[] =>
  (h.exth.get(type) ?? []).map((b) => decodeText(b, h.encoding).replace(/\0+$/, '').trim()).filter(Boolean);

const exthUint = (h: MobiHeader, type: number): number | undefined => {
  const b = h.exth.get(type)?.[0];
  return b && b.length >= 4 ? b.readUInt32BE(0) : undefined;
};

/* ------------------------------------------------------ decompression */

/** Trailing entries appended to each text record must be removed before decompressing. */
function trimTrailing(rec: Buffer, extraFlags: number): Buffer {
  let end = rec.length;
  let flags = extraFlags >> 1;
  while (flags) {
    if (flags & 1) end -= backwardVarLen(rec, end);
    flags >>= 1;
  }
  if (extraFlags & 1 && end > 0) end -= (rec[end - 1] & 0x3) + 1;
  return rec.subarray(0, Math.max(0, end));
}

/** Variable-width integer stored *backwards* at the end of a record. */
function backwardVarLen(rec: Buffer, end: number): number {
  let bitpos = 0;
  let result = 0;
  let i = end;
  for (;;) {
    if (i <= 0) return result;
    i--;
    const v = rec[i];
    result |= (v & 0x7f) << bitpos;
    bitpos += 7;
    if (v & 0x80 || bitpos >= 28 || i === 0) return result;
  }
}

/** PalmDOC (LZ77 variant). Writes into `out` at `pos`, returns the new position. */
function palmDocDecompress(input: Buffer, out: Buffer, pos: number): number {
  let i = 0;
  while (i < input.length && pos < out.length) {
    const c = input[i++];
    if (c === 0) {
      out[pos++] = 0;
    } else if (c <= 8) {
      for (let n = 0; n < c && i < input.length && pos < out.length; n++) out[pos++] = input[i++];
    } else if (c <= 0x7f) {
      out[pos++] = c;
    } else if (c <= 0xbf) {
      if (i >= input.length) break;
      const pair = (c << 8) | input[i++];
      const distance = (pair >> 3) & 0x07ff;
      const length = (pair & 0x07) + 3;
      if (distance === 0 || distance > pos) break;
      for (let n = 0; n < length && pos < out.length; n++) {
        out[pos] = out[pos - distance];
        pos++;
      }
    } else {
      out[pos++] = 0x20;
      if (pos < out.length) out[pos++] = c ^ 0x80;
    }
  }
  return pos;
}

/**
 * HUFF/CDIC decompression (compression type 17480), used by Amazon-generated files.
 *
 * A canonical Huffman code whose symbols are dictionary phrases. dict1 is a 256-entry
 * fast path keyed by the top byte of the next 32 bits; when its entry is not terminal we
 * walk the per-length min/max code table instead. Dictionary phrases whose flag bit is
 * clear are themselves compressed and get expanded recursively (and memoised).
 *
 * The bit reader needs a 64-bit sliding window, so it runs on BigInt. That is slower
 * than the PalmDOC path, but HUFF books are the minority and it is correct.
 */
interface HuffEntry {
  codelen: number;
  term: number;
  maxcode: number;
}

class HuffCdic {
  private readonly dict1: HuffEntry[] = [];
  private readonly minCode: number[] = new Array(33).fill(0);
  private readonly maxCode: number[] = new Array(33).fill(0);
  private readonly phrases: { data: Buffer; expanded: boolean }[] = [];

  constructor(records: Buffer[]) {
    const huff = records[0];
    if (!huff || huff.subarray(0, 4).toString('latin1') !== 'HUFF') throw new Error('HUFF 记录损坏');
    const off1 = huff.readUInt32BE(8);
    const off2 = huff.readUInt32BE(12);

    for (let i = 0; i < 256; i++) {
      const v = huff.readUInt32BE(off1 + i * 4);
      const codelen = v & 0x1f;
      const term = v & 0x80;
      if (codelen === 0) throw new Error('HUFF 表损坏');
      this.dict1.push({ codelen, term, maxcode: (v >>> 8) * 2 ** (32 - codelen) + (2 ** (32 - codelen) - 1) });
    }

    for (let codelen = 1; codelen <= 32; codelen++) {
      const mincode = huff.readUInt32BE(off2 + (codelen - 1) * 8);
      const maxcode = huff.readUInt32BE(off2 + (codelen - 1) * 8 + 4);
      this.minCode[codelen] = mincode * 2 ** (32 - codelen);
      this.maxCode[codelen] = (maxcode + 1) * 2 ** (32 - codelen) - 1;
    }

    for (let r = 1; r < records.length; r++) {
      const cdic = records[r];
      if (!cdic || cdic.subarray(0, 4).toString('latin1') !== 'CDIC') continue;
      const total = cdic.readUInt32BE(8);
      const bits = cdic.readUInt32BE(12);
      const n = Math.min(1 << bits, total - this.phrases.length);
      for (let i = 0; i < n; i++) {
        const offset = cdic.readUInt16BE(0x10 + i * 2);
        const blen = cdic.readUInt16BE(0x10 + offset);
        const length = blen & 0x7fff;
        this.phrases.push({
          data: cdic.subarray(0x12 + offset, 0x12 + offset + length),
          expanded: (blen & 0x8000) !== 0,
        });
      }
    }
  }

  decompress(input: Buffer): Buffer {
    return this.unpack(input, 0);
  }

  private unpack(data: Buffer, depth: number): Buffer {
    if (depth > 32) throw new Error('HUFF 字典递归过深，文件可能损坏');
    const chunks: Buffer[] = [];
    let bitsLeft = data.length * 8;
    let bytePos = 0;
    let n = 32;

    const window = (at: number): bigint => {
      let v = 0n;
      for (let i = 0; i < 8; i++) {
        const idx = at + i;
        v = (v << 8n) | BigInt(idx < data.length ? data[idx] : 0);
      }
      return v;
    };

    let x = window(bytePos);

    for (;;) {
      if (n <= 0) {
        bytePos += 4;
        x = window(bytePos);
        n += 32;
      }
      const code = Number((x >> BigInt(n)) & 0xffffffffn);

      const entry = this.dict1[code >>> 24];
      let codelen = entry.codelen;
      let maxcode = entry.maxcode;
      if (!entry.term) {
        while (codelen <= 32 && code < this.minCode[codelen]) codelen++;
        if (codelen > 32) break;
        maxcode = this.maxCode[codelen];
      }

      n -= codelen;
      bitsLeft -= codelen;
      if (bitsLeft < 0) break;

      const index = Math.floor((maxcode - code) / 2 ** (32 - codelen));
      const phrase = this.phrases[index];
      if (!phrase) break;
      if (!phrase.expanded) {
        phrase.data = this.unpack(phrase.data, depth + 1);
        phrase.expanded = true;
      }
      chunks.push(phrase.data);
    }
    return Buffer.concat(chunks);
  }
}

/* ------------------------------------------------------------- markup */

const IMAGE_MAGIC: [Buffer, string, string][] = [
  [Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg', 'jpg'],
  [Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png', 'png'],
  [Buffer.from('GIF8', 'latin1'), 'image/gif', 'gif'],
  [Buffer.from('RIFF', 'latin1'), 'image/webp', 'webp'],
];

const imageKind = (buf: Buffer): { ext: string } | null => {
  for (const [magic, , ext] of IMAGE_MAGIC) if (buf.subarray(0, magic.length).equals(magic)) return { ext };
  return null;
};

const PAGEBREAK = Buffer.from('<mbp:pagebreak', 'latin1');
const HTML_OPEN = Buffer.from('<html', 'latin1');
/** Sections larger than this get split again at headings so pages stay responsive. */
const MAX_SECTION_BYTES = 240_000;

function findAll(raw: Buffer, needle: Buffer, limit = Infinity): number[] {
  const out: number[] = [];
  let from = 0;
  while (out.length < limit) {
    const at = raw.indexOf(needle, from);
    if (at < 0) break;
    out.push(at);
    from = at + needle.length;
  }
  return out;
}

/**
 * Chapter boundaries.
 *
 * MOBI6 marks them with <mbp:pagebreak>. Files whose text stream is KF8-style markup
 * (Amazon's newer output, also found inside some .azw3 that still declare mobiType 2)
 * have none — instead the stream is a run of complete <html> documents, one per chapter.
 */
function splitSections(raw: Buffer): { start: number; end: number }[] {
  let breaks: number[] = [0];
  const pageBreaks = findAll(raw, PAGEBREAK);
  if (pageBreaks.length) {
    for (const at of pageBreaks) if (at > breaks[breaks.length - 1]) breaks.push(at);
  } else {
    const docs = findAll(raw, HTML_OPEN);
    if (docs.length > 1) breaks = docs[0] <= 8 ? docs : [0, ...docs];
  }

  // Some books carry almost no pagebreaks but ship a full TOC of `filepos` anchors —
  // 《零基础入门学习Python》 has SIX pagebreaks and THREE HUNDRED AND ONE filepos links.
  // Every filepos is an exact byte offset of a section start, so when the TOC promises
  // far more structure than the pagebreaks deliver, the anchors become the boundaries.
  // Books whose pagebreaks already match their TOC density are left untouched.
  if (breaks.length < 64) {
    const anchors = new Set<number>();
    const text = raw.toString('latin1');
    const re = /filepos\s*=\s*["']?0*(\d+)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const at = Number(m[1]);
      if (at > 0 && at < raw.length) anchors.add(at);
    }
    if (anchors.size >= 8 && breaks.length - 1 < anchors.size / 3) {
      const merged = new Set(breaks);
      const sorted = [...anchors].sort((a, b) => a - b);
      let last = -1;
      for (const at of sorted) {
        // Skip anchors that land on top of an existing break or a just-kept anchor:
        // degenerate slivers make one-line "chapters".
        if ([...merged].some((b) => Math.abs(b - at) < 48) || at - last < 48) continue;
        merged.add(at);
        last = at;
      }
      breaks = [...merged].sort((a, b) => a - b);
    }
  }
  breaks.push(raw.length);

  const sections: { start: number; end: number }[] = [];
  for (let i = 0; i < breaks.length - 1; i++) {
    let start = breaks[i];
    const end = breaks[i + 1];
    if (end - start < 24) continue;
    // Oversized section (a book with no page breaks): cut at <h1>/<h2>/<h3>.
    while (end - start > MAX_SECTION_BYTES) {
      let cut = -1;
      for (const tag of ['<h1', '<h2', '<h3']) {
        const needle = Buffer.from(tag, 'latin1');
        const at = raw.indexOf(needle, start + MAX_SECTION_BYTES / 2);
        if (at > start && at < end && (cut < 0 || at < cut)) cut = at;
      }
      if (cut < 0 || cut - start > MAX_SECTION_BYTES) cut = Math.min(end, start + MAX_SECTION_BYTES);
      sections.push({ start, end: cut });
      start = cut;
    }
    sections.push({ start, end });
  }
  return sections.length ? sections : [{ start: 0, end: raw.length }];
}

/**
 * Chapter title guess. A real heading wins; otherwise the *first block* is used, but only
 * if it is short enough to plausibly be a title — otherwise we'd dump a paragraph of body
 * text into the table of contents.
 */
const titleFrom = (html: string): string | undefined => {
  const heading = /<h[1-6][^>]*>([\s\S]{0,300}?)<\/h[1-6]>/i.exec(html);
  const headingText = collapse((heading?.[1] ?? '').replace(/<[^>]+>/g, ''));
  if (headingText) return headingText.slice(0, 80);

  const block = /<(p|div|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(html);
  const blockText = collapse((block?.[2] ?? '').replace(/<[^>]+>/g, ''));
  return blockText && blockText.length <= 40 ? blockText : undefined;
};

/** Kindle resource ids are base32hex: 0-9 then A-V. "005A" -> 170. */
const base32hex = (s: string): number =>
  [...s.toUpperCase()].reduce((acc, ch) => {
    const code = ch.charCodeAt(0);
    return acc * 32 + (code <= 57 ? code - 48 : code - 55);
  }, 0);

/** Ordered [chapterId, label] pairs from a converted table-of-contents page. */
function tocLinks(html: string): [string, string][] {
  const out: [string, string][] = [];
  const re = /<a\b[^>]*href="#chapter:([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const label = collapse(m[2].replace(/<[^>]+>/g, ''));
    if (label) out.push([m[1], label.slice(0, 90)]);
  }
  return out;
}

/* ------------------------------------------------------------- import */

export async function importMobi(file: string, bookId: string): Promise<ImportedBook> {
  const buf = fs.readFileSync(file);
  const palm = readPalm(buf);
  const header = readHeader(record(palm, 0));

  if (header.mobiType === 248 || header.mobiType === 260) {
    throw new Error('这是 KF8/AZW3 格式，暂不支持。请改用同一本书的 .epub，或用 Calibre 转成 EPUB 再导入。');
  }
  if (header.compression !== 1 && header.compression !== 2 && header.compression !== 17480) {
    throw new Error(`未知的压缩方式：${header.compression}`);
  }

  /* ---- text ---- */

  const out = Buffer.alloc(header.textLength);
  let pos = 0;
  let huff: HuffCdic | null = null;
  if (header.compression === 17480) {
    const huffRecords: Buffer[] = [];
    for (let i = 0; i < header.huffCount; i++) huffRecords.push(record(palm, header.huffOffset + i));
    huff = new HuffCdic(huffRecords);
  }

  for (let i = 1; i <= header.textRecords && i < palm.count; i++) {
    const chunk = trimTrailing(record(palm, i), header.extraFlags);
    if (header.compression === 1) {
      pos += chunk.copy(out, pos, 0, Math.min(chunk.length, out.length - pos));
    } else if (header.compression === 2) {
      pos = palmDocDecompress(chunk, out, pos);
    } else {
      const piece = huff!.decompress(chunk);
      pos += piece.copy(out, pos, 0, Math.min(piece.length, out.length - pos));
    }
    if (pos >= out.length) break;
  }
  const raw = out.subarray(0, pos);
  if (raw.length < 64) throw new Error('解压后没有正文，文件可能已损坏');

  /* ---- sections ---- */

  /**
   * Page breaks in a MOBI are typographic, not structural: illustrated books put every
   * plate on its own page, which would otherwise produce a chapter called "第 314 节"
   * holding one <img>. A section with no text of its own belongs to the section before it.
   */
  const ranges = splitSections(raw).reduce<{ start: number; end: number }[]>((acc, range) => {
    const text = decodeText(raw.subarray(range.start, range.end), header.encoding)
      .replace(/<[^>]+>/g, '')
      .replace(/&[a-z#0-9]+;/gi, '')
      .trim();
    if (!text && acc.length) acc[acc.length - 1].end = range.end;
    else acc.push({ ...range });
    return acc;
  }, []);
  const usedImages = new Map<number, string>(); // recindex -> images/<name>
  const emittedRels = new Set<string>();
  const assets: { rel: string; data: Buffer }[] = [];

  const imageRel = (recindex: number): string | null => {
    const cached = usedImages.get(recindex);
    if (cached) return cached;
    const index = header.firstImage + recindex - 1;
    if (index <= 0 || index >= palm.count) return null;
    const data = record(palm, index);
    const kind = imageKind(data);
    if (!kind) return null;
    const rel = `images/img-${String(recindex).padStart(5, '0')}.${kind.ext}`;
    usedImages.set(recindex, rel);
    emittedRels.add(rel);
    assets.push({ rel, data: Buffer.from(data) });
    return rel;
  };

  const sectionOf = (byteOffset: number): number => {
    let lo = 0;
    let hi = ranges.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ranges[mid].start <= byteOffset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  const chapters: ImportedBook['chapters'] = [];
  const readingOrder: ChapterRef[] = [];
  const toc: TocItem[] = [];
  /** <title> of each source document — KF8 chapters carry their real title there. */
  const docTitles: string[] = [];

  ranges.forEach((range, index) => {
    let html = decodeText(raw.subarray(range.start, range.end), header.encoding);

    docTitles.push(collapse((/<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(html)?.[1] ?? '').replace(/<[^>]+>/g, '')));

    // Images are referenced by record number, never by path:
    //   MOBI6 → <img recindex="0042">
    //   KF8   → <img src="kindle:embed:005A?mime=image/jpg">   (base32hex, 1-based)
    html = html.replace(/<img\b([^>]*)>/gi, (_whole, attrs: string) => {
      const recindex = /recindex\s*=\s*["']?0*(\d+)/i.exec(attrs);
      const embed = /kindle:embed:([0-9A-Va-v]+)/.exec(attrs);
      const index = recindex ? Number(recindex[1]) : embed ? base32hex(embed[1]) : 0;
      if (!index) return '';
      const rel = imageRel(index);
      if (!rel) return '';
      const alt = /alt\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? '';
      return `<img src="${rel}" alt="${alt.replace(/"/g, '&quot;')}" />`;
    });

    // <a filepos=0000012345> — byte offset into the uncompressed stream.
    html = html.replace(/<a\b([^>]*?)filepos\s*=\s*["']?0*(\d+)["']?([^>]*)>/gi, (_m, pre: string, offset: string, post: string) => {
      const target = ranges[sectionOf(Number(offset))];
      const targetIndex = ranges.indexOf(target);
      return `<a${pre}href="__chapter__${targetIndex}"${post}>`;
    });

    const id = `sec${String(index + 1).padStart(4, '0')}`;
    chapters.push({ id, file: `${id}.html`, html });
    readingOrder.push({ id, href: `chapters/${id}.html`, title: undefined, format: 'html' });
  });

  // Second pass: internal links can only be resolved once every chapter id exists.
  // Then the markup goes through the same whitelist rebuild as every other format —
  // MOBI markup is untrusted, and extractBlocks depends on the normalised shape.
  chapters.forEach((chapter, index) => {
    const linked = chapter.html.replace(/__chapter__(\d+)/g, (_m, n: string) =>
      `chapter://${chapters[Number(n)]?.id ?? chapter.id}`,
    );
    chapter.html = sanitizeChapter(linked, {
      bookId,
      resolveImage: (src) => (emittedRels.has(src) ? src : null),
      resolveLink: (href) => (href.startsWith('chapter://') ? href.slice('chapter://'.length) : null),
    });
    const docTitle = docTitles[index];
    readingOrder[index].title =
      (docTitle && docTitle.length <= 80 ? docTitle : undefined) ??
      titleFrom(chapter.html) ??
      `第 ${index + 1} 节`;
  });

  /* ---- table of contents ----
   * A MOBI's real TOC is an ordinary page full of filepos links, pointed at by
   * <guide><reference type="toc">. Its link labels are the author's own chapter titles,
   * which beat anything we can guess from the markup.
   */
  const guide = /<reference\b[^>]*type\s*=\s*["']?toc["']?[^>]*filepos\s*=\s*["']?0*(\d+)/i.exec(
    decodeText(raw.subarray(0, Math.min(raw.length, 8192)), header.encoding),
  );
  let tocIndex = guide ? sectionOf(Number(guide[1])) : -1;
  if (tocIndex < 0) {
    let best = -1;
    chapters.forEach((chapter, i) => {
      const count = tocLinks(chapter.html).length;
      if (count >= 5 && count > best) {
        best = count;
        tocIndex = i;
      }
    });
  }

  const titled = new Map<string, string>();
  if (tocIndex >= 0 && chapters[tocIndex]) {
    for (const [chapterId, label] of tocLinks(chapters[tocIndex].html)) {
      if (!titled.has(chapterId)) titled.set(chapterId, label);
    }
  }

  chapters.forEach((chapter, index) => {
    const fromToc = titled.get(chapter.id);
    if (fromToc) {
      readingOrder[index].title = fromToc;
    } else if (readingOrder[index].title === `第 ${index + 1} 节` && index > 0) {
      // Untitled page that isn't in the book's own TOC: it is a continuation of the
      // chapter before it, which reads far better than "第 299 节".
      const previous = readingOrder[index - 1].title!.replace(/（续\d*）$/, '');
      readingOrder[index].title = `${previous}（续）`;
    }
    toc.push({ title: readingOrder[index].title!, chapterId: chapter.id });
  });

  /* ---- cover ---- */

  let cover: string | undefined;
  const coverOffset = exthUint(header, 201);
  if (coverOffset != null && coverOffset !== 0xffffffff) {
    cover = imageRel(coverOffset + 1) ?? undefined;
  }
  if (!cover) {
    const thumb = exthUint(header, 202);
    if (thumb != null && thumb !== 0xffffffff) cover = imageRel(thumb + 1) ?? undefined;
  }

  /* ---- metadata ---- */

  const rawLanguage = exthText(header, 524)[0] || 'zh';
  // Bare subtags confuse voice matching; give them a region.
  const language = rawLanguage === 'zh' ? 'zh-CN' : rawLanguage === 'en' ? 'en-US' : rawLanguage;
  const manifest: BookManifest = {
    schema: BOOK_SCHEMA,
    id: bookId,
    title: exthText(header, 503)[0] || header.title || path.basename(file, path.extname(file)),
    authors: exthText(header, 100),
    language,
    description: exthText(header, 103)[0]?.replace(/<[^>]+>/g, '').slice(0, 800),
    published: exthText(header, 106)[0],
    cover,
    readingOrder,
    toc,
    meta: {
      publisher: exthText(header, 101)[0],
      isbn: exthText(header, 104)[0],
      producer: exthText(header, 108)[0],
      records: palm.count,
      images: usedImages.size,
    },
  };

  return { manifest, chapters, assets };
}
