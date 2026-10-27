<#
.SYNOPSIS
    S6_cut Installer for Windows (PowerShell)
.DESCRIPTION
    Bootstrap installer that clones/updates the S6_cut repository from GitHub,
    then installs/updates using Docker Compose. Preserves existing .env, projects,
    Library, media, outputs, models, and persistent Docker state.

      irm https://raw.githubusercontent.com/carmelo-schepis/S6_CUT/main/Install-S6_CUT.ps1 | iex
.NOTES
    Installs into $HOME\s6_cut by default. Safe to run repeatedly.
#>

param(
    [Parameter(Mandatory=$false)]
    [string]$InstallDir = "$env:USERPROFILE\s6_cut",

    [Parameter(Mandatory=$false)]
    [string]$RepoUrl = "https://github.com/carmelo-schepis/S6_CUT.git",

    [Parameter(Mandatory=$false)]
    [string]$Branch = "main",

    [Parameter(Mandatory=$false)]
    [int]$StartTimeout = 300,

    [Parameter(Mandatory=$false)]
    [switch]$ForceRecreate
)

$InstallDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($InstallDir)
$GitImage = "alpine/git:2.54.0@sha256:4fac439ee3b9204bec99c712b8a15942999632458f716ae8149fbb97cb760cd4"

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

# Docker
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Die "Docker is not installed. Install Docker Desktop from https://www.docker.com/products/docker-desktop/, then re-run the install command."
}
Write-Ok "Docker found"

# Docker engine running
docker info > $null 2>&1
if ($LASTEXITCODE -ne 0) {
    Die "Docker is installed but its engine is not running or not reachable. Start Docker Desktop, wait until it is ready, then re-run the install command."
}
Write-Ok "Docker engine is running"

# Docker Compose v2
docker compose version > $null 2>&1
if ($LASTEXITCODE -ne 0) {
    Die "Docker Compose v2 is required but the 'docker compose' command is missing. Install Docker Compose v2 (https://docs.docker.com/compose/install/), then re-run the install command."
}
Write-Ok "Docker Compose found"

$UseDockerGit = -not (Get-Command git -ErrorAction SilentlyContinue)
if ($UseDockerGit) {
    Write-Step "Using Git inside Docker (no separate Git installation needed)"
}
else {
    Write-Ok "Git found"
}

# --- repository ----------------------------------------------------------------

function Invoke-RepositoryGit {
    if ($UseDockerGit) {
        & docker run --rm --mount "type=bind,source=$InstallDir,target=/s6_cut" --workdir /s6_cut $GitImage -c safe.directory=/s6_cut @args
    }
    else {
        & git @args
    }
}

$CurrentStep = "preparing repository"
$ComposeFile = "compose.yaml"

if (Test-Path (Join-Path $InstallDir ".git")) {
    Write-Ok "S6_cut repository found at $InstallDir"
    Write-Step "Updating repository..."
    Set-Location $InstallDir
    Invoke-RepositoryGit fetch --quiet origin
    if ($LASTEXITCODE -eq 0) {
        Invoke-RepositoryGit pull --quiet --ff-only origin $Branch 2>$null
        if ($LASTEXITCODE -ne 0) {
            Write-Warn "Could not fast-forward to the latest ${Branch} (local changes?). Keeping the current source."
        }
    }
    else {
        Write-Warn "Could not reach the repository remote. Keeping the current source."
    }
    Write-Ok "Repository updated"
}
elseif (Test-Path (Join-Path $InstallDir $ComposeFile)) {
    Write-Warn "Found an existing S6_cut installation at $InstallDir (not a git checkout). Reusing it in place."
    Write-Ok "Repository ready"
    Set-Location $InstallDir
}
elseif ((Test-Path $InstallDir) -and (Get-ChildItem $InstallDir -Force)) {
    Die "$InstallDir already exists and is not an S6_cut installation. Move it aside, or use a different location."
}
else {
    Write-Step "Downloading S6_cut into $InstallDir..."
    New-Item -ItemType Directory -Path $InstallDir -Force -ErrorAction Stop | Out-Null
    Set-Location $InstallDir -ErrorAction Stop
    Invoke-RepositoryGit clone --quiet --depth 1 --branch $Branch $RepoUrl .
    if ($LASTEXITCODE -ne 0) {
        Die "Could not download S6_cut. Check your network connection and re-run the install command."
    }
    Write-Ok "Repository downloaded"
}
Set-Location $InstallDir -ErrorAction Stop

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

