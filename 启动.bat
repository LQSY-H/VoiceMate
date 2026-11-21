@echo off
chcp 65001 >nul
cd /d "%~dp0"
title VoiceMate

set "HERE=%~dp0"
if not exist "%HERE%app\启动.bat" (
  echo [错误] 找不到 app\启动.bat
  pause
  exit /b 1
)

call "%HERE%app\启动.bat"
