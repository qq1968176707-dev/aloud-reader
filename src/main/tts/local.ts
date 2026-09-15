/**
 * Local model TTS backend.
 *
 * The app does not bundle a neural TTS model — a good Chinese voice is 500MB–2GB of
 * weights plus a Python/PyTorch runtime, which has no business inside a reader. Instead
 * this speaks HTTP to a model server the user runs themselves, with presets for the
 * common ones. That is also where the interesting voices live: GPT-SoVITS has a large
 * community of cloned character voices (二次元 included), and CosyVoice takes a plain
 * Chinese sentence as an emotion instruction.
 *
 * The request is made from the main process so the renderer keeps its strict CSP and
 * never needs CORS from a localhost server.
 */
import fs from 'node:fs';
import type { LocalTtsConfig, LocalTtsResult } from '@shared/types';
import { resolveVoicePath } from './voices';

export interface LocalSynthRequest {
  text: string;
  rate: number;
  config: LocalTtsConfig;
}

const trimSlash = (s: string): string => s.replace(/\/+$/, '');

const MIME_BY_SIGNATURE: [number[], string][] = [
  [[0x49, 0x44, 0x33], 'audio/mpeg'], // ID3
  [[0xff, 0xfb], 'audio/mpeg'],
  [[0xff, 0xf3], 'audio/mpeg'],
  [[0xff, 0xf2], 'audio/mpeg'],
  [[0x52, 0x49, 0x46, 0x46], 'audio/wav'], // RIFF
  [[0x4f, 0x67, 0x67, 0x53], 'audio/ogg'], // OggS
  [[0x66, 0x4c, 0x61, 0x43], 'audio/flac'],
];

function sniffMime(buf: Buffer, fallback: string): string {
  for (const [sig, mime] of MIME_BY_SIGNATURE) {
    if (sig.every((b, i) => buf[i] === b)) return mime;
  }
  return fallback;
}

/** `{{text}}` / `{{voice}}` / `{{speed}}` / `{{instruct}}` / `{{model}}` in custom templates. */
function fillTemplate(template: string, req: LocalSynthRequest): string {
  const map: Record<string, string> = {
    text: req.text,
    voice: req.config.voice,
    model: req.config.model,
    instruct: req.config.instruct,
    speed: String(req.rate),
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_m, key: string) =>
    key in map ? JSON.stringify(map[key]).slice(1, -1) : '',
  );
}

interface Built {
  url: string;
  init: RequestInit;
  fallbackMime: string;
}

async function buildRequest(req: LocalSynthRequest): Promise<Built> {
  const { config } = req;
  const base = trimSlash(config.baseUrl);

  switch (config.preset) {
    /* Built-in Kokoro server (tts-server/server.py), auto-started by the app. */
    case 'kokoro':
      return {
        url: `${base}/tts`,
        fallbackMime: 'audio/wav',
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: req.text, voice: config.voice || 'zf_001', speed: req.rate }),
        },
      };

    /* Voice cloning (tts-server/voxcpm_server.py): reference wav + its transcript. */
    case 'voxcpm': {
      const sample = config.samples?.find((s) => s.id === config.voice);
      return {
        url: `${base}/tts`,
        fallbackMime: 'audio/wav',
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: req.text,
            prompt_wav: resolveVoicePath(sample?.path ?? config.refAudio ?? ''),
            prompt_text: sample?.transcript ?? config.refText,
            speed: req.rate,
          }),
        },
      };
    }

    /* OpenAI-compatible: Kokoro-FastAPI, openedai-speech, index-tts-vllm, many wrappers. */
    case 'openai':
      return {
        url: `${base}/v1/audio/speech`,
        fallbackMime: 'audio/mpeg',
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: config.model || 'tts-1',
            input: req.text,
            voice: config.voice || 'alloy',
            speed: req.rate,
            response_format: 'mp3',
          }),
        },
      };

    /* GPT-SoVITS api_v2.py — field names verbatim from the upstream script. */
    case 'gpt-sovits':
      return {
        url: `${base}/tts`,
        fallbackMime: 'audio/wav',
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: req.text,
            text_lang: 'zh',
            ref_audio_path: config.voice,
            prompt_text: config.refText,
            prompt_lang: config.refLang || 'zh',
            speed_factor: req.rate,
            text_split_method: 'cut5',
            media_type: 'wav',
            streaming_mode: false,
            batch_size: 1,
            top_k: 15,
            top_p: 1,
            temperature: 1,
          }),
        },
      };

    /* CosyVoice runtime/python/fastapi/server.py — multipart form fields. */
    case 'cosyvoice': {
      const form = new FormData();
      form.append('tts_text', req.text);
      let path = '/inference_sft';
      if (config.cosyMode === 'sft') {
        form.append('spk_id', config.voice || '中文女');
      } else {
        path = config.cosyMode === 'instruct2' ? '/inference_instruct2' : '/inference_zero_shot';
        if (config.cosyMode === 'instruct2') form.append('instruct_text', config.instruct || '用平静的语气朗读');
        else form.append('prompt_text', config.refText);
        if (!config.refAudio) throw new Error('CosyVoice 的零样本/情感模式需要一段参考音频（refAudio）');
        const wav = await fs.promises.readFile(config.refAudio);
        form.append('prompt_wav', new Blob([wav], { type: 'audio/wav' }), 'prompt.wav');
      }
      return { url: `${base}${path}`, fallbackMime: 'audio/wav', init: { method: 'POST', body: form } };
    }

    case 'custom':
    default: {
      const url = `${base}${config.path.startsWith('/') ? config.path : `/${config.path}`}`;
      if (config.method === 'GET') {
        const query = new URLSearchParams({
          text: req.text,
          voice: config.voice,
          speed: String(req.rate),
        });
        return { url: `${url}?${query}`, fallbackMime: 'audio/wav', init: { method: 'GET' } };
      }
      return {
        url,
        fallbackMime: 'audio/wav',
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...config.headers },
          body: fillTemplate(config.bodyTemplate || '{"text":"{{text}}"}', req),
        },
      };
    }
  }
}

