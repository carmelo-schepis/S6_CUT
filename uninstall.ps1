<#
.SYNOPSIS
    S6_cut Uninstaller for Windows (PowerShell)
.DESCRIPTION
    Stops and removes the S6_cut Docker containers while preserving your data
    by default. Nothing is deleted unless you explicitly ask for it.
.NOTES
    Run from the installation directory (where compose.yaml exists), or
    specify -InstallDir to target a different location.
#>

param(
    [Parameter(Mandatory=$false)]
    [string]$InstallDir = "$env:USERPROFILE\s6_cut",

    [Parameter(Mandatory=$false)]
    [string]$ComposeFile = "compose.yaml",

    [Parameter(Mandatory=$false)]
    [switch]$RemoveImages,

    [Parameter(Mandatory=$false)]
    [switch]$Purge,

    [Parameter(Mandatory=$false)]
    [switch]$Yes
)

# --- formatting ---------------------------------------------------------------

function Write-Info { param([string]$Message) Write-Host "`n$Message" -ForegroundColor Cyan }
function Write-Step { param([string]$Message) Write-Host "  → $Message" -ForegroundColor Gray }
function Write-Ok   { param([string]$Message) Write-Host "  ✓ $Message" -ForegroundColor Green }
function Write-Warn { param([string]$Message) Write-Host "  ! $Message" -ForegroundColor Yellow }
function Write-Fail { param([string]$Message) Write-Host "  ✗ $Message" -ForegroundColor Red }

function Show-Usage {
    @"
Usage: uninstall.ps1 [options]

Options:
  -RemoveImages   Also remove the locally built S6_cut Docker images.
  -Purge          Also delete the installation directory, including your
                  data, media, outputs, models, and .env. Irreversible.
  -Yes            Confirm a destructive option (required with -Purge).
  -InstallDir     Installation directory (default: ~/s6_cut)
  -h, -Help       Show this help.

Without options, uninstall.ps1 stops and removes the S6_cut containers and
the Compose network. Docker volumes and user files are never deleted.

Environment:
  S6_INSTALL_DIR    installation directory (default: ~/s6_cut)
"@
}

if ($Purge -and -not $Yes) {
    Write-Fail "--Purge deletes the installation directory including your data and is irreversible."
    Write-Fail "Re-run with -Purge -Yes to confirm."
    exit 1
}

if (-not (Test-Path $InstallDir) -or -not (Test-Path (Join-Path $InstallDir $ComposeFile))) {
    Write-Host "S6_cut does not appear to be installed at $InstallDir — nothing to do."
    exit 0
}

Write-Info "S6_cut Uninstaller"
Write-Host "  Install directory: $InstallDir"

Set-Location $InstallDir

if ($RemoveImages) {
    Write-Step "Removing S6_cut Docker images..."
    docker compose down --rmi local
}
else {
    Write-Step "Stopping and removing S6_cut containers..."
    docker compose down
}
Write-Ok "S6_cut containers stopped and removed"

if ($Purge) {
    Write-Step "Deleting the installation directory (including your data)..."
    Set-Location $env:USERPROFILE
    Remove-Item -Recurse -Force $InstallDir -ErrorAction Stop
    Write-Ok "Removed $InstallDir"
    Write-Host ""
    Write-Ok "S6_cut fully removed."
}
else {
    Write-Host ""
    Write-Ok "S6_cut uninstalled. Your data, media, outputs, models, and .env are preserved at:"
    Write-Host "  $InstallDir"
    Write-Host "To run S6_cut again, re-run the install command. To delete everything, re-run uninstall.ps1 -Purge -Yes."
}