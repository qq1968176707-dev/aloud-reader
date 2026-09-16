/** Mount point of the whole app — see base.d.ts. */
export const BASE = __BASE__;

/**
 * Same-origin route the service worker serves book images from.
 *
 * Chapter HTML bakes `aloud://book/<id>/<rel>` at import time so that a single parser
 * serves both hosts. A page cannot resolve a custom scheme, so the web host rewrites
 * that prefix to this path and the service worker answers it out of OPFS. Keeping it
 * in its own module lets the service worker import the constant too, instead of the
 * two sides agreeing on a magic string by accident.
 */
export const ASSET_BASE = `${__BASE__}bookasset/`;

/** Same, for pictures dropped onto the handwriting layer (OPFS `ink/<bookId>/<file>`). */
export const INK_BASE = `${__BASE__}inkasset/`;
