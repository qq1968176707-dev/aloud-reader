/**
 * Optional online TTS backend: Microsoft Edge "read aloud" neural voices.
 *
 * Why it exists: the offline Windows SAPI5 Chinese voice (Huihui) is intelligible but
 * flat, and the good Windows 11 natural voices (Xiaoxiao / Yunxi) are only exposed to
 * WinRT, not to SAPI5 — so Chromium's speechSynthesis cannot see them. This backend is
 * the pragmatic way to get high-quality zh-CN audio, and it also reports precise word
 * boundaries, which makes karaoke highlighting better than SAPI's.
 *
 * Caveats, stated plainly: this is an undocumented endpoint used by the Edge browser's
 * read-aloud feature. It needs network access, it is off by default, and Microsoft can
 * change or gate it at any time — every call falls back to the offline system engine.
 */
import crypto from 'node:crypto';
import WebSocket from 'ws';
import type { EdgeSynthRequest, EdgeSynthResult, EdgeWordBoundary, TtsVoice } from '@shared/types';

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const WSS = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const VOICES = 'https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list';
const CHROMIUM_VERSION = '130.0.2849.68';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';
const ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold';
const WIN_EPOCH = 11644473600;

/** Signature the Edge client sends; mirrors the public `edge-tts` implementation. */
function secMsGec(): string {
  let seconds = Math.floor(Date.now() / 1000) + WIN_EPOCH;
  seconds -= seconds % 300;
  const ticks = BigInt(seconds) * 10_000_000n;
  return crypto.createHash('sha256').update(`${ticks}${TRUSTED_CLIENT_TOKEN}`).digest('hex').toUpperCase();
}

const headers = (): Record<string, string> => ({
  'User-Agent': UA,
  'Accept-Language': 'en-US,en;q=0.9',
  Origin: ORIGIN,
  Pragma: 'no-cache',
  'Cache-Control': 'no-cache',
});

const stamp = (): string => new Date().toString().replace(/GMT([+-]\d{4}).*/, 'GMT$1 (Coordinated Universal Time)');

const escapeXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const pct = (rate: number): string => {
  const p = Math.round((Math.max(0.5, Math.min(2, rate)) - 1) * 100);
  return `${p >= 0 ? '+' : ''}${p}%`;
};

/* ---------------------------------------------------------------- voices */

let voiceCache: { at: number; voices: TtsVoice[] } | null = null;

/** Shipped as a fallback so the picker is never empty when the list endpoint is blocked. */
const FALLBACK_VOICES: TtsVoice[] = [
  ['zh-CN-XiaoxiaoNeural', '晓晓 (女声 · 温暖)', 'zh-CN'],
  ['zh-CN-XiaoyiNeural', '晓伊 (女声 · 活泼)', 'zh-CN'],
  ['zh-CN-YunxiNeural', '云希 (男声 · 沉稳)', 'zh-CN'],
  ['zh-CN-YunjianNeural', '云健 (男声 · 解说)', 'zh-CN'],
  ['zh-CN-YunyangNeural', '云扬 (男声 · 新闻)', 'zh-CN'],
  ['zh-TW-HsiaoChenNeural', '曉臻 (台湾)', 'zh-TW'],
  ['en-US-AriaNeural', 'Aria (US, female)', 'en-US'],
  ['en-US-GuyNeural', 'Guy (US, male)', 'en-US'],
  ['en-US-JennyNeural', 'Jenny (US, female)', 'en-US'],
  ['en-GB-SoniaNeural', 'Sonia (UK, female)', 'en-GB'],
].map(([id, name, lang]) => ({ id, name, lang, engine: 'edge' as const, wordBoundary: true }));

export async function listEdgeVoices(): Promise<TtsVoice[]> {
  if (voiceCache && Date.now() - voiceCache.at < 12 * 3600_000) return voiceCache.voices;
  try {
    const url = `${VOICES}?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=1-${CHROMIUM_VERSION}`;
    const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = (await res.json()) as { ShortName: string; FriendlyName: string; Locale: string; Gender: string }[];
    const voices: TtsVoice[] = raw.map((v) => ({
      id: v.ShortName,
      name: `${v.FriendlyName.replace(/^Microsoft\s+/, '').replace(/\s+Online.*$/, '')} · ${v.Gender === 'Female' ? '女' : '男'}`,
      lang: v.Locale,
      engine: 'edge',
      wordBoundary: true,
    }));
    voiceCache = { at: Date.now(), voices };
    return voices;
  } catch {
    voiceCache = { at: Date.now(), voices: FALLBACK_VOICES };
    return FALLBACK_VOICES;
  }
}

/* ------------------------------------------------------------- synthesis */

const CONFIG_MESSAGE = JSON.stringify({
  context: {
    synthesis: {
      audio: {
        metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'true' },
        outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
      },
    },
  },
});

export function synthesizeEdge(req: EdgeSynthRequest): Promise<EdgeSynthResult> {
  const requestId = crypto.randomUUID().replace(/-/g, '');
  const url = `${WSS}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=1-${CHROMIUM_VERSION}&ConnectionId=${requestId}`;

  return new Promise<EdgeSynthResult>((resolve, reject) => {
    const ws = new WebSocket(url, { headers: headers(), handshakeTimeout: 10_000 });
    const chunks: Buffer[] = [];
    const boundaries: EdgeWordBoundary[] = [];
    let settled = false;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      if (err) reject(err);
      else if (!chunks.length) reject(new Error('Edge TTS 没有返回音频'));
      else resolve({ audio: Buffer.concat(chunks).toString('base64'), boundaries });
    };

    const timer = setTimeout(() => finish(new Error('Edge TTS 超时')), 20_000);

    ws.on('open', () => {
      ws.send(
        `X-Timestamp:${stamp()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${CONFIG_MESSAGE}`,
      );
      const lang = req.voice.split('-').slice(0, 2).join('-') || 'en-US';
      const ssml =
        `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang}'>` +
        `<voice name='${req.voice}'>` +
        `<prosody pitch='${req.pitch ? `${req.pitch > 0 ? '+' : ''}${req.pitch}Hz` : '+0Hz'}' rate='${pct(req.rate)}' volume='+0%'>` +
        `${escapeXml(req.text)}</prosody></voice></speak>`;
      ws.send(
        `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${stamp()}Z\r\nPath:ssml\r\n\r\n${ssml}`,
      );
    });

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        // 2-byte big-endian header length, then an ASCII header block, then mp3 bytes.
        if (data.length < 2) return;
        const headerLength = data.readUInt16BE(0);
        if (data.length > headerLength + 2) chunks.push(data.subarray(headerLength + 2));
        return;
      }
      const text = data.toString('utf8');
      const split = text.indexOf('\r\n\r\n');
      const head = split < 0 ? text : text.slice(0, split);
      const body = split < 0 ? '' : text.slice(split + 4);
      if (head.includes('Path:audio.metadata')) {
        try {
          const meta = JSON.parse(body) as {
            Metadata: { Type: string; Data: { Offset: number; Duration: number; text: { Text: string } } }[];
          };
          for (const m of meta.Metadata ?? []) {
            if (m.Type !== 'WordBoundary') continue;
            boundaries.push({
              offsetMs: m.Data.Offset / 10_000,
              durationMs: m.Data.Duration / 10_000,
              text: m.Data.text.Text,
            });
          }
        } catch {
          /* ignore malformed metadata frames */
        }
      } else if (head.includes('Path:turn.end')) {
        finish();
      }
    });

    ws.on('error', (err) => finish(err instanceof Error ? err : new Error(String(err))));
    ws.on('close', () => finish());
  });
}
