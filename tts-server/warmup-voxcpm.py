# -*- coding: utf-8 -*-
"""Download VoxCPM weights and prove one synthesis works. Run by install-voxcpm.bat / install-voxcpm.sh."""
import os
import sys
import time

RUNTIME = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "runtime-voxcpm")
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ["HF_HOME"] = os.path.join(RUNTIME, "hf")

MODEL_ID = os.environ.get("ALOUD_VOXCPM_MODEL", "openbmb/VoxCPM-0.5B")

from huggingface_hub import snapshot_download  # noqa: E402

# hf-mirror rate-limits bursts; alternate endpoints and rely on resume between attempts.
ENDPOINTS = ["https://hf-mirror.com", "https://huggingface.co"]
path = None
for attempt in range(10):
    endpoint = ENDPOINTS[attempt % len(ENDPOINTS)]
    try:
        path = snapshot_download(MODEL_ID, max_workers=2, endpoint=endpoint)
        break
    except Exception as exc:  # noqa: BLE001
        print("attempt %d via %s failed: %s" % (attempt + 1, endpoint, str(exc)[:160]), flush=True)
        time.sleep(min(20, 3 * (attempt + 1)))
if path is None:
    raise SystemExit("model download failed after retries")
print("weights at %s" % path, flush=True)

import torch  # noqa: E402

print("torch %s | cuda available: %s | mps available: %s" % (torch.__version__, torch.cuda.is_available(), getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available()), flush=True)

from voxcpm import VoxCPM  # noqa: E402

model = VoxCPM.from_pretrained(MODEL_ID, load_denoiser=False)
wav = model.generate(text="这是声音克隆引擎的安装自检。", cfg_value=2.0, inference_timesteps=10)
print("test synthesis ok: %d samples @ %s Hz" % (len(wav), getattr(model.tts_model, "sample_rate", "?")), flush=True)

os.makedirs(os.path.join(RUNTIME, "voices"), exist_ok=True)
print("WARMUP_OK")
