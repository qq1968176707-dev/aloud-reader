@echo off
rem Installs the built-in neural voice (Kokoro-82M zh) into %APPDATA%\Aloud Reader\kokoro.
rem Needs: Python 3.10-3.13 on PATH (py launcher), internet for the first run only.
setlocal
rem Everything lives NEXT TO the scripts, never under the user profile: %APPDATA% is
rem subject to MSIX virtualization (a sandboxed installer and the real app would see
rem two different directories) and this machine's profile is EFS-encrypted, which
rem breaks pip's rename-based installs with WinError 17.
set "TARGET=%~dp0runtime"
if not "%~1"=="" set "TARGET=%~1"
set "HF_ENDPOINT=https://hf-mirror.com"
set "HF_HOME=%TARGET%\hf"
set "PIP_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple"

echo === Aloud Reader built-in voice installer ===
echo target: %TARGET%

rem Prefer Python 3.10-3.12: some deps pin an older numpy that has no 3.13 wheels and
rem would fall into a source build (meson) that fails.
set "UV_PY=%APPDATA%\uv\python\cpython-3.11.15-windows-x86_64-none\python.exe"
if not exist "%TARGET%\venv\Scripts\python.exe" (
  if exist "%UV_PY%" ( "%UV_PY%" -m venv "%TARGET%\venv"
  ) else ( py -3.12 -m venv "%TARGET%\venv" || py -3.11 -m venv "%TARGET%\venv" || py -3 -m venv "%TARGET%\venv" || python -m venv "%TARGET%\venv" )
)
if not exist "%TARGET%\venv\Scripts\python.exe" (
  echo INSTALL_FAIL: could not create venv - is Python installed?
  exit /b 1
)

"%TARGET%\venv\Scripts\python.exe" -m pip install --upgrade pip -i %PIP_INDEX% || goto :err
"%TARGET%\venv\Scripts\python.exe" -m pip install kokoro "misaki[zh]" numpy -i %PIP_INDEX% || goto :err
"%TARGET%\venv\Scripts\python.exe" "%~dp0warmup.py" "%TARGET%" || goto :err

echo INSTALL_OK
exit /b 0

:err
echo INSTALL_FAIL
exit /b 1
