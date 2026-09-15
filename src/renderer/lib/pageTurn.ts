/**
 * Page-turn animation: the Apple-Books-style curl, driven by the cursor.
 *
 * The sheet bends at a vertical fold line under the pointer. Left of the fold the old
 * page still lies flat; the strip right of it has flipped over. With fold line f the
 * flipped strip is exactly `transform-origin: f` + `scaleX(-1)`: one clip-path plus one
 * transform per layer, all GPU-composited, so the drag never drops frames.
 *
 * The strip carries *two* faces, because a real leaf has two. Before halfway you see its
 * front (the old page, mirrored); past halfway you see its back — the page about to land
 * there, counter-mirrored to read upright. They crossfade around the vertical, and when
 * the fold reaches its end the strip already shows exactly what lies beneath it, so the
 * swap to the real content changes nothing on screen.
 *
 * The crease is strictly VERTICAL, by decision. A tilted, cursor-following crease was
 * built twice and reverted twice at the user's request ("改回原来的，不用动态卷页") —
 * every rigid-mirror treatment of a tilted crease either rotates the strip's content by
 * 2θ or layers ghosted content over the neighbouring page; doing it truly cleanly needs a
 * curved-mesh warp (WebGL), not CSS. Do not reintroduce tilt on this model.
 *
 * All layers are cloned DOM, not screenshots: chapters are full of images, and raster
 * snapshots would miss them or repaint on every frame of a drag.
 */
export type PageAnimation = 'slide' | 'curl' | 'fade' | 'none';

export interface TurnOptions {
  direction: 1 | -1;
  viewport: HTMLElement;
  content: HTMLElement;
  /** paginator stride: one full screen + gap. */
  stride: number;
  fromPage: number;
  toPage: number;
  columns: number;
  gap: number;
  /**
   * The OLD page as a pre-cloned window, for turns where `content` no longer holds it —
   * crossing a chapter replaces the flowed content entirely, so the outgoing page must be
   * captured with snapshotWindow() before the switch and handed in here.
   */
  oldSnapshot?: HTMLElement;
}

interface Metrics {
  padLeft: number;
  padTop: number;
  innerWidth: number;
  innerHeight: number;
  colWidth: number;
}

function measure(viewport: HTMLElement, columns: number, gap: number): Metrics {
  const cs = getComputedStyle(viewport);
  const padLeft = parseFloat(cs.paddingLeft || '0');
  const padRight = parseFloat(cs.paddingRight || '0');
  const padTop = parseFloat(cs.paddingTop || '0');
  const padBottom = parseFloat(cs.paddingBottom || '0');
  const innerWidth = viewport.clientWidth - padLeft - padRight;
  const innerHeight = viewport.clientHeight - padTop - padBottom;
  const colWidth = columns === 2 ? (innerWidth - gap) / 2 : innerWidth;
  return { padLeft, padTop, innerWidth, innerHeight, colWidth };
}

/**
 * Capture the page currently on screen as a self-contained DOM window.
 *
 * Used before a chapter switch: once the new chapter's HTML mounts, the old page cannot
 * be re-cloned from anywhere — this clone is the only copy the turn animation gets.
 */
export function snapshotWindow(
  viewport: HTMLElement,
  content: HTMLElement,
  page: number,
  stride: number,
  columns: number,
  gap: number,
): HTMLElement {
  return cloneWindow(content, Math.max(0, page) * stride, measure(viewport, columns, gap));
}

/** A clipped window onto the flowed content, one column wide, as a live DOM clone. */
function cloneWindow(content: HTMLElement, offsetX: number, m: Metrics): HTMLElement {
  const holder = document.createElement('div');
  holder.className = 'pt-holder';
  holder.style.width = `${m.innerWidth}px`;
  holder.style.height = `${m.innerHeight}px`;
  holder.style.transform = `translate3d(${-offsetX}px, 0, 0)`;
  const clone = content.cloneNode(true) as HTMLElement;
  clone.removeAttribute('id');
  clone.style.transform = 'none';
  clone.style.transition = 'none';
  clone.style.willChange = 'auto';
  holder.appendChild(clone);
  return holder;
}

function easeSettle(
  set: (p: number) => void,
  from: number,
  to: number,
  durationMs: number,
  done: () => void,
): void {
  const start = performance.now();
  const step = (now: number): void => {
    const t = Math.min(1, (now - start) / durationMs);
    const eased = 1 - (1 - t) ** 3;
    set(from + (to - from) * eased);
    if (t < 1) requestAnimationFrame(step);
    else done();
  };
  requestAnimationFrame(step);
}

