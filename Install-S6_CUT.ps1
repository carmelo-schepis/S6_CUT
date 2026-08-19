<#
.SYNOPSIS
    S6_cut Installer for Windows (PowerShell)
.DESCRIPTION
    Bootstrap installer that clones/updates the S6_cut repository from GitHub,
    then installs/updates using Docker Compose. Preserves existing .env, projects,
    Library, media, outputs, models, and persistent Docker state.

    PRIVATE REPO (authenticated -- works now):
      gh api -H "Accept: application/vnd.github.raw+json" repos/carmelo-schepis/S6_CUT/contents/Install-S6_CUT.ps1 | Invoke-Expression

    PUBLIC REPO (anonymous -- works after repository is made public):
      irm https://raw.githubusercontent.com/carmelo-schepis/S6_CUT/master/Install-S6_CUT.ps1 | iex
.NOTES
    Installs into $HOME\s6_cut by default. Safe to run repeatedly.
#>

param(
    [Parameter(Mandatory=$false)]
    [string]$InstallDir = "$env:USERPROFILE\s6_cut",

    [Parameter(Mandatory=$false)]
    [string]$RepoUrl = "https://github.com/carmelo-schepis/S6_CUT.git",

    [Parameter(Mandatory=$false)]
    [string]$Branch = "master",

    [Parameter(Mandatory=$false)]
    [int]$StartTimeout = 300,

    [Parameter(Mandatory=$false)]
    [switch]$ForceRecreate
)

# --- formatting ---------------------------------------------------------------

function Write-Info { param([string]$Message) Write-Host "`n$Message" -ForegroundColor Cyan }
function Write-Step { param([string]$Message) Write-Host "  -> $Message" -ForegroundColor Gray }
function Write-Ok   { param([string]$Message) Write-Host "  [OK] $Message" -ForegroundColor Green }
function Write-Warn { param([string]$Message) Write-Host "  [!] $Message" -ForegroundColor Yellow }
function Write-Fail { param([string]$Message) Write-Host "  [FAIL] $Message" -ForegroundColor Red }

function Die {
    param([string]$Message)
    Write-Fail $Message
    exit 1
}

# --- checks -------------------------------------------------------------------

Write-Info "S6_cut Installer (Windows PowerShell)"

# Check OS
if (-not ([Environment]::OSVersion.Platform -eq "Win32NT")) {
    Die "This installer is for Windows only. Use install.sh on Linux/macOS."
}
Write-Ok "Windows detected"

# Check prerequisites
$CurrentStep = "checking prerequisites"

# Git
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Die "Git is not installed. Install it from https://git-scm.com/downloads, then re-run the install command."
}
Write-Ok "Git found"

# Docker
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Die "Docker is not installed. Install Docker Desktop from https://www.docker.com/products/docker-desktop/, then re-run the install command."
}
Write-Ok "Docker found"

# Docker engine running
try {
    docker info > $null 2>&1
    Write-Ok "Docker engine is running"
}
catch {
    Die "Docker is installed but its engine is not running or not reachable. Start Docker Desktop, wait until it is ready, then re-run the install command."
}

# Docker Compose v2
if (-not (docker compose version > $null 2>&1)) {
    Die "Docker Compose v2 is required but the 'docker compose' command is missing. Install Docker Compose v2 (https://docs.docker.com/compose/install/), then re-run the install command."
}
Write-Ok "Docker Compose found"

# --- repository ----------------------------------------------------------------

$CurrentStep = "preparing repository"
$ComposeFile = "compose.yaml"

if (-not (Test-Path $InstallDir)) {
    Write-Step "Creating installation directory: $InstallDir"
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    Write-Ok "Installation directory created"
}
elseif (Test-Path (Join-Path $InstallDir ".git")) {
    Write-Ok "S6_cut repository found at $InstallDir"
    Write-Step "Updating repository..."
    Set-Location $InstallDir
    try {
        git fetch --quiet origin
        if (-not (git pull --quiet --ff-only origin $Branch 2>$null)) {
            Write-Warn "Could not fast-forward to the latest ${Branch} (local changes?). Keeping the current source."
        }
    }
    catch {
        Write-Warn "Could not reach the repository remote. Keeping the current source."
    }
    Write-Ok "Repository updated"
}
elseif (Test-Path (Join-Path $InstallDir $ComposeFile)) {
    Write-Warn "Found an existing S6_cut installation at $InstallDir (not a git checkout). Reusing it in place."
    Write-Ok "Repository ready"
    Set-Location $InstallDir
}
elseif ((Get-ChildItem $InstallDir -Force).Count -gt 0) {
    Die "$InstallDir already exists and is not an S6_cut installation. Move it aside, or use a different location."
}
else {
    Write-Step "Downloading S6_cut into $InstallDir..."
    mkdir -p $InstallDir
    git clone --quiet --depth 1 --branch $Branch $RepoUrl $InstallDir
    Write-Ok "Repository downloaded"
    Set-Location $InstallDir
}

