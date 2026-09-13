@echo off
title Duolingo Chess - Local Stockfish 17 Engine (Depth 15)
color 0A
cd /d "%~dp0"

echo ======================================================================
echo    DUOLINGO CHESS BOT - LOCAL NATIVE STOCKFISH 17 ENGINE (DEPTH 15)
echo ======================================================================
echo.

if not exist "engine\stockfish.exe" (
    echo [*] First-time setup: Downloading Stockfish 17 binary...
    node setup-stockfish.js
    if %errorlevel% neq 0 (
        echo [!] Failed to download Stockfish. Please check your internet connection.
        pause
        exit /b %errorlevel%
    )
)

echo [*] Starting Local Stockfish Bridge Server on port 3333...
echo [*] Keep this window OPEN while playing Duolingo Chess!
echo.
node stockfish-server.js
pause
