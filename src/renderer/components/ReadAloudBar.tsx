import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  LocalTtsConfig,
  LocalTtsPreset,
  ReadAloudSegment,
  ReadAloudSettings,
  TtsVoice,
} from '@shared/types';
import type { RaStatus } from '../tts/controller';
import { clamp } from '../lib/util';
import { Icon, Segmented, Slider, Switch, useDismiss } from './ui';
import VoiceRecorder from './VoiceRecorder';

interface Props {
  status: RaStatus;
  current: ReadAloudSegment | null;
  settings: ReadAloudSettings;
  patch: (p: Partial<ReadAloudSettings>) => void;
  voices: TtsVoice[];
  wordHighlightLive: boolean;
  onToggle: () => void;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}

/**
 * Kokoro's zh voices are named zf_017 … zm_100, which tells you nothing. These notes come
 * from measuring the median F0 of every voice reading the same sentence — pitch is what
 * separates "少女/可爱" from "成熟/沉稳".
 */
const VOICE_NOTE: Record<string, string> = {
  zf_074: '女 · 少女感最强 320Hz',
  zf_038: '女 · 少女感 316Hz',
  zf_073: '女 · 少女感 312Hz',
  zf_077: '女 · 偏甜 304Hz',
  zf_092: '女 · 偏甜 304Hz',
  zf_072: '女 · 偏甜 300Hz',
  zf_017: '女 · 清亮 296Hz',
  zf_001: '女 · 标准',
  zf_079: '女 · 最沉稳 145Hz',
  zf_046: '女 · 沉稳 176Hz',
  zf_019: '女 · 沉稳 190Hz',
};

const VOICE_GROUPS: { key: string; label: string; match: (v: TtsVoice) => boolean }[] = [
  { key: 'zh', label: '中文语音', match: (v) => v.lang.toLowerCase().startsWith('zh') },
  { key: 'en', label: '英文语音', match: (v) => v.lang.toLowerCase().startsWith('en') },
];

