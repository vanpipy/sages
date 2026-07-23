@echo off
REM
REM Four Sages Installation Script for pi (Batch)
REM Installs to %USERPROFILE%\.pi\packages\sages
REM
REM Also installs AFT config + subagent templates + the 4-agent subagent
REM pipeline doc. Does NOT install npm-based peers (pi-aft, pi-magic-context,
REM pi-subagents, pi-codebase-memory, pi-graphify) — those have Linux-specific
REM deps (uv, onnxruntime) and require pi CLI; install them with
REM `pi install npm:@...` after this script completes.
REM

setlocal EnableDelayedExpansion

set "PI_DIR=%USERPROFILE%\.pi"
set "PKG_NAME=sages"
set "PKG_DIR=%PI_DIR%\packages\%PKG_NAME%"
set "REPO_URL=https://github.com/vanpipy/sages.git"
set "AGENT_DIR=%PI_DIR%\agent"

REM Force mode + mode selector (mutually exclusive)
set "FORCE=false"
set "UNINSTALL="
set "SAGES_ONLY="
set "SYSTEM_ONLY="

REM ──────── Parse args ────────
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
if /i "%~1"=="--sages-only" (
    set "SAGES_ONLY=true"
    shift
    goto :parse_args
)
if /i "%~1"=="--system-only" (
    set "SYSTEM_ONLY=true"
    shift
    goto :parse_args
)
if /i "%~1"=="--help" goto :usage
if /i "%~1"=="-h" goto :usage
echo Error: Unknown option: %~1
goto :usage

:args_done

if defined UNINSTALL goto :uninstall
if defined SAGES_ONLY goto :sages_only
if defined SYSTEM_ONLY goto :system_only

REM ──────────── DEFAULT INSTALL ────────────

echo ==^> Installing sages + AFT config + subagent templates + subagents doc + SYSTEM.md...
echo     (npm peers: pi-aft, pi-magic-context, pi-subagents, pi-codebase-memory, pi-graphify
echo      install those with 'pi install npm:...' after this script)

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
        echo Install manually: powershell -Command "iex (iwr https://pi.dev/install.ps1).Content"
        exit /b 1
    )
)

where pi >nul 2>&1
if errorlevel 1 (
    echo Error: pi not found after installation
    exit /b 1
)

