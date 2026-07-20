@echo off
cd /d "%~dp0"
echo =========================================
echo  GMS Attendance Server
echo =========================================
echo.
echo  PC IP addresses:
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /i "IPv4"') do (
    set ip=%%a
    setlocal enabledelayedexpansion
    set ip=!ip: =!
    echo   http://!ip!:3000
    endlocal
)
echo.
echo  ESP32 target (secrets.h):
echo   SERVER_URL = http://YOUR-PC-IP:3000
echo.
echo  Test from phone browser:
echo   http://YOUR-PC-IP:3000/api/health
echo.
echo  If ESP32 cannot connect, run allow-port-3000.ps1 as Administrator.
echo =========================================
echo.
node server.js
pause
