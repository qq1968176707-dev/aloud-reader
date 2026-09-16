// MUST be first: it puts `window.aloud` in place before any renderer module runs.
// See the comment in install.ts — the store touches the API during its own evaluation.
import './install';

import React from 'react';
import { createRoot } from 'react-dom/client';
import App from '../renderer/App';
import '../renderer/styles/tokens.css';
import '../renderer/styles/app.css';
import './web.css';

/**
 * Entry point for the browser build (iPad).
 *
 * The renderer is shared verbatim with the desktop app, and it reaches the outside
 * world only through `window.aloud`. Installing the browser implementation of that
 * object before React mounts is the whole trick — nothing downstream knows or cares
 * which host it is running on.
 */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js');
  });
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
