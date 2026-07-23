#!/usr/bin/env pwsh
#
# Four Sages Installation Script for pi (PowerShell)
# Installs to $env:USERPROFILE\.pi\packages\sages
#
# Also installs AFT config + magic-context config + subagent templates +
# the 4-agent subagent pipeline doc. Does NOT install npm-based peers
# (pi-aft, pi-magic-context, pi-subagents, pi-codebase-memory, pi-graphify)
# — those have Linux-specific deps (uv, onnxruntime) and require pi CLI;
# install them with `pi install npm:@...` after this script completes.
#

$ErrorActionPreference = 'Stop'

param(
    [string]$Prefix,
    [switch]$Force,
    [switch]$Uninstall,
    [switch]$SagesOnly,
    [switch]$SystemOnly,
    [switch]$Help
)

# Core paths
$PI_DIR = if ($Prefix) { $Prefix } else { "$env:USERPROFILE\.pi" }
$PKG_NAME = "sages"
$PKG_DIR = "$PI_DIR\packages\$PKG_NAME"
$REPO_URL = "https://github.com/vanpipy/sages.git"
$AGENT_DIR = "$PI_DIR\agent"

# Subagent template install info (mirrors install.sh).
# Source: pi/templates/agents/{software-auditor,software-developer}.md
# Target: $AGENT_DIR\agents\ — global agent definitions loaded by pi-subagents.
# Without these, sages' orchestrator can't dispatch software-{auditor,developer}
# subagents by name. The 2 built-in agents (Explore, Plan) come from pi-subagents
# and need no install — see also SUBAGENTS.md for the full 4-agent pipeline.
$SUBAGENT_TEMPLATE_DIR = Join-Path (Split-Path -Parent $PSCommandPath) "..\templates\agents"
$SUBAGENT_TARGET_DIR = "$AGENT_DIR\agents"
$SUBAGENT_NAMES = @("software-auditor", "software-developer")
$SUBAGENT_SENTINEL = "SAGES_TEMPLATE_V1"

# Subagent pipeline doc — installed alongside agent .md files. Plain markdown,
# NOT parsed by pi-subagents (lives outside agents/, so it's not loaded as an
# agent def even though YAML frontmatter is absent).
$SUBAGENTS_DOC_TEMPLATE = Join-Path (Split-Path -Parent $PSCommandPath) "..\templates\SUBAGENTS.md"
$SUBAGENTS_DOC_TARGET = "$AGENT_DIR\SUBAGENTS.md"

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
# Mirrors is_subagent_template_installed() in install.sh — uses a grep
# equivalent (Select-String) so user-written agent files (no sentinel)
# are preserved on re-install.
function IsSubagentTemplateInstalled {
    param([string]$File)
    if (-not (Test-Path $File)) { return $false }
    $content = Get-Content $File -Raw -ErrorAction SilentlyContinue
    if (-not $content) { return $false }
    return $content.Contains($SUBAGENT_SENTINEL)
}

# Copy each $SUBAGENT_NAMES template to $SUBAGENT_TARGET_DIR. Idempotent:
#   - missing → install from template
#   - file exists with sentinel → skip (already installed by us)
#   - file exists without sentinel → user-customized; skip unless -Force
function Install-SubagentTemplates {
    if (-not (Test-Path $SUBAGENT_TEMPLATE_DIR)) {
        Write-Host "  Warning: subagent template dir not found at $SUBAGENT_TEMPLATE_DIR"
        Write-Host "  (Re-download the sages repo or restore templates/agents/)"
        return
    }

    $null = New-Item -ItemType Directory -Path $SUBAGENT_TARGET_DIR -Force -ErrorAction SilentlyContinue

    foreach ($name in $SUBAGENT_NAMES) {
        $template = Join-Path $SUBAGENT_TEMPLATE_DIR "$name.md"
        $target = Join-Path $SUBAGENT_TARGET_DIR "$name.md"

        if (-not (Test-Path $template)) {
            Write-Host "  Warning: template not found: $template (skipping $name)"
            continue
        }

        if ((Test-Path $target) -and (IsSubagentTemplateInstalled $target) -and -not $Force) {
            Write-Host "  $name.md already installed (use -Force to reinstall)"
            continue
        }
        if ((Test-Path $target) -and -not (IsSubagentTemplateInstalled $target) -and -not $Force) {
            Write-Host "  $name.md exists with user customization (use -Force to overwrite)"
            continue
        }

        if (Test-Path $target) { Remove-Item -Force $target }
        Copy-Item $template $target
        Write-Host "  Installed $name.md (subagent template)"
    }
}

