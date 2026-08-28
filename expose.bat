@echo off
title Expose SAHAAI to Mobile (HTTPS)
echo ====================================================================
echo                   EXPOSE SAHAAI TO MOBILE VIA HTTPS
echo ====================================================================
echo.
echo Note: Mobile browsers require HTTPS for camera, mic, and orientation!
echo We recommend exposing the local FastAPI server (port 8000) using ngrok.
echo.
where ngrok >nul 2>nul
if %errorlevel% neq 0 (
    echo [WARNING] ngrok is not found on your system PATH.
    echo Please install ngrok (https://ngrok.com) or use cloudflared / localtunnel.
    echo.
    echo Exposing alternatives:
    echo 1. Run: npx localtunnel --port 8000
    echo 2. Run: cloudflared tunnel --url http://localhost:8000
    echo.
    pause
    exit /b
)

echo Starting ngrok tunnel on port 8000...
echo Copy the HTTPS URL shown in the ngrok output and open it on your phone!
echo.
ngrok http 8000
pause
