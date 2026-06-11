# ~/Project/sages/pi-yunxiao/scripts/install.ps1
# Windows PowerShell equivalent of install.sh
# Note: For v1, recommends using WSL for full compatibility

$ErrorActionPreference = "Stop"

$PiDir = if ($env:PI_DIR) { $env:PI_DIR } else { "$env:USERPROFILE\.pi" }
$PkgName = "yunxiao"
$SrcDir = Split-Path -Parent $PSScriptRoot
$PkgDir = "$PiDir\packages\$PkgName"
$Settings = "$PiDir\agent\settings.json"
$RuntimeDirs = @("prompts", "skills", "extensions", "src")

Write-Host "==> Installing $PkgName from $SrcDir"
New-Item -ItemType Directory -Force -Path $PkgDir | Out-Null

foreach ($d in $RuntimeDirs) {
    $srcSub = Join-Path $SrcDir $d
    $destSub = Join-Path $PkgDir $d
    if (Test-Path $srcSub) {
        if (Test-Path $destSub) {
            Write-Host "  [skip] $d/ (use --force to overwrite)"
        } else {
            Copy-Item -Recurse -Force $srcSub $destSub
            Write-Host "  [copy] $d/"
        }
    }
}

Copy-Item -Force (Join-Path $SrcDir "package.json") $PkgDir
Copy-Item -Force (Join-Path $SrcDir "tsconfig.json") $PkgDir

# Register in settings.json
$settingsDir = Split-Path -Parent $Settings
New-Item -ItemType Directory -Force -Path $settingsDir | Out-Null
if (-not (Test-Path $Settings)) {
    "{}" | Set-Content $Settings
}
$json = Get-Content $Settings -Raw | ConvertFrom-Json
if (-not $json.packages) { $json | Add-Member -MemberType NoteProperty -Name packages -Value @() }
if ($json.packages -notcontains $PkgDir) {
    $json.packages += $PkgDir
}
$json | ConvertTo-Json -Depth 10 | Set-Content $Settings

Write-Host ""
Write-Host "Done. Restart pi."
