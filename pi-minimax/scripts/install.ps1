# ~/Project/sages/pi-minimax/scripts/install.ps1
#
# PowerShell variant of install.sh. Mirrors the same source-to-runtime copy.

param(
    [switch]$Force,
    [switch]$Uninstall,
    [string]$Prefix,
    [switch]$Help
)

if ($Help) {
    Write-Output @"
Usage: install.ps1 [OPTIONS]

Options:
  -Force            Overwrite existing files
  -Uninstall        Remove installed files
  -Prefix DIR       Set pi config dir (default: ~/.pi)
  -Help             Show this help
"@
    exit 0
}

if (-not $Prefix) { $Prefix = if ($env:PI_DIR) { $env:PI_DIR } else { Join-Path $HOME ".pi" } }
$PkgName = "minimax"
$SrcDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$PkgDir = Join-Path $Prefix "packages/$PkgName"
$Settings = Join-Path $Prefix "agent/settings.json"

$RuntimeDirs = @("prompts", "skills", "extensions", "src")

if ($Uninstall) {
    Write-Output "==> Uninstalling $PkgName"
    if (Test-Path $PkgDir) {
        Remove-Item -Recurse -Force $PkgDir
        Write-Output "  [rm] $PkgDir"
    }
    Write-Output "Done."
    exit 0
}

# Install
Write-Output "==> Installing $PkgName from $SrcDir"
if (-not (Test-Path $PkgDir)) { New-Item -ItemType Directory -Force -Path $PkgDir | Out-Null }

foreach ($d in $RuntimeDirs) {
    $src = Join-Path $SrcDir $d
    $dst = Join-Path $PkgDir $d
    if (-not (Test-Path $src)) { continue }
    if ((Test-Path $dst) -and -not $Force) {
        Write-Output "  [skip] $d/ (use -Force to overwrite)"
    } else {
        if (Test-Path $dst) { Remove-Item -Recurse -Force $dst }
        Copy-Item -Recurse -Force $src $dst
        Write-Output "  [copy] $d/"
    }
}

$pkgJson = Join-Path $SrcDir "package.json"
$tscJson = Join-Path $SrcDir "tsconfig.json"
if (Test-Path $pkgJson) {
    Copy-Item -Force $pkgJson (Join-Path $PkgDir "package.json")
    Write-Output "  [copy] package.json"
}
if (Test-Path $tscJson) {
    Copy-Item -Force $tscJson (Join-Path $PkgDir "tsconfig.json")
    Write-Output "  [copy] tsconfig.json"
}

Write-Output ""
Write-Output "Done. Restart pi: exit && pi"
