@echo off
title Uninstall IDM Auto Trial Reset Task

:: Self-elevation to run as Administrator
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting Administrator privileges...
    powershell -Command "Start-Process cmd -ArgumentList '/c \"\"%~f0\"\"' -Verb RunAs"
    exit /b
)

schtasks /delete /tn "IDM_Auto_Trial_Reset" /f
echo.
echo [OK] Scheduled task "IDM_Auto_Trial_Reset" has been successfully removed.
echo.
pause
