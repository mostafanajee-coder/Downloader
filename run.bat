@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ================================================
echo   Downloader - checking requirements and starting
echo ================================================
echo.

where winget >nul 2>nul
if errorlevel 1 (
    set "HAVE_WINGET=0"
) else (
    set "HAVE_WINGET=1"
)

REM --- Node.js ---------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
    echo [!] Node.js not found.
    if "!HAVE_WINGET!"=="1" (
        echo     Installing Node.js via winget...
        winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
        call :RefreshPath
    ) else (
        echo     winget is not available on this machine.
        echo     Download Node.js manually from: https://nodejs.org
        echo     Then run this file again.
        pause
        exit /b 1
    )
) else (
    echo [OK] Node.js found:
    node --version
)

where node >nul 2>nul
if errorlevel 1 (
    echo [X] Node.js still not found after install attempt.
    echo     Close this window and run the file again, or restart your PC and retry.
    pause
    exit /b 1
)

echo.

REM --- ffmpeg (only needed for downloading segmented HLS videos) ------
where ffmpeg >nul 2>nul
if errorlevel 1 (
    echo [!] ffmpeg not found ^(needed to merge segmented HLS videos^).
    if "!HAVE_WINGET!"=="1" (
        echo     Installing ffmpeg via winget...
        winget install -e --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements
        call :RefreshPath
    ) else (
        echo     winget is not available. Download ffmpeg manually from:
        echo     https://www.gyan.dev/ffmpeg/builds/
    )
) else (
    echo [OK] ffmpeg found:
    ffmpeg -version | findstr /b "ffmpeg"
)

where ffmpeg >nul 2>nul
if errorlevel 1 (
    echo [!] ffmpeg still not found. Normal file downloads will work fine,
    echo     but segmented HLS video downloads will not until ffmpeg is on PATH.
    echo.
)

echo.

REM --- project dependencies --------------------------------------------
if not exist "node_modules" (
    echo [...] Installing project dependencies ^(npm install^), this may take a minute...
    call npm install
    if errorlevel 1 (
        echo [X] npm install failed. Check your internet connection and try again.
        pause
        exit /b 1
    )
) else (
    echo [OK] Project dependencies already installed.
)

echo.
echo [...] Starting the app...
echo.
call npm start

pause
exit /b 0

REM ======================================================================
REM Re-reads PATH from the registry (System + User) after installing new
REM software, so we don't need to close and reopen the terminal window.
:RefreshPath
setlocal disabledelayedexpansion
set "SysPath="
set "UserPath="
for /f "usebackq tokens=2,*" %%A in (`reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul`) do set "SysPath=%%B"
for /f "usebackq tokens=2,*" %%A in (`reg query "HKCU\Environment" /v Path 2^>nul`) do set "UserPath=%%B"
endlocal & set "PATH=%SysPath%;%UserPath%;%PATH%"
goto :eof