export default function ReadAloudBar({
  status,
  current,
  settings,
  patch,
  voices,
  wordHighlightLive,
  onToggle,
  onPrev,
  onNext,
  onClose,
}: Props): JSX.Element {
  const [open, setOpen] = useState(false);
  const popover = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const gearRef = useRef<HTMLButtonElement>(null);
  useDismiss(popover, () => setOpen(false), open);

  // Anchored to the gear in viewport coordinates, flipped below it when there is no room
  // above, and always clamped inside the window.
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({});
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = gearRef.current?.getBoundingClientRect();
    if (!anchor) return;
    const width = 290;
    const height = Math.min(540, window.innerHeight - 24);
    const left = Math.min(Math.max(12, anchor.right - width), window.innerWidth - width - 12);
    const above = anchor.top - 12 - height;
    const top = above >= 12 ? above : Math.min(anchor.bottom + 12, window.innerHeight - height - 12);
    setPanelStyle({ position: 'fixed', left, top, width, maxHeight: height, overflowY: 'auto' });
  }, [open]);

  // Keep a stable label while the engine is warming up.
  const [label, setLabel] = useState('');
  useEffect(() => {
    if (current) setLabel(current.text.trim().replace(/\s+/g, ' ').slice(0, 42));
    else if (status === 'idle') setLabel('');
  }, [current, status]);

  const rate = settings.rate;
  const bump = (delta: number): void => patch({ rate: Number(clamp(rate + delta, 0.5, 2).toFixed(2)) });

  // NOTE: no `position: relative` here. .ra-bar is absolutely positioned by the
  // stylesheet, and overriding that put the whole bar back in normal flow — it dragged
  // its settings popover off-screen with it. The popover is portalled to <body> and
  // positioned in viewport coordinates for the same reason.
  return (
    <div className="ra-bar" ref={barRef}>
      <button className="play" onClick={onToggle} title="播放 / 暂停 (Space)">
        <Icon name={status === 'playing' ? 'pause' : 'play'} size={19} />
      </button>
      <button className="btn icon" onClick={onPrev} title="上一行 (Ctrl+↑)">
        <Icon name="prevLine" size={17} />
      </button>
      <button className="btn icon" onClick={onNext} title="下一行 (Ctrl+↓)">
        <Icon name="nextLine" size={17} />
      </button>

      <span className="divider" />

      <button className="btn icon" onClick={() => bump(-0.1)} title="减速">
        −
      </button>
      <span className="rate">{rate.toFixed(1)}×</span>
      <button className="btn icon" onClick={() => bump(0.1)} title="加速">
        +
      </button>

      <span className="divider" />

      <span className="ra-status">
        {status === 'loading' ? '准备中…' : label || '点任意一行开始朗读'}
      </span>

      <button
        className="btn icon"
        ref={gearRef}
        onClick={() => setOpen((v) => !v)}
        title="朗读设置"
      >
        <Icon name="gear" size={17} />
      </button>
      <button className="btn icon" onClick={onClose} title="关闭朗读">
        <Icon name="close" size={16} />
      </button>

      {/* Rendered into <body>: .stage clips its children, and this panel is taller than
          the space above the bar on short windows. */}
      {open
        ? createPortal(
        <div className="ra-settings" ref={popover} style={panelStyle}>
          <div className="field">
            <label>
              <span>语音引擎</span>
            </label>
            <Segmented
              value={settings.engine}
              options={[
                { value: 'system', label: '系统离线' },
                { value: 'local', label: '本地模型' },
                { value: 'edge', label: 'Edge' },
              ]}
              onChange={(engine) => patch({ engine })}
            />
          </div>

          {settings.engine === 'local' ? (
            <LocalSettings config={settings.local} patch={(local) => patch({ local: { ...settings.local, ...local } })} />
          ) : null}

          {settings.engine !== 'local' &&
            VOICE_GROUPS.map((group) => {
            const list = voices.filter(group.match);
            return (
              <div className="field" key={group.key}>
                <label>
                  <span>{group.label}</span>
                  <span>{list.length ? '' : '（未安装）'}</span>
                </label>
                <select
                  className="control"
                  value={settings.voiceByLang[group.key] ?? ''}
                  onChange={(e) =>
                    patch({ voiceByLang: { ...settings.voiceByLang, [group.key]: e.target.value } })
                  }
                >
                  <option value="">自动选择</option>
                  {list.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name} · {v.lang}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}

          <Slider
            label="语速"
            value={settings.rate}
            min={0.5}
            max={2}
            step={0.05}
            format={(v) => `${v.toFixed(2)}×`}
            onChange={(r) => patch({ rate: r })}
          />
          <Slider
            label="每行停顿"
            value={settings.linePauseMs}
            min={0}
            max={1500}
            step={20}
            format={(v) => `${v} ms`}
            onChange={(linePauseMs) => patch({ linePauseMs })}
          />

          <Switch
            label="逐词高亮"
            checked={settings.highlightWords}
            onChange={(highlightWords) => patch({ highlightWords })}
          />
          {settings.engine === 'local' ? (
            <Switch
              label="按时长估算词位置"
              checked={settings.estimateWordTiming}
              onChange={(estimateWordTiming) => patch({ estimateWordTiming })}
            />
          ) : null}
          <Switch
            label="自动滚动跟随"
            checked={settings.autoScroll}
            onChange={(autoScroll) => patch({ autoScroll })}
          />
          <Switch
            label="读完本章即停止"
            checked={settings.stopAtChapterEnd}
            onChange={(stopAtChapterEnd) => patch({ stopAtChapterEnd })}
          />

          <p className="ra-hint">
            {settings.engine === 'system'
              ? '系统语音完全离线，用的是 Windows SAPI5 语音库；音色机械，但零配置、断网可用。'
              : settings.engine === 'local'
                ? '接你本机跑的模型服务（GPT-SoVITS / CosyVoice / 任何 OpenAI 兼容接口），音色和情感都由那边决定。'
                : '⚠️ 微软已关闭这个免费接口，实测握手返回 403，基本不能用了。建议改用「本地模型」。'}
            {settings.highlightWords && !wordHighlightLive
              ? ' 当前语音不上报词边界，已降级为整行高亮。'
              : ''}
          </p>
        </div>,
        document.body,
      )
        : null}
    </div>
  );
}

/* --------------------------------------------------- local model config */

const PRESETS: { value: LocalTtsPreset; label: string; hint: string; baseUrl: string }[] = [
  { value: 'kokoro', label: '内置神经语音（推荐）', hint: 'Kokoro-82M 中文模型，随应用管理、自动启动，完全离线', baseUrl: 'http://127.0.0.1:8973' },
  { value: 'voxcpm', label: '我的声音（克隆）', hint: 'VoxCPM 零样本克隆：录一段自己的声音，整本书都用它来读', baseUrl: 'http://127.0.0.1:8974' },
  { value: 'gpt-sovits', label: 'GPT-SoVITS', hint: '角色音色克隆最强，二次元音色包最多（api_v2.py，默认 9880）', baseUrl: 'http://127.0.0.1:9880' },
  { value: 'cosyvoice', label: 'CosyVoice', hint: '情感控制最好，可以用一句中文描述语气（FastAPI runtime，默认 50000）', baseUrl: 'http://127.0.0.1:50000' },
  { value: 'openai', label: 'OpenAI 兼容', hint: '任何提供 /v1/audio/speech 的服务：IndexTTS-vLLM、Kokoro-FastAPI、openedai-speech…', baseUrl: 'http://127.0.0.1:8000' },
  { value: 'custom', label: '自定义', hint: '自己填地址和 JSON 模板，占位符：{{text}} {{voice}} {{speed}} {{instruct}}', baseUrl: 'http://127.0.0.1:8080' },
];

function LocalSettings({
  config,
  patch,
}: {
  config: LocalTtsConfig;
  patch: (p: Partial<LocalTtsConfig>) => void;
}): JSX.Element {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [kokoro, setKokoro] = useState<{ installed: boolean; running: boolean; ready: boolean; voices: string[] } | null>(
    null,
  );
  const [voxcpm, setVoxcpm] = useState<{ installed: boolean; running: boolean; ready: boolean; device: string } | null>(
    null,
  );
  const [recording, setRecording] = useState(false);
  const [auditioning, setAuditioning] = useState(false);
  const preset = PRESETS.find((p) => p.value === config.preset) ?? PRESETS[0];

  /** Speak one line with a candidate voice, without disturbing the reading position. */
  const audition = async (voice: string): Promise<void> => {
    setAuditioning(true);
    try {
      const result = await window.aloud.tts.localSynth({
        text: '今天天气真好呀，我们一起去看看那本新书吧。',
        rate: 1,
        config: { ...config, voice },
      });
      const bytes = Uint8Array.from(atob(result.audio), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: result.mime }));
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      await audio.play();
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setAuditioning(false);
    }
  };

  useEffect(() => {
    if (config.preset !== 'kokoro' && config.preset !== 'voxcpm') return;
    let alive = true;
    const poll = (): void => {
      if (config.preset === 'kokoro') {
        void window.aloud.tts.kokoroStatus().then((s) => alive && setKokoro(s));
      } else {
        void window.aloud.tts.voxcpmStatus().then((s) => alive && setVoxcpm(s));
      }
    };
    poll();
    const timer = setInterval(poll, 4000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [config.preset]);

  const field = (label: string, key: keyof LocalTtsConfig, placeholder = ''): JSX.Element => (
    <div className="field">
      <label>
        <span>{label}</span>
      </label>
      <input
        className="control"
        value={String(config[key] ?? '')}
        placeholder={placeholder}
        onChange={(e) => patch({ [key]: e.target.value } as Partial<LocalTtsConfig>)}
      />
    </div>
  );

  return (
    <>
      <div className="field">
        <label>
          <span>服务类型</span>
        </label>
        <select
          className="control"
          value={config.preset}
          onChange={(e) => {
            const next = PRESETS.find((p) => p.value === e.target.value)!;
            patch({ preset: next.value, baseUrl: next.baseUrl });
          }}
        >
          {PRESETS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
        <p className="ra-hint" style={{ marginTop: 4 }}>
          {preset.hint}
        </p>
      </div>

      {config.preset !== 'kokoro' && config.preset !== 'voxcpm'
        ? field('服务地址', 'baseUrl', 'http://127.0.0.1:9880')
        : null}

      {config.preset === 'kokoro' ? (
        <>
          <div className="field">
            <label>
              <span>音色</span>
              <span>
                {kokoro == null
                  ? '…'
                  : !kokoro.installed
                    ? '未安装'
                    : kokoro.ready
                      ? '✓ 运行中'
                      : kokoro.running
                        ? '模型加载中…'
                        : '未启动（点播放会自动启动）'}
              </span>
            </label>
            <div style={{ display: 'flex', gap: 6 }}>
              <select
                className="control"
                style={{ flex: 1, minWidth: 0 }}
                value={config.voice || 'zf_001'}
                onChange={(e) => patch({ voice: e.target.value })}
              >
                {(kokoro?.voices.length ? kokoro.voices : ['zf_001']).map((v) => (
                  <option key={v} value={v}>
                    {v}
                    {VOICE_NOTE[v] ? ` · ${VOICE_NOTE[v]}` : v.startsWith('zf') ? ' · 女' : v.startsWith('zm') ? ' · 男' : ''}
                  </option>
                ))}
              </select>
              <button
                className="btn"
                disabled={auditioning}
                onClick={() => void audition(config.voice || 'zf_001')}
                title="用这个音色念一句"
              >
                {auditioning ? '…' : '试听'}
              </button>
            </div>
            <p className="ra-hint" style={{ marginTop: 4 }}>
              想要偏少女/可爱的音色，试 zf_074、zf_038、zf_073（音高最高）；想沉稳一些试 zf_079、zf_046。
            </p>
          </div>
          {kokoro && !kokoro.installed ? (
            <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
              <button className="btn primary" onClick={() => void window.aloud.tts.kokoroInstall()}>
                一键安装（约 1GB，需联网）
              </button>
            </div>
          ) : null}
        </>
      ) : null}

      {config.preset === 'voxcpm' ? (
        <>
          <div className="field">
            <label>
              <span>我的声音</span>
              <span>
                {voxcpm == null
                  ? '…'
                  : !voxcpm.installed
                    ? '引擎未安装'
                    : voxcpm.ready
                      ? `✓ ${voxcpm.device}`
                      : voxcpm.running
                        ? '加载中…'
                        : '未启动'}
              </span>
            </label>
            {config.samples?.length ? (
              <select className="control" value={config.voice} onChange={(e) => patch({ voice: e.target.value })}>
                {config.samples.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {Math.round(s.durationSec)}s
                  </option>
                ))}
              </select>
            ) : (
              <p className="ra-hint" style={{ margin: 0 }}>
                还没有录音。点下面的按钮录一段，之后整本书都会用你的声音读。
              </p>
            )}
          </div>

          <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
            <button className="btn primary" onClick={() => setRecording(true)}>
              <Icon name="speaker" size={15} /> 录制我的声音
            </button>
            {config.samples?.length ? (
              <button
                className="btn ghost-danger"
                onClick={() => {
                  const rest = config.samples.filter((s) => s.id !== config.voice);
                  const gone = config.samples.find((s) => s.id === config.voice);
                  if (gone) void window.aloud.voice.remove(gone.path);
                  patch({ samples: rest, voice: rest[0]?.id ?? '' });
                }}
              >
                删除这个
              </button>
            ) : null}
            {voxcpm && !voxcpm.installed ? (
              <button className="btn" onClick={() => void window.aloud.tts.voxcpmInstall()}>
                安装克隆引擎（约 5GB）
              </button>
            ) : null}
          </div>

          {recording ? (
            <VoiceRecorder
              onClose={() => setRecording(false)}
              onSaved={(sample) => {
                patch({ samples: [...(config.samples ?? []), sample], voice: sample.id });
                setRecording(false);
              }}
            />
          ) : null}
        </>
      ) : null}

      {config.preset === 'gpt-sovits' ? (
        <>
          {field('参考音频路径', 'voice', 'D:\\voices\\角色.wav')}
          {field('参考音频的文字', 'refText', '参考音频里说的那句话')}
        </>
      ) : null}

      {config.preset === 'cosyvoice' ? (
        <>
          <div className="field">
            <label>
              <span>模式</span>
            </label>
            <Segmented
              value={config.cosyMode}
              options={[
                { value: 'sft', label: '内置音色' },
                { value: 'instruct2', label: '情感指令' },
                { value: 'zero_shot', label: '克隆' },
              ]}
              onChange={(cosyMode) => patch({ cosyMode })}
            />
          </div>
          {config.cosyMode === 'sft'
            ? field('内置音色', 'voice', '中文女 / 中文男 / 粤语女 …')
            : field('参考音频路径', 'refAudio', 'D:\\voices\\角色.wav')}
          {config.cosyMode === 'instruct2' ? field('情感指令', 'instruct', '用兴奋的语气朗读') : null}
          {config.cosyMode === 'zero_shot' ? field('参考音频的文字', 'refText', '') : null}
        </>
      ) : null}

      {config.preset === 'openai' ? (
        <>
          {field('模型', 'model', 'tts-1 / index-tts / kokoro')}
          {field('音色名', 'voice', 'alloy / zf_xiaobei …')}
        </>
      ) : null}

      {config.preset === 'custom' ? (
        <>
          <div className="field">
            <label>
              <span>请求方式 / 路径</span>
            </label>
            <div style={{ display: 'flex', gap: 6 }}>
              <select
                className="control"
                style={{ flex: '0 0 84px' }}
                value={config.method}
                onChange={(e) => patch({ method: e.target.value as 'POST' | 'GET' })}
              >
                <option>POST</option>
                <option>GET</option>
              </select>
              <input className="control" style={{ flex: 1 }} value={config.path} onChange={(e) => patch({ path: e.target.value })} />
            </div>
          </div>
          {config.method === 'POST' ? (
            <div className="field">
              <label>
                <span>请求体模板 (JSON)</span>
              </label>
              <textarea
                className="control"
                style={{ height: 96, resize: 'vertical', padding: 8, fontFamily: 'Consolas, monospace', fontSize: 11.5 }}
                value={config.bodyTemplate}
                onChange={(e) => patch({ bodyTemplate: e.target.value })}
              />
            </div>
          ) : null}
          {field('音色', 'voice')}
        </>
      ) : null}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
        <button
          className="btn primary"
          disabled={testing}
          onClick={() => {
            setTesting(true);
            setResult(null);
            void window.aloud.tts
              .localTest(config)
              .then(setResult)
              .catch((err: unknown) => setResult({ ok: false, message: String(err) }))
              .finally(() => setTesting(false));
          }}
        >
          {testing ? '测试中…' : '测试连接'}
        </button>
        {result ? (
          <span style={{ fontSize: 11.5, color: result.ok ? 'var(--app-fg-muted)' : '#d23c28', lineHeight: 1.4 }}>
            {result.message.slice(0, 120)}
          </span>
        ) : null}
      </div>
    </>
  );
}
