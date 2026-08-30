@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (
  echo Node.js is required: https://nodejs.org/
  pause
  exit /b 1
)
if not exist node_modules call npm install --no-audit --no-fund
node src\index.js
echo.
pause
