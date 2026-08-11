@echo off
:: Request Admin privileges
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo Requesting Administrative Privileges...
    powershell -Command "Start-Process cmd -ArgumentList '/c %~s0' -Verb RunAs"
    exit /b
)

echo Administrative Privileges acquired.
echo Copying AUTHORIZATION.txt to IDM directory...
copy /Y "%~dp0AUTHORIZATION.txt" "C:\Program Files (x86)\Internet Download Manager\AUTHORIZATION.txt"
if %errorlevel% equ 0 (
    echo.
    echo Successfully copied AUTHORIZATION.txt to C:\Program Files (x86)\Internet Download Manager\
) else (
    echo.
    echo Failed to copy the file. Please ensure IDM is installed at the expected path.
)
echo.
pause