export interface PageTurner {
  /** 0 = untouched, 1 = fully turned. */
  set(progress: number): void;
  getProgress(): number;
  /** Map a cursor position to a progress value (the paper is pinned to the cursor). */
  progressFromCursor(clientX: number): number;
  /** Release progress above this commits the turn. */
  readonly commitThreshold: number;
  settle(to: 0 | 1, durationMs?: number): Promise<void>;
  destroy(): void;
}

/* ================================================================= fold */

export class PageFold implements PageTurner {
  readonly commitThreshold: number;
  private readonly overlay: HTMLElement;
  private readonly frame: HTMLElement;
  private readonly flat: HTMLElement;
  private readonly flap: HTMLElement;
  private readonly faceFront: HTMLElement;
  private readonly faceBack: HTMLElement;
  private readonly flapShade: HTMLElement;
  private readonly gutter: HTMLElement;
  private readonly m: Metrics;
  private readonly forward: boolean;
  private readonly frameLeftAbs: number;
  /** Fold span: the whole spread in double mode, one column in single mode. */
  private readonly W: number;
  /** Where the fold line stops: the spine (double) or past the edge (single). */
  private readonly fEnd: number;
  private readonly double: boolean;
  private progress = 0;
  private disposed = false;

  constructor(options: TurnOptions) {
    const { viewport, content, direction, stride, fromPage, toPage, columns, gap } = options;
    this.m = measure(viewport, columns, gap);
    this.forward = direction === 1;
    this.double = columns === 2;
    this.W = this.double ? this.m.innerWidth : this.m.colWidth;
    this.fEnd = this.double ? this.W / 2 : this.forward ? 0 : this.W;
    // Single column: the cursor can only fold to the midpoint (progress 0.5); the rest
    // is finished by settle. Double: dragging to the spine completes the fold.
    this.commitThreshold = this.double ? 0.45 : 0.25;

    const fromOffset = Math.max(0, fromPage) * stride;
    const toOffset = Math.max(0, toPage) * stride;
    // The outgoing page: cloned live, unless the caller captured it before a chapter
    // switch — after the switch, `content` only knows the NEW chapter.
    const fromWindow = (): HTMLElement =>
      options.oldSnapshot
        ? (options.oldSnapshot.cloneNode(true) as HTMLElement)
        : cloneWindow(content, fromOffset, this.m);

    this.overlay = document.createElement('div');
    this.overlay.className = 'pt-overlay';
    const frame = document.createElement('div');
    this.frame = frame;
    frame.className = 'pt-frame';
    frame.style.left = `${this.m.padLeft}px`;
    frame.style.top = `${this.m.padTop}px`;
    frame.style.width = `${this.W}px`;
    frame.style.height = `${this.m.innerHeight}px`;

    // The untouched remainder of the OLD spread, so nothing changes before the sweep.
    this.flat = document.createElement('div');
    this.flat.className = 'pt-flat';
    this.flat.appendChild(fromWindow());

    // The flipped strip, with a face on each side of the leaf. Faces are wrappers rather
    // than the clones themselves — the clone's own transform is already carrying its
    // scroll offset.
    this.flap = document.createElement('div');
    this.flap.className = 'pt-flap';
    this.faceFront = document.createElement('div');
    this.faceFront.className = 'pt-face';
    this.faceFront.appendChild(this.forward ? fromWindow() : cloneWindow(content, toOffset, this.m));
    this.faceBack = document.createElement('div');
    this.faceBack.className = 'pt-face pt-face-back';
    this.faceBack.appendChild(this.forward ? cloneWindow(content, toOffset, this.m) : fromWindow());
    this.flapShade = document.createElement('div');
    this.flapShade.className = 'pt-flap-shade';
    this.flap.append(this.faceFront, this.faceBack, this.flapShade);

    this.gutter = document.createElement('div');
    this.gutter.className = 'pt-gutter';

    frame.append(this.gutter, this.flat, this.flap);
    this.overlay.appendChild(frame);
    viewport.appendChild(this.overlay);
    this.frameLeftAbs = viewport.getBoundingClientRect().left + this.m.padLeft;
    this.set(0);
  }

