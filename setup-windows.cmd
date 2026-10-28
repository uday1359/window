@echo off
rem One-click developer setup of WinAgent on this computer.
rem Works on its own: if setup-windows.ps1 is not next to this file, it is downloaded from GitHub.
rem Run it as your normal user (double-click). It asks for administrator approval only to install software.
setlocal
set "SCRIPT=%~dp0setup-windows.ps1"
if not exist "%SCRIPT%" (
  set "SCRIPT=%TEMP%\setup-windows.ps1"
  echo Downloading setup-windows.ps1 from GitHub ...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol='Tls12'; foreach ($u in 'https://raw.githubusercontent.com/uday1359/window/main/setup-windows.ps1','https://api.github.com/repos/uday1359/window/contents/setup-windows.ps1') { try { Invoke-WebRequest $u -Headers @{Accept='application/vnd.github.raw'} -OutFile "$env:TEMP\setup-windows.ps1" -UseBasicParsing -TimeoutSec 60; exit 0 } catch { } }; exit 1"
  if errorlevel 1 (
    echo Download failed. Check the internet connection and try again.
    pause
    exit /b 1
  )
)
if "%~1"=="" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -Developer
) else (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
)
echo.
pause
