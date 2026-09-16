import { useEffect, useState } from 'react';

/**
 * "Add to Home Screen" nudge, shown once, in Safari, before the app is installed.
 *
 * On iPad the difference between a tab and a home-screen app is not cosmetic: the
 * installed one gets its own storage that iOS is far less eager to evict, runs
 * full-screen, and keeps the reading position between sessions. Safari has no
 * `beforeinstallprompt`, so the only thing possible is to describe the two taps.
 */
const KEY = 'aloud.a2hs.dismissed';

/** iOS/iPadOS Safari, not already installed. iPadOS 13+ reports itself as a Mac. */
function shouldOffer(): boolean {
  try {
    if (localStorage.getItem(KEY)) return false;
  } catch {
    /* private mode — offer anyway, dismissal just will not stick */
  }
  const standalone =
    (navigator as { standalone?: boolean }).standalone === true ||
    matchMedia('(display-mode: standalone)').matches;
  if (standalone) return false;
  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
  const safari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|Chrome/.test(ua);
  return iOS && safari;
}

export default function A2HSHint(): JSX.Element | null {
  const [show, setShow] = useState(false);

  // Not on the first paint: the reader should be on screen before anything asks for
  // attention, and `shouldOffer` reads storage.
  useEffect(() => {
    const timer = setTimeout(() => setShow(shouldOffer()), 2500);
    return () => clearTimeout(timer);
  }, []);

  if (!show) return null;

  const dismiss = (): void => {
    try {
      localStorage.setItem(KEY, '1');
    } catch {
      /* ignore */
    }
    setShow(false);
  };

  return (
    <div className="a2hs-hint" role="note">
      <span>
        装到主屏幕再用：点一下底部的<b> 分享 </b>按钮，选<b>「添加到主屏幕」</b>。
        这样书和进度不会被 Safari 清掉，打开也没有地址栏。
      </span>
      <button className="btn icon" title="知道了" onClick={dismiss} aria-label="知道了">
        ✕
      </button>
    </div>
  );
}
