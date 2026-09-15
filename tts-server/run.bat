@echo off
rem Manual start of the built-in voice server (the reader normally does this itself).
setlocal
set "HERE=%~dp0"
set "ALOUD_KOKORO_DATA=%HERE%runtime"
"%HERE%runtime\venv\Scripts\python.exe" "%HERE%server.py" --port 8973
