// MUST be first: it puts `window.aloud` in place before any renderer module runs.
// See the comment in install.ts — the store touches the API during its own evaluation.
import './install';

import React from 'react';
import { createRoot } from 'react-dom/client';
import App from '../renderer/App';
import A2HSHint from './A2HSHint';
import '../renderer/styles/tokens.css';
import '../renderer/styles/app.css';
import './web.css';
import { BASE } from './assets';

/**
 * Entry point for the browser build (iPad).
 *
 * The renderer is shared verbatim with the desktop app, and it reaches the outside
 * world only through `window.aloud`. Installing the browser implementation of that
 * object before React mounts is the whole trick — nothing downstream knows or cares
 * which host it is running on.
 */

// Registered under the app's own base so the PWA also works from a subdirectory
// (GitHub Pages serves project sites at /<repo>/).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(`${BASE}sw.js`, { scope: BASE });
  });
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
    <A2HSHint />
  </React.StrictMode>,
);
