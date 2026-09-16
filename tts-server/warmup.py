# -*- coding: utf-8 -*-
"""Pre-download the Kokoro zh model + voices, and write voices.json.

Run by install.bat / install.sh inside the venv. Uses snapshot_download (resumable, retried) instead
of hammering one HEAD request per voice — hf-mirror rate-limits that into failures.
"""
import json
import os
import sys
import time

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

REPO_ID = "hexgrad/Kokoro-82M-v1.1-zh"
OUT_DIR = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))

from huggingface_hub import snapshot_download  # noqa: E402

# Resumable: every attempt keeps what it got. hf-mirror rate-limits bursts of small
# files, so alternate endpoints between attempts and go easy on concurrency.
ENDPOINTS = [os.environ["HF_ENDPOINT"], "https://huggingface.co"]
snapshot = None
for attempt in range(12):
    os.environ["HF_ENDPOINT"] = ENDPOINTS[attempt % len(ENDPOINTS)]
    try:
        snapshot = snapshot_download(
            REPO_ID,
            allow_patterns=["*.json", "*.pth", "voices/*.pt"],
            max_workers=2,
            endpoint=os.environ["HF_ENDPOINT"],
        )
        break
    except Exception as exc:  # noqa: BLE001
        print("attempt %d via %s failed: %s" % (attempt + 1, os.environ["HF_ENDPOINT"], str(exc)[:160]))
        time.sleep(min(20, 3 * (attempt + 1)))
if snapshot is None:
    raise SystemExit("snapshot download failed after retries")

voices_dir = os.path.join(snapshot, "voices")
voices = sorted(f[:-3] for f in os.listdir(voices_dir) if f.endswith(".pt"))
if not voices:
    raise SystemExit("no voice packs in snapshot")
print("voices cached: %d" % len(voices))

os.makedirs(OUT_DIR, exist_ok=True)
with open(os.path.join(OUT_DIR, "voices.json"), "w", encoding="utf-8") as f:
    json.dump(voices, f, ensure_ascii=False, indent=2)

from kokoro import KPipeline  # noqa: E402

pipe = KPipeline(lang_code="z", repo_id=REPO_ID)
total = 0
for result in pipe("你好，这是内置语音的安装自检。", voice=voices[0]):
    if result.audio is not None:
        total += int(result.audio.shape[-1])
if total <= 0:
    raise SystemExit("test synthesis produced no audio")
print("test synthesis ok: %d samples" % total)
print("WARMUP_OK")
