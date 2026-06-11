@echo off
REM Windows stub - delegates to PowerShell
powershell -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
