import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/tokens.css';
import './styles/app.css';

// macOS: the window keeps its traffic lights over the top-left of the top bar; CSS
// reserves room for them except in full screen, where macOS hides them.
if (window.aloud.platform === 'darwin') {
  const root = document.documentElement;
  root.classList.add('mac');
  window.aloud.onFullscreen((on) => root.classList.toggle('fullscreen', on));
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
