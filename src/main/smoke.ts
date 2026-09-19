/**
 * Headless verification harness (development only — never reached in normal startup).
 *
 *   ALOUD_SMOKE=<book file>  npx electron .   → run the import pipeline, print a summary
 *   ALOUD_SMOKE_UI=1         npx electron .   → boot the real window, open the first book,
 *                                               report renderer errors and DOM diagnostics
 *
 * Results go to ALOUD_SMOKE_OUT (default ./smoke-result.json) because Electron on Windows
 * is a GUI-subsystem binary whose stdout is not attached to the parent shell.
 */
import { app, clipboard, nativeImage, type BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { makeSegments } from '@shared/text';
import { P, ensureDirs } from './paths';
import * as store from './store';
import { importFile } from './import';
import type { PlainIndex } from '@shared/types';

function emitter(): (value: unknown) => void {
  const outFile = process.env.ALOUD_SMOKE_OUT ?? path.join(process.cwd(), 'smoke-result.json');
  return (value: unknown) => {
    const text = `${JSON.stringify(value, null, 2)}\n`;
    try {
      fs.writeFileSync(outFile, text, 'utf8');
    } catch {
      /* nothing else we can do */
    }
    console.log(text);
  };
}

export async function runImportSmoke(file: string): Promise<void> {
  const emit = emitter();
  try {
    ensureDirs();
    store.init();
    const result = await importFile(file);
    if (result.ok && result.bookId) {
      const plain = store.readJson<PlainIndex | null>(P.plain(result.bookId), null);
      const first = plain?.chapters[0];
      const segments = first ? makeSegments(first.id, first.blocks) : [];
      emit({
        ...result,
        userData: P.root(),
        chapters: plain?.chapters.length,
        words: plain?.chapters.reduce((a, c) => a + c.words, 0),
        firstChapterBlocks: first?.blocks.length,
        firstChapterSegments: segments.length,
        sampleSegments: segments.slice(0, 4).map((s) => ({ id: s.id, lang: s.lang, text: s.text })),
      });
    } else {
      emit(result);
    }
    app.exit(result.ok ? 0 : 1);
  } catch (err) {
    emit({ ok: false, file, error: err instanceof Error ? `${err.message}\n${err.stack}` : String(err) });
    app.exit(1);
  }
}

const DIAGNOSTICS = `(async () => { try { return await (async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const click = (el) => {
    const r = el.getBoundingClientRect();
    const x = r.left + Math.min(30, r.width / 2), y = r.top + r.height / 2;
    for (const type of ['mousedown', 'mouseup', 'click']) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
    }
  };
  const store = window.__aloudStore;
  const wanted = window.__aloudSmokeBook;
  const books = store.getState().library.books;
  const book = (wanted && books.find((b) => b.id.includes(wanted) || b.title.includes(wanted))) || books[0];
  if (!book) return { error: 'library is empty — import a book first' };

  const openedAt = performance.now();
  store.getState().navigate({ name: 'reader', bookId: book.id });
  await wait(2200);
  const out = {
    book: book.title,
    bookStats: { chapters: book.chapterCount, words: book.wordCount, openMs: Math.round(performance.now() - openedAt) },
    route: store.getState().route.name,
    customHighlightApi: typeof CSS !== 'undefined' && 'highlights' in CSS,
    ch1: {
      blocksInDom: document.querySelectorAll('[data-blk]').length,
      firstBlockText: document.querySelector('[data-blk]')?.textContent?.slice(0, 30) ?? null,
      chars: document.querySelector('.chapter')?.textContent?.length ?? 0,
    },
    bottombar: [...document.querySelectorAll('.bottombar span')].map((s) => s.textContent),
  };
  // A probe that throws must not swallow everything measured before it — the partial
  // result is usually what says which surface was missing.
  window.__aloudOut = out;
  // A probe that throws must not swallow everything measured before it — the partial
  // result is usually what says which surface was missing.
  window.__aloudOut = out;

  // --- jump to chapter 2 through the real table of contents
  document.querySelector('[title="目录"]')?.click();
  await wait(400);
  const tocItems = [...document.querySelectorAll('.toc-item')];
  out.tocEntries = tocItems.map((b) => b.textContent);
  tocItems[1]?.click();
  await wait(1600);
  const img = document.querySelector('.chapter img');
  out.ch2 = {
    blocksInDom: document.querySelectorAll('[data-blk]').length,
    imageSrc: img ? img.currentSrc || img.src : null,
    imageLoaded: img ? img.naturalWidth > 0 : null,
    figcaption: document.querySelector('.chapter figcaption')?.textContent?.slice(0, 24) ?? null,
    tableCells: document.querySelectorAll('.chapter td').length,
    pageIndicator: document.querySelector('.bottombar span')?.textContent ?? null,
    // The last column must not spill outside the clipping viewport.
    columnOverflow: (() => {
      const vp = document.querySelector('.viewport');
      const c = document.querySelector('.chapter');
      if (!vp || !c) return null;
      const cs = getComputedStyle(vp);
      const inner = vp.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      return {
        columnBoxWidth: Math.round(c.getBoundingClientRect().width),
        innerWidth: Math.round(inner),
        scrollWidth: c.scrollWidth,
        columnCount: getComputedStyle(c).columnCount,
        chars: c.textContent.length,
      };
    })(),
  };

  // --- pagination: force overflow with a big font, then turn pages
  store.getState().patchSettings({ fontSizePx: 34, lineHeight: 2.2 });
  await wait(900);
  const pagesLabel = () => document.querySelector('.bottombar span')?.textContent ?? '';
  out.pagination = { atBigFont: pagesLabel() };
  document.querySelector('.page-edge.right')?.click();
  await wait(600);
  out.pagination.afterNext = pagesLabel();
  document.querySelector('.page-edge.left')?.click();
  await wait(600);
  out.pagination.afterPrev = pagesLabel();
  store.getState().patchSettings({ layout: 'scroll' });
  await wait(700);
  out.pagination.scrollMode = {
    label: pagesLabel(),
    transform: getComputedStyle(document.querySelector('.chapter')).transform,
    viewportScrolls: document.querySelector('.viewport').scrollHeight > document.querySelector('.viewport').clientHeight,
  };
  store.getState().patchSettings({ layout: 'paginated', fontSizePx: 19, lineHeight: 1.75 });
  await wait(800);
  out.pagination.restored = pagesLabel();

  // --- page-turn animation: the curl leaf must actually mount, and the page must advance
  // Jump to a chapter with real prose first — a one-page chapter has nothing to turn.
  document.querySelector('[title="目录"]')?.click();
  await wait(400);
  const items = [...document.querySelectorAll('.toc-item')];
  (items[5] ?? items[items.length - 1])?.click();
  await wait(1500);
  store.getState().patchSettings({ fontSizePx: 30, pageAnimation: 'curl', pageSound: true });
  await wait(1000);
  const before = pagesLabel();
  document.querySelector('.page-edge.right')?.click();
  await wait(160);
  const flapEl = document.querySelector('.pt-flap');
  const flatEl = document.querySelector('.pt-flat .chapter');
  out.curl = {
    before,
    flapMounted: !!flapEl,
    flapMirrored: flapEl ? getComputedStyle(flapEl).transform.slice(0, 20) : null,
    flapClip: flapEl ? getComputedStyle(flapEl).clipPath.slice(0, 30) : null,
    flatClonedText: flatEl ? (flatEl.textContent || '').trim().slice(0, 16) : null,
    frameSpansSpread: (() => {
      const fr = document.querySelector('.pt-frame');
      const vp2 = document.querySelector('.viewport');
      if (!fr || !vp2) return null;
      const cs2 = getComputedStyle(vp2);
      const inner = vp2.clientWidth - parseFloat(cs2.paddingLeft) - parseFloat(cs2.paddingRight);
      return Math.abs(fr.getBoundingClientRect().width - inner) < 2;
    })(),
    audioContexts: typeof AudioContext !== 'undefined',
  };
  await wait(900);
  out.curl.after = pagesLabel();
  out.curl.leafRemoved = !document.querySelector('.pt-flap');
  document.querySelector('.page-edge.left')?.click();
  await wait(900);
  out.curl.afterBack = pagesLabel();

  // The turning leaf is a DOM clone, so images must come along and be painted, not blank.
  document.querySelector('[title="目录"]')?.click();
  await wait(400);
  const plate = [...document.querySelectorAll('.toc-item')].find((b) => (b.textContent || '').includes('《'));
  if (plate) {
    plate.click();
    await wait(1500);
    store.getState().patchSettings({ spread: 'single', fontSizePx: 34 });
    await wait(900);
    out.curlWithImage = { pages: pagesLabel(), realImages: document.querySelectorAll('.chapter img').length };
    document.querySelector('.page-edge.right')?.click();
    await wait(110);
    const cloned = [...document.querySelectorAll('.pt-flat img')];
    out.curlWithImage.leafMounted = !!document.querySelector('.pt-flap');
    out.curlWithImage.clonedImages = cloned.length;
    out.curlWithImage.clonedImagesPainted = cloned.filter((i) => i.naturalWidth > 0).length;
    out.curlWithImage.clonedSrc = cloned[0] ? cloned[0].getAttribute('src')?.slice(0, 48) : null;
    await wait(900);
    store.getState().patchSettings({ spread: 'auto' });
  }
  await wait(400);

  // --- drag to turn: the fold must track the cursor and commit on release
  const vp = document.querySelector('.viewport');
  const box = vp.getBoundingClientRect();
  const y = box.top + box.height / 2;
  const x0 = box.left + box.width * 0.8;
  const send = (type, x, yy) =>
    (type === 'mousedown' ? vp : window).dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: yy ?? y,
        button: 0,
        // Without this the reader reads the move as "button released somewhere we never
        // saw" and cancels the gesture — which is correct behaviour, and a dead test.
        buttons: type === 'mouseup' ? 0 : 1,
      }),
    );

  const turnEl = () => document.querySelector('.pt-flap');
  const turnPose = () => {
    const el = turnEl();
    return el ? getComputedStyle(el).transform + '|' + getComputedStyle(el).clipPath : null;
  };
  while (document.querySelector('.pt-flap')) await wait(100); // no in-flight fold
  const dragStart = pagesLabel();
  send('mousedown', x0);
  await wait(30);
  send('mousemove', x0 - 40);
  await wait(120); // let the spring move the paper
  const poseEarly = turnPose();
  // Drag all the way across the spine to the left side of the spread.
  const total = Math.round(box.width * 0.72);
  for (const frac of [0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 1]) {
    send('mousemove', x0 - Math.round(total * frac), y + Math.round(20 * frac));
    await wait(40);
  }
  const poseLate = turnPose();
  out.drag = {
    before: dragStart,
    foldAppeared: !!poseEarly,
    followsCursor: !!(poseEarly && poseLate && poseEarly !== poseLate),
    stageDraggingClass: !!document.querySelector('.stage.dragging'),
  };
  send('mouseup', x0 - total);
  await wait(800);
  out.drag.after = pagesLabel();
  out.drag.cleanedUp = !turnEl() && !document.querySelector('.stage.dragging');

  // With the read-aloud bar open, the text column must stop above it — no glyph may sit
  // under the controls.
  {
    const barWasOpen = !!document.querySelector('.ra-bar');
    if (!barWasOpen) document.querySelector('[title="逐行朗读"]')?.click();
    await wait(900);
    const bar = document.querySelector('.ra-bar');
    const br = bar ? bar.getBoundingClientRect() : null;
    let overlapped = 0;
    if (br) {
      for (const b of document.querySelectorAll('[data-blk]')) {
        const r = b.getBoundingClientRect();
        if (r.width === 0) continue;
        const hit = r.right > br.left && r.left < br.right && r.bottom > br.top && r.top < br.bottom;
        if (hit) overlapped++;
      }
    }
    out.raBarOverlap = { barMounted: !!bar, blocksUnderBar: overlapped };
    if (!barWasOpen) document.querySelector('.ra-bar [title="关闭朗读"]')?.click();
    await wait(700);
  }

  // Toolbar scale must actually resize the pill and its glyphs.
  {
    const glyph = () => document.querySelector('.tool-cluster .btn.icon svg');
    const at = (scale) => {
      store.getState().patchSettings({ toolbarScale: scale });
      return new Promise((r) => setTimeout(r, 260)).then(() => Math.round(glyph().getBoundingClientRect().width));
    };
    const small = await at(0.8);
    const big = await at(1.3);
    store.getState().patchSettings({ toolbarScale: 1 });
    await wait(260);
    out.toolbarScale = { small, big, scales: big > small + 3 };
  }

  // A release the app never hears about (outside the window) must not wedge the gesture.
  {
    while (document.querySelector('.pt-flap')) await wait(100);
    const vp6 = document.querySelector('.viewport').getBoundingClientRect();
    const y6 = vp6.top + vp6.height / 2;
    const x6 = vp6.left + vp6.width * 0.9;
    const before = pagesLabel();
    document
      .querySelector('.viewport')
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x6, clientY: y6, button: 0 }));
    await wait(20);
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 1, clientX: x6 - 200, clientY: y6, buttons: 1 }));
    await wait(40);
    // …and now a move with no button held: the user let go somewhere we can't see.
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 1, clientX: x6 - 260, clientY: y6, buttons: 0 }));
    await wait(700);
    const recovered = { lostUpCleared: !document.querySelector('.stage.dragging') };
    // The very next drag must still work.
    const b2 = pagesLabel();
    document
      .querySelector('.viewport')
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x6, clientY: y6, button: 0 }));
    await wait(20);
    for (const frac of [0.15, 0.5, 0.85, 1]) {
      window.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true, buttons: 1, clientX: x6 - vp6.width * 0.7 * frac, clientY: y6, buttons: 1 }),
      );
      await wait(30);
    }
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x6 - vp6.width * 0.7, clientY: y6 }));
    await wait(900);
    out.lostMouseUp = { ...recovered, before, nextDragWorked: pagesLabel() !== b2 };
  }

  // Consecutive drags: the gesture must keep working, including across a chapter end.
  {
    while (document.querySelector('.pt-flap')) await wait(100);
    const vp5 = document.querySelector('.viewport').getBoundingClientRect();
    const y5 = vp5.top + vp5.height / 2;
    const startX5 = vp5.left + vp5.width * 0.9;
    const travel5 = Math.round(vp5.width * 0.75);
    const log = [];
    // 8 drags on a 10-page chapter, so the last ones run off the end and must cross into
    // the next chapter — that is the case that used to kill the gesture.
    for (let n = 0; n < 8; n++) {
      const before = pagesLabel();
      document
        .querySelector('.viewport')
        .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: startX5, clientY: y5, button: 0 }));
      await wait(20);
      for (const frac of [0.1, 0.35, 0.6, 0.85, 1]) {
        window.dispatchEvent(
          new MouseEvent('mousemove', { bubbles: true, buttons: 1, clientX: startX5 - travel5 * frac, clientY: y5 }),
        );
        await wait(30);
      }
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: startX5 - travel5, clientY: y5 }));
      await wait(900);
      log.push({
        n: n + 1,
        before,
        after: pagesLabel(),
        chapter: (document.querySelector('.book-title')?.textContent ?? '').slice(-14),
        stuckDragClass: !!document.querySelector('.stage.dragging'),
        stuckFold: !!document.querySelector('.pt-flap'),
        overlays: document.querySelectorAll('.pt-overlay').length,
      });
    }
    out.repeatDrag = log;
  }

  // A tilted crease must not leave an unfolded wedge: both layers have to be clipped on
  // the SAME slanted line. Verify by sampling the fold's own geometry.
  {
    while (document.querySelector('.pt-flap')) await wait(100);
    // Make sure there IS a next page to fold onto, whatever the previous test left behind.
    for (let i = 0; i < 3 && /第 (\\d+) \\/ \\1 页/.test(pagesLabel()); i++) {
      document.querySelector('.page-edge.left')?.click();
      await wait(700);
    }
    const vp4 = document.querySelector('.viewport').getBoundingClientRect();
    const yMid = vp4.top + vp4.height / 2;
    const sx4 = vp4.left + vp4.width * 0.85;
    document
      .querySelector('.viewport')
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: sx4, clientY: yMid, button: 0 }));
    await wait(20);
    // Drag left AND far down, so the crease tilts hard.
    for (const [dx, dy] of [[60, 20], [220, 120], [420, 240], [620, 330]]) {
      window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 1, clientX: sx4 - dx, clientY: yMid + dy }));
      await wait(35);
    }
    const flap4 = document.querySelector('.pt-flap');
    const flat4 = document.querySelector('.pt-flat');
    const flapClipStr = flap4 ? getComputedStyle(flap4).clipPath : '';
    const flatClipStr = flat4 ? getComputedStyle(flat4).clipPath : '';
    // Fractional px values are the crease endpoints; the integers are the box edges.
    // NOTE: this source lives inside a template literal, so every backslash must be
    // doubled or the escape is eaten before the renderer ever sees the regex.
    const creasePts = (s) =>
      (s.match(/-?\\d+\\.\\d+px/g) || []).map(parseFloat).sort((p, q) => p - q);
    const flapPts = creasePts(flapClipStr);
    const flatPts = creasePts(flatClipStr);
    out.tiltedFold = {
      mounted: !!flap4,
      flapClip: flapClipStr.slice(0, 62),
      flatClip: flatClipStr.slice(0, 62),
      flapTransform: flap4 ? getComputedStyle(flap4).transform.slice(0, 34) : null,
      // Both polygons must be cut on the SAME slanted line — that is what closes the wedge.
      creasePoints: { flap: flapPts, flat: flatPts },
      creaseShared:
        flapPts.length >= 2 &&
        flapPts.length === flatPts.length &&
        flapPts.every((v, i) => Math.abs(v - flatPts[i]) < 0.6),
      // A pure vertical fold is exactly matrix(-1, 0, 0, 1, …); anything else is tilted.
      tiltApplied: flap4 ? !getComputedStyle(flap4).transform.startsWith('matrix(-1, 0, 0, 1') : null,
    };
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: sx4 - 620, clientY: yMid + 330 }));
    await wait(800);
  }

  // Dragging must work from ANY part of the page, including pictures and links —
  // both are natively draggable and their drag would otherwise eat the gesture.
  {
    const dragFrom = async (el) => {
      const r = el.getBoundingClientRect();
      const sx = r.left + r.width / 2;
      const sy = r.top + r.height / 2;
      const pagesBefore = pagesLabel();
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: sx, clientY: sy, button: 0 }));
      await wait(20);
      let folded = false;
      let lastClip = null;
      let frameW = null;
      const travel = Math.round(window.innerWidth * 0.55);
      for (const step of [40, 140, 260, 400, travel]) {
        window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 1, clientX: sx - step, clientY: sy }));
        await wait(30);
        const flap = document.querySelector('.pt-flap');
        if (flap) {
          folded = true;
          lastClip = getComputedStyle(flap).clipPath;
          frameW = Math.round(document.querySelector('.pt-frame').getBoundingClientRect().width);
        }
      }
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: sx - travel, clientY: sy }));
      await wait(800);
      return {
        folded,
        startX: Math.round(sx),
        travel,
        frameW,
        lastClip,
        pagesBefore,
        pagesAfter: pagesLabel(),
        turned: pagesLabel() !== pagesBefore,
      };
    };

    // find a chapter that actually has a picture
    document.querySelector('[title="目录"]')?.click();
    await wait(350);
    const plate2 = [...document.querySelectorAll('.toc-item')].find((b) => (b.textContent || '').includes('《'));
    plate2?.click();
    await wait(1400);

    // The image has to be on the page currently shown — in a multicolumn flow the others
    // sit far off to the right and dragging "from" them would prove nothing.
    const vpBox2 = document.querySelector('.viewport').getBoundingClientRect();
    const visibleImg = () =>
      [...document.querySelectorAll('.chapter img')].find((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 40 && r.left >= vpBox2.left - 2 && r.right <= vpBox2.right + 2;
      });
    let img = visibleImg();
    for (let i = 0; i < 6 && !img; i++) {
      document.querySelector('.page-edge.right')?.click();
      await wait(800);
      img = visibleImg();
    }

    // A native image drag must be refused — that is what used to eat the gesture.
    let dragStartPrevented = null;
    if (img) {
      const ev = new Event('dragstart', { bubbles: true, cancelable: true });
      img.dispatchEvent(ev);
      dragStartPrevented = ev.defaultPrevented;
    }

    while (document.querySelector('.pt-flap')) await wait(100); // let any fold finish
    out.dragFromImage = img ? await dragFrom(img) : { skipped: 'no image visible on any of 6 pages' };
    out.dragFromImage.imgUserDrag = img ? getComputedStyle(img).webkitUserDrag : null;
    out.dragFromImage.dragStartPrevented = dragStartPrevented;
    await wait(500);
  }

  // Selection mode: off = paper (no text selection, drag turns pages);
  // on = selectable text and the drag gesture stands down.
  {
    const btn = () => document.querySelector('[title^="选中模式"]');
    const chapterEl = () => document.querySelector('.chapter');
    const before = { title: btn()?.getAttribute('title'), userSelect: getComputedStyle(chapterEl()).userSelect };
    btn()?.click();
    await wait(300);
    const after = { title: btn()?.getAttribute('title'), userSelect: getComputedStyle(chapterEl()).userSelect };
    // With selection on, a horizontal drag must NOT turn the page.
    const pagesBefore = pagesLabel();
    const vp3 = document.querySelector('.viewport').getBoundingClientRect();
    const yy = vp3.top + vp3.height / 2;
    const sx = vp3.left + vp3.width * 0.8;
    document
      .querySelector('.viewport')
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: sx, clientY: yy, button: 0 }));
    for (const step of [60, 200, 400]) {
      window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 1, clientX: sx - step, clientY: yy }));
      await wait(30);
    }
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: sx - 400, clientY: yy }));
    await wait(500);
    out.selectMode = {
      offUserSelect: before.userSelect,
      onUserSelect: after.userSelect,
      toggled: before.title !== after.title,
      dragDidNotTurn: pagesLabel() === pagesBefore,
      noFoldMounted: !document.querySelector('.pt-flap'),
    };
    btn()?.click(); // back to paper mode
    await wait(300);
  }

  /* ---------------- regressions fixed this round ---------------- */

  // Font switching: [data-font] has to reach the DOM or tokens.css never matches.
  const stageEl = document.querySelector('.stage');
  const fontOf = () => getComputedStyle(document.querySelector('.chapter')).fontFamily;
  store.getState().patchSettings({ fontFamily: 'serif-cn' });
  await wait(160);
  const serifFont = fontOf();
  store.getState().patchSettings({ fontFamily: 'sans-cn' });
  await wait(160);
  const sansFont = fontOf();
  store.getState().patchSettings({ bold: true });
  await wait(160);
  const boldWeight = getComputedStyle(document.querySelector('.chapter')).fontWeight;
  store.getState().patchSettings({ bold: false, fontFamily: 'serif-cn' });
  await wait(160);
  out.fontSwitch = {
    attr: stageEl ? stageEl.getAttribute('data-font') : null,
    serif: serifFont.slice(0, 26),
    sans: sansFont.slice(0, 26),
    changes: serifFont !== sansFont,
    boldWeight,
    boldWorks: boldWeight === '600',
  };

  // Both panels open at once: contents on the left, notes on the right.
  document.querySelector('[title="目录"]')?.click();
  await wait(220);
  document.querySelector('[title="标注与书签"]')?.click();
  await wait(220);
  out.panelsTogether = {
    left: !!document.querySelector('.panel.left'),
    right: !!document.querySelector('.panel:not(.left)'),
    bothOpen: !!document.querySelector('.panel.left') && !!document.querySelector('.panel:not(.left)'),
    gripCount: document.querySelectorAll('.panel-grip').length,
  };

  // Panel resize: drag the grip and see the width follow.
  store.getState().patchSettings({ panelWidth: 320 });
  await wait(300);
  const grip = document.querySelector('.panel:not(.left) .panel-grip');
  if (grip) {
    const panelEl = grip.closest('.panel');
    const w0 = panelEl.getBoundingClientRect().width;
    const gr = grip.getBoundingClientRect();
    grip.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: gr.left + 4, clientY: 300, button: 0, buttons: 1 }));
    await wait(30);
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: gr.left - 90, clientY: 300, buttons: 1 }));
    await wait(60);
    const w1 = panelEl.getBoundingClientRect().width;
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: gr.left - 90, clientY: 300 }));
    await wait(220);
    out.panelResize = { from: Math.round(w0), to: Math.round(w1), grew: w1 > w0 + 40 };
  }
  document.querySelectorAll('.panel [title="关闭 (Esc)"]').forEach((b) => b.click());
  await wait(200);

  // The fold: crease must be vertical and both faces present, with no global fade.
  out.fold = await (async () => {
    const vp = document.querySelector('.viewport');
    const r = vp.getBoundingClientRect();
    const startX = r.left + r.width * 0.72;
    vp.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: startX, clientY: r.top + 200, button: 0, buttons: 1 }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: startX - 260, clientY: r.top + 340, buttons: 1 }));
    await wait(120);
    const flap = document.querySelector('.pt-flap');
    const settingsNow = store.getState().settings;
    const flat = document.querySelector('.pt-flat');
    const frame = document.querySelector('.pt-frame');
    const info = flap
      ? {
          faces: flap.querySelectorAll('.pt-face').length,
          flapTransform: getComputedStyle(flap).transform,
          backTransform: getComputedStyle(flap.querySelector('.pt-face-back')).transform,
          flatClip: getComputedStyle(flat).clipPath,
          flapClip: getComputedStyle(flap).clipPath,
          frameOpacity: getComputedStyle(frame).opacity,
        }
      : {
          faces: 0,
          why: {
            overlay: !!document.querySelector('.pt-overlay'),
            anim: settingsNow.pageAnimation,
            layout: settingsNow.layout,
            selectOn: (document.querySelector('[title^="选中模式"]')?.getAttribute('title') || '').indexOf('开') > 0,
          },
        };
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: startX - 260, clientY: r.top + 340 }));
    await wait(650);
    // matrix(-1, 0, 0, 1, tx, 0) is a pure horizontal mirror: no rotation, so no tear.
    const isMirror = (t) => {
      if (!t || t.indexOf('matrix(') !== 0) return false;
      const n = t.slice(7, -1).split(',').map(Number);
      return n[0] === -1 && n[1] === 0 && n[2] === 0 && n[3] === 1;
    };
    info.pureMirror = isMirror(info.flapTransform);
    info.backCancels = isMirror(info.backTransform);
    info.noGlobalFade = info.frameOpacity === '1';
    info.usesInset = (info.flatClip || '').indexOf('inset') === 0;
    info.ok = info.faces === 2 && info.pureMirror && info.backCancels &&
      info.noGlobalFade && info.usesInset;
    return info;
  })();

  // A sentence straddling a page break: the page must turn at the boundary WORD, while
  // the sentence is still being spoken — not after it ends.
  out.midSentenceTurn = await (async () => {
    store.getState().patchReadAloud({ autoScroll: true });
    await wait(200);
    const api = window.__aloudRaProbe;
    if (!api) return { skipped: 'probe not exposed' };
    const found = api.findStraddler();
    if (!found) return { skipped: 'no straddling segment in this chapter' };
    if (!api.begin(found.id)) return { skipped: 'segment vanished' };
    await wait(900); // line highlight + snap to the segment's start page
    const pageAtStart = pagesLabel();
    // Speak up to just BEFORE the boundary: the page must not move yet.
    api.feed(Math.max(0, found.cross - 2));
    await wait(500);
    const pageBeforeCross = pagesLabel();
    // The boundary word: this is the moment the page should turn, mid-sentence.
    api.feed(found.cross);
    let foldSeen = false;
    for (let i = 0; i < 12; i++) {
      if (document.querySelector('.pt-flap')) { foldSeen = true; break; }
      await wait(100);
    }
    const pageAfterCross = pagesLabel();
    api.end();
    await wait(300);
    return {
      segment: found.id,
      cross: found.cross,
      length: found.length,
      pageAtStart,
      pageBeforeCross,
      pageAfterCross,
      heldBeforeBoundary: pageAtStart === pageBeforeCross,
      turnedAtBoundary: pageAfterCross !== pageBeforeCross,
      foldSeen,
      ok: pageAtStart === pageBeforeCross && pageAfterCross !== pageBeforeCross && foldSeen,
    };
  })();

  // Turning BACK across a chapter boundary: must land on the previous chapter's LAST
  // page (not its first), and must play the chosen page animation while doing it.
  out.backCross = await (async () => {
    const digits = (t) => t.split('').filter((ch) => ch >= '0' && ch <= '9').join('');
    document.querySelector('[title="目录"]')?.click();
    await wait(400);
    const items = [...document.querySelectorAll('.toc-item')];
    const cur = items.findIndex((b) => b.classList.contains('current'));
    const nxt = items[cur + 1];
    if (!nxt) return { skipped: 'no next chapter' };
    nxt.click();
    await wait(1600);
    document.querySelector('.panel.left [title="关闭 (Esc)"]')?.click();
    await wait(400);
    const atStart = pagesLabel();
    const endProbe = window.__aloudRaProbe?.probeEndAnchor?.(-1) ?? null;
    window.__loadTrace = [];
    document.querySelector('.page-edge.left')?.click();
    await wait(280);
    const snapEarly = window.__aloudRaProbe?.parity?.() ?? null;
    let foldSeen = false;
    for (let i = 0; i < 20; i++) {
      if (document.querySelector('.pt-flap')) { foldSeen = true; break; }
      await wait(100);
    }
    await wait(1400);
    const snapLate = window.__aloudRaProbe?.parity?.() ?? null;
    const landed = pagesLabel();
    const parity = window.__aloudRaProbe && window.__aloudRaProbe.parity ? window.__aloudRaProbe.parity() : null;
    const parts = landed.split('/');
    const a = parts.length === 2 ? Number(digits(parts[0])) : NaN;
    const b = parts.length === 2 ? Number(digits(parts[1])) : NaN;
    // Exactly the last page right after landing; image decodes may then reflow the
    // chapter and shift the anchor by one page while keeping the same text visible, so
    // "at or adjacent to the end" is the honest post-reflow criterion. What must NEVER
    // happen is landing at the chapter head — that was the reported bug.
    const nearEnd = Number.isFinite(a) && Number.isFinite(b) && a >= b - 1 && a > 1;
    return {
      atStart,
      landed,
      parity,
      endProbe,
      loadTrace: (window.__loadTrace ?? []).slice(0, 14),
      snapEarly: snapEarly ? { last: snapEarly.lastAnchor, pending: snapEarly.pendingAnchor } : null,
      snapLate: snapLate ? { last: snapLate.lastAnchor, pending: snapLate.pendingAnchor } : null,
      foldSeen,
      nearEnd,
      multiPage: Number.isFinite(b) && b > 1,
      ok: nearEnd && b > 1 && foldSeen,
    };
  })();

  // Turning FORWARD across a chapter boundary must land on the next chapter's FIRST
  // page — the user reported landing on its 4th.
  out.forwardCross = await (async () => {
    const digits = (t) => t.split('').filter((ch) => ch >= '0' && ch <= '9').join('');
    const pageNums = () => {
      const parts = pagesLabel().split('/');
      return parts.length === 2 ? [Number(digits(parts[0])), Number(digits(parts[1]))] : [NaN, NaN];
    };
    // Ride to the end of the current chapter.
    for (let i = 0; i < 40; i++) {
      const [a, b] = pageNums();
      if (Number.isFinite(a) && a >= b) break;
      document.querySelector('.page-edge.right')?.click();
      await wait(350);
    }
    const chapterBefore = (document.querySelector('.reader .topbar .book-title')?.textContent ?? '').slice(-12);
    const atEnd = pagesLabel();
    // The crossing click.
    document.querySelector('.page-edge.right')?.click();
    let foldSeen = false;
    for (let i = 0; i < 20; i++) {
      if (document.querySelector('.pt-flap')) { foldSeen = true; break; }
      await wait(100);
    }
    await wait(1600);
    const landed = pagesLabel();
    const chapterAfter = (document.querySelector('.reader .topbar .book-title')?.textContent ?? '').slice(-12);
    const st = window.__aloudRaProbe && window.__aloudRaProbe.parity ? window.__aloudRaProbe.parity() : null;
    const [a, b] = pageNums();
    return {
      chapterBefore,
      atEnd,
      chapterAfter,
      landed,
      anchors: st ? { lastAnchor: st.lastAnchor, pendingAnchor: st.pendingAnchor } : null,
      foldSeen,
      firstPage: a === 1,
      crossed: chapterAfter !== chapterBefore,
      ok: a === 1 && chapterAfter !== chapterBefore && foldSeen,
    };
  })();

  // The user's exact failure: visit the NEXT chapter first (leaving a page index in the
  // paginator), come back, ride to this chapter's end, then cross forward. The revisited
  // chapter used to open at the stale page index instead of page 1.
  out.forwardCrossRevisit = await (async () => {
    const digits = (t) => t.split('').filter((ch) => ch >= '0' && ch <= '9').join('');
    const nums = () => {
      const parts = pagesLabel().split('/');
      return parts.length === 2 ? [Number(digits(parts[0])), Number(digits(parts[1]))] : [NaN, NaN];
    };
    const tocJump = async (offset) => {
      document.querySelector('[title="目录"]')?.click();
      await wait(400);
      const items = [...document.querySelectorAll('.toc-item')];
      const cur = items.findIndex((x) => x.classList.contains('current'));
      const target = items[cur + offset];
      if (!target) return false;
      target.click();
      await wait(1500);
      document.querySelector('.panel.left [title="关闭 (Esc)"]')?.click();
      await wait(300);
      return true;
    };
    // 1. Go to the next chapter and walk a few pages in, leaving a page index behind.
    if (!(await tocJump(1))) return { skipped: 'no next chapter' };
    for (let i = 0; i < 3; i++) {
      document.querySelector('.page-edge.right')?.click();
      await wait(350);
    }
    const visitedAt = pagesLabel();
    // 2. Back to the previous chapter, ride to its end.
    if (!(await tocJump(-1))) return { skipped: 'no prev chapter' };
    for (let i = 0; i < 40; i++) {
      const [a, b] = nums();
      if (Number.isFinite(a) && a >= b) break;
      document.querySelector('.page-edge.right')?.click();
      await wait(350);
    }
    const atEnd = pagesLabel();
    // 3. The crossing click into the revisited chapter.
    document.querySelector('.page-edge.right')?.click();
    await wait(2200);
    const landed = pagesLabel();
    const [a] = nums();
    return { visitedAt, atEnd, landed, firstPage: a === 1, ok: a === 1 };
  })();

  // Polish wave: Ctrl+wheel type size, tracking and paragraph-spacing knobs.
  out.polish = await (async () => {
    store.getState().patchSettings({ fontSizePx: 19 });
    await wait(250);
    const sizeBefore = store.getState().settings.fontSizePx;
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, ctrlKey: true, cancelable: true }));
    await wait(200);
    const sizeUp = store.getState().settings.fontSizePx;
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, ctrlKey: true, cancelable: true }));
    await wait(200);
    const sizeDown = store.getState().settings.fontSizePx;
    const chapterEl = () => document.querySelector('.chapter');
    store.getState().patchSettings({ letterSpacing: 0.05, paragraphSpacing: 0.8 });
    await wait(400);
    const cs = getComputedStyle(chapterEl());
    const p = chapterEl().querySelector('p');
    const pcs = p ? getComputedStyle(p) : null;
    const tracking = cs.letterSpacing;
    const paraMargin = pcs ? pcs.marginBottom : null;
    store.getState().patchSettings({ letterSpacing: 0, paragraphSpacing: 0, fontSizePx: sizeBefore });
    await wait(300);
    // Plain wheel = page turn (Ctrl+wheel stays type size).
    const pageBeforeWheel = pagesLabel();
    document.querySelector('.viewport').dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }));
    await wait(900);
    const pageAfterWheel = pagesLabel();
    // A trackpad momentum TRAIN (many small deltas) must turn exactly ONE page.
    const vpEl2 = document.querySelector('.viewport');
    for (let i = 0; i < 8; i++) {
      vpEl2.dispatchEvent(new WheelEvent('wheel', { deltaY: 28, bubbles: true, cancelable: true }));
      await wait(35);
    }
    await wait(1100);
    const pageAfterTrain = pagesLabel();
    // Horizontal (tilt wheel / sideways swipe) pages too — one gesture, one page back.
    for (let i = 0; i < 8; i++) {
      vpEl2.dispatchEvent(new WheelEvent('wheel', { deltaX: -30, bubbles: true, cancelable: true }));
      await wait(35);
    }
    await wait(1100);
    const pageAfterSideways = pagesLabel();
    return {
      sizeBefore,
      sizeUp,
      sizeDown,
      wheelTurns: pageAfterWheel !== pageBeforeWheel,
      trainPages: [pageAfterWheel, pageAfterTrain, pageAfterSideways],
      trainOnePage: pageAfterTrain !== pageAfterWheel && pageAfterSideways === pageAfterWheel,
      wheelWorks: sizeUp === sizeBefore + 1 && sizeDown === sizeBefore,
      tracking,
      trackingWorks: tracking !== 'normal' && parseFloat(tracking) > 0,
      paraMargin,
      paraWorks: paraMargin !== null && parseFloat(paraMargin) > parseFloat(cs.fontSize) * 1.2,
    };
  })();

  // The in-app confirm dialog: right-click delete opens it, Esc cancels, nothing lost.
  out.confirmDialog = await (async () => {
    store.getState().navigate({ name: 'library' });
    await wait(900);
    // The shelf opens on 现在阅读, and a book the harness navigated to programmatically was
    // never promoted out of 想读 — so ask for 全部图书 before counting cards.
    [...document.querySelectorAll('.side-item')].find((b) => b.textContent.includes('全部图书'))?.click();
    await wait(500);
    const before = document.querySelectorAll('.book-card').length;
    const card = document.querySelector('.book-card');
    const backToReader = async () => {
      store.getState().navigate({ name: 'reader', bookId: book.id });
      await wait(1500);
    };
    // Every later probe drives the reader: never leave the library mounted behind us.
    if (!card) {
      await backToReader();
      return { skipped: 'no books' };
    }
    const r = card.getBoundingClientRect();
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 40 }));
    await wait(400);
    const menuShown = !!document.querySelector('.context-menu');
    document.querySelector('.context-menu .danger')?.click();
    await wait(450);
    const sheet = document.querySelector('.confirm-sheet');
    const dialogShown = !!sheet;
    const focusOnCancel = document.activeElement?.textContent === '取消';
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(350);
    const dialogGone = !document.querySelector('.confirm-sheet');
    const after = document.querySelectorAll('.book-card').length;
    await backToReader();
    return {
      menuShown,
      dialogShown,
      focusOnCancel,
      dialogGone,
      nothingDeleted: before === after,
      ok: menuShown && dialogShown && dialogGone && before === after,
    };
  })();

  // Reading recordings, end to end on the fake mic: record 3s while turning a page,
  // stop, list, play URL resolves, delete.
  out.recording = await (async () => {
    document.querySelector('.tool-cluster [title="录音"]')?.click();
    await wait(350);
    const menuShown = !!document.querySelector('.context-menu');
    const items = [...document.querySelectorAll('.context-menu button')];
    items.find((b) => b.textContent.includes('开始录音'))?.click();
    await wait(1200);
    const chip = document.querySelector('.rec-chip');
    const liveShown = !!chip;
    // Turn a page mid-recording so the timeline gets a second mark.
    document.querySelector('.page-edge.right')?.click();
    await wait(1800);
    document.querySelector('.rec-chip')?.click(); // stop
    await wait(1200);
    const list = await window.aloud.recordings.list(book.id);
    const rec = list[0];
    let playable = false;
    if (rec) {
      playable = await new Promise((resolve) => {
        const a = new Audio('aloud://recording/' + book.id + '/' + rec.id);
        a.onloadedmetadata = () => resolve(a.duration > 1);
        a.onerror = () => resolve(false);
        setTimeout(() => resolve(false), 4000);
      });
    }
    // Panel lists it.
    document.querySelector('.tool-cluster [title="录音"], .tool-cluster [title="录音中"]')?.click();
    await wait(300);
    [...document.querySelectorAll('.context-menu button')].find((b) => b.textContent.includes('录音列表'))?.click();
    await wait(500);
    const rowShown = !!document.querySelector('.recording-row');
    if (rec) await window.aloud.recordings.remove(book.id, rec.id);
    const after = await window.aloud.recordings.list(book.id);
    document.querySelector('.panel:not(.left) [title="关闭 (Esc)"]')?.click();
    await wait(300);
    return {
      menuShown,
      liveShown,
      saved: !!rec,
      durationSec: rec ? Math.round(rec.durationSec * 10) / 10 : null,
      timelineMarks: rec ? rec.timeline.length : 0,
      playable,
      rowShown,
      cleanedUp: after.length === 0,
      ok: menuShown && liveShown && !!rec && rec.durationSec > 1.5 && rec.timeline.length >= 2 && playable && rowShown && after.length === 0,
    };
  })();

  // Model download: the button, the bar, the cancel. Only with ALOUD_SMOKE_TTS_FAKE=1 +
  // ALOUD_TTS_DIR pointing at stub scripts — otherwise this would pull a 5GB engine.
  out.engineInstall = await (async () => {
    if (!window.__aloudSmokeInstall) return { skipped: 'set ALOUD_SMOKE_TTS_FAKE=1 with ALOUD_TTS_DIR' };
    document.querySelector('[title="逐行朗读"]')?.click();
    await wait(600);
    document.querySelector('.ra-bar [title="朗读设置"]')?.click();
    await wait(400);
    store.getState().patchReadAloud({ engine: 'local' });
    await wait(400);
    const presetSelect = [...document.querySelectorAll('.ra-settings select')].find((el) =>
      [...el.options].some((o) => o.value === 'voxcpm'),
    );
    if (!presetSelect) return { ok: false, why: 'no preset select' };
    presetSelect.value = 'voxcpm';
    presetSelect.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(900);
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('下载声音克隆引擎'));
    if (!btn) return { ok: false, why: 'no download button' };
    btn.click();
    await wait(1200);
    const barShown = !!document.querySelector('.engine-bar');
    let percent = null;
    let phase = null;
    for (let i = 0; i < 12; i++) {
      await wait(700);
      const head = document.querySelector('.engine-install-head');
      const text = head ? head.textContent : '';
      const m = /(\\d{1,3})%/.exec(text || '');
      if (m) percent = Number(m[1]);
      if (text && text.includes('·')) phase = text.split('·')[1].trim().slice(0, 12);
      if (percent) break;
    }
    const line = document.querySelector('.engine-install-line')?.textContent ?? null;
    [...document.querySelectorAll('button')].find((b) => b.textContent.includes('取消下载'))?.click();
    await wait(900);
    const stopped = !document.querySelector('.engine-bar');
    store.getState().patchReadAloud({ engine: 'system' });
    document.querySelector('.ra-bar [title="关闭朗读"]')?.click();
    await wait(300);
    return { barShown, percent, phase, line, stopped, ok: barShown && percent > 0 && stopped };
  })();

  // Handwriting: draw a pen stroke with synthetic PointerEvents, survive a font-size
  // reflow (block re-projection), erase it, undo a second stroke, verify persistence.
  out.ink = await (async () => {
    document.querySelector('.tool-cluster [title="手写标注"]')?.click();
    await wait(450);
    const cap = document.querySelector('.ink-capture');
    const barShown = !!document.querySelector('.ink-toolbar');
    if (!cap) return { ok: false, why: 'no capture layer' };
    const r = cap.getBoundingClientRect();
    const cx = Math.round(r.left + r.width * 0.28);
    const cy = Math.round(r.top + r.height * 0.42);
    const pe = (type, x, y) =>
      cap.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 7, pointerType: 'pen',
        pressure: type === 'pointerup' ? 0 : 0.62, clientX: x, clientY: y, button: 0, buttons: 1,
      }));
    const draw = async () => {
      pe('pointerdown', cx, cy);
      for (let i = 1; i <= 8; i++) { pe('pointermove', cx + i * 9, cy + Math.round(Math.sin(i) * 5)); await wait(16); }
      pe('pointerup', cx + 72, cy);
      await wait(1100); // > save debounce
    };
    const paths = () => document.querySelectorAll('svg.ink-layer path').length;
    // Deltas against whatever real ink the user already has in this chapter, and an
    // exact snapshot to put back at the end — undo-counting alone proved leaky.
    const basePaths = paths();
    const fileBefore = await window.aloud.ink.get(book.id);
    const baseFile = fileBefore.strokes.length;
    await draw();
    const drawn = paths() - basePaths;
    // Counting elements is not enough: the fountain pen (the default) once drew a path
    // whose fill a stylesheet rule overrode to none — present in the DOM, invisible on
    // the page, and every count-based check passed. Ask what is actually painted.
    const inkVisible = (() => {
      const all = [...document.querySelectorAll('svg.ink-layer path.ink-pen')];
      const el = all[all.length - 1];
      if (!el) return false;
      const cs = getComputedStyle(el);
      const paint = el.classList.contains('ink-fountain') ? cs.fill : cs.stroke;
      return paint !== 'none' && paint !== '' && cs.opacity !== '0';
    })();
    const persisted = (await window.aloud.ink.get(book.id)).strokes.length - baseFile;
    // Reflow: the stroke must re-project onto its block, not vanish or duplicate.
    const fs0 = store.getState().settings.fontSizePx;
    store.getState().patchSettings({ fontSizePx: fs0 + 2 });
    await wait(1300);
    const afterReflow = paths();
    store.getState().patchSettings({ fontSizePx: fs0 });
    await wait(1300);
    // Eraser wipes it.
    document.querySelector('.ink-toolbar [title="橡皮"]')?.click();
    await wait(150);
    pe('pointerdown', cx + 18, cy + 2);
    pe('pointerup', cx + 18, cy + 2);
    await wait(400);
    const afterErase = paths();
    // Undo removes a fresh stroke.
    document.querySelector('.ink-toolbar [title="笔"]')?.click();
    await wait(150);
    await draw();
    const beforeUndo = paths();
    document.querySelector('.ink-toolbar [title^="撤销"]')?.click();
    await wait(400);
    const afterUndo = paths();
    // Unwind every demo commit (state) then restore the exact pre-probe file.
    for (let i = 0; i < 6; i++) document.querySelector('.ink-toolbar [title^="撤销"]')?.click();
    await wait(1100);
    await window.aloud.ink.save(fileBefore);
    document.querySelector('.ink-toolbar [title="完成"]')?.click();
    await wait(300);
    const capGone = !document.querySelector('.ink-capture');
    return {
      barShown, drawn, persisted, afterReflow: afterReflow - basePaths, afterErase: afterErase - basePaths,
      beforeUndo: beforeUndo - basePaths, afterUndo: afterUndo - basePaths, capGone,
      inkVisible,
      ok: barShown && drawn === 1 && inkVisible && persisted === 1 && afterReflow - basePaths === 1 &&
        afterErase - basePaths === 0 && beforeUndo - basePaths === 1 && afterUndo - basePaths === 0 && capGone,
    };
  })();

  // The full GoodNotes toolset: pen styles, shapes, text boxes, pasted pictures with
  // move/resize, lasso selection, redo. Everything is unwound afterwards by undo.
  out.inkPro = await (async () => {
    document.querySelector('.tool-cluster [title="手写标注"]')?.click();
    await wait(450);
    const cap = document.querySelector('.ink-capture');
    if (!cap) return { ok: false, why: 'no capture layer' };
    const content = document.querySelector('.viewport > div');
    const svg = () => document.querySelector('svg.ink-layer');
    const r = cap.getBoundingClientRect();
    const bx = Math.round(r.left + r.width * 0.3);
    const by = Math.round(r.top + r.height * 0.35);
    const pe = (type, x, y) =>
      cap.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 11, pointerType: 'pen',
        pressure: type === 'pointerup' ? 0 : 0.6, clientX: x, clientY: y, button: 0, buttons: 1,
      }));
    const drag = async (x0, y0, x1, y1) => {
      pe('pointerdown', x0, y0);
      const steps = 6;
      for (let i = 1; i <= steps; i++) {
        pe('pointermove', x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps);
        await wait(14);
      }
      pe('pointerup', x1, y1);
      await wait(220);
    };
    const count = (sel) => (svg() ? svg().querySelectorAll(sel).length : 0);
    const base = {
      fountain: count('.ink-fountain'), pencil: count('.ink-pencil'), shape: count('.ink-shape'),
      text: count('text.ink-text'),
    };
    const fileBefore = await window.aloud.ink.get(book.id);
    const fileTextsBefore = fileBefore.strokes.filter((s) => s.kind === 'text').length;
    let undos = 0;
    // 1. Fountain (default style) then pencil.
    document.querySelector('.ink-toolbar [title="笔"]')?.click();
    await wait(120);
    await drag(bx, by, bx + 90, by + 8);
    undos++;
    const fountainDrawn = count('.ink-fountain') - base.fountain === 1;
    document.querySelector('.ink-toolbar [title="铅笔"]')?.click();
    await wait(120);
    await drag(bx, by + 26, bx + 90, by + 30);
    undos++;
    const pencilEl = svg() ? svg().querySelector('.ink-pencil') : null;
    const pencilDrawn = count('.ink-pencil') - base.pencil === 1 && !!pencilEl && pencilEl.getAttribute('filter') === 'url(#ink-grain)';
    document.querySelector('.ink-toolbar [title="钢笔"]')?.click(); // restore default style
    // 2. Shape: rectangle.
    document.querySelector('.ink-toolbar [title="形状"]')?.click();
    await wait(150);
    document.querySelector('.ink-toolbar [title="矩形"]')?.click();
    await wait(120);
    await drag(bx + 14, by + 54, bx + 120, by + 118);
    undos++;
    const shapeDrawn = count('.ink-shape') - base.shape === 1;
    // 3. Text box.
    document.querySelector('.ink-toolbar [title="文字"]')?.click();
    await wait(150);
    pe('pointerdown', bx + 30, by + 150);
    pe('pointerup', bx + 30, by + 150);
    await wait(350);
    const ta = document.querySelector('.ink-text-editor');
    let textMade = false;
    const detailText = { taShown: !!ta, valAfter: null, openAfter: null };
    if (ta) {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(ta, '手写测试');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(150);
      detailText.valAfter = ta.value;
      // Commit via Ctrl+Enter, not blur() — blur never fires when the window itself
      // has no OS focus (smoke runs while the user works elsewhere).
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
      await wait(1200);
      detailText.openAfter = !!document.querySelector('.ink-text-editor');
      undos++;
      // Judge by the persisted file, not DOM counts — a leftover text box at the same
      // spot once turned this click into an edit-in-place and fooled the DOM delta.
      const fileTextsNow = (await window.aloud.ink.get(book.id)).strokes.filter((s) => s.kind === 'text').length;
      detailText.fileDelta = fileTextsNow - fileTextsBefore;
      textMade = fileTextsNow - fileTextsBefore === 1;
    }
    // (Picture paste/resize/delete runs as a separate probe with a freshly written
    // clipboard — see out.inkPaste — because Deskflow shares the clipboard across
    // machines and minutes-old clipboard content does not survive.)
    // 4. Lasso the rectangle shape, move it, undo, redo. Switch to the select tool
    // explicitly — relying on the paste side effect made this section order-fragile.
    document.querySelector('.ink-toolbar [title="选择"]')?.click();
    await wait(200);
    // Elements are torn down on every repaint — never cache them; re-query and
    // re-measure fresh each time.
    const shapeX = () => {
      const el = svg() ? svg().querySelector('.ink-shape') : null;
      return el ? el.getBBox().x : NaN;
    };
    let hadSel = false;
    let lassoMoved = false;
    let undone = false;
    let redone = false;
    const detail = {};
    if (svg() && svg().querySelector('.ink-shape')) {
      const sb = svg().querySelector('.ink-shape').getBBox();
      const cRect = content.getBoundingClientRect();
      const x0 = cRect.left + sb.x - 16;
      const y0 = cRect.top + sb.y - 16;
      const x1 = cRect.left + sb.x + sb.width + 16;
      const y1 = cRect.top + sb.y + sb.height + 16;
      // Trace the perimeter corner to corner (each leg starts where the last ended).
      const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
      pe('pointerdown', x0, y0);
      for (let ci = 1; ci < corners.length; ci++) {
        const [ax, ay] = corners[ci - 1];
        const [cxx, cyy] = corners[ci];
        for (let i = 1; i <= 4; i++) pe('pointermove', ax + ((cxx - ax) * i) / 4, ay + ((cyy - ay) * i) / 4);
        await wait(12);
      }
      pe('pointerup', x0, y0);
      await wait(350);
      hadSel = !!svg().querySelector('g.ink-selbox');
      const beforeX = shapeX();
      if (hadSel) {
        await drag(cRect.left + sb.x + sb.width / 2, cRect.top + sb.y + sb.height / 2,
          cRect.left + sb.x + sb.width / 2 + 30, cRect.top + sb.y + sb.height / 2 + 16);
        undos++;
        await wait(250);
      }
      const movedX = shapeX();
      lassoMoved = hadSel && movedX - beforeX > 15;
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
      await wait(300);
      const backX = shapeX();
      undone = Math.abs(backX - beforeX) < 4;
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true }));
      await wait(300);
      const fwdX = shapeX();
      redone = fwdX - beforeX > 15;
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
      await wait(200);
      detail.beforeX = Math.round(beforeX);
      detail.movedX = Math.round(movedX);
      detail.backX = Math.round(backX);
      detail.fwdX = Math.round(fwdX);
    }
    // Unwind all demo commits back to the load snapshot (user ink stays intact).
    // A dangling text editor (aborted paste path) would eat every keydown first.
    const dangling = document.querySelector('.ink-text-editor');
    if (dangling) {
      dangling.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await wait(200);
    }
    for (let i = 0; i < undos + 3; i++) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
      await wait(60);
    }
    await wait(1100);
    const clean =
      count('.ink-fountain') === base.fountain && count('.ink-pencil') === base.pencil &&
      count('.ink-shape') === base.shape && count('text.ink-text') === base.text;
    await window.aloud.ink.save(fileBefore);
    document.querySelector('.ink-toolbar [title="完成"]')?.click();
    await wait(250);
    return {
      fountainDrawn, pencilDrawn, shapeDrawn, textMade, hadSel, lassoMoved, undone, redone, clean, detail, detailText,
      ok: fountainDrawn && pencilDrawn && shapeDrawn && textMade &&
        hadSel && lassoMoved && undone && redone && clean,
    };
  })();

  // Toolbar docking: drag the grip to the left edge → vertical rail, persisted.
  // Created notebooks: each sheet must occupy exactly one COLUMN — so N sheets are
  // N pages single-spread and N/2 double — the ruling must be painted, and a sheet
  // must work as an ink anchor. (The column part is measured, not assumed: sheets
  // inside a wrapper element lost their percentage height and six of them collapsed
  // onto one page.)
  out.notebook = await (async () => {
    const WANT = 6;
    const bookId = await store.getState().createNotebook({
      title: '自检笔记本',
      paper: 'lined',
      pages: WANT,
    });
    if (!bookId) return { ok: false, why: 'create failed' };
    const spread0 = store.getState().settings.spread;
    const fs0 = store.getState().settings.fontSizePx;
    try {
      // Wait for the reader to actually be open. The loading skeleton has no
      // bottom bar and no page edges, so a fixed sleep that lands early reads
      // nothing and every assertion fails for the wrong reason.
      // (No backticks in here: this whole block lives inside a template literal.)
      const until = async (fn, ms = 12000) => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          if (fn()) return true;
          await wait(120);
        }
        return false;
      };
      // No regex here: this lives in a template literal, where a backslash-d is
      // eaten and the pattern silently turns into /d+/g. Filter characters instead.
      const nums = (t) => {
        const out = [];
        let cur = '';
        for (const ch of t) {
          if (ch >= '0' && ch <= '9') cur += ch;
          else if (cur) { out.push(Number(cur)); cur = ''; }
        }
        if (cur) out.push(Number(cur));
        return out;
      };
      const paged = () => nums(pagesLabel()).length >= 2;

      store.getState().navigate({ name: 'reader', bookId });
      const opened = await until(() => document.querySelectorAll('.paper-sheet').length > 0 && paged());
      if (!opened) return { ok: false, why: 'reader never finished opening', label: pagesLabel() };

      const measure = async (spread) => {
        store.getState().patchSettings({ spread });
        // The paginator remeasures asynchronously; wait for a page count again.
        await wait(300);
        await until(paged);
        const content = document.querySelector('.viewport > div');
        const cols = content ? Number(getComputedStyle(content).columnCount) || 1 : 1;
        const sheets = document.querySelectorAll('.paper-sheet').length;
        const pages = nums(pagesLabel())[1];
        const box = document.querySelector('.paper-sheet')?.getBoundingClientRect();
        const vp = document.querySelector('.viewport')?.getBoundingClientRect();
        return {
          cols, sheets, pages,
          fills: !!(box && vp && box.height > vp.height * 0.7),
          ok: sheets === WANT && pages === Math.ceil(WANT / cols) && !!box && !!vp && box.height > vp.height * 0.7,
        };
      };
      const double = await measure('double');
      const single = await measure('single');

      const first = document.querySelector('.paper-sheet');
      const ruled = first ? getComputedStyle(first).backgroundImage !== 'none' : false;

      const pageNow = () => nums(pagesLabel())[0];
      const before = pageNow();
      document.querySelector('.page-edge.right')?.click();
      await until(() => pageNow() !== before, 6000);
      const turned = pageNow() === before + 1;

      // Write on a sheet: it must anchor and survive a type-size change.
      document.querySelector('.tool-cluster [title="手写标注"]')?.click();
      await until(() => !!document.querySelector('.ink-capture'), 5000);
      // Pick the pen explicitly. The tool is Reader state that outlives ink mode, and
      // the inkPro probe leaves it on the lasso — a drag then paints a selection box
      // that vanishes on pointerup, so the stroke count never moves and the failure
      // looks like "drawing is broken on notebooks".
      document.querySelector('.ink-toolbar [title="笔"]')?.click();
      await wait(200);
      const cap = document.querySelector('.ink-capture');
      let inked = false;
      let inkHeld = false;
      if (cap) {
        const r = cap.getBoundingClientRect();
        const x0 = Math.round(r.left + r.width * 0.25);
        const y0 = Math.round(r.top + r.height * 0.35);
        const pe = (type, x, y) =>
          cap.dispatchEvent(new PointerEvent(type, {
            bubbles: true, cancelable: true, pointerId: 23, pointerType: 'pen',
            pressure: type === 'pointerup' ? 0 : 0.6, clientX: x, clientY: y, button: 0, buttons: 1,
          }));
        pe('pointerdown', x0, y0);
        for (let i = 1; i <= 8; i++) { pe('pointermove', x0 + i * 12, y0 + i); await wait(14); }
        pe('pointerup', x0 + 96, y0);
        const strokes = () => document.querySelectorAll('svg.ink-layer path').length;
        await until(() => strokes() === 1, 5000);
        inked = strokes() === 1;
        store.getState().patchSettings({ fontSizePx: fs0 + 3 });
        await wait(1500);
        inkHeld = strokes() === 1;
        store.getState().patchSettings({ fontSizePx: fs0 });
        await wait(1200);
        document.querySelector('.ink-toolbar [title="完成"]')?.click();
        await wait(250);
      }

      return {
        double, single, ruled, turned, inked, inkHeld,
        ok: double.ok && single.ok && ruled && turned && inked && inkHeld,
      };
    } finally {
      store.getState().patchSettings({ spread: spread0, fontSizePx: fs0 });
      await store.getState().removeBook(bookId);
      store.getState().navigate({ name: 'reader', bookId: book.id });
      await wait(1800);
    }
  })();

  out.inkDock = await (async () => {
    document.querySelector('.tool-cluster [title="手写标注"]')?.click();
    await wait(400);
    const grip = document.querySelector('.ink-grip');
    if (!grip) return { ok: false, why: 'no grip' };
    const dock0 = store.getState().settings.inkDock || 'top';
    const pe2 = (type, x, y, target) =>
      (target || window).dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 17, pointerType: 'mouse',
        clientX: x, clientY: y, button: 0, buttons: 1,
      }));
    const g = grip.getBoundingClientRect();
    pe2('pointerdown', g.left + 6, g.top + 8, grip);
    for (let i = 1; i <= 5; i++) { pe2('pointermove', g.left - ((g.left - 60) * i) / 5, g.top + i * 30); await wait(16); }
    pe2('pointerup', 60, Math.round(window.innerHeight / 2));
    await wait(400);
    const bar = document.querySelector('.ink-toolbar');
    const docked = !!bar && bar.classList.contains('dock-left');
    const vertical = !!bar && getComputedStyle(bar).flexDirection === 'column';
    const saved = store.getState().settings.inkDock === 'left';
    store.getState().patchSettings({ inkDock: dock0 });
    await wait(300);
    const restored = (store.getState().settings.inkDock || 'top') === dock0;
    document.querySelector('.ink-toolbar [title="完成"]')?.click();
    await wait(250);
    return { docked, vertical, saved, restored, ok: docked && vertical && saved && restored };
  })();

  // Windowed (not maximized) geometry: no glyph may be clipped by the bottom of the
  // stage, and the column box must match the viewport it was measured against.
  out.windowedClip = await (async () => {
    const geom = () => {
      const vp = document.querySelector('.viewport');
      const content = document.querySelector('.viewport > div');
      const stage = document.querySelector('.stage');
      const bottom = document.querySelector('.bottombar');
      const cs = getComputedStyle(vp);
      const vpr = vp.getBoundingClientRect();
      const contentBottom = vpr.bottom - parseFloat(cs.paddingBottom || '0');
      // The lowest text line actually painted on this page.
      const walker = document.createTreeWalker(document.querySelector('.chapter'), NodeFilter.SHOW_TEXT);
      let lowest = null;
      let n;
      while ((n = walker.nextNode())) {
        if (!n.textContent.trim()) continue;
        const r = document.createRange();
        r.selectNodeContents(n);
        for (const rect of r.getClientRects()) {
          if (rect.width < 2 || rect.height < 2) continue;
          if (rect.left > vpr.right || rect.right < vpr.left) continue; // other columns
          if (!lowest || rect.bottom > lowest) lowest = rect.bottom;
        }
      }
      return {
        stageBottom: Math.round(stage.getBoundingClientRect().bottom),
        bottombarTop: Math.round(bottom.getBoundingClientRect().top),
        contentBoxBottom: Math.round(contentBottom),
        columnHeight: content ? Math.round(content.getBoundingClientRect().height) : null,
        viewportContentH: Math.round(vp.clientHeight - parseFloat(cs.paddingTop || '0') - parseFloat(cs.paddingBottom || '0')),
        lowestTextBottom: lowest === null ? null : Math.round(lowest),
        innerH: window.innerHeight,
      };
    };
    const fits = (g) => g.lowestTextBottom !== null && g.lowestTextBottom <= g.contentBoxBottom + 1 && g.columnHeight <= g.viewportContentH + 1;
    const sample = async (label) => {
      // Walk a few pages so pages with images and long paragraphs both get probed.
      const out = [];
      for (let i = 0; i < 5; i++) {
        out.push(geom());
        document.querySelector('.page-edge.right')?.click();
        await wait(450);
      }
      return { label, pages: out, allFit: out.every(fits) };
    };
    const before = geom();
    await window.aloud.smokeResize(1180, 760);
    await wait(1400);
    const double = await sample('windowed-double-1180');
    await window.aloud.smokeResize(1100, 740);
    await wait(1400);
    const single = await sample('windowed-single-1100');
    // The user's display runs at 125% scaling: windowed CSS heights go fractional.
    await window.aloud.smokeResize(1320, 896);
    await wait(600);
    await window.aloud.smokeResize(1.25, 0);
    await wait(1400);
    const scaled = await sample('windowed-zoom-1.25');
    await window.aloud.smokeResize(1, 0);
    await wait(600);
    await window.aloud.smokeResize(0, 0); // restore maximized
    await wait(1400);
    const restored = geom();
    return { before, double, single, scaled, restored, smallFits: double.allFit && single.allFit && scaled.allFit, restoredFits: fits(restored) };
  })();

  // Opening read-aloud must not move the text by a single pixel: the transport lives in
  // the title bar now, in space that was already empty.
  out.raNoShift = await (async () => {
    const chapterTop = () => Math.round(document.querySelector('.chapter').getBoundingClientRect().top);
    const vpBox = () => {
      const r = document.querySelector('.viewport').getBoundingClientRect();
      return Math.round(r.top) + 'x' + Math.round(r.height);
    };
    const before = { top: chapterTop(), vp: vpBox(), pages: pagesLabel() };
    document.querySelector('[title="逐行朗读"]')?.click();
    await wait(900);
    const open = { top: chapterTop(), vp: vpBox(), pages: pagesLabel() };
    const barInHeader = !!document.querySelector('.topbar .ra-bar');
    const bar = document.querySelector('.ra-bar');
    const header = document.querySelector('.reader .topbar');
    const fits = bar && header ? bar.getBoundingClientRect().height <= header.getBoundingClientRect().height : null;
    document.querySelector('.ra-bar [title="关闭朗读"]')?.click();
    await wait(600);
    const after = { top: chapterTop(), vp: vpBox(), pages: pagesLabel() };
    return {
      barInHeader,
      barFitsHeader: fits,
      before,
      open,
      after,
      textNeverMoved: before.top === open.top && open.top === after.top,
      pagesUnchanged: before.pages === open.pages && open.pages === after.pages,
    };
  })();

  // Library grid geometry: does any card's text run into the row below it?
  out.libraryGrid = await (async () => {
    store.getState().navigate({ name: 'library' });
    await wait(900);
    // 现在阅读 can be empty on a fresh profile; measure the shelf that always has the books.
    [...document.querySelectorAll('.side-item')].find((b) => b.textContent.includes('全部图书'))?.click();
    await wait(500);
    // Squeeze the shelf into several rows: row spacing is the thing being measured, and a
    // wide window puts every book on one row where there is no row spacing to check.
    const lib = document.querySelector('.library');
    const restoreWidth = lib.style.maxWidth;
    lib.style.maxWidth = '760px';
    await wait(400);
    const cards = [...document.querySelectorAll('.book-card')];
    const boxes = cards.map((c) => {
      const meta = c.querySelector('.book-meta');
      const title = c.querySelector('.book-meta .title');
      const cover = c.querySelector('.cover-wrap');
      return {
        card: c.getBoundingClientRect(),
        meta: meta.getBoundingClientRect(),
        title: title.getBoundingClientRect(),
        cover: cover.getBoundingClientRect(),
        titleLines: Math.round(title.getBoundingClientRect().height / parseFloat(getComputedStyle(title).lineHeight)),
        clipped: title.scrollHeight > title.clientHeight + 1,
      };
    });
    // Text of one card overlapping the artwork of another is the actual complaint.
    let collisions = 0;
    for (const a of boxes) {
      for (const b of boxes) {
        if (a === b) continue;
        const hit =
          a.meta.left < b.cover.right - 2 &&
          a.meta.right > b.cover.left + 2 &&
          a.meta.top < b.cover.bottom - 2 &&
          a.meta.bottom > b.cover.top + 2;
        if (hit) collisions++;
      }
    }
    // Vertical breathing room between one card's text and the next row's artwork.
    let minRowGap = null;
    for (const a of boxes) {
      for (const b of boxes) {
        if (b.cover.top <= a.meta.bottom) continue;
        if (b.cover.left > a.meta.right || b.cover.right < a.meta.left) continue;
        const gap = b.cover.top - a.meta.bottom;
        if (minRowGap === null || gap < minRowGap) minRowGap = gap;
      }
    }
    lib.style.maxWidth = restoreWidth;
    return {
      cards: cards.length,
      cardWidth: boxes.length ? Math.round(boxes[0].card.width) : 0,
      titleOverflowsCard: boxes.some((b) => b.title.right > b.card.right + 2 || b.title.left < b.card.left - 2),
      overflowDetail: boxes.map((b) => ({
        card: Math.round(b.card.width),
        meta: Math.round(b.meta.width),
        title: Math.round(b.title.width),
        rightSpill: Math.round(b.title.right - b.card.right),
      })),
      coverNarrowerThanCard: boxes.some((b) => b.cover.width < b.card.width - 2),
      coverHeight: boxes.length ? Math.round(boxes[0].cover.height) : 0,
      maxTitleLines: Math.max(0, ...boxes.map((b) => b.titleLines)),
      anyTitleClipped: boxes.some((b) => b.clipped),
      collisions,
      minRowGap: minRowGap === null ? null : Math.round(minRowGap),
    };
  })();

  // Reading position must survive closing the book: go somewhere, leave to the library,
  // come back, and land on the same page.
  out.resume = await (async () => {
    const bookId = book.id;
    const settle = async () => {
      let last = null;
      for (let i = 0; i < 25; i++) {
        const now = pagesLabel();
        if (now && now === last) return now;
        last = now;
        await wait(200);
      }
      return last;
    };
    if (store.getState().route.name !== 'reader') {
      store.getState().navigate({ name: 'reader', bookId });
      await wait(1200);
    }
    await settle();
    document.querySelector('.page-edge.right')?.click();
    await wait(700);
    const afterClick1 = pagesLabel();
    document.querySelector('.page-edge.right')?.click();
    await wait(700);
    const afterClick2 = pagesLabel();
    const label = pagesLabel();
    const chapter = document.querySelector('.reader .topbar .book-title')?.textContent ?? '';
    // Where does the caret sit RIGHT NOW, before leaving? (save-side truth)
    const vpEl = document.querySelector('.viewport');
    const vpr = vpEl.getBoundingClientRect();
    const vcs = getComputedStyle(vpEl);
    const probe = document.caretRangeFromPoint(
      vpr.left + parseFloat(vcs.paddingLeft) + 6,
      vpr.top + parseFloat(vcs.paddingTop) + 6,
    );
    const probeText = probe ? (probe.startContainer.textContent || '').slice(probe.startOffset, probe.startOffset + 12) : null;
    const whereBefore = window.__aloudRaProbe && window.__aloudRaProbe.whereAmI ? window.__aloudRaProbe.whereAmI() : null;
    const turningAtLeave = !!document.querySelector('.pt-flap');
    store.getState().navigate({ name: 'library' });
    await wait(900);
    const saved = await window.aloud.state.get(bookId);
    store.getState().navigate({ name: 'reader', bookId });
    await wait(1200);
    await settle();
    return {
      afterClick1,
      afterClick2,
      whereBefore,
      turningAtLeave,
      probeText,
      savedAnchor: saved.position
        ? saved.position.anchor.chapterId + '#' + saved.position.anchor.blockIndex + '@' + saved.position.anchor.start +
          ' "' + (saved.position.anchor.suffix || saved.position.anchor.exact || '').slice(0, 12) + '"'
        : null,
      before: label,
      after: pagesLabel(),
      chapterBefore: chapter.slice(-14),
      chapterAfter: (document.querySelector('.reader .topbar .book-title')?.textContent ?? '').slice(-14),
      samePage: label === pagesLabel(),
    };
  })();

  // A one-page chapter must still turn by dragging.
  out.singlePageDrag = await (async () => {
    // Short chapters only collapse to a single page at a small type size, so force one
    // rather than hoping the current settings happen to produce it.
    store.getState().patchSettings({ fontSizePx: 13, marginPct: 4 });
    await wait(700);
    let found = null;
    for (let i = 0; i < 70 && found === null; i++) {
      const label = pagesLabel();
      if ((label || '').split(' ').join('').indexOf('第1/1页') >= 0) found = i;
      else {
        document.querySelector('.page-edge.right')?.click();
        await wait(420);
      }
    }
    if (found === null) {
      store.getState().patchSettings({ fontSizePx: 19, marginPct: 12 });
      return { skipped: 'no single-page chapter found', lastLabel: pagesLabel() };
    }
    const before = document.querySelector('.reader .topbar .book-title')?.textContent ?? '';
    const vp = document.querySelector('.viewport');
    const r = vp.getBoundingClientRect();
    vp.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: r.left + r.width * 0.7, clientY: r.top + 220, button: 0, buttons: 1 }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: r.left + r.width * 0.2, clientY: r.top + 240, buttons: 1 }));
    await wait(120);
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: r.left + r.width * 0.2, clientY: r.top + 240 }));
    await wait(900);
    const after = document.querySelector('.reader .topbar .book-title')?.textContent ?? '';
    store.getState().patchSettings({ fontSizePx: 19, marginPct: 12 });
    await wait(500);
    return { atChapter: found, before: before.slice(0, 30), after: after.slice(0, 30), moved: before !== after };
  })();


  // Bookmark button must fill in when the current page is bookmarked.
  {
    const bm = () => document.querySelector('[title$="书签 (Ctrl+B)"]');
    const filled = () => !!bm()?.querySelector('svg[fill="currentColor"]');
    const before = filled();
    bm()?.click();
    await wait(400);
    const after = filled();
    out.bookmarkButton = { before, after, litUp: !before && after, classOn: bm()?.className.includes('on') };
    bm()?.click(); // undo
    await wait(300);
  }

  // No text may bleed into the page margins: overflow must clip at the content box,
  // not the padding box, or neighbouring columns show as slivers down both edges.
  const vpEl = document.querySelector('.viewport');
  const vpr = vpEl.getBoundingClientRect();
  const cs3 = getComputedStyle(vpEl);
  const padL = parseFloat(cs3.paddingLeft);
  const padR = parseFloat(cs3.paddingRight);
  const probeStrip = (fromX, toX) => {
    let hits = 0;
    for (let i = 0; i < 6; i++) {
      const yy = vpr.top + vpr.height * (0.15 + i * 0.13);
      for (let k = 0; k < 5; k++) {
        const xx = fromX + ((toX - fromX) * k) / 4;
        const el = document.elementFromPoint(xx, yy);
        if (el && el.closest('.chapter')) hits++;
      }
    }
    return hits;
  };
  out.marginBleed = {
    padLeft: Math.round(padL),
    leftStripHits: probeStrip(vpr.left + 2, vpr.left + padL - 3),
    rightStripHits: probeStrip(vpr.right - padR + 3, vpr.right - 2),
  };
  out.marginBleed.clean = out.marginBleed.leftStripHits === 0 && out.marginBleed.rightStripHits === 0;

  // Edge arrows: visible only when the cursor is near that side.
  const stage2 = document.querySelector('.stage');
  const sb = stage2.getBoundingClientRect();
  const edgeOpacity = (sel) => parseFloat(getComputedStyle(document.querySelector(sel)).opacity);
  stage2.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 1, clientX: sb.left + sb.width / 2, clientY: y }));
  await wait(260);
  const centerOpacity = edgeOpacity('.page-edge.right');
  stage2.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 1, clientX: sb.right - 30, clientY: y }));
  await wait(260);
  const nearOpacity = edgeOpacity('.page-edge.right');
  out.edgeArrows = { centerOpacity, nearOpacity, ok: centerOpacity < 0.05 && nearOpacity > 0.5 };

  // a short drag must snap back instead of turning
  const beforeShort = pagesLabel();
  send('mousedown', x0);
  await wait(30);
  send('mousemove', x0 - 30);
  await wait(60);
  send('mouseup', x0 - 30);
  await wait(600);
  out.drag.shortDragStaysPut = pagesLabel() === beforeShort;

  store.getState().patchSettings({ fontSizePx: 19 });
  await wait(600);

  // --- annotation round-trip on a real Range
  const longTextNode = () => {
    const walker = document.createTreeWalker(document.querySelector('.chapter'), NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) if (n.data.trim().length > 20) return n;
    return null;
  };
  const target = longTextNode();
  if (target) {
    const range = document.createRange();
    range.setStart(target, 2);
    range.setEnd(target, 12);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    target.parentElement.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await wait(300);
    const swatch = document.querySelector('.selection-menu .swatch');
    out.selectionMenuShown = !!swatch;
    swatch?.click();
    await wait(500);
    out.annotationsAfterHighlight = (await window.aloud.annotations.get(book.id)).annotations.length;
    out.highlightPainted = CSS.highlights.has('anno-yellow');
  }

  // --- English chapter: block rebuild + per-segment language detection
  document.querySelector('[title="目录"]')?.click();
  await wait(300);
  [...document.querySelectorAll('.toc-item')][2]?.click();
  await wait(1600);
  out.ch3 = {
    blocksInDom: document.querySelectorAll('[data-blk]').length,
    firstBlockText: document.querySelector('[data-blk]')?.textContent?.slice(0, 30) ?? null,
  };

  // --- read-aloud: voices, then start from a clicked line
  let voices = [];
  for (let i = 0; i < 20 && !voices.length; i++) {
    voices = speechSynthesis.getVoices();
    if (!voices.length) await wait(250);
  }
  out.voices = voices.map((v) => v.name + ' [' + v.lang + ']' + (v.localService ? ' local' : ''));

  // ALOUD_SMOKE_LOCAL_TTS=<baseUrl> exercises the local-model engine end to end.
  // A base on port 8973 tests the built-in kokoro preset (auto-start included).
  const localBase = window.__aloudSmokeLocalTts;
  if (localBase) {
    const isKokoro = localBase.includes('8973');
    store.getState().patchReadAloud({
      engine: 'local',
      estimateWordTiming: true,
      local: isKokoro
        ? { ...store.getState().settings.readAloud.local, preset: 'kokoro', baseUrl: localBase, voice: 'zf_001' }
        : { ...store.getState().settings.readAloud.local, preset: 'gpt-sovits', baseUrl: localBase, voice: 'ref.wav', refText: '参考' },
    });
    await wait(300);
    out.kokoroStatus = isKokoro ? await window.aloud.tts.kokoroStatus() : null;
    out.localTest = await window.aloud.tts.localTest(store.getState().settings.readAloud.local);
  }

  // ALOUD_SMOKE_VOICE=<wav>|<transcript> exercises the cloning engine end to end.
  const voiceSpec = window.__aloudSmokeVoice;
  if (voiceSpec) {
    const [wavPath, transcript] = voiceSpec.split('|');
    out.voxcpmStatus = await window.aloud.tts.voxcpmStatus();
    const cloneCfg = {
      ...store.getState().settings.readAloud.local,
      preset: 'voxcpm',
      baseUrl: 'http://127.0.0.1:8974',
      voice: 'probe',
      samples: [
        {
          id: 'probe',
          name: 'probe',
          path: wavPath,
          transcript: transcript || '',
          durationSec: 0,
          createdAt: new Date().toISOString(),
        },
      ],
    };
    store.getState().patchReadAloud({ engine: 'local', local: cloneCfg });
    await wait(300);
    out.cloneTest = await window.aloud.tts.localTest(cloneCfg);
  }

  store.getState().patchReadAloud({ rate: 2, linePauseMs: 0 });
  // An earlier probe may have left the TOC / annotations panel open, and then the click
  // that is supposed to start read-aloud lands in the panel instead of on a line.
  for (const close of document.querySelectorAll('.panel [title="关闭 (Esc)"]')) close.click();
  await wait(400);
  document.querySelector('[title="逐行朗读"]')?.click();
  await wait(600);
  out.readAloudBarShown = !!document.querySelector('.ra-bar');
  // Only blocks actually on the current page can be clicked — in a multicolumn layout the
  // rest sit far off to the right.
  const vpBox = document.querySelector('.viewport').getBoundingClientRect();
  const onScreen = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.left >= vpBox.left - 4 && r.right <= vpBox.right + 4 && r.top >= vpBox.top - 4;
  };

  // --- is the gear reachable, and does its popover land inside the window?
  const gear = document.querySelector('.ra-bar [title="朗读设置"]');
  const gearRect = gear ? gear.getBoundingClientRect() : null;
  const topmost = gearRect
    ? document.elementFromPoint(gearRect.left + gearRect.width / 2, gearRect.top + gearRect.height / 2)
    : null;
  gear?.click();
  await wait(350);
  const panel = document.querySelector('.ra-settings');
  const pr = panel ? panel.getBoundingClientRect() : null;
  const stage = document.querySelector('.stage');
  out.gear = {
    exists: !!gear,
    rect: gearRect ? { x: Math.round(gearRect.x), y: Math.round(gearRect.y), w: Math.round(gearRect.width) } : null,
    topmostElementAtGear: topmost ? topmost.className || topmost.tagName : null,
    hitsGear: !!(gear && topmost && (gear === topmost || gear.contains(topmost))),
    panelMounted: !!panel,
    panelRect: pr ? { top: Math.round(pr.top), bottom: Math.round(pr.bottom), h: Math.round(pr.height) } : null,
    panelVisibleInWindow: pr ? pr.top >= 0 && pr.bottom <= window.innerHeight : null,
    stageOverflow: stage ? getComputedStyle(stage).overflow : null,
    windowInner: { w: window.innerWidth, h: window.innerHeight },
  };
  document.querySelector('.ra-bar [title="朗读设置"]')?.click();
  await wait(200);
  // Click where a reader actually would: the middle of the visible page.
  void onScreen;
  const cx = vpBox.left + vpBox.width * 0.25;
  const cy = vpBox.top + vpBox.height * 0.5;
  const under = document.elementFromPoint(cx, cy);
  out.readAloudClickTarget = under ? under.tagName + ': ' + (under.textContent || '').trim().slice(0, 20) : 'nothing';
  if (under) {
    for (const type of ['mousedown', 'mouseup', 'click']) {
      under.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
    }
  }
  await wait(1500);
  out.readAloud = {
    lineHighlightPainted: CSS.highlights.has('ra-line'),
    wordHighlightPainted: CSS.highlights.has('ra-word'),
    activeLine: document.querySelector('.ra-status')?.textContent ?? null,
    dimmed: !!document.querySelector('.chapter.dim'),
    synthSpeaking: speechSynthesis.speaking,
    errorToast: document.querySelector('.toast.error')?.textContent ?? null,
  };

  // Does the loop actually walk line by line? Sample the active line for 24s.
  const seen = [];
  const words = new Set();
  for (let i = 0; i < 48; i++) {
    const now = document.querySelector('.ra-status')?.textContent ?? '';
    if (now && seen[seen.length - 1] !== now) seen.push(now);
    const w = CSS.highlights.get('ra-word');
    if (w) for (const r of w) words.add(String(r).slice(0, 0) + r.toString());
    await wait(500);
  }
  out.lineSequence = seen.map((s) => s.slice(0, 28));
  out.distinctWordRanges = words.size;
  out.errorToastAtEnd = document.querySelector('.toast.error')?.textContent ?? null;

  document.querySelector('.ra-bar [title="关闭朗读"]')?.click();
  speechSynthesis.cancel();
  store.getState().patchReadAloud({ rate: 1, linePauseMs: 120 });
  // app.exit() is a hard kill, so exercise the flush-on-unload path explicitly.
  window.dispatchEvent(new Event('beforeunload'));
  await wait(400);
  out.settingsAfterFlush = await window.aloud.settings.get();

  return out;
})(); } catch (e) { return { scriptError: String(e), stack: e && e.stack, partial: window.__aloudOut }; } })()`;

/**
 * Evaluate one probe file against a real window and quit.
 *
 * The full UI harness samples read-aloud in real time and takes many minutes, which is
 * a poor loop when you are iterating on one behaviour. Same globals, same console
 * capture, one answer.
 */
/** A full run is minutes long (read-aloud is sampled live); this is a hang, not slowness. */
const SUITE_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Race a promise against a deadline.
 *
 * Two runs in a row produced no output at all: a probe wedged, the evaluated script
 * never settled, and the harness waited forever. A suite that can hang silently is
 * worse than one that fails — with this it reports which probe it stopped on.
 */
async function withWatchdog<T>(work: Promise<T>, ms: number): Promise<T | { timedOut: true }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runProbe(win: BrowserWindow, probeFile: string): Promise<void> {
  const emit = emitter();
  const consoleMessages: string[] = [];
  const LEVELS = ['debug', 'info', 'warn', 'error'];
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (message.includes('ScriptProcessorNode is deprecated')) return;
    if (level >= 2) consoleMessages.push(`[${LEVELS[level] ?? level}] ${message} (${source}:${line})`);
  });

  try {
    await new Promise<void>((resolve, reject) => {
      win.webContents.once('did-finish-load', () => resolve());
      win.webContents.once('did-fail-load', (_e, code, desc) => reject(new Error(`${code} ${desc}`)));
      setTimeout(() => reject(new Error('load timeout')), 20_000);
    });
    await new Promise((r) => setTimeout(r, 1200));
    const body = fs.readFileSync(probeFile, 'utf8');
    const wantBook = JSON.stringify(process.env.ALOUD_SMOKE_BOOK ?? '');
    const result = await win.webContents.executeJavaScript(
      `(async () => {
        window.__aloudSmokeBook = ${wantBook} || null;
        const store = window.__aloudStore;
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const wanted = window.__aloudSmokeBook;
        const books = store.getState().library.books;
        const book = (wanted && books.find((b) => b.id.includes(wanted) || b.title.includes(wanted))) || books[0];
        try {
          ${body}
        } catch (err) {
          return { probeError: String(err && err.stack || err) };
        }
      })()`,
      true,
    );
    emit({ ok: !consoleMessages.length && !(result && result.probeError), result, consoleMessages });
    app.exit(0);
  } catch (err) {
    emit({ ok: false, error: err instanceof Error ? `${err.message}
${err.stack}` : String(err), consoleMessages });
    app.exit(1);
  }
}

