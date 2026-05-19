@echo off
REM
REM Four Sages Installation Script for pi (Batch)
REM Installs to %USERPROFILE%\.pi\packages\sages
REM
REM Also installs pi-memory for persistent memory capabilities
REM

setlocal EnableDelayedExpansion

set "PI_DIR=%USERPROFILE%\.pi"
set "PKG_NAME=sages"
set "PKG_DIR=%PI_DIR%\packages\%PKG_NAME%"
set "REPO_URL=https://github.com/vanpipy/sages.git"
set "AGENT_DIR=%PI_DIR%\agent"
set "PI_MEMORY_PKG=npm:@samfp/pi-memory"

set "FORCE=false"
set "UNINSTALL="

:parse_args
if "%~1"=="" goto :args_done
if /i "%~1"=="--prefix" (
    set "PI_DIR=%~2"
    set "PKG_DIR=%PI_DIR%\packages\%PKG_NAME%"
    shift
    shift
    goto :parse_args
)
if /i "%~1"=="--force" (
    set "FORCE=true"
    shift
    goto :parse_args
)
if /i "%~1"=="--uninstall" (
    set "UNINSTALL=true"
    shift
    goto :parse_args
)
if /i "%~1"=="--help" goto :usage
if /i "%~1"=="-h" goto :usage
echo Error: Unknown option: %~1
goto :usage

:args_done

if defined UNINSTALL goto :uninstall

REM ===================== INSTALL =====================

echo ==^> Installing sages + pi-memory...

REM Pre-flight checks
where git >nul 2>&1
if errorlevel 1 (
    echo Error: git is required
    exit /b 1
)

REM Check if pi is installed
where pi >nul 2>&1
if errorlevel 1 (
    echo ==^> Installing pi...
    powershell -Command "iex (iwr https://pi.dev/install.ps1).Content"
    if errorlevel 1 (
        echo Error: pi installation failed
        echo Install manually: powershell -Command \"iex (iwr https://pi.dev/install.ps1).Content\"
        exit /b 1
    )
)

REM Verify pi is available
where pi >nul 2>&1
if errorlevel 1 (
    echo Error: pi not found after installation
    exit /b 1
)

REM Install pi-memory (simple check)
echo ==^> Installing pi-memory...
set "SETTINGS=%PI_DIR%\agent\settings.json"
if not exist "%SETTINGS%" (
    echo { "packages": [] } > "%SETTINGS%"
)

REM Check if pi-memory already installed
findstr /C:"%PI_MEMORY_PKG%" "%SETTINGS%" >nul 2>&1
if not errorlevel 1 (
    echo   pi-memory already installed
) else (
    findstr /C:"@samfp/pi-memory" "%SETTINGS%" >nul 2>&1
    if not errorlevel 1 (
        echo   pi-memory already installed
    ) else (
        echo   Adding to settings.json...
        powershell -Command "$d = Get-Content '%SETTINGS%' -Raw ^| ConvertFrom-Json; if(-not $d.packages) { $d.packages = @() }; if('%PI_MEMORY_PKG%' -notin $d.packages) { $d.packages += '%PI_MEMORY_PKG%' }; $d ^| ConvertTo-Json -Depth 10 ^| Set-Content '%SETTINGS%' -Encoding UTF8"
        echo   Installed pi-memory
    )
)

REM Clone sages
echo ==^> Installing sages...
set "TMP_DIR=%TEMP%\sages-install"
if exist "%TMP_DIR%" rmdir /s /q "%TMP_DIR%"
mkdir "%TMP_DIR%" >nul 2>&1

echo   Cloning from %REPO_URL%...
git clone "%REPO_URL%" "%TMP_DIR%" >nul 2>&1
if errorlevel 1 (
    echo Error: Failed to clone sages repository
    rmdir /s /q "%TMP_DIR%" 2>nul
    exit /b 1
)

REM Install sages
if not exist "%PKG_DIR%" mkdir "%PKG_DIR%" >nul 2>&1

for %%D in (prompts skills extensions src) do (
    set "SRC_DIR=%TMP_DIR%\pi\%%D"
    set "DEST_DIR=%PKG_DIR%\%%D"
    
    if exist "!SRC_DIR!" (
        if exist "!DEST_DIR!" (
            if "%FORCE%"=="true" (
                rmdir /s /q "!DEST_DIR!"
                xcopy /s /e /y "!SRC_DIR!" "!PKG_DIR!\"
                echo   Installed %%D\
            ) else (
                echo   Skipping %%D\ (exists, use --force to overwrite)
            )
        ) else (
            xcopy /s /e /y "!SRC_DIR!" "!PKG_DIR!\"
            echo   Installed %%D\
        )
    )
)

REM Handle package.json
set "PKG_JSON=%PKG_DIR%\package.json"
set "PKG_JSON_SRC=%TMP_DIR%\pi\package.json"
if exist "%PKG_JSON%" (
    if "%FORCE%"=="true" (
        if exist "%PKG_JSON_SRC%" (
            copy /y "%PKG_JSON_SRC%" "%PKG_JSON%" >nul
            echo   Installed package.json
        )
    ) else (
        echo   Keeping existing package.json
    )
) else (
    if exist "%PKG_JSON_SRC%" (
        copy /y "%PKG_JSON_SRC%" "%PKG_JSON%" >nul
        echo   Installed package.json
    )
)

