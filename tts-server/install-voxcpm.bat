@echo off
rem Installs the voice-cloning engine (VoxCPM) into tts-server\runtime-voxcpm.
rem Needs internet for the first run: ~2.5GB PyTorch + ~2GB model weights.
rem Everything stays on this drive — the user profile is EFS-encrypted (pip WinError 17)
rem and MSIX-virtualized (two processes would see two different directories).
setlocal
set "TARGET=%~dp0runtime-voxcpm"
if not "%~1"=="" set "TARGET=%~1"
set "HF_ENDPOINT=https://hf-mirror.com"
set "HF_HOME=%TARGET%\hf"
set "PIP_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple"
rem VoxCPM requires Python >=3.10,<3.13
set "UV_PY=%APPDATA%\uv\python\cpython-3.11.15-windows-x86_64-none\python.exe"

echo === Aloud Reader voice-cloning installer (VoxCPM) ===
echo target: %TARGET%

if not exist "%TARGET%\venv\Scripts\python.exe" (
  if exist "%UV_PY%" ( "%UV_PY%" -m venv "%TARGET%\venv"
  ) else ( py -3.12 -m venv "%TARGET%\venv" || py -3.11 -m venv "%TARGET%\venv" || py -3 -m venv "%TARGET%\venv" )
)
if not exist "%TARGET%\venv\Scripts\python.exe" (
  echo INSTALL_FAIL: could not create venv
  exit /b 1
)
set "PY=%TARGET%\venv\Scripts\python.exe"

"%PY%" -m pip install --upgrade pip -i %PIP_INDEX% || goto :err
rem Blackwell (RTX 50xx) needs the cu128 wheels; falls back to CPU-only if that fails.
"%PY%" -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu128 || (
  echo [warn] CUDA wheels failed, falling back to CPU-only torch
  "%PY%" -m pip install torch torchaudio -i %PIP_INDEX% || goto :err
)
"%PY%" -m pip install voxcpm soundfile -i %PIP_INDEX% || goto :err
"%PY%" "%~dp0warmup-voxcpm.py" "%TARGET%" || goto :err

echo INSTALL_OK
exit /b 0

:err
echo INSTALL_FAIL
exit /b 1
