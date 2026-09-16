#!/bin/bash
# Installs the built-in neural voice (Kokoro-82M zh) — macOS / Linux counterpart of install.bat.
# Usage: install.sh [target]   (the reader passes ~/Library/Application Support/Aloud Reader/tts-server/runtime)
# Needs internet for the first run only.
HERE="$(cd "$(dirname "$0")" && pwd)"
TARGET="${1:-$HERE/runtime}"
export HF_ENDPOINT="https://hf-mirror.com"
export HF_HOME="$TARGET/hf"
PIP_INDEX="https://pypi.tuna.tsinghua.edu.cn/simple"

echo "=== Aloud Reader built-in voice installer ==="
echo "target: $TARGET"

fail() { echo "INSTALL_FAIL"; echo "（可以关闭这个窗口；修好后在阅读器里重新点「安装」）"; exit 1; }

. "$HERE/_python.sh"
make_venv "$TARGET" || fail
PY="$TARGET/venv/bin/python"

"$PY" -m pip install --upgrade pip -i "$PIP_INDEX" || fail
"$PY" -m pip install kokoro "misaki[zh]" numpy -i "$PIP_INDEX" || fail
"$PY" "$HERE/warmup.py" "$TARGET" || fail

echo "INSTALL_OK"
echo "安装完成，可以关闭这个窗口，回到阅读器使用内置语音。"
