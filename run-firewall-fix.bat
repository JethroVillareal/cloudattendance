@echo off
:: Run firewall fix script as Administrator
:: This batch file elevates PowerShell to admin and runs allow-port-3000.ps1

setlocal

:: Check if running as admin
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo Requesting administrator privileges...
    powershell -Command "Start-Process cmd -ArgumentList '/c \"%~f0\"' -Verb RunAs"
    exit /b
)

echo Running as Administrator...
echo.

:: Navigate to script directory
cd /d "%~dp0"

:: Run the PowerShell script
powershell -ExecutionPolicy Bypass -File "allow-port-3000.ps1"

endlocal
