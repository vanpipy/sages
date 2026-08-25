#!/usr/bin/env pwsh
#
# Four Sages Installation Script for pi (PowerShell)
# Installs to $env:USERPROFILE\.pi\packages\sages
#
# Also installs magic-context config + subagent templates +
# the 4-agent subagent pipeline doc. Does NOT install npm-based peers
# (pi-magic-context, pi-subagents, pi-codebase-memory, pi-evaluator)
# — those have Linux-specific deps (uv, onnxruntime) and require pi CLI;
# install them with `pi install npm:@...` after this script completes.
#
# Note: AFT (pi-code-intel via @cortexkit/aft-pi) is NOT auto-installed.
# Binary provisioning is owned by the AFT team; users run
#     npx @cortexkit/aft@latest setup --harness pi
# manually. pi/templates/aft.jsonc ships as a reference template the
# user can copy to $env:USERPROFILE\.config\cortexkit\aft.jsonc after installation.
#

param(
    [string]$Prefix,
    [switch]$Force,
    [switch]$Uninstall,
    [switch]$SagesOnly,
    [switch]$SystemOnly,
    [switch]$Help
)

$ErrorActionPreference = 'Stop'

# Core paths
$PI_DIR = if ($Prefix) { $Prefix } else { "$env:USERPROFILE\.pi" }
$PKG_NAME = "sages"
$PKG_DIR = "$PI_DIR\packages\$PKG_NAME"
$REPO_URL = "https://github.com/vanpipy/sages.git"
$AGENT_DIR = "$PI_DIR\agent"

# Subagent template install info (GC-2026-066 reversal).
#
# Every default subagent (Explore, Plan, developer, auditor) is a
# canonical built-in in pi-subagents — see
# `pi-subagents/src/default-agents.ts`. No user-level template is
# shipped, and there is no install / uninstall path for subagent
# templates anymore. Pre-existing user-level developer.md /
# auditor.md (if installed by older install.sh / install.ps1 /
# install.bat versions) are LEFT IN PLACE for the user to remove
# manually. New user customizations go in `~/.pi/agent/agents/`
# (global) or `.pi/agents/` (project) and override the built-in via
# direct registry-hit precedence in `registerAgents` (see
# agent-types.ts).
#
# The `$SUBAGENT_SENTINEL` constant below stays — it's stamped into
# the agent-tool-description.md template so its uninstall path can tell
# which copy is ours.

$SUBAGENT_SENTINEL = "SAGES_TEMPLATE_V1"

# Temp directory for cloning (unique per run)
$script:TMP_DIR = ""

function cleanup {
    if ($script:TMP_DIR -and (Test-Path $script:TMP_DIR)) {
        Remove-Item -Recurse -Force $script:TMP_DIR -ErrorAction SilentlyContinue
    }
}

function usage {
    Write-Host "Usage: $PSCommandPath [OPTIONS]"
    Write-Host ""
    Write-Host "Options:"
    Write-Host "  -Prefix DIR       Set pi config dir (default: ~\.pi)"
    Write-Host "  -Force            Overwrite existing files"
    Write-Host "  -Uninstall        Remove installed files"
    Write-Host "  -SagesOnly        Only install sages source files (still clones)"
    Write-Host "  -SystemOnly       Only install SYSTEM.md"
    Write-Host "  -Help             Show this help message"
}

function check_git {
    $git = Get-Command git -ErrorAction SilentlyContinue
    if (-not $git) {
        Write-Host "Error: git is required" -ForegroundColor Red
        exit 1
    }
}

function install_pi_if_needed {
    $pi = Get-Command pi -ErrorAction SilentlyContinue
    if (-not $pi) {
        Write-Host "==> Installing pi..."
        try {
            $script = Invoke-WebRequest -Uri "https://pi.dev/install.ps1" -UseBasicParsing
            Invoke-Expression $script.Content
        } catch {
            Write-Host "Error: pi installation failed" -ForegroundColor Red
            Write-Host "Install manually: iwr https://pi.dev/install.ps1 | iex" -ForegroundColor Yellow
            exit 1
        }
    }
}

# True if $File exists and carries our SAGES_TEMPLATE_V1 sentinel.
# Used by the agent-tool-description.md install path to detect user-
# customized copies (mirrors `is_*_installed` patterns in install.sh).
function IsAgentToolDescriptionInstalled {
    param([string]$File)
    if (-not (Test-Path $File)) { return $false }
    $content = Get-Content $File -Raw -ErrorAction SilentlyContinue
    if (-not $content) { return $false }
    return $content.Contains($SUBAGENT_SENTINEL)
}

