import { defaultSettings as sharedDefaults, defaultStats } from '@shared/defaults';
import type { Settings } from '@shared/types';

export { defaultStats };

/**
 * Desktop defaults, adjusted for what a tablet browser can actually do.
 *
 * The desktop build defaults to the bundled Kokoro model; there is no Python server on
 * an iPad, so the system voice is both the default and the only option. Single-page
 * layout suits a held tablet better than a two-page spread, and the page-turn sound is
 * off because iOS silences it until the first user gesture anyway.
 */
export const defaultSettings = (): Settings => {
  const s = sharedDefaults();
  return {
    ...s,
    spread: 'single',
    pageSound: false,
    readAloud: { ...s.readAloud, engine: 'system' },
  };
};