function Get-ComposeSetting {
    param([string]$Name, [string]$Default)

    $Value = [Environment]::GetEnvironmentVariable($Name, "Process")
    if ($null -ne $Value) {
        if ([string]::IsNullOrEmpty($Value)) { return $Default }
        return $Value.Trim().Trim('"').Trim("'")
    }
    if (Test-Path ".env") {
        $Pattern = '^\s*' + [regex]::Escape($Name) + '\s*=\s*(.*?)\s*$'
        foreach ($Line in Get-Content ".env") {
            if ($Line -cmatch $Pattern) {
                $Value = $Matches[1] -replace '\s+#.*$', ''
            }
        }
    }
    if ([string]::IsNullOrEmpty($Value)) { $Value = $Default }
    return $Value.Trim().Trim('"').Trim("'")
}

function Get-NumericPort {
    param([string]$Value, [string]$Name)

    $Port = 0
    if ($Value -notmatch '^\d{1,5}$' -or
        -not [int]::TryParse($Value, [ref]$Port) -or $Port -lt 1 -or $Port -gt 65535) {
        Die "$Name must be a numeric port from 1 through 65535."
    }
    return $Port
}

function Resolve-WebBinding {
    param([string]$Binding)

    $Address = $null
    $PortText = $Binding
    if ($Binding -match '^(?<address>(?:\d{1,3}\.){3}\d{1,3}):(?<port>\d{1,5})$') {
        $Address = $Matches.address
        $PortText = $Matches.port
        $ParsedAddress = $null
        if (-not [System.Net.IPAddress]::TryParse($Address, [ref]$ParsedAddress) -or
            $ParsedAddress.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
            Die "S6_PORT must be a numeric port or an IPv4 binding such as 127.0.0.1:8080."
        }
        $Address = $ParsedAddress.ToString()
    }
    elseif ($Binding -notmatch '^\d{1,5}$') {
        Die "S6_PORT must be a numeric port or an IPv4 binding such as 127.0.0.1:8080."
    }

    $Port = Get-NumericPort -Value $PortText -Name "S6_PORT"

    $UrlHost = if (-not $Address -or $Address -eq "0.0.0.0") { "localhost" } else { $Address }
    $HealthHost = if (-not $Address -or $Address -eq "0.0.0.0") { "127.0.0.1" } else { $Address }
    return [PSCustomObject]@{ Port = $Port; UrlHost = $UrlHost; HealthHost = $HealthHost }
}

$WebBinding = Get-ComposeSetting -Name "S6_PORT" -Default "8080"
$Web = Resolve-WebBinding -Binding $WebBinding
$EnginePortSetting = Get-ComposeSetting -Name "S6_ENGINE_PORT" -Default "8001"
$EnginePort = Get-NumericPort -Value $EnginePortSetting -Name "S6_ENGINE_PORT"

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
$Url = "http://$($Web.HealthHost):$($Web.Port)/api/health"
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

Write-Host ""
Write-Ok "S6_cut is running"
Write-Host ""
Write-Host "  Frontend: http://$($Web.UrlHost):$($Web.Port)"
Write-Host "  Backend:  http://localhost:$EnginePort"
Write-Host ""
Write-Info "Next steps"
Write-Host "  * Open the Frontend URL in your browser to start creating projects."
Write-Host "  * The Backend engine (and its API docs) listens on localhost only."
Write-Host "  * Install directory: $InstallDir  (your data lives under ${InstallDir}\data)"
Write-Host "  * Update S6_cut later: re-run the same install command."
Write-Host "  * Uninstall (keeps your data): run uninstall.ps1 -- see the README."
