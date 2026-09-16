/**
 * Build editions. `ALOUD_EDITION=lite` drops the voice-cloning engine (VoxCPM): the
 * preset, its installer and its IPC all disappear, so the lite build never offers
 * something it cannot do. Everything else is identical between the two.
 *
 * The value is inlined by esbuild at build time (see scripts/esbuild.common.mjs) and by
 * Vite for the renderer (`__ALOUD_EDITION__`).
 */
export const EDITION: 'pro' | 'lite' = process.env.ALOUD_EDITION === 'lite' ? 'lite' : 'pro';
export const HAS_CLONE = EDITION === 'pro';
