# Shared by install.sh / install-voxcpm.sh: create "$1/venv" with Python 3.10–3.12.
# Sourced, not executed. macOS ships Python 3.9 (too old for kokoro/voxcpm), so prefer
# uv (downloads a standalone 3.11 on demand), then Homebrew/python.org interpreters.
make_venv() {
  local venv="$1/venv"
  [ -x "$venv/bin/python" ] && return 0
  mkdir -p "$1"
  if command -v uv >/dev/null 2>&1; then
    uv venv --seed --python 3.11 "$venv" && return 0
  fi
  for py in python3.12 python3.11 python3.10 \
            /opt/homebrew/bin/python3.12 /opt/homebrew/bin/python3.11 /opt/homebrew/bin/python3.10 \
            /usr/local/bin/python3.12 /usr/local/bin/python3.11 /usr/local/bin/python3.10; do
    if command -v "$py" >/dev/null 2>&1; then
      "$py" -m venv "$venv" && return 0
    fi
  done
  echo "INSTALL_FAIL: 需要 Python 3.10–3.12。任选其一安装后重试："
  echo "  brew install uv          （推荐，自动下载 Python 3.11）"
  echo "  brew install python@3.11"
  return 1
}
