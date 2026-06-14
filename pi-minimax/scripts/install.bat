@echo off
REM
REM ~/Project/sages/pi-minimax/scripts/install.bat
REM
REM Windows variant of install.sh. Mirrors the same source-to-runtime copy.

setlocal enabledelayedexpansion

if "%PI_DIR%"=="" set PI_DIR=%USERPROFILE%\.pi
set PKG_NAME=minimax
set SRC_DIR=%~dp0..
set PKG_DIR=%PI_DIR%\packages\%PKG_NAME%
set SETTINGS=%PI_DIR%\agent\settings.json

set RUNTIME_DIRS=prompts skills extensions src
set FORCE=false

if "%1"=="--force" set FORCE=true
if "%1"=="--uninstall" goto uninstall
if "%1"=="--help" goto help
if "%1"=="-h" goto help

:install
echo ==^> Installing %PKG_NAME% from %SRC_DIR%
if not exist "%PKG_DIR%" mkdir "%PKG_DIR%"

for %%d in (%RUNTIME_DIRS%) do (
    if exist "%SRC_DIR%\%%d" (
        if exist "%PKG_DIR%\%%d" (
            if "%FORCE%"=="false" (
                echo   [skip] %%d\ ^(use --force to overwrite^)
            ) else (
                rmdir /s /q "%PKG_DIR%\%%d"
                xcopy /e /i /y "%SRC_DIR%\%%d" "%PKG_DIR%\%%d" ^> nul
                echo   [copy] %%d\
            )
        ) else (
            xcopy /e /i /y "%SRC_DIR%\%%d" "%PKG_DIR%\%%d" ^> nul
            echo   [copy] %%d\
        )
    )
)

if exist "%SRC_DIR%\package.json" (
    copy /y "%SRC_DIR%\package.json" "%PKG_DIR%\package.json" ^> nul
    echo   [copy] package.json
)
if exist "%SRC_DIR%\tsconfig.json" (
    copy /y "%SRC_DIR%\tsconfig.json" "%PKG_DIR%\tsconfig.json" ^> nul
    echo   [copy] tsconfig.json
)

echo.
echo Done. Restart pi: exit ^&^& pi
goto :eof

:uninstall
echo ==^> Uninstalling %PKG_NAME%
if exist "%PKG_DIR%" rmdir /s /q "%PKG_DIR%"
echo Done.
goto :eof

:help
echo Usage: %~nx0 [OPTIONS]
echo Options:
echo   --force            Overwrite existing files
echo   --uninstall        Remove installed files
echo   --help, -h         Show this help
goto :eof
