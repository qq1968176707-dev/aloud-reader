# -*- coding: utf-8 -*-
"""
Aloud Reader built-in neural TTS server (Kokoro-82M v1.1-zh).

Tiny stdlib HTTP server the reader talks to on 127.0.0.1. No FastAPI, no flask —
two endpoints and a lock:

    GET  /health          -> {"ok": true, "ready": bool, "voices": [...]}
    POST /tts             -> audio/wav
         {"text": "...", "voice": "zf_001", "speed": 1.0}

The model (~330MB) lives in the HuggingFace cache; run install.bat once to create the
venv, install deps and pre-download everything so this starts offline afterwards.
"""
import argparse
import io
import json
import os
import struct
import sys
import threading
import wave

# Model downloads go through hf-mirror by default (direct HF is unreachable for many
# Chinese networks); harmless when the files are already cached.
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
# The HF cache is pinned next to the scripts: the default (~/.cache) is unreliable here —
# MSIX-virtualized processes and the real app would resolve it to different directories.
_default_runtime = os.path.join(os.path.dirname(os.path.abspath(__file__)), "runtime")
os.environ.setdefault("HF_HOME", os.path.join(os.environ.get("ALOUD_KOKORO_DATA", _default_runtime), "hf"))

# Once the weights are cached, pin the hub offline. Without this a machine with no
# network spends the whole connect timeout on every single start before falling back to
# exactly the files it already had.
_hub = os.path.join(os.environ["HF_HOME"], "hub")
try:
    if os.path.isdir(_hub) and any(n.startswith("models--") for n in os.listdir(_hub)):
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
except OSError:
    pass

REPO_ID = "hexgrad/Kokoro-82M-v1.1-zh"
SAMPLE_RATE = 24000

_pipeline = None
_lock = threading.Lock()
_ready = False
_error = None
_voices = []


def data_dir():
    return os.path.dirname(os.path.abspath(__file__))


def load_voices_list():
    """voices.json is written by warmup.py from the actual repo listing."""
    for base in (os.environ.get("ALOUD_KOKORO_DATA", ""), _default_runtime, data_dir()):
        if not base:
            continue
        p = os.path.join(base, "voices.json")
        if os.path.isfile(p):
            try:
                with open(p, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                pass
    return ["zf_001", "zf_002", "zf_003", "zf_004", "zf_005", "zm_009", "zm_010", "zm_011"]


def load_model():
    global _pipeline, _ready, _error
    try:
        from kokoro import KPipeline

        _pipeline = KPipeline(lang_code="z", repo_id=REPO_ID)
        # One tiny synthesis so the first real request doesn't pay the lazy-init cost.
        for _ in _pipeline("预热。", voice=_voices[0] if _voices else "zf_001"):
            break
        _ready = True
        print("[kokoro] model ready", flush=True)
    except Exception as exc:  # noqa: BLE001
        _error = "%s: %s" % (type(exc).__name__, exc)
        print("[kokoro] load failed: %s" % _error, flush=True)


def synthesize(text, voice, speed):
    import numpy as np

    chunks = []
    with _lock:
        for result in _pipeline(text, voice=voice, speed=speed):
            audio = result.audio
            if audio is None:
                continue
            arr = audio.detach().cpu().numpy() if hasattr(audio, "detach") else np.asarray(audio)
            chunks.append(arr)
    if not chunks:
        raise RuntimeError("no audio produced")
    pcm = np.concatenate(chunks)
    pcm16 = (np.clip(pcm, -1.0, 1.0) * 32767.0).astype("<i2")

    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm16.tobytes())
    return buf.getvalue()


from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer  # noqa: E402


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quieter logs
        sys.stderr.write("[http] %s\n" % (fmt % args))

    def _send(self, code, body, ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/health"):
            payload = {"ok": True, "ready": _ready, "error": _error, "voices": _voices}
            self._send(200, json.dumps(payload).encode("utf-8"))
        else:
            self._send(404, b'{"message":"not found"}')

    def do_POST(self):
        if not self.path.startswith("/tts"):
            self._send(404, b'{"message":"not found"}')
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            req = json.loads(self.rfile.read(length).decode("utf-8"))
            text = (req.get("text") or "").strip()
            voice = req.get("voice") or (_voices[0] if _voices else "zf_001")
            speed = float(req.get("speed") or 1.0)
            speed = max(0.5, min(2.0, speed))
            if not text:
                self._send(400, b'{"message":"no text"}')
                return
            if not _ready:
                msg = json.dumps({"message": "model not ready", "error": _error}).encode("utf-8")
                self._send(503, msg)
                return
            audio = synthesize(text, voice, speed)
            self._send(200, audio, "audio/wav")
        except Exception as exc:  # noqa: BLE001
            msg = json.dumps({"message": str(exc)}).encode("utf-8")
            self._send(500, msg)


def main():
    global _voices
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8973)
    args = parser.parse_args()

    _voices = load_voices_list()
    threading.Thread(target=load_model, daemon=True).start()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print("[kokoro] listening on http://127.0.0.1:%d" % args.port, flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
