import { useEffect, useState } from 'react';
import type { UpdateState } from '@shared/types';
import { IS_ANDROID, IS_WEB, cx } from '../lib/util';

/**
 * The one place an update shows up, on every platform.
 *
 * Quiet by design: nothing appears for a check that found nothing, a download runs as a
 * thin line in the corner, and only a finished download asks for anything — and even
 * then "later" is a real answer (desktop installs on quit anyway). Reading is the job;
 * this must never cover the page.
 */
export default function UpdateBanner(): JSX.Element | null {
  const [state, setState] = useState<UpdateState>({ kind: 'idle' });
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => window.aloud.update?.onState(setState), []);

  // "Already latest" and errors are answers to a question the user asked — show them,
  // then get out of the way.
  useEffect(() => {
    if (state.kind !== 'latest' && state.kind !== 'error') return;
    const timer = setTimeout(() => setState({ kind: 'idle' }), 5000);
    return () => clearTimeout(timer);
  }, [state]);

  const key = `${state.kind}:${'version' in state ? state.version : ''}`;
  if (state.kind === 'idle' || state.kind === 'checking' || dismissed === key) return null;

  const later = (): void => setDismissed(key);
  const apply = (): void => void window.aloud.update?.apply();

  let text: string;
  let actions: JSX.Element | null = null;
  switch (state.kind) {
    case 'available':
      text = `发现新版本 ${state.version}`;
      actions = (
        <>
          <button className="btn primary" onClick={() => void window.aloud.update?.download()}>
            下载更新
          </button>
          <button className="btn" onClick={later}>
            以后
          </button>
        </>
      );
      break;
    case 'downloading':
      text = `正在下载新版本 ${state.version}${state.percent != null ? ` · ${state.percent}%` : '…'}`;
      break;
    case 'ready':
      text = IS_ANDROID
        ? `新版本 ${state.version} 已下载`
        : IS_WEB
          ? `已更新到 ${state.version}`
          : `新版本 ${state.version} 已准备好`;
      actions = (
        <>
          <button className="btn primary" onClick={apply}>
            {IS_ANDROID ? '安装' : IS_WEB ? '刷新' : '重启更新'}
          </button>
          <button className="btn" onClick={later} title={IS_WEB || IS_ANDROID ? undefined : '退出应用时会自动装上'}>
            {IS_WEB || IS_ANDROID ? '以后' : '退出时再装'}
          </button>
        </>
      );
      break;
    case 'manual':
      text = `有新版本 ${state.version}，这个版本需要手动下载`;
      actions = (
        <>
          <button className="btn primary" onClick={apply}>
            去下载
          </button>
          <button className="btn" onClick={later}>
            以后
          </button>
        </>
      );
      break;
    case 'latest':
      text = `已经是最新版本（${state.version}）`;
      break;
    case 'error':
      text = `检查更新失败：${state.message}`;
      break;
  }

  return (
    <div className={cx('update-banner', `update-${state.kind}`)} role="status">
      <span className="update-text">{text}</span>
      {actions ? <span className="update-actions">{actions}</span> : null}
      {state.kind === 'downloading' ? (
        <span className={cx('update-bar', state.percent == null && 'indeterminate')}>
          <span style={{ width: `${state.percent ?? 100}%` }} />
        </span>
      ) : null}
    </div>
  );
}
