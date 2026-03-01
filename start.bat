@echo off
REM Otakudesu API Startup Script for Windows

echo.
echo =========================================
echo     Otakudesu API v2.0.0
echo =========================================
echo.

REM Set environment variable
set NODE_TLS_REJECT_UNAUTHORIZED=0

REM Kill existing process on port 3000
echo [*] Checking port 3000...
for /f "tokens=5" %%a in ('netstat -ano ^| find "3000"') do (
    taskkill /PID %%a /F 2>nul
)

echo [*] Starting server...
timeout /t 1 /nobreak

REM Start the server
node index.js

echo.
echo Server stopped!
pause
