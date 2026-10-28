@echo off
rem Double-click to set up WinAgent on this computer (see setup-windows.ps1).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-windows.ps1" %*
echo.
pause