function install_system_prompt {
    $null = New-Item -ItemType Directory -Path $AGENT_DIR -Force -ErrorAction SilentlyContinue

    # SYSTEM.md is sourced from a single template (pi/templates/SYSTEM.md) to avoid
    # drift across install.sh / install.ps1 / install.bat.
    $scriptDir = Split-Path -Parent $PSCommandPath
    $systemTemplate = Join-Path $scriptDir "..\templates\SYSTEM.md"
    if (-not (Test-Path $systemTemplate)) {
        Write-Host "  Error: SYSTEM.md template not found at $systemTemplate"
        Write-Host "  (Re-download the sages repo or restore templates/SYSTEM.md)"
        return
    }
    Copy-Item -Path $systemTemplate -Destination "$AGENT_DIR\SYSTEM.md" -Force
    Write-Host "  Installed SYSTEM.md (from template)"
}

function register_settings {
    $settings = "$PI_DIR\agent\settings.json"
    $null = New-Item -ItemType Directory -Path (Split-Path $settings) -Force -ErrorAction SilentlyContinue

    $data = @{ packages = @() }
    if (Test-Path $settings) {
        try {
            $data = Get-Content $settings -Raw | ConvertFrom-Json
            if (-not $data.packages) { $data.packages = @() }
        } catch {
            $data = @{ packages = @() }
        }
    }

    # Remove existing sages entry, then add
    $data.packages = @($data.packages | Where-Object {
        $_ -ne $PKG_DIR -and $_ -notmatch $PKG_NAME
    })

    if ($PKG_DIR -notin $data.packages) {
        $data.packages += $PKG_DIR
    }

    $data | ConvertTo-Json -Depth 10 | Set-Content $settings -Encoding UTF8
    Write-Host "  Registered sages"
}

function unregister_settings {
    $settings = "$PI_DIR\agent\settings.json"
    if (-not (Test-Path $settings)) { return }

    try {
        $data = Get-Content $settings -Raw | ConvertFrom-Json
        $data.packages = @($data.packages | Where-Object {
            $_ -ne $PKG_DIR -and $_ -notmatch $PKG_NAME
        })
        $data | ConvertTo-Json -Depth 10 | Set-Content $settings -Encoding UTF8
        Write-Host "  Unregistered sages"
    } catch {
        Write-Host "  Warning: $_"
    }
}

function install {
    Write-Host "==> Installing sages + subagent templates + subagents doc + SYSTEM.md..."
    Write-Host "    (npm peers: pi-magic-context, pi-subagents, pi-codebase-memory, pi-evaluator" -NoNewline
    Write-Host " — install those with 'pi install npm:...' after this script)"

    # Pre-flight checks
    check_git
    install_pi_if_needed

    # Verify pi is available
    $pi = Get-Command pi -ErrorAction SilentlyContinue
    if (-not $pi) {
        Write-Host "Error: pi not found after installation" -ForegroundColor Red
        exit 1
    }

    # Clone sages
    Write-Host "==> Installing sages..."
    $script:TMP_DIR = Join-Path ([System.IO.Path]::GetTempPath()) "sages-install-$([guid]::NewGuid().ToString('N'))"
    $null = New-Item -ItemType Directory -Path $script:TMP_DIR -Force

    Write-Host "  Cloning from $REPO_URL..."
    try {
        git clone $REPO_URL $script:TMP_DIR 2>&1 | Out-Null
    } catch {
        Write-Host "Error: Failed to clone sages repository" -ForegroundColor Red
        cleanup
        exit 1
    }

    # Install sages
    $null = New-Item -ItemType Directory -Path $PKG_DIR -Force -ErrorAction SilentlyContinue

    $dirs = @("prompts", "skills", "extensions", "src", "profiles", "subagents", "templates")
    foreach ($dir in $dirs) {
        $srcDir = Join-Path $script:TMP_DIR "pi\$dir"
        $destDir = Join-Path $PKG_DIR $dir

        if (-not (Test-Path $srcDir)) {
            continue
        }

        if ((Test-Path $destDir) -and -not $Force) {
            Write-Host "  Skipping $dir\ (exists, use -Force to overwrite)"
        } else {
            if (Test-Path $destDir) {
                Remove-Item -Recurse -Force $destDir
            }
            Copy-Item -Recurse $srcDir $PKG_DIR\
            Write-Host "  Installed $dir\"
        }
    }

    # Handle package.json
    $pkgJsonDest = Join-Path $PKG_DIR "package.json"
    if ((Test-Path $pkgJsonDest) -and -not $Force) {
        Write-Host "  Keeping existing package.json"
    } else {
        $pkgJsonSrc = Join-Path $script:TMP_DIR "pi\package.json"
        if (Test-Path $pkgJsonSrc) {
            Copy-Item $pkgJsonSrc $pkgJsonDest -Force
            Write-Host "  Installed package.json"
        }
    }

    # Register in settings
    register_settings

    # Install SYSTEM.md
    $systemMdPath = Join-Path $AGENT_DIR "SYSTEM.md"
    if ((-not (Test-Path $systemMdPath)) -or $Force) {
        Write-Host "==> Installing SYSTEM.md..."
        install_system_prompt
    }

    # Cleanup
    cleanup

    Write-Host ""
    Write-Host "Done! Restart pi: exit && pi" -ForegroundColor Green
}

