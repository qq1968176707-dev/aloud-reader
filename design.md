# Design — 逐读 Aloud Reader

A locked design system for this app. Every visual change reads this file before
emitting code. Do not regenerate per surface — extend or amend this file when the
system needs to grow.

The system is **Apple Books grammar**: the book is the hero; chrome is quiet,
translucent material that defers. One accent, hairline separators, soft double
shadows, one motion-curve family. Nothing decorative.

## Genre

modern-minimal (Apple desktop-app school — not a marketing site; every surface is
an app surface).

## Surfaces

- **Library (书架)** — cover grid with shelf heading; sidebar of shelves and
  collections. Covers are the imagery; no other decoration is allowed.
- **Reader (阅读)** — content-first. Chrome dims to a whisper after 3.5 s idle
  (`.chrome-idle`). Panels dock left (contents) and right (everything else).
  Ink mode (手写) floats one material pill (`.ink-toolbar`) holding
  the whole GoodNotes toolset: select/lasso, pen (ball/fountain/pencil styles as
  12px text chips, never micro caps), marker, eraser, shapes, text, picture.
  The middle section is contextual (styles for pen, kinds for shape); pen
  colors are saturated tokens (`--pen-*`), marker reuses the highlight fills
  (`--hl-*`) with multiply/screen blend so text stays legible over ink.
  Selection is an accent dashed box drawn inside the SVG layer itself.
  The pill docks top-center by default and drags by its grip to either side,
  becoming a vertical rail (`.dock-left`/`.dock-right`, persisted in
  `settings.inkDock`) — a top pill covers the first lines of the page.
- **Stats (统计)** — two-column cards, real data only. Never invent a metric.

## Theme

Defined in `src/renderer/styles/tokens.css` — the single source of truth.
Chrome palette is light/dark (`data-app-dark`); the reading surface has four
user themes (white / sepia / gray / night) that only recolour the page, never
the chrome.

- Accent: Apple system orange — `#d97e00` light · `#ff9f0a` dark. ≤ 5 % of any
  viewport. Never a second accent hue.
- **Accent has two grades** (WCAG-measured 2026-08-08): `--accent` for FILLS and
  large glyphs; `--accent-text` for accent-coloured TEXT (`#9a5a00` light — 5.47:1
  on white, 4.64:1 on the sidebar; `#ff9f0a` dark — 7.71:1). Raw `--accent` as a
  text colour in light mode measures 3.03:1 and is a defect.
- `--accent-fg` is dark ink (`#241503`) in BOTH modes: white-on-orange measured
  3.03:1, ink-on-orange 5.86:1 light / 8.63:1 dark.
- Faint (`--app-fg-faint`) is for decorative metadata only (counts, ticks).
  Information-bearing copy uses muted or stronger. One `·` separator per line,
  maximum; prefer Chinese comma for prose lists.
- Danger: `--danger` (`#c93a26` light · `#ff6b52` dark). The only other
  chromatic voice, reserved for destructive actions and errors.
- Hairlines: `--app-line` at ~9 % ink. Never opaque grey borders.
- Materials: floating chrome (menus, popovers, toasts, panels, selection menu,
  dictionary card, note editor) uses `--app-material` + `--material-blur`.
  Opaque floating surfaces are a defect.

## Typography

- UI: `--font-ui` (Segoe UI Variable Text → PingFang SC → Microsoft YaHei UI).
- Display: `--font-display` (Segoe UI Variable Display first) — shelf headings,
  stat values, empty-state titles.
- Reading column: user-selected via `[data-font]` stacks; never the UI font
  unless the user picks it.
- **Type floor: 12 px.** Nothing below it, ever (user rule: 设计禁小字).
  Letter-spacing on Chinese text ≤ 0.08 em; no wide-tracked uppercase labels;
  no italic headers.

## Spacing

4-pt rhythm. Radii: `--radius-sm 6 · --radius 10 · --radius-lg 16 ·
--radius-pop 13` (floating layer). Book covers are the exception: 4 px —
covers are boards, not app icons.

## Motion

- Curves: `--ease` (Apple sheet), `--ease-out` (micro), `--spring` (~4 %
  overshoot, controls), `--spring-sheet` (no overshoot, panels). All sampled
  physical springs via `linear()` — never browser `ease`, never hand-drawn
  bounce.
- Route changes crossfade via the View Transitions API (200 ms).
- Page turns: the curl model in `src/renderer/lib/pageTurn.ts`. Crease is
  vertical BY DECISION (tilt was built twice, rejected twice — do not
  reintroduce without WebGL).
- `prefers-reduced-motion: reduce` collapses everything.

## Microinteractions stance

- Silent success; toasts only for outcomes the user cannot see.
- Press feedback: icon buttons scale 0.92, primary 0.97, knobs stretch.
- Focus: `:focus-visible` ring, accent at 65 %, never animated in.
- Chrome-idle is sacred: never dim controls that are in use (panels open,
  read-aloud active, selection visible → pinned).

## CTA voice

- Primary: accent fill, 9 px radius, verb-first Chinese label (导入图书).
- Everything else: quiet icon buttons; toggles show state via accent-soft fill.
- Native `window.confirm` is legacy — replace with in-app dialogs when touched.

## What every surface MUST share

- The accent and its ≤ 5 % budget; the danger token for destruction only.
- Material language for anything floating.
- Spring curves for anything that moves.
- The 12 px type floor and tabular numerals for page/stat figures.

## What surfaces MAY differ on

- The reading surface's four user themes.
- Library cover art (books look like books, not cards).
- Stats layout density.

## Provenance

Locked 2026-08-05 by a `hallmark redesign` pass over an existing hand-built
system. The system predates Hallmark; this file codifies it so future passes
extend instead of replace.
