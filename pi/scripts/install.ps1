#!/usr/bin/env pwsh
#
# Four Sages Installation Script for pi (PowerShell)
# Installs to $env:USERPROFILE\.pi\packages\sages
#
# Also installs pi-memory for persistent memory capabilities
#

$ErrorActionPreference = 'Stop'

param(
    [string]$Prefix,
    [switch]$Force,
    [switch]$Uninstall,
    [switch]$Help
)

# Core paths
$PI_DIR = if ($Prefix) { $Prefix } else { "$env:USERPROFILE\.pi" }
$PKG_NAME = "sages"
$PKG_DIR = "$PI_DIR\packages\$PKG_NAME"
$REPO_URL = "https://github.com/vanpipy/sages.git"
$AGENT_DIR = "$PI_DIR\agent"
$PI_MEMORY_PKG = "npm:@samfp/pi-memory"

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

function is_pi_memory_installed {
    $settings = "$PI_DIR\agent\settings.json"
    if (-not (Test-Path $settings)) { return $false }
    
    try {
        $data = Get-Content $settings -Raw | ConvertFrom-Json
        $packages = $data.packages
        if ($packages -contains $PI_MEMORY_PKG -or $packages -contains "@samfp/pi-memory") {
            return $true
        }
    } catch {}
    return $false
}

function install_pi_memory {
    Write-Host "==> Installing pi-memory..."
    
    if (is_pi_memory_installed) {
        Write-Host "  pi-memory already installed"
        return
    }
    
    # Try using pi install command first
    $pi = Get-Command pi -ErrorAction SilentlyContinue
    if ($pi) {
        Write-Host "  Installing via 'pi install $PI_MEMORY_PKG'..."
        try {
            & pi install $PI_MEMORY_PKG
            Write-Host "  Installed pi-memory"
            return
        } catch {
            Write-Host "  pi install failed, trying manual..."
        }
    }
    
    # Fallback: manually add to settings.json
    Write-Host "  Adding to settings.json..."
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
    
    if ($PI_MEMORY_PKG -notin $data.packages) {
        $data.packages += $PI_MEMORY_PKG
        $data | ConvertTo-Json -Depth 10 | Set-Content $settings -Encoding UTF8
        Write-Host "  Added $PI_MEMORY_PKG"
    }
    
    Write-Host "  Installed pi-memory"
}

function uninstall_pi_memory {
    Write-Host "==> Uninstalling pi-memory..."
    
    $settings = "$PI_DIR\agent\settings.json"
    if (-not (Test-Path $settings)) {
        Write-Host "  No settings file"
        return
    }
    
    try {
        $data = Get-Content $settings -Raw | ConvertFrom-Json
        $originalCount = $data.packages.Count
        $data.packages = @($data.packages | Where-Object {
            $_ -ne $PI_MEMORY_PKG -and $_ -ne "pi-memory" -and $_ -ne "@samfp/pi-memory"
        })
        
        if ($data.packages.Count -lt $originalCount) {
            $data | ConvertTo-Json -Depth 10 | Set-Content $settings -Encoding UTF8
            Write-Host "  Removed $PI_MEMORY_PKG"
        } else {
            Write-Host "  Not found in settings"
        }
    } catch {
        Write-Host "  Warning: $_"
    }
    
    # Remove package directory if exists
    $memoryDir = "$PI_DIR\packages\pi-memory"
    if (Test-Path $memoryDir) {
        Remove-Item -Recurse -Force $memoryDir
        Write-Host "  Removed $memoryDir"
    }
    
    Write-Host "  pi-memory uninstalled"
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
    Write-Host "==> Installing sages + pi-memory..."
    
    # Pre-flight checks
    check_git
    install_pi_if_needed
    
    # Verify pi is available
    $pi = Get-Command pi -ErrorAction SilentlyContinue
    if (-not $pi) {
        Write-Host "Error: pi not found after installation" -ForegroundColor Red
        exit 1
    }
    
    # Install pi-memory first
    install_pi_memory
    
    # Clone sages
    Write-Host "==> Installing sages..."
    $script:TMP_DIR = Join-Path ([System.IO.Path]::GetTempPath()) "sages-install-$( [guid]::NewGuid().ToString('N') )"
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
    
    # Install system prompt
    $systemMdPath = Join-Path $AGENT_DIR "SYSTEM.md"
    if ((-not (Test-Path $systemMdPath)) -or $Force) {
        install_system_prompt
    }
    
    # Cleanup
    cleanup
    
    Write-Host ""
    Write-Host "Done! Restart pi: exit && pi" -ForegroundColor Green
}

function uninstall {
    Write-Host "==> Uninstalling sages + pi-memory..."
    
    # Remove sages
    if (Test-Path $PKG_DIR) {
        Remove-Item -Recurse -Force $PKG_DIR
        Write-Host "  Removed sages"
    }
    
    # Unregister sages
    unregister_settings
    
    # Uninstall pi-memory
    uninstall_pi_memory
    
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
} else {
    install
}