export async function synthesizeLocal(req: LocalSynthRequest): Promise<LocalTtsResult> {
  const started = Date.now();
  const { url, init, fallbackMime } = await buildRequest(req);
  const timeout = Math.max(5, req.config.timeoutSec || 60) * 1000;

  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
  } catch (err) {
    // App-managed servers: not running yet is normal — start and retry once.
    if (req.config.preset === 'kokoro' || req.config.preset === 'voxcpm') {
      const start =
        req.config.preset === 'kokoro'
          ? (await import('./kokoro')).ensureKokoro
          : (await import('./voxcpm')).ensureVoxcpm;
      const started2 = await start();
      if (!started2.ok) throw new Error(started2.message);
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
    } else {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`连不上本地语音服务 ${url}：${reason}`);
    }
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`本地语音服务返回 ${res.status}：${body.slice(0, 300)}`);
  }

  const contentType = res.headers.get('content-type') ?? '';
  const raw = Buffer.from(await res.arrayBuffer());

  // Some servers answer with JSON containing base64 or a URL instead of raw audio.
  if (contentType.includes('application/json')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new Error('本地语音服务返回了无法解析的 JSON');
    }
    const found = findAudio(parsed);
    if (!found) throw new Error(`本地语音服务没有返回音频：${raw.toString('utf8').slice(0, 300)}`);
    if (found.kind === 'url') {
      const audioRes = await fetch(found.value, { signal: AbortSignal.timeout(timeout) });
      if (!audioRes.ok) throw new Error(`取音频失败 ${audioRes.status}`);
      const bytes = Buffer.from(await audioRes.arrayBuffer());
      return { audio: bytes.toString('base64'), mime: sniffMime(bytes, fallbackMime), ms: Date.now() - started };
    }
    const bytes = Buffer.from(found.value, 'base64');
    return { audio: bytes.toString('base64'), mime: sniffMime(bytes, fallbackMime), ms: Date.now() - started };
  }

  if (raw.length < 64) throw new Error('本地语音服务返回的音频为空');
  return {
    audio: raw.toString('base64'),
    mime: sniffMime(raw, contentType.split(';')[0] || fallbackMime),
    ms: Date.now() - started,
  };
}

/** Look for base64 audio or an audio URL anywhere in a JSON response. */
function findAudio(value: unknown, depth = 0): { kind: 'base64' | 'url'; value: string } | null {
  if (depth > 4 || value == null) return null;
  if (typeof value === 'string') {
    if (/^https?:\/\/\S+\.(wav|mp3|ogg|flac)(\?|$)/i.test(value)) return { kind: 'url', value };
    if (value.length > 512 && /^[A-Za-z0-9+/=\s]+$/.test(value.slice(0, 512))) {
      return { kind: 'base64', value: value.replace(/^data:[^,]+,/, '') };
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findAudio(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof value === 'object') {
    // Prefer obviously-named fields before scanning everything.
    for (const key of ['audio', 'data', 'audio_base64', 'audio_url', 'url', 'wav', 'result', 'output']) {
      if (key in (value as Record<string, unknown>)) {
        const hit = findAudio((value as Record<string, unknown>)[key], depth + 1);
        if (hit) return hit;
      }
    }
    for (const item of Object.values(value as Record<string, unknown>)) {
      const hit = findAudio(item, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/** Connection test used by the settings panel. */
export async function testLocal(config: LocalTtsConfig): Promise<{ ok: boolean; message: string }> {
  try {
    const result = await synthesizeLocal({ text: '语音连接测试，一二三。', rate: 1, config });
    const kb = Math.round((result.audio.length * 0.75) / 1024);
    return { ok: true, message: `连接成功：${kb} KB ${result.mime}，用时 ${result.ms} ms` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
