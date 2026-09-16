#!/bin/bash
# Installs the voice-cloning engine (VoxCPM) — macOS / Linux counterpart of install-voxcpm.bat.
# Usage: install-voxcpm.sh [target]
# Needs internet for the first run: PyTorch + ~2GB model weights. On Apple Silicon there
# are no CUDA wheels; torch runs on CPU (MPS where the model supports it).
HERE="$(cd "$(dirname "$0")" && pwd)"
TARGET="${1:-$HERE/runtime-voxcpm}"
export HF_ENDPOINT="https://hf-mirror.com"
export HF_HOME="$TARGET/hf"
PIP_INDEX="https://pypi.tuna.tsinghua.edu.cn/simple"

echo "=== Aloud Reader voice-cloning installer (VoxCPM) ==="
echo "target: $TARGET"

fail() { echo "INSTALL_FAIL"; echo "（可以关闭这个窗口；修好后在阅读器里重新点「安装」）"; exit 1; }

. "$HERE/_python.sh"
make_venv "$TARGET" || fail
PY="$TARGET/venv/bin/python"

"$PY" -m pip install --upgrade pip -i "$PIP_INDEX" || fail
"$PY" -m pip install torch torchaudio -i "$PIP_INDEX" || fail
"$PY" -m pip install voxcpm soundfile -i "$PIP_INDEX" || fail
"$PY" "$HERE/warmup-voxcpm.py" "$TARGET" || fail

echo "INSTALL_OK"
echo "安装完成，可以关闭这个窗口，回到阅读器使用声音克隆。"
