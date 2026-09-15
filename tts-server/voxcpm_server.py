# -*- coding: utf-8 -*-
"""
Aloud Reader voice-cloning TTS server (VoxCPM).

Same HTTP contract as the built-in Kokoro server, plus the cloning parameters:

    GET  /health   -> {"ok": true, "ready": bool, "device": "cuda"|"cpu", "voices": [...]}
    POST /tts      -> audio/wav
         {"text": "...", "prompt_wav": "D:/.../me.wav", "prompt_text": "...", "speed": 1.0}

`prompt_wav` + `prompt_text` are the reference recording and what was said in it —
that pair is what makes the output sound like the speaker. Both are optional; without
them VoxCPM speaks in its own default voice.

Weights and venv live in tts-server/runtime-voxcpm/ (never under the user profile: that
directory is EFS-encrypted and MSIX-virtualized on this machine).
"""
import argparse
import io
import json
import os
import sys
import threading
import wave

_HERE = os.path.dirname(os.path.abspath(__file__))
_RUNTIME = os.environ.get("ALOUD_VOXCPM_DATA", os.path.join(_HERE, "runtime-voxcpm"))
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("HF_HOME", os.path.join(_RUNTIME, "hf"))

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

MODEL_ID = os.environ.get("ALOUD_VOXCPM_MODEL", "openbmb/VoxCPM-0.5B")
VOICES_DIR = os.path.join(_RUNTIME, "voices")

_model = None
_lock = threading.Lock()
_ready = False
_error = None
_device = "cpu"
_sample_rate = 16000


def patch_audio_loading():
    """
    Load reference audio with soundfile instead of torchcodec.

    torchaudio >= 2.9 dispatches `load()` to torchcodec, which needs FFmpeg's
    *shared* DLLs; the common Windows ffmpeg builds (winget/Gyan "essentials") are
    static, so cloning would die with "Could not load libtorchcodec" the moment a
    reference wav was passed. soundfile ships libsndfile in the wheel and handles
    everything we feed it.
    """
    try:
        import numpy as np
        import soundfile as sf
        import torch
        import torchaudio

        def _load(path, *_args, **_kwargs):
            data, sr = sf.read(str(path), dtype="float32", always_2d=True)
            return torch.from_numpy(np.ascontiguousarray(data.T)), sr

        torchaudio.load = _load
        print("[voxcpm] audio loading patched to soundfile", flush=True)
    except Exception as exc:  # noqa: BLE001
        print("[voxcpm] could not patch audio loading: %s" % exc, flush=True)


def load_model():
    global _model, _ready, _error, _device, _sample_rate
    try:
        import torch

        patch_audio_loading()
        from voxcpm import VoxCPM

        _device = "cuda" if torch.cuda.is_available() else "cpu"
        _model = VoxCPM.from_pretrained(MODEL_ID, load_denoiser=False)
        try:
            _sample_rate = int(_model.tts_model.sample_rate)
        except Exception:  # noqa: BLE001
            _sample_rate = 16000
        _ready = True
        print("[voxcpm] ready on %s, sr=%d" % (_device, _sample_rate), flush=True)
    except Exception as exc:  # noqa: BLE001
        _error = "%s: %s" % (type(exc).__name__, exc)
        print("[voxcpm] load failed: %s" % _error, flush=True)


def list_voices():
    try:
        return sorted(f for f in os.listdir(VOICES_DIR) if f.lower().endswith(".wav"))
    except Exception:  # noqa: BLE001
        return []


def to_wav_bytes(pcm, sample_rate):
    import numpy as np

    arr = np.asarray(pcm, dtype="float32").reshape(-1)
    pcm16 = (np.clip(arr, -1.0, 1.0) * 32767.0).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm16.tobytes())
    return buf.getvalue()


def synthesize(text, prompt_wav, prompt_text, speed):
    kwargs = {"text": text, "cfg_value": 2.0, "inference_timesteps": 10}
    if prompt_wav and os.path.isfile(prompt_wav):
        kwargs["prompt_wav_path"] = prompt_wav
        if prompt_text:
            kwargs["prompt_text"] = prompt_text
    with _lock:
        wav = _model.generate(**kwargs)
    data = to_wav_bytes(wav, _sample_rate)
    # VoxCPM has no speed knob; resample the header for small adjustments so the reader's
    # speed slider still does something sensible.
    if abs(speed - 1.0) > 0.02:
        import numpy as np

        arr = np.frombuffer(data[44:], dtype="<i2").astype("float32") / 32767.0
        idx = np.arange(0, len(arr), speed, dtype="float64")
        idx = idx[idx < len(arr) - 1]
        lo = idx.astype("int64")
        frac = idx - lo
        arr = arr[lo] * (1 - frac) + arr[lo + 1] * frac
        data = to_wav_bytes(arr, _sample_rate)
    return data


from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer  # noqa: E402


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("[http] %s\n" % (fmt % args))

    def _send(self, code, body, ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/health"):
            payload = {
                "ok": True,
                "ready": _ready,
                "error": _error,
                "device": _device,
                "voices": list_voices(),
            }
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
            if not text:
                self._send(400, b'{"message":"no text"}')
                return
            if not _ready:
                self._send(503, json.dumps({"message": "model not ready", "error": _error}).encode("utf-8"))
                return
            audio = synthesize(
                text,
                req.get("prompt_wav") or "",
                req.get("prompt_text") or "",
                float(req.get("speed") or 1.0),
            )
            self._send(200, audio, "audio/wav")
        except Exception as exc:  # noqa: BLE001
            self._send(500, json.dumps({"message": str(exc)}).encode("utf-8"))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8974)
    args = parser.parse_args()
    os.makedirs(VOICES_DIR, exist_ok=True)
    threading.Thread(target=load_model, daemon=True).start()
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
