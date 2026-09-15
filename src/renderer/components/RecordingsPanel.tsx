import { useEffect, useRef, useState } from 'react';
import type { RecordingMark, RecordingMeta } from '@shared/types';
import { Icon } from './ui';

const fmtDur = (s: number): string => {
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
};

const fmtWhen = (iso: string): string => {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes(),
  ).padStart(2, '0')}`;
};

/**
 * Reading recordings for the open book — GoodNotes' recording list, reader-shaped.
 *
 * The special move is 跟随: while a recording plays, the book follows the position
 * timeline captured during recording, landing on whatever you were reading at that
 * moment of the audio.
 */
export default function RecordingsPanel({
  bookId,
  refreshKey,
  onFollow,
  onDelete,
}: {
  bookId: string;
  /** Bumped by the reader when a new recording finishes, to reload the list. */
  refreshKey: number;
  onFollow: (mark: RecordingMark) => void;
  onDelete?: () => void;
}): JSX.Element {
  const [items, setItems] = useState<RecordingMeta[]>([]);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lastMarkT = useRef(-1);
  const followRef = useRef(follow);
  followRef.current = follow;

  useEffect(() => {
    void window.aloud.recordings.list(bookId).then(setItems);
  }, [bookId, refreshKey]);

  useEffect(
    () => () => {
      audioRef.current?.pause();
      audioRef.current = null;
    },
    [],
  );

  const play = (rec: RecordingMeta): void => {
    if (playingId === rec.id) {
      audioRef.current?.pause();
      audioRef.current = null;
      setPlayingId(null);
      return;
    }
    audioRef.current?.pause();
    const audio = new Audio(`aloud://recording/${bookId}/${rec.id}`);
    audioRef.current = audio;
    lastMarkT.current = -1;
    audio.ontimeupdate = () => {
      if (!followRef.current) return;
      const t = audio.currentTime * 1000;
      // The latest mark at or before the playhead is where the reader was.
      let hit: RecordingMark | null = null;
      for (const m of rec.timeline) {
        if (m.t <= t) hit = m;
        else break;
      }
      if (hit && hit.t !== lastMarkT.current) {
        lastMarkT.current = hit.t;
        onFollow(hit);
      }
    };
    audio.onended = () => setPlayingId(null);
    audio.onerror = () => setPlayingId(null);
    void audio.play();
    setPlayingId(rec.id);
  };

  return (
    <div className="recordings">
      <label className="switch" style={{ padding: '2px 2px 10px' }}>
        <span>回放时页面跟随当时的位置</span>
        <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
      </label>

      {items.length === 0 ? (
        <p className="rec-empty">
          还没有录音。点工具栏的麦克风，边读边把想法说出来；回放时书页会跟着你当时读到的位置走。
        </p>
      ) : (
        items.map((rec) => (
          <div key={rec.id} className="recording-row">
            <button
              className={`btn icon play-toggle${playingId === rec.id ? ' on' : ''}`}
              title={playingId === rec.id ? '停止' : '播放'}
              onClick={() => play(rec)}
            >
              <Icon name={playingId === rec.id ? 'pause' : 'play'} size={15} />
            </button>
            <div className="meta">
              <div className="name">{rec.title || '阅读录音'}</div>
              <div className="sub">
                {fmtWhen(rec.createdAt)} · {fmtDur(rec.durationSec)}
              </div>
            </div>
            <button
              className="btn icon ghost-danger"
              title="删除录音"
              onClick={() => {
                audioRef.current?.pause();
                setPlayingId(null);
                void window.aloud.recordings.remove(bookId, rec.id).then(() => {
                  setItems((xs) => xs.filter((x) => x.id !== rec.id));
                  onDelete?.();
                });
              }}
            >
              <Icon name="trash" size={15} />
            </button>
          </div>
        ))
      )}
    </div>
  );
}
