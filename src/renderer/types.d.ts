import type { AloudApi } from '../main/preload';

declare global {
  /** Build edition, inlined by Vite (see vite.config.ts). */
  const __ALOUD_EDITION__: 'pro' | 'lite';

  interface Window {
    aloud: AloudApi;
  }

  /** CSS Custom Highlight API (Chromium 105+). Not yet in lib.dom.d.ts for all TS versions. */
  interface HighlightRegistry extends Map<string, Highlight> {}

  class Highlight {
    constructor(...ranges: AbstractRange[]);
    add(range: AbstractRange): void;
    clear(): void;
    delete(range: AbstractRange): boolean;
    priority: number;
    readonly size: number;
  }

  namespace CSS {
    const highlights: HighlightRegistry;
  }
}

export {};
