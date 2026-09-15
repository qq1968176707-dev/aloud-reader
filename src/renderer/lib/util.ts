export const cx = (...parts: (string | false | null | undefined)[]): string =>
  parts.filter(Boolean).join(' ');

export const uid = (): string =>
  (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

export const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export function debounce<T extends (...args: never[]) => void>(
  fn: T,
  ms: number,
): T & { cancel(): void; flush(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: never[] | null = null;
  const wrapped = ((...args: never[]) => {
    pending = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      pending = null;
      fn(...args);
    }, ms);
  }) as T & { cancel(): void; flush(): void };
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    pending = null;
  };
  /** Run the queued call right now — used when the window is going away. */
  wrapped.flush = () => {
    if (!timer || !pending) return;
    clearTimeout(timer);
    timer = null;
    const args = pending;
    pending = null;
    fn(...args);
  };
  return wrapped;
}

export const todayKey = (d = new Date()): string => d.toLocaleDateString('sv-SE');

export function formatMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 1) return '不到 1 分钟';
  if (minutes < 60) return `${Math.round(minutes)} 分钟`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m} 分钟`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

export function relativeDate(iso?: string): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  if (days < 30) return `${Math.floor(days / 7)} 周前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}

export const bookAssetUrl = (bookId: string, rel?: string): string | undefined =>
  rel ? `aloud://book/${bookId}/${rel.split('/').map(encodeURIComponent).join('/')}` : undefined;

/** Deterministic pastel pair for generated covers. */
export function coverGradient(seed: string): [string, string] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return [`hsl(${h} 46% 62%)`, `hsl(${(h + 38) % 360} 52% 44%)`];
}
