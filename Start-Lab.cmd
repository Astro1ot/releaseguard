@echo off
chcp 65001 >nul
cd /d "%~dp0"
where python >nul 2>&1
if errorlevel 1 (
  echo Python 3.11+ is required. Install Python and run this file again.
  pause
  exit /b 1
)
python scripts\presenter.py
pause
