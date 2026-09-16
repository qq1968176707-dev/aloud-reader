#!/bin/bash
# Manual start of the built-in voice server (the reader normally does this itself).
# Usage: run.sh [runtime dir]   default: ~/Library/Application Support/Aloud Reader/tts-server/runtime
HERE="$(cd "$(dirname "$0")" && pwd)"
RUNTIME="${1:-$HOME/Library/Application Support/Aloud Reader/tts-server/runtime}"
export ALOUD_KOKORO_DATA="$RUNTIME"
exec "$RUNTIME/venv/bin/python" "$HERE/server.py" --port 8973