function install_sages_only {
    # Mirrors install.sh's --sages-only: clones repo + installs sages source +
    # registers in settings.json, but skips all peers + templates + SYSTEM.md.
    Write-Host "==> Installing sages only (skip subagent templates, SYSTEM.md)..."

    check_git
    install_pi_if_needed

    $pi = Get-Command pi -ErrorAction SilentlyContinue
    if (-not $pi) {
        Write-Host "Error: pi not found after installation" -ForegroundColor Red
        exit 1
    }

    Write-Host "==> Installing sages..."
    $script:TMP_DIR = Join-Path ([System.IO.Path]::GetTempPath()) "sages-install-$([guid]::NewGuid().ToString('N'))"
    $null = New-Item -ItemType Directory -Path $script:TMP_DIR -Force

    Write-Host "  Cloning from $REPO_URL..."
    try {
        git clone $REPO_URL $script:TMP_DIR 2>&1 | Out-Null
    } catch {
        Write-Host "Error: Failed to clone sages repository" -ForegroundColor Red
        cleanup
        exit 1
    }

    $null = New-Item -ItemType Directory -Path $PKG_DIR -Force -ErrorAction SilentlyContinue

    $dirs = @("prompts", "skills", "extensions", "src", "profiles", "subagents", "templates")
    foreach ($dir in $dirs) {
        $srcDir = Join-Path $script:TMP_DIR "pi\$dir"
        $destDir = Join-Path $PKG_DIR $dir
        if (-not (Test-Path $srcDir)) { continue }
        if ((Test-Path $destDir) -and -not $Force) {
            Write-Host "  Skipping $dir\ (exists, use -Force to overwrite)"
        } else {
            if (Test-Path $destDir) { Remove-Item -Recurse -Force $destDir }
            Copy-Item -Recurse $srcDir $PKG_DIR\
            Write-Host "  Installed $dir\"
        }
    }

    $pkgJsonDest = Join-Path $PKG_DIR "package.json"
    if (-not (Test-Path $pkgJsonDest) -or $Force) {
        $pkgJsonSrc = Join-Path $script:TMP_DIR "pi\package.json"
        if (Test-Path $pkgJsonSrc) {
            Copy-Item $pkgJsonSrc $pkgJsonDest -Force
            Write-Host "  Installed package.json"
        }
    } else {
        Write-Host "  Keeping existing package.json"
    }

    register_settings
    cleanup

    Write-Host "  (skipped: subagent templates, SYSTEM.md)"
    Write-Host ""
    Write-Host "Done! Restart pi: exit && pi" -ForegroundColor Green
}

function install_system_only {
    # Mirrors install.sh's --system-only: only install/update SYSTEM.md.
    Write-Host "==> Installing SYSTEM.md only (skip sages, subagent templates)..."

    $systemMdPath = Join-Path $AGENT_DIR "SYSTEM.md"
    if ((-not (Test-Path $systemMdPath)) -or $Force) {
        install_system_prompt
    } else {
        Write-Host "  SYSTEM.md already exists (use -Force to overwrite)"
    }

    Write-Host "  (skipped: sages, subagent templates)"
    Write-Host ""
    Write-Host "Done! Restart pi: exit && pi" -ForegroundColor Green
}

function uninstall {
    Write-Host "==> Uninstalling sages + subagent templates + SYSTEM.md..."

    # Remove sages
    if (Test-Path $PKG_DIR) {
        Remove-Item -Recurse -Force $PKG_DIR
        Write-Host "  Removed sages"
    }

    # Unregister sages
    unregister_settings

    # SYSTEM.md is plain markdown with no sentinel — leave it alone unless no sage
    # source is left (this matches install.sh's behavior — uninstall doesn't
    # touch SYSTEM.md because the user might want to keep it as a reference).
    if (Test-Path "$AGENT_DIR\SYSTEM.md") {
        Write-Host "  SYSTEM.md left in place (no sentinel; user-customized docs preserved)"
    }

    Write-Host ""
    Write-Host "Done. Restart pi: exit && pi" -ForegroundColor Green
}

# Main
if ($Help) {
    usage
    exit 0
}

if ($Uninstall) {
    uninstall
} elseif ($SagesOnly) {
    install_sages_only
} elseif ($SystemOnly) {
    install_system_only
} else {
    install
}