export async function runUiSmoke(win: BrowserWindow): Promise<void> {
  const emit = emitter();
  const consoleMessages: string[] = [];
  const LEVELS = ['debug', 'info', 'warn', 'error'];

  win.webContents.on('console-message', (_e, level, message, line, source) => {
    // Known, accepted deprecation: both recorders use ScriptProcessorNode on purpose
    // (AudioWorklet needs a served module; the processor API is frozen-stable). The
    // warning is noise, not a defect.
    if (message.includes('ScriptProcessorNode is deprecated')) return;
    if (level >= 2) consoleMessages.push(`[${LEVELS[level] ?? level}] ${message} (${source}:${line})`);
  });
  win.webContents.on('preload-error', (_e, file, error) => {
    consoleMessages.push(`[preload] ${file}: ${error.message}`);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    consoleMessages.push(`[renderer gone] ${details.reason}`);
  });

  try {
    await new Promise<void>((resolve, reject) => {
      win.webContents.once('did-finish-load', () => resolve());
      win.webContents.once('did-fail-load', (_e, code, desc) => reject(new Error(`${code} ${desc}`)));
      setTimeout(() => reject(new Error('load timeout')), 20_000);
    });
    // Give React a beat to hydrate the library before driving it.
    await new Promise((r) => setTimeout(r, 1200));
    const localBase = JSON.stringify(process.env.ALOUD_SMOKE_LOCAL_TTS ?? '');
    const wantBook = JSON.stringify(process.env.ALOUD_SMOKE_BOOK ?? '');
    const wantVoice = JSON.stringify(process.env.ALOUD_SMOKE_VOICE ?? '');
    const raced = await withWatchdog(
      win.webContents.executeJavaScript(
        `window.__aloudSmokeLocalTts = ${localBase} || null; window.__aloudSmokeBook = ${wantBook} || null;` +
          ` window.__aloudSmokeVoice = ${wantVoice} || null; window.__aloudSmokeInstall = ${JSON.stringify(process.env.ALOUD_SMOKE_TTS_FAKE === '1')}; ${DIAGNOSTICS}`,
        true,
      ) as Promise<Record<string, unknown>>,
      SUITE_TIMEOUT_MS,
    );

    if ((raced as { timedOut?: true }).timedOut) {
      // Read back what did finish, so the report names the probe it wedged on.
      const done = (await win.webContents
        .executeJavaScript('Object.keys(window.__aloudOut ?? {})', true)
        .catch(() => [])) as string[];
      emit({
        ok: false,
        error: `probe suite timed out after ${Math.round(SUITE_TIMEOUT_MS / 1000)}s`,
        lastCompletedProbe: done[done.length - 1] ?? '(none)',
        completedProbes: done,
        consoleMessages,
      });
      app.exit(1);
      return;
    }
    const diagnostics = raced as Record<string, unknown>;
    // Picture paste probe with a freshly written clipboard: this machine shares its
    // clipboard over Deskflow, so anything written minutes earlier may be gone by the
    // time the renderer pastes. Write it milliseconds before the Ctrl+V.
    clipboard.writeImage(
      nativeImage.createFromBitmap(Buffer.alloc(64 * 64 * 4, 0x9a), { width: 64, height: 64 }),
    );
    diagnostics.inkPaste = await win.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        document.querySelector('.tool-cluster [title="手写标注"]')?.click();
        await wait(450);
        const svg = () => document.querySelector('svg.ink-layer');
        const content = document.querySelector('.viewport > div');
        const cap = document.querySelector('.ink-capture');
        if (!cap || !content) return { ok: false, why: 'no capture layer' };
        const imgs = () => (svg() ? svg().querySelectorAll('image.ink-image') : []);
        const base = imgs().length;
        const bid = window.__aloudStore.getState().route.bookId;
        const fileBefore = await window.aloud.ink.get(bid);
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true }));
        await wait(1100);
        const imageMade = imgs().length - base === 1;
        const selboxShown = !!(svg() && svg().querySelector('g.ink-selbox'));
        const pe = (type, x, y) =>
          cap.dispatchEvent(new PointerEvent(type, {
            bubbles: true, cancelable: true, pointerId: 13, pointerType: 'mouse',
            pressure: type === 'pointerup' ? 0 : 0.5, clientX: x, clientY: y, button: 0, buttons: 1,
          }));
        let resized = false;
        if (imageMade && selboxShown) {
          const list = imgs();
          const el = list[list.length - 1];
          const w0 = parseFloat(el.getAttribute('width'));
          const box = svg().querySelector('g.ink-selbox rect');
          const cRect = content.getBoundingClientRect();
          const hx = cRect.left + parseFloat(box.getAttribute('x')) + parseFloat(box.getAttribute('width'));
          const hy = cRect.top + parseFloat(box.getAttribute('y')) + parseFloat(box.getAttribute('height'));
          pe('pointerdown', hx, hy);
          for (let i = 1; i <= 6; i++) { pe('pointermove', hx + i * 10, hy + i * 7); await wait(14); }
          pe('pointerup', hx + 60, hy + 42);
          await wait(300);
          const l2 = imgs();
          const w1 = parseFloat(l2[l2.length - 1].getAttribute('width'));
          resized = w1 > w0 * 1.2;
        }
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
        await wait(350);
        const deleted = imgs().length === base;
        await wait(1000); // let the debounced save (with picture GC) run
        await window.aloud.ink.save(fileBefore);
        document.querySelector('.ink-toolbar [title="完成"]')?.click();
        await wait(250);
        return { imageMade, selboxShown, resized, deleted, ok: imageMade && selboxShown && resized && deleted };
      })()`,
      true,
    );
    // Design-review screenshots: chrome states that matter, saved beside the result
    // file. A picture settles style questions that CSS text never can.
    if (process.env.ALOUD_SMOKE_SHOTS) {
      const shotDir = path.dirname(process.env.ALOUD_SMOKE_OUT ?? process.cwd());
      const js = (code: string): Promise<unknown> => win.webContents.executeJavaScript(code, true);
      const shot = async (name: string): Promise<void> => {
        await new Promise((r) => setTimeout(r, 700));
        const image = await win.webContents.capturePage();
        fs.writeFileSync(path.join(shotDir, name), image.toPNG());
      };
      await shot('shot-reader.png');
      // Ink mode with real strokes on the page: pen line + marker swipe.
      await js(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        window.__inkShotBefore = await window.aloud.ink.get(window.__aloudStore.getState().route.bookId);
        document.querySelector('.tool-cluster [title="手写标注"]')?.click();
        await wait(400);
        const cap = document.querySelector('.ink-capture');
        if (!cap) return;
        const r = cap.getBoundingClientRect();
        const pe = (type, x, y) => cap.dispatchEvent(new PointerEvent(type, {
          bubbles: true, cancelable: true, pointerId: 9, pointerType: 'pen',
          pressure: type === 'pointerup' ? 0 : 0.6, clientX: x, clientY: y, button: 0, buttons: 1,
        }));
        const strokeAt = async (yFrac) => {
          const x0 = r.left + r.width * 0.16;
          const y0 = r.top + r.height * yFrac;
          pe('pointerdown', x0, y0);
          for (let i = 1; i <= 10; i++) { pe('pointermove', x0 + i * 14, y0 + Math.sin(i * 0.9) * 4); await wait(16); }
          pe('pointerup', x0 + 140, y0);
          await wait(120);
        };
        await strokeAt(0.32);
        document.querySelector('.ink-toolbar [title="荧光笔"]')?.click();
        await wait(120);
        await strokeAt(0.45);
        // A rectangle and an arrow show the shape tool in the same frame.
        const dragTo = async (x0, y0, x1, y1) => {
          pe('pointerdown', x0, y0);
          for (let i = 1; i <= 6; i++) { pe('pointermove', x0 + ((x1 - x0) * i) / 6, y0 + ((y1 - y0) * i) / 6); await wait(14); }
          pe('pointerup', x1, y1);
          await wait(150);
        };
        document.querySelector('.ink-toolbar [title="形状"]')?.click();
        await wait(150);
        document.querySelector('.ink-toolbar [title="矩形"]')?.click();
        await wait(120);
        await dragTo(r.left + r.width * 0.13, r.top + r.height * 0.52, r.left + r.width * 0.34, r.top + r.height * 0.60);
        document.querySelector('.ink-toolbar [title="箭头"]')?.click();
        await wait(120);
        await dragTo(r.left + r.width * 0.30, r.top + r.height * 0.72, r.left + r.width * 0.22, r.top + r.height * 0.63);
      })()`);
      await shot('shot-ink.png');
      // The same scene with the toolbar docked as a left rail.
      await js(
        `window.__inkDock0 = window.__aloudStore.getState().settings.inkDock || 'top';` +
          ` window.__aloudStore.getState().patchSettings({ inkDock: 'left' })`,
      );
      await shot('shot-ink-dock.png');
      await js(`window.__aloudStore.getState().patchSettings({ inkDock: window.__inkDock0 })`);
      await js(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        // Undo all demo items (state) then restore the exact pre-shot file.
        for (let i = 0; i < 5; i++) document.querySelector('.ink-toolbar [title^="撤销"]')?.click();
        await wait(1100);
        if (window.__inkShotBefore) await window.aloud.ink.save(window.__inkShotBefore);
        document.querySelector('.ink-toolbar [title="完成"]')?.click();
      })()`);
      await js(`document.querySelector('[title="外观"]')?.click()`);
      await shot('shot-appearance.png');
      await js(`document.querySelector('.panel:not(.left) [title="关闭 (Esc)"]')?.click()`);
      await js(`window.__aloudStore.getState().navigate({ name: 'library' })`);
      await shot('shot-library.png');
      await js(`window.__aloudStore.getState().navigate({ name: 'stats' })`);
      await shot('shot-stats.png');
    }
    emit({ ok: !consoleMessages.length, diagnostics, consoleMessages });
    app.exit(consoleMessages.length ? 1 : 0);
  } catch (err) {
    emit({
      ok: false,
      error:
        err instanceof Error
          ? `${err.message}\n${err.stack}`
          : JSON.stringify(err, Object.getOwnPropertyNames(err ?? {})),
      consoleMessages,
    });
    app.exit(1);
  }
}