REM Clone sages
echo ==^> Installing sages...
set "TMP_DIR=%TEMP%\sages-install-%RANDOM%"
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
                xcopy /s /e /y "!SRC_DIR!" "!PKG_DIR!\" >nul
                echo   Installed %%D\
            ) else (
                echo   Skipping %%D\ (exists, use --force to overwrite)
            )
        ) else (
            xcopy /s /e /y "!SRC_DIR!" "!PKG_DIR!\" >nul
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

REM Register in settings (sages package)
echo   Registering sages...
if not exist "%AGENT_DIR%" mkdir "%AGENT_DIR%" >nul 2>&1
if not exist "%AGENT_DIR%\settings.json" (
    echo { "packages": [] } > "%AGENT_DIR%\settings.json"
)
powershell -Command "$d = Get-Content '%AGENT_DIR%\settings.json' -Raw ^| ConvertFrom-Json; if(-not $d.packages) { $d.packages = @() }; $d.packages = @($d.packages ^| Where-Object { $_ -ne '%PKG_DIR%' -and $_ -notmatch '%PKG_NAME%' }); if('%PKG_DIR%' -notin $d.packages) { $d.packages += '%PKG_DIR%' }; $d ^| ConvertTo-Json -Depth 10 ^| Set-Content '%AGENT_DIR%\settings.json' -Encoding UTF8"

REM ─── AFT config (~/.config/cortexkit/aft.jsonc) ───
echo ==^> Installing AFT config template...
set "AFT_HOME=%USERPROFILE%\.config\cortexkit"
set "AFT_CONFIG=%AFT_HOME%\aft.jsonc"
set "AFT_TEMPLATE=%~dp0..\templates\aft.jsonc"
if exist "%AFT_TEMPLATE%" (
    if not exist "%AFT_HOME%" mkdir "%AFT_HOME%" >nul 2>&1
    if exist "%AFT_CONFIG%" (
        REM Sentinel check: SAGES_TEMPLATE_V1 means we installed it
        findstr /C:"SAGES_TEMPLATE_V1" "%AFT_CONFIG%" >nul 2>&1
        if not errorlevel 1 (
            if "%FORCE%"=="true" (
                copy /Y "%AFT_TEMPLATE%" "%AFT_CONFIG%" >nul
                echo   Installed AFT config from template (--force)
            ) else (
                echo   AFT config already installed (use --force to reinstall)
            )
        ) else (
            echo   AFT config user-customized (use --force to overwrite)
        )
    ) else (
        copy /Y "%AFT_TEMPLATE%" "%AFT_CONFIG%" >nul
        echo   Installed AFT config from template (feature flags enabled)
    )
) else (
    echo   Warning: AFT template not found at %AFT_TEMPLATE%
)

REM ─── Subagent templates (Stages 3+4 of 4-agent pipeline) ───
echo ==^> Installing subagent templates...
if not exist "%AGENT_DIR%\agents" mkdir "%AGENT_DIR%\agents" >nul 2>&1
for %%N in (software-auditor software-developer) do (
    set "TPL_NAME=%%N"
    set "TEMPLATE=%TMP_DIR%\pi\templates\agents\%%N.md"
    set "TARGET=%AGENT_DIR%\agents\%%N.md"

    if exist "%TEMPLATE%" (
        if exist "%TARGET%" (
            findstr /C:"SAGES_TEMPLATE_V1" "%TARGET%" >nul 2>&1
            if not errorlevel 1 (
                if "%FORCE%"=="true" (
                    copy /Y "%TEMPLATE%" "%TARGET%" >nul
                    echo   Installed %%N.md (--force)
                ) else (
                    echo   %%N.md already installed (use --force to reinstall)
                )
            ) else (
                echo   %%N.md user-customized (use --force to overwrite)
            )
        ) else (
            copy /Y "%TEMPLATE%" "%TARGET%" >nul
            echo   Installed %%N.md
        )
    ) else (
        echo   Warning: template missing: %TEMPLATE%
    )
)

REM ─── SUBAGENTS.md (4-agent pipeline doc) ───
echo ==^> Installing subagents doc...
set "SUBAGENTS_DOC_TEMPLATE=%~dp0..\templates\SUBAGENTS.md"
set "SUBAGENTS_DOC_TARGET=%AGENT_DIR%\SUBAGENTS.md"
if exist "%SUBAGENTS_DOC_TEMPLATE%" (
    if exist "%SUBAGENTS_DOC_TARGET%" (
        if "%FORCE%"=="true" (
            copy /Y "%SUBAGENTS_DOC_TEMPLATE%" "%SUBAGENTS_DOC_TARGET%" >nul
            echo   Installed SUBAGENTS.md (--force)
        ) else (
            echo   SUBAGENTS.md already exists (use --force to overwrite)
        )
    ) else (
        if not exist "%AGENT_DIR%" mkdir "%AGENT_DIR%" >nul 2>&1
        copy /Y "%SUBAGENTS_DOC_TEMPLATE%" "%SUBAGENTS_DOC_TARGET%" >nul
        echo   Installed SUBAGENTS.md (4-agent pipeline doc)
    )
) else (
    echo   Warning: SUBAGENTS.md template not found
)

REM ─── SYSTEM.md ───
set "SYSTEM_MD=%AGENT_DIR%\SYSTEM.md"
if not exist "%SYSTEM_MD%" (
    if not exist "%AGENT_DIR%" mkdir "%AGENT_DIR%" >nul 2>&1
    REM SYSTEM.md is sourced from a single template (pi/templates/SYSTEM.md) to avoid
    REM drift across install.sh / install.ps1 / install.bat.
    set "SYSTEM_TEMPLATE=%~dp0..\templates\SYSTEM.md"
    if not exist "%SYSTEM_TEMPLATE%" (
        echo   Error: SYSTEM.md template not found at %SYSTEM_TEMPLATE%
        echo   ^^(Re-download the sages repo or restore templates\SYSTEM.md^^)
    ) else (
        copy /Y "%SYSTEM_TEMPLATE%" "%SYSTEM_MD%" >nul
        echo   Installed SYSTEM.md ^^(from template^^)
    )
) else (
    if "%FORCE%"=="true" (
        set "SYSTEM_TEMPLATE=%~dp0..\templates\SYSTEM.md"
        if exist "%SYSTEM_TEMPLATE%" (
            copy /Y "%SYSTEM_TEMPLATE%" "%SYSTEM_MD%" >nul
            echo   Installed SYSTEM.md (--force)
        )
    )
)

REM Cleanup
rmdir /s /q "%TMP_DIR%" 2>nul

echo.
echo Done! Restart pi: exit ^&^& pi
exit /b 0

REM ──────────── --sages-only ────────────

:sages_only

echo ==^> Installing sages only (skip AFT config, subagent templates, SUBAGENTS.md, SYSTEM.md)...

where git >nul 2>&1
if errorlevel 1 (
    echo Error: git is required
    exit /b 1
)

echo ==^> Installing sages...
set "TMP_DIR=%TEMP%\sages-install-%RANDOM%"
if exist "%TMP_DIR%" rmdir /s /q "%TMP_DIR%"
mkdir "%TMP_DIR%" >nul 2>&1

echo   Cloning from %REPO_URL%...
git clone "%REPO_URL%" "%TMP_DIR%" >nul 2>&1
if errorlevel 1 (
    echo Error: Failed to clone sages repository
    rmdir /s /q "%TMP_DIR%" 2>nul
    exit /b 1
)

if not exist "%PKG_DIR%" mkdir "%PKG_DIR%" >nul 2>&1

for %%D in (prompts skills extensions src) do (
    set "SRC_DIR=%TMP_DIR%\pi\%%D"
    set "DEST_DIR=%PKG_DIR%\%%D"
    if exist "!SRC_DIR!" (
        if exist "!DEST_DIR!" (
            if "%FORCE%"=="true" (
                rmdir /s /q "!DEST_DIR!"
                xcopy /s /e /y "!SRC_DIR!" "!PKG_DIR!\" >nul
                echo   Installed %%D\
            ) else (
                echo   Skipping %%D\ (exists, use --force to overwrite)
            )
        ) else (
            xcopy /s /e /y "!SRC_DIR!" "!PKG_DIR!\" >nul
            echo   Installed %%D\
        )
    )
)

REM package.json
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
if not exist "%AGENT_DIR%" mkdir "%AGENT_DIR%" >nul 2>&1
if not exist "%AGENT_DIR%\settings.json" (
    echo { "packages": [] } > "%AGENT_DIR%\settings.json"
)
powershell -Command "$d = Get-Content '%AGENT_DIR%\settings.json' -Raw ^| ConvertFrom-Json; if(-not $d.packages) { $d.packages = @() }; $d.packages = @($d.packages ^| Where-Object { $_ -ne '%PKG_DIR%' -and $_ -notmatch '%PKG_NAME%' }); if('%PKG_DIR%' -notin $d.packages) { $d.packages += '%PKG_DIR%' }; $d ^| ConvertTo-Json -Depth 10 ^| Set-Content '%AGENT_DIR%\settings.json' -Encoding UTF8"
echo   Registered sages

rmdir /s /q "%TMP_DIR%" 2>nul

echo   ^^(skipped: AFT config, subagent templates, SUBAGENTS.md, SYSTEM.md^^)
echo.
echo Done! Restart pi: exit ^&^& pi
exit /b 0

REM ──────────── --system-only ────────────

:system_only

echo ==^> Installing SYSTEM.md only (skip sages, AFT config, subagent templates, SUBAGENTS.md)...
if not exist "%AGENT_DIR%" mkdir "%AGENT_DIR%" >nul 2>&1
set "SYSTEM_MD=%AGENT_DIR%\SYSTEM.md"
set "SYSTEM_TEMPLATE=%~dp0..\templates\SYSTEM.md"
if exist "%SYSTEM_MD%" (
    if "%FORCE%"=="true" (
        if exist "%SYSTEM_TEMPLATE%" (
            copy /Y "%SYSTEM_TEMPLATE%" "%SYSTEM_MD%" >nul
            echo   Installed SYSTEM.md (--force)
        )
    ) else (
        echo   SYSTEM.md already exists (use --force to overwrite)
    )
) else (
    if exist "%SYSTEM_TEMPLATE%" (
        copy /Y "%SYSTEM_TEMPLATE%" "%SYSTEM_MD%" >nul
        echo   Installed SYSTEM.md ^^(from template^^)
    ) else (
        echo   Error: SYSTEM.md template not found at %SYSTEM_TEMPLATE%
    )
)

echo   ^^(skipped: sages, AFT config, subagent templates, SUBAGENTS.md^^)
echo.
echo Done! Restart pi: exit ^&^& pi
exit /b 0

REM ──────────── USAGE ────────────

:usage
echo Usage: %~nx0 [OPTIONS]
echo.
echo Options:
echo   --prefix DIR       Set pi config dir (default: ~\^.pi)
echo   --force            Overwrite existing files
echo   --uninstall        Remove installed files
echo   --sages-only       Only install sages source files (still clones)
echo   --system-only      Only install SYSTEM.md
echo   --help, -h         Show this help message
exit /b 0

REM ──────────── UNINSTALL ────────────

:uninstall

echo ==^> Uninstalling sages + AFT config + subagent templates + SUBAGENTS.md...

REM Remove sages package
if exist "%PKG_DIR%" (
    rmdir /s /q "%PKG_DIR%"
    echo   Removed sages
)

REM Unregister from settings.json
if exist "%AGENT_DIR%\settings.json" (
    powershell -Command "$d = Get-Content '%AGENT_DIR%\settings.json' -Raw ^| ConvertFrom-Json; $d.packages = @($d.packages ^| Where-Object { $_ -ne '%PKG_DIR%' -and $_ -notmatch '%PKG_NAME%' }); $d ^| ConvertTo-Json -Depth 10 ^| Set-Content '%AGENT_DIR%\settings.json' -Encoding UTF8"
    echo   Unregistered sages
)

REM Remove AFT config (only if our SAGES_TEMPLATE_V1 sentinel)
set "AFT_CONFIG=%USERPROFILE%\.config\cortexkit\aft.jsonc"
if exist "%AFT_CONFIG%" (
    findstr /C:"SAGES_TEMPLATE_V1" "%AFT_CONFIG%" >nul 2>&1
    if not errorlevel 1 (
        del /Q "%AFT_CONFIG%"
        echo   Removed AFT config (was our template)
    ) else (
        echo   AFT config user-customized, leaving alone
    )
)

REM Remove subagent templates (only if our sentinel)
for %%N in (software-auditor software-developer) do (
    set "TARGET=%AGENT_DIR%\agents\%%N.md"
    if exist "%TARGET%" (
        findstr /C:"SAGES_TEMPLATE_V1" "%TARGET%" >nul 2>&1
        if not errorlevel 1 (
            del /Q "%TARGET%"
            echo   Removed %%N.md (was our template)
        ) else (
            echo   %%N.md user-customized, leaving alone
        )
    )
)

REM Remove SUBAGENTS.md (only if content matches template byte-for-byte)
set "SUBAGENTS_DOC_TEMPLATE=%~dp0..\templates\SUBAGENTS.md"
set "SUBAGENTS_DOC_TARGET=%AGENT_DIR%\SUBAGENTS.md"
if exist "%SUBAGENTS_DOC_TARGET%" (
    if exist "%SUBAGENTS_DOC_TEMPLATE%" (
        REM fc /B returns 0 on identical files; >0 otherwise
        fc /B "%SUBAGENTS_DOC_TARGET%" "%SUBAGENTS_DOC_TEMPLATE%" >nul 2>&1
        if not errorlevel 1 (
            del /Q "%SUBAGENTS_DOC_TARGET%"
            echo   Removed SUBAGENTS.md (was our template)
        ) else (
            echo   SUBAGENTS.md user-customized, leaving alone
        )
    ) else (
        echo   SUBAGENTS.md comparison template missing, leaving alone
    )
)

REM SYSTEM.md has no sentinel — leave in place unless --force requested
if exist "%AGENT_DIR%\SYSTEM.md" (
    echo   SYSTEM.md left in place (no sentinel; user-customized docs preserved)
)

echo.
echo Done. Restart pi: exit ^&^& pi
exit /b 0