# --- configuration ------------------------------------------------------------

$CurrentStep = "preparing configuration"
if (Test-Path ".env") {
    Write-Ok "Configuration ready (.env preserved)"
}
elseif (Test-Path ".env.example") {
    Copy-Item ".env.example" ".env"
    Write-Ok "Configuration ready (created .env from the template)"
}
else {
    Write-Warn ".env.example is missing; using the built-in defaults."
    Write-Ok "Configuration ready (defaults)"
}

# --- containers ---------------------------------------------------------------

$CurrentStep = "building and starting the containers"
Write-Step "Building S6_cut (the first build can take several minutes)..."
Write-Step "Starting containers..."

$ComposeArgs = @("compose", "up", "-d", "--build")
if ($ForceRecreate) { $ComposeArgs += "--force-recreate" }
docker @ComposeArgs

if ($LASTEXITCODE -ne 0) {
    Die "Docker Compose failed to start. Run 'docker compose logs' for details."
}
Write-Ok "Containers started"

# --- wait for ready -----------------------------------------------------------

$CurrentStep = "waiting for S6_cut to become ready"
$WebPort = 8080
if (Test-Path ".env") {
    $EnvLine = Get-Content ".env" | Where-Object { $_ -match '^S6_PORT=' } | Select-Object -First 1
    if ($EnvLine) { $WebPort = ($EnvLine -split '=')[1].Trim('"', "'") }
}

$Url = "http://127.0.0.1:$WebPort/api/health"
Write-Step "Waiting for S6_cut to become ready (timeout ${StartTimeout}s)..."

$Deadline = [DateTime]::Now.AddSeconds($StartTimeout)
$Ready = $false

while ([DateTime]::Now -lt $Deadline) {
    try {
        $Response = Invoke-WebRequest -Uri $Url -Method Get -TimeoutSec 5 -ErrorAction Stop -UseBasicParsing
        if ($Response.StatusCode -eq 200) {
            $Ready = $true
            break
        }
    }
    catch {
        # Ignore errors, keep polling
    }
    Start-Sleep -Seconds 3
}

if (-not $Ready) {
    Write-Fail "S6_cut did not become ready within ${StartTimeout} seconds."
    Write-Host ""
    Write-Info "Diagnostics -- service status"
    docker compose ps
    Write-Host ""
    Write-Info "Diagnostics -- recent container logs"
    docker compose logs --tail=60
    Die "S6_cut failed to start. Review the diagnostics above, fix the cause, and re-run the install command."
}

Write-Ok "S6_cut is ready"

# --- summary ------------------------------------------------------------------

Write-Host ""
Write-Info "Services"
docker compose ps

$EnginePort = 8001
if (Test-Path ".env") {
    $EnvLine = Get-Content ".env" | Where-Object { $_ -match '^S6_ENGINE_PORT=' } | Select-Object -First 1
    if ($EnvLine) { $EnginePort = ($EnvLine -split '=')[1].Trim('"', "'") }
}

Write-Host ""
Write-Ok "S6_cut is running"
Write-Host ""
Write-Host "  Frontend: http://localhost:$WebPort"
Write-Host "  Backend:  http://localhost:$EnginePort"
Write-Host ""
Write-Info "Next steps"
Write-Host "  * Open the Frontend URL in your browser to start creating projects."
Write-Host "  * The Backend engine (and its API docs) listens on localhost only."
Write-Host "  * Install directory: $InstallDir  (your data lives under ${InstallDir}\data)"
Write-Host "  * Update S6_cut later: re-run the same install command."
Write-Host "  * Uninstall (keeps your data): run uninstall.ps1 -- see the README."