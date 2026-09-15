import { useEffect, useRef, useState } from 'react';
import type { VoiceSample } from '@shared/types';
import { Icon } from './ui';

/**
 * Records a reference clip for voice cloning.
 *
 * The engine needs two things: a clean 8–20s recording and *exactly* what was said in
 * it. So the prompt sentence is shown on screen and that same string is stored as the
 * transcript — no typing, no mismatch, which is the usual reason cloning sounds wrong.
 *
 * Capture is raw PCM straight off the graph rather than MediaRecorder. MediaRecorder
 * hands back webm/opus, which then has to survive `decodeAudioData` before it is usable
 * — and that call fails opaquely ("Unable to decode audio data") whenever the container
 * is short, empty or muxed with a codec the decoder declines. Since a ScriptProcessor is
 * already the cheapest way to drive the level meter, taking its buffers *is* the
 * recording: no container, no decode step, no failure mode.
 */
const PROMPTS = [
  '我在读一本书，声音平稳一些，像给朋友念一段话。窗外的雨下了一整天，屋子里很安静。',
  '有一种读书的方式，是让声音走在眼睛前面半步。朗读把文字重新变回时间里的东西。',
  '春天的早晨，阳光从树叶的缝隙里落下来，地上是一片摇晃的光斑。',
];

type Phase = 'idle' | 'recording' | 'processing' | 'preview';

/** Float32 mono -> 16-bit PCM WAV, so the preview `<audio>` has something to play. */
function encodeWav(samples: Float32Array, rate: number): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buf);
  const str = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

export default function VoiceRecorder({
  onSaved,
  onClose,
}: {
  onSaved: (sample: VoiceSample) => void;
  onClose: () => void;
}): JSX.Element {
  const [phase, setPhase] = useState<Phase>('idle');
  const [prompt, setPrompt] = useState(PROMPTS[0]);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [preview, setPreview] = useState<{ url: string; samples: Float32Array; rate: number } | null>(null);
  const [name, setName] = useState('我的声音');
  const [saving, setSaving] = useState(false);

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const nodeRef = useRef<ScriptProcessorNode | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);
  const takingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const previewRef = useRef<string | null>(null);

  const teardown = (): void => {
    takingRef.current = false;
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    nodeRef.current?.disconnect();
    nodeRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    const ctx = ctxRef.current;
    ctxRef.current = null;
    if (ctx && ctx.state !== 'closed') void ctx.close();
  };

  useEffect(() => {
    return () => {
      teardown();
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = async (): Promise<void> => {
    setError(null);
    teardown(); // a previous take may still hold the mic
    chunksRef.current = [];
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = stream;

      const ctx = new AudioContext();
      ctxRef.current = ctx;
      if (ctx.state === 'suspended') await ctx.resume();

      const source = ctx.createMediaStreamSource(stream);
      const node = ctx.createScriptProcessor(4096, 1, 1);
      nodeRef.current = node;

      node.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        let peak = 0;
        for (let i = 0; i < input.length; i++) peak = Math.max(peak, Math.abs(input[i]));
        setLevel(peak);
        if (takingRef.current) chunksRef.current.push(new Float32Array(input));
      };

      // A ScriptProcessor only runs while it is routed to the destination, but routing the
      // microphone to the speakers would howl — so it goes through a muted gain node.
      const mute = ctx.createGain();
      mute.gain.value = 0;
      source.connect(node);
      node.connect(mute);
      mute.connect(ctx.destination);

      takingRef.current = true;
      setSeconds(0);
      setPhase('recording');
      timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
    } catch (err) {
      teardown();
      setError(err instanceof Error ? `拿不到麦克风：${err.message}` : String(err));
      setPhase('idle');
    }
  };

  const stop = (): void => {
    setPhase('processing');
    takingRef.current = false;
    const rate = ctxRef.current?.sampleRate ?? 48000;
    const chunks = chunksRef.current;
    teardown();
    setLevel(0);

    const total = chunks.reduce((n, c) => n + c.length, 0);
    if (total < rate * 0.5) {
      setError('没有录到声音：检查麦克风是否被静音或被其他程序占用。');
      setPhase('idle');
      return;
    }
    const mono = new Float32Array(total);
    let at = 0;
    for (const c of chunks) {
      mono.set(c, at);
      at += c.length;
    }
    chunksRef.current = [];

    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    const url = URL.createObjectURL(encodeWav(mono, rate));
    previewRef.current = url;
    setPreview({ url, samples: mono, rate });
    setPhase('preview');
  };

  const save = async (): Promise<void> => {
    if (!preview || saving) return;
    setSaving(true);
    try {
      const saved = await window.aloud.voice.save({
        name,
        transcript: prompt,
        sampleRate: preview.rate,
        samples: Array.from(preview.samples),
      });
      onSaved({
        id: saved.id,
        name,
        path: saved.path,
        transcript: prompt,
        durationSec: saved.durationSec,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const tooShort = seconds < 6;

  return (
    <div className="voice-rec">
      <header>
        <strong>录一段你自己的声音</strong>
        <button className="btn icon" onClick={onClose} title="关闭">
          <Icon name="close" size={16} />
        </button>
      </header>

      <p className="hint">
        照着下面这段话念，语速正常、离麦克风一拳距离、环境安静。念满 8–20 秒效果最好。
      </p>

      <div className="prompt-box">{prompt}</div>
      {phase === 'idle' ? (
        <div className="prompt-switch">
          {PROMPTS.map((p, i) => (
            <button key={i} className={p === prompt ? 'on' : ''} onClick={() => setPrompt(p)}>
              第 {i + 1} 段
            </button>
          ))}
        </div>
      ) : null}

      {phase === 'recording' ? (
        <div className="rec-meter">
          <span className="dot" />
          <span className="secs">{seconds}s</span>
          <span className="bar">
            <i style={{ width: `${Math.min(100, level * 260)}%` }} />
          </span>
        </div>
      ) : null}

      {error ? <p className="rec-error">{error}</p> : null}

      <div className="rec-actions">
        {phase === 'idle' ? (
          <button className="btn primary" onClick={() => void start()}>
            <Icon name="speaker" size={15} /> 开始录音
          </button>
        ) : null}
        {phase === 'recording' ? (
          <button className="btn primary" onClick={stop} disabled={seconds < 3}>
            停止{tooShort ? `（至少 6 秒）` : ''}
          </button>
        ) : null}
        {phase === 'processing' ? <span className="hint">处理中…</span> : null}
        {phase === 'preview' && preview ? (
          <>
            <audio controls src={preview.url} style={{ height: 32 }} />
            <input
              className="control"
              style={{ width: 120 }}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button className="btn" onClick={() => setPhase('idle')}>
              重录
            </button>
            <button className="btn primary" onClick={() => void save()} disabled={saving}>
              {saving ? '保存中…' : '用这个声音'}
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
