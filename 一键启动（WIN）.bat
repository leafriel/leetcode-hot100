@echo off
setlocal
powershell.exe -NoProfile -File "%~dp0tools\start-windows.ps1" %*
if errorlevel 1 pause
