@echo off
chcp 65001 >nul
set "APPDIR=%~dp0"
cd /d "%APPDIR%"
title VoiceMate

set "PY="
if exist "%APPDIR%..\runtime\python.exe" set "PY=%APPDIR%..\runtime\python.exe"
if not defined PY (
  where python >nul 2>nul
  if not errorlevel 1 set "PY=python"
)
if not defined PY if exist "D:\Python\python.exe" set "PY=D:\Python\python.exe"
if not defined PY (
  echo [错误] 找不到 Python：runtime\python.exe 缺失，系统里也没有 Python 3.9+。
  echo.
  pause
  exit /b 1
)

echo ============================================================
echo   VoiceMate
echo   正在准备，模型加载需要 30~90 秒，请勿关闭本窗口
echo ============================================================
echo.

"%PY%" "server.py"

rem python 退出后，兜底清掉可能残留的语音服务子进程
if not exist "%TEMP%\breeze_app_child.pid" goto :done
set /p CHILDPID=<"%TEMP%\breeze_app_child.pid"
if defined CHILDPID taskkill /PID %CHILDPID% /T /F >nul 2>&1
del "%TEMP%\breeze_app_child.pid" >nul 2>&1
:done

echo.
echo 已退出，按任意键关闭窗口。
pause >nul