  progressFromCursor(clientX: number): number {
    const W = this.W;
    const x = Math.max(0, Math.min(W, clientX - this.frameLeftAbs));
    if (this.forward) {
      // Grabbed edge rides at the cursor: e = 2f − W ⇒ f = (x + W) / 2.
      const f = (x + W) / 2;
      return (W - f) / (W - this.fEnd);
    }
    // Backward: leading edge of the unfolded part e = 2f ⇒ f = x / 2.
    const f = x / 2;
    return f / this.fEnd;
  }

  set(progress: number): void {
    if (this.disposed) return;
    this.progress = Math.max(0, Math.min(1, progress));
    const W = this.W;
    const f = this.forward
      ? W - this.progress * (W - this.fEnd)
      : this.progress * this.fEnd;

    // A vertical crease at x = f. `inset()` is exact here — every layer is clipped in the
    // same box and the reflection is about the same line, so the seam cannot open up.
    const H = this.m.innerHeight;
    const cy = H / 2;
    const leftOfCrease = `inset(0 ${Math.max(0, W - f)}px 0 0)`;
    const rightOfCrease = `inset(0 0 0 ${Math.max(0, f)}px)`;

    if (this.forward) {
      this.flat.style.clipPath = leftOfCrease;
      this.flap.style.clipPath = rightOfCrease;
      this.gutter.style.clipPath = rightOfCrease;
    } else {
      this.flat.style.clipPath = rightOfCrease;
      this.flap.style.clipPath = leftOfCrease;
      this.gutter.style.clipPath = leftOfCrease;
    }

    // Reflect the strip about the crease.
    this.flap.style.transformOrigin = `${f}px ${cy}px`;
    this.flap.style.transform = 'scaleX(-1)';
    // The back face cancels that reflection about the very same line, landing upright and
    // pixel-aligned with the real content below it.
    this.faceBack.style.transformOrigin = `${f}px ${cy}px`;
    this.faceBack.style.transform = 'scaleX(-1)';

    // Past the vertical, the leaf shows its other side. Crossfade over a short window
    // centred on halfway rather than at the very end, so nothing pops at the landing.
    const flip = Math.max(0, Math.min(1, (this.progress - 0.34) / 0.34));
    this.faceBack.style.opacity = String(flip);
    this.faceFront.style.opacity = String(1 - flip);
    // Paper catches less light as it stands up and more as it lies back down.
    this.flapShade.style.opacity = String(0.1 + 0.34 * Math.sin(Math.PI * this.progress));
    this.gutter.style.opacity = String(0.55 * Math.sin(Math.PI * Math.min(1, this.progress * 1.2)));
  }

  getProgress(): number {
    return this.progress;
  }

  settle(to: 0 | 1, durationMs = 340): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return new Promise((resolve) => {
      easeSettle((p) => this.set(p), this.progress, to, durationMs, () => {
        this.destroy();
        resolve();
      });
    });
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.overlay.remove();
  }
}

export const createTurner = (options: TurnOptions): PageTurner => new PageFold(options);

/* ------------------------------------------------------------- one-shot */

export interface PageTurnOptions extends TurnOptions {
  mode: 'curl' | 'fade';
  durationMs?: number;
}

/** Non-interactive turn (arrow keys, edge buttons). */
export function runPageTurn(options: PageTurnOptions): Promise<void> {
  const { mode, viewport, content, stride, fromPage, columns, gap } = options;
  const m = measure(viewport, columns, gap);
  if (m.innerWidth <= 0 || m.innerHeight <= 0) return Promise.resolve();

  if (mode === 'fade') {
    const overlay = document.createElement('div');
    overlay.className = 'pt-overlay';
    const face = document.createElement('div');
    face.className = 'pt-frame pt-flat';
    face.style.left = `${m.padLeft}px`;
    face.style.top = `${m.padTop}px`;
    face.style.width = `${m.innerWidth}px`;
    face.style.height = `${m.innerHeight}px`;
    face.appendChild(
      options.oldSnapshot
        ? (options.oldSnapshot.cloneNode(true) as HTMLElement)
        : cloneWindow(content, fromPage * stride, m),
    );
    overlay.appendChild(face);
    viewport.appendChild(overlay);
    const animation = face.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: 260,
      easing: 'ease-out',
      fill: 'forwards',
    });
    return animation.finished.catch(() => undefined).then(() => overlay.remove());
  }

  const turner = createTurner(options);
  return turner.settle(1, options.durationMs ?? (options.columns === 2 ? 560 : 480));
}