# Remove agent files in $SUBAGENT_TARGET_DIR ONLY if they carry our sentinel.
# User-written or hand-edited agent files are left alone (NEVER-TOUCH policy,
# same as install.sh's uninstall_subagent_templates).
function Uninstall-SubagentTemplates {
    foreach ($name in $SUBAGENT_NAMES) {
        $target = Join-Path $SUBAGENT_TARGET_DIR "$name.md"
        if (-not (Test-Path $target)) { continue }
        if (IsSubagentTemplateInstalled $target) {
            Remove-Item -Force $target
            Write-Host "  Removed $name.md (was our template)"
        } else {
            Write-Host "  $name.md is user-customized, leaving alone"
        }
    }
}

# Install the 4-agent pipeline doc (SUBAGENTS.md). Idempotent:
#   - missing → install from template
#   - file exists → skip unless -Force (user-customized)
# Plain markdown, no sentinel — diff'd against template at uninstall time.
function Install-SubagentsDoc {
    if (-not (Test-Path $SUBAGENTS_DOC_TEMPLATE)) {
        Write-Host "  Warning: SUBAGENTS.md template not found at $SUBAGENTS_DOC_TEMPLATE"
        return
    }

    if ((Test-Path $SUBAGENTS_DOC_TARGET) -and -not $Force) {
        Write-Host "  SUBAGENTS.md already exists (use -Force to overwrite)"
        return
    }

    $null = New-Item -ItemType Directory -Path (Split-Path $SUBAGENTS_DOC_TARGET) -Force -ErrorAction SilentlyContinue
    Copy-Item $SUBAGENTS_DOC_TEMPLATE $SUBAGENTS_DOC_TARGET -Force
    Write-Host "  Installed SUBAGENTS.md (4-agent pipeline doc)"
}