REM Register in settings
echo   Registering sages...
if not exist "%AGENT_DIR%" mkdir "%AGENT_DIR%" >nul 2>&1
if not exist "%SETTINGS%" (
    echo { "packages": [] } > "%SETTINGS%"
)
powershell -Command "$d = Get-Content '%SETTINGS%' -Raw ^| ConvertFrom-Json; if(-not $d.packages) { $d.packages = @() }; $d.packages = @($d.packages ^| Where-Object { $_ -ne '%PKG_DIR%' -and $_ -notmatch '%PKG_NAME%' }); if('%PKG_DIR%' -notin $d.packages) { $d.packages += '%PKG_DIR%' }; $d ^| ConvertTo-Json -Depth 10 ^| Set-Content '%SETTINGS%' -Encoding UTF8"

REM Install system prompt
set "SYSTEM_MD=%AGENT_DIR%\SYSTEM.md"
if not exist "%SYSTEM_MD%" (
    if not exist "%AGENT_DIR%" mkdir "%AGENT_DIR%" >nul 2>&1
    (
        echo # Role: DevSecOps ^& Polyglot Systems Engineer
        echo.
        echo You are a strategic expert specializing in AI-driven DevOps, Security ^& Penetration Testing, and Multi-language Engineering.
        echo.
        echo ## Context Prioritization ^& Constitution
        echo **At the START of EVERY session, before any implementation work:**
        echo.
        echo 1. **Scan for and read these files IN ORDER:**
        echo    - `.specify/memory/constitution.md` - project constitution
        echo    - `.pi/SYSTEM.md` or `CLAUDE.md` - project-specific overrides
        echo    - `AGENTS.md` - agent instructions
        echo    - `SPEC.md` or `SPECIFY.md` - project specifications
        echo.
        echo 2. **Local Dominance**: Project-specific rules override global directives.
        echo.
        echo 3. **Store in memory**: Use `memory_remember` to persist project-specific rules.
        echo.
        echo 4. **Execution Gate**: Verify specific constraints before taking action.
        echo.
        echo ## TDD Enforcement Hook
        echo **Every implementation request MUST follow:**
        echo 1. **Red Stage**: Write the test case first.
        echo 2. **Verification Stage**: Execute to confirm failure.
        echo 3. **Green Stage**: Write minimal code to pass.
        echo 4. **Refactor Stage**: Optimize for readability and performance.
        echo.
        echo ## Core Principles
        echo - **Go**: High-performance orchestration and TUI systems.
        echo - **Python**: Exploit development, automation, deep security auditing.
        echo - **Java**: Type-safe backend support without framework bloat.
        echo - **Node.js**: Event-driven tasks with async safety.
        echo.
        echo ## Universal Protocol
        echo - Version Control: Conventional Commits.
        echo - Automation First: Unix-pipe philosophy and state persistence.
        echo - Communication: Direct and technical with Markdown tables.
    ) > "%SYSTEM_MD%"
    echo   Installed SYSTEM.md
)

REM Cleanup
rmdir /s /q "%TMP_DIR%" 2>nul

echo.
echo Done! Restart pi: exit ^&^& pi
exit /b 0

REM ===================== UNINSTALL =====================

:uninstall

echo ==^> Uninstalling sages + pi-memory...

REM Remove sages
if exist "%PKG_DIR%" (
    rmdir /s /q "%PKG_DIR%"
    echo   Removed sages
)

REM Unregister sages
if exist "%SETTINGS%" (
    powershell -Command "$d = Get-Content '%SETTINGS%' -Raw ^| ConvertFrom-Json; $d.packages = @($d.packages ^| Where-Object { $_ -ne '%PKG_DIR%' -and $_ -notmatch '%PKG_NAME%' }); $d ^| ConvertTo-Json -Depth 10 ^| Set-Content '%SETTINGS%' -Encoding UTF8"
    echo   Unregistered sages
)

REM Uninstall pi-memory
echo ==^> Uninstalling pi-memory...
if exist "%SETTINGS%" (
    powershell -Command "$d = Get-Content '%SETTINGS%' -Raw ^| ConvertFrom-Json; $d.packages = @($d.packages ^| Where-Object { $_ -ne '%PI_MEMORY_PKG%' -and $_ -ne 'pi-memory' -and $_ -ne '@samfp/pi-memory' }); $d ^| ConvertTo-Json -Depth 10 ^| Set-Content '%SETTINGS%' -Encoding UTF8"
    echo   Removed %PI_MEMORY_PKG%
)

set "MEMORY_DIR=%PI_DIR%\packages\pi-memory"
if exist "%MEMORY_DIR%" (
    rmdir /s /q "%MEMORY_DIR%"
    echo   Removed %MEMORY_DIR%
)

echo.
echo Done. Restart pi: exit ^&^& pi
exit /b 0

REM ===================== USAGE =====================

:usage
echo Usage: %~nx0 [OPTIONS]
echo.
echo Options:
echo   --prefix DIR       Set pi config dir (default: ~\^.pi)
echo   --force            Overwrite existing files
echo   --uninstall        Remove installed files
echo   --help, -h         Show this help message
exit /b 0
