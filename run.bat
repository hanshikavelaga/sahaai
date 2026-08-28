@echo off
title SAHAAI - Smart AI Hazard Awareness & Assistive Intelligence
echo ====================================================================
echo                   SAHAAI SERVER STARTUP SCRIPT
echo ====================================================================
echo.
echo Installing any missing python requirements...
python -m pip install -r requirements.txt
echo.
echo Launching FastAPI Application Server at http://127.0.0.1:8000
echo.
python -m backend.app.main
echo.
pause