function Uninstall-SubagentsDoc {
    if (-not (Test-Path $SUBAGENTS_DOC_TARGET)) { return }
    if (-not (Test-Path $SUBAGENTS_DOC_TEMPLATE)) {
        Write-Host "  SUBAGENTS.md comparison template missing, leaving alone"
        return
    }
    # Compare via canonical paths to handle the ..\templates\SUBAGENTS.md relative form
    $a = (Resolve-Path $SUBAGENTS_DOC_TARGET).Path
    $b = (Resolve-Path $SUBAGENTS_DOC_TEMPLATE).Path
    if ((Get-FileHash $a).Hash -eq (Get-FileHash $b).Hash) {
        Remove-Item -Force $SUBAGENTS_DOC_TARGET
        Write-Host "  Removed SUBAGENTS.md (was our template)"
    } else {
        Write-Host "  SUBAGENTS.md is user-customized, leaving alone"
    }
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

function install_aft_config {
    # AFT config (~/.config/cortexkit/aft.jsonc) — feature flags template.
    # Best-effort copy: silently skipped if AFT user template is hand-edited
    # (matches install.sh's NEVER-TOUCH policy via SAGES_TEMPLATE_V1 sentinel).
    # We mirror that with the same sentinel string + content sanity check.
    $aftHome = Join-Path $env:USERPROFILE ".config\cortexkit"
    $aftConfig = Join-Path $aftHome "aft.jsonc"
    $scriptDir = Split-Path -Parent $PSCommandPath
    $aftTemplate = Join-Path $scriptDir "..\templates\aft.jsonc"

    if (-not (Test-Path $aftTemplate)) {
        Write-Host "  Warning: AFT template not found at $aftTemplate"
        return
    }

    $null = New-Item -ItemType Directory -Path $aftHome -Force -ErrorAction SilentlyContinue

    # Already installed by us → skip
    if ((Test-Path $aftConfig) -and (Select-String -Path $aftConfig -Pattern "SAGES_TEMPLATE_V1" -Quiet) -and -not $Force) {
        Write-Host "  AFT config already installed (use -Force to reinstall)"
        return
    }
    # User-customized → preserve
    if ((Test-Path $aftConfig) -and -not $Force) {
        Write-Host "  AFT config already exists (user-customized; use -Force to overwrite)"
        return
    }

    Copy-Item $aftTemplate $aftConfig -Force
    Write-Host "  Installed AFT config from template (feature flags enabled)"
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
    Write-Host "==> Installing sages + AFT config + subagent templates + subagents doc + SYSTEM.md..."
    Write-Host "    (npm peers: pi-aft, pi-magic-context, pi-subagents, pi-codebase-memory, pi-graphify" -NoNewline
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

    $dirs = @("prompts", "skills", "extensions", "src")
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

    # Install AFT config (best-effort; user-customized preserved)
    Write-Host "==> Installing AFT config template..."
    install_aft_config

    # Install subagent templates (4-agent pipeline Stages 3-4)
    Write-Host "==> Installing subagent templates..."
    Install-SubagentTemplates

    # Install SUBAGENTS.md (4-agent pipeline doc)
    Write-Host "==> Installing subagents doc..."
    Install-SubagentsDoc

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
    Write-Host "==> Installing sages only (skip AFT config, subagent templates, SUBAGENTS.md, SYSTEM.md)..."

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

    $dirs = @("prompts", "skills", "extensions", "src")
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

    Write-Host "  (skipped: AFT config, subagent templates, SUBAGENTS.md, SYSTEM.md)"
    Write-Host ""
    Write-Host "Done! Restart pi: exit && pi" -ForegroundColor Green
}

function install_system_only {
    # Mirrors install.sh's --system-only: only install/update SYSTEM.md.
    Write-Host "==> Installing SYSTEM.md only (skip sages, AFT config, subagent templates, SUBAGENTS.md)..."

    $systemMdPath = Join-Path $AGENT_DIR "SYSTEM.md"
    if ((-not (Test-Path $systemMdPath)) -or $Force) {
        install_system_prompt
    } else {
        Write-Host "  SYSTEM.md already exists (use -Force to overwrite)"
    }

    Write-Host "  (skipped: sages, AFT config, subagent templates, SUBAGENTS.md)"
    Write-Host ""
    Write-Host "Done! Restart pi: exit && pi" -ForegroundColor Green
}

function uninstall {
    Write-Host "==> Uninstalling sages + AFT config + subagent templates + SUBAGENTS.md + SYSTEM.md..."

    # Remove sages
    if (Test-Path $PKG_DIR) {
        Remove-Item -Recurse -Force $PKG_DIR
        Write-Host "  Removed sages"
    }

    # Unregister sages
    unregister_settings

    # Remove AFT config (only if our SAGES_TEMPLATE_V1 sentinel)
    $aftConfig = Join-Path $env:USERPROFILE ".config\cortexkit\aft.jsonc"
    if ((Test-Path $aftConfig) -and (Select-String -Path $aftConfig -Pattern "SAGES_TEMPLATE_V1" -Quiet)) {
        Remove-Item -Force $aftConfig
        Write-Host "  Removed AFT config (was our template)"
    } elseif (Test-Path $aftConfig) {
        Write-Host "  AFT config is user-customized, leaving alone"
    }

    # Remove subagent templates (only if our sentinel) + SUBAGENTS.md (only if matches template)
    Uninstall-SubagentTemplates
    Uninstall-SubagentsDoc

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
