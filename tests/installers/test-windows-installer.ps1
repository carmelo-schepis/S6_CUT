<#
Native Windows PowerShell 5.1 regression harness for Install-S6_CUT.ps1.
Run with: powershell.exe -NoProfile -File tests/installers/test-windows-installer.ps1
Docker, HTTP, and Git-in-Docker are controlled stubs; this is not live install evidence.
#>

$ErrorActionPreference = "Stop"
$InstallerPath = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) "Install-S6_CUT.ps1"
$SourceText = Get-Content -LiteralPath $InstallerPath -Raw
$SourceText = [regex]::Replace($SourceText, '(?s)function Die\s*\{\s*param\(\[string\]\$Message\)\s*Write-Fail \$Message\s*exit 1\s*\}', [System.Text.RegularExpressions.MatchEvaluator]{ param($Match) 'function Die { param([string]$Message) throw $Message }' })
$Installer = [scriptblock]::Create($SourceText)
$GitPath = (Microsoft.PowerShell.Core\Get-Command git -ErrorAction Stop).Source
$OriginalLocation = Get-Location
$OriginalPort = [Environment]::GetEnvironmentVariable("S6_PORT", "Process")
$OriginalEnginePort = [Environment]::GetEnvironmentVariable("S6_ENGINE_PORT", "Process")
$TestRoot = Join-Path ([IO.Path]::GetTempPath()) ("S6 installer tests " + [guid]::NewGuid().ToString("N"))
$SourceRepo = Join-Path $TestRoot "source with spaces"
$script:MockScenario = "Success"
$script:MockHealthUrls = @()
$script:MockDockerCalls = @()
$script:HideGit = $false
$script:HideDocker = $false

function Assert-Equal {
    param($Expected, $Actual, [string]$Message)
    if ($Expected -cne $Actual) { throw "$Message`nExpected: $Expected`nActual:   $Actual" }
}

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Get-Command {
    param([string]$Name, [string]$ErrorAction)
    if (($Name -eq "docker" -and $script:HideDocker) -or ($Name -eq "git" -and $script:HideGit)) { return $null }
    return Microsoft.PowerShell.Core\Get-Command -Name $Name -ErrorAction SilentlyContinue
}

function docker {
    param([Parameter(ValueFromRemainingArguments=$true)][string[]]$DockerArgs)
    $Call = $DockerArgs -join " "
    $script:MockDockerCalls += $Call
    $global:LASTEXITCODE = 0

    if ($DockerArgs.Count -ge 2 -and $DockerArgs[0] -eq "run") {
        $MountIndex = [Array]::IndexOf($DockerArgs, "--mount")
        $Mount = $DockerArgs[$MountIndex + 1]
        $Source = $Mount -replace '^type=bind,source=', ''
        $TargetMarker = $Source.LastIndexOf(',target=')
        if ($TargetMarker -ge 0) { $Source = $Source.Substring(0, $TargetMarker) }
        $ConfigIndex = [Array]::IndexOf($DockerArgs, "-c")
        $GitArgs = @($DockerArgs[($ConfigIndex + 2)..($DockerArgs.Count - 1)])
        Push-Location -LiteralPath $Source
        try { & $GitPath @GitArgs; $global:LASTEXITCODE = $LASTEXITCODE }
        finally { Pop-Location }
        return
    }

    if ($Call -eq "info" -and $script:MockScenario -eq "DockerUnavailable") {
        $global:LASTEXITCODE = 1
        return
    }
    if ($Call -eq "compose version" -and $script:MockScenario -eq "ComposeMissing") {
        $global:LASTEXITCODE = 1
        return
    }
    if ($Call -eq "compose config --format json") {
        # Mocked Compose resolution for this harness; this is not live install evidence.
        $WebBinding = "8080"
        $EnginePort = "8001"
        if (Test-Path -LiteralPath ".env") {
            foreach ($Line in Get-Content -LiteralPath ".env") {
                if ($Line -match '^\s*S6_PORT\s*[:=]\s*(.*?)\s*$') { $WebBinding = $Matches[1].Trim('"').Trim("'") }
                if ($Line -match '^\s*S6_ENGINE_PORT\s*[:=]\s*(.*?)\s*$') { $EnginePort = $Matches[1].Trim('"').Trim("'") }
            }
        }
        if ($WebBinding -match '^\$\{WEB_PORT:-(?<fallback>\d+)\}$') {
            $WebPortOverride = [Environment]::GetEnvironmentVariable("WEB_PORT", "Process")
            $WebBinding = if ($WebPortOverride) { $WebPortOverride } else { $Matches.fallback }
        }
        $ProcessWeb = [Environment]::GetEnvironmentVariable("S6_PORT", "Process")
        $ProcessEngine = [Environment]::GetEnvironmentVariable("S6_ENGINE_PORT", "Process")
        if ($null -ne $ProcessWeb -and $ProcessWeb -ne "") { $WebBinding = $ProcessWeb }
        if ($null -ne $ProcessEngine -and $ProcessEngine -ne "") { $EnginePort = $ProcessEngine }

        $WebHost = ""
        $WebPort = $WebBinding
        if ($WebBinding -match '^(?<host>(?:\d{1,3}\.){3}\d{1,3}):(?<port>\d+)$') {
            $WebHost = $Matches.host
            $WebPort = $Matches.port
        }
        $Resolved = [PSCustomObject]@{
            services = [PSCustomObject]@{
                web = [PSCustomObject]@{ ports = @([PSCustomObject]@{ target = 8080; published = $WebPort; host_ip = $WebHost }) }
                engine = [PSCustomObject]@{ ports = @([PSCustomObject]@{ target = 8001; published = $EnginePort; host_ip = "127.0.0.1" }) }
            }
        }
        return ($Resolved | ConvertTo-Json -Depth 8 -Compress)
    }
    if ($Call.StartsWith("compose up ") -and (Test-Path -LiteralPath ".env") -eq $false) {
        $global:LASTEXITCODE = 1
        throw "Compose was called before .env was available."
    }
}

function Invoke-WebRequest {
    param([string]$Uri, [string]$Method, [int]$TimeoutSec, [string]$ErrorAction, [switch]$UseBasicParsing)
    $script:MockHealthUrls += $Uri
    if ($script:MockScenario -eq "ReadinessFailure") { throw "Simulated health endpoint failure" }
    return [PSCustomObject]@{ StatusCode = 200 }
}

function New-TestRepository {
    New-Item -ItemType Directory -Path $SourceRepo -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $SourceRepo "compose.yaml") -Value "services: {}" -Encoding Ascii
    Set-Content -LiteralPath (Join-Path $SourceRepo ".env.example") -Value @("S6_PORT=8080", "S6_ENGINE_PORT=8001", "CUSTOM=keep") -Encoding Ascii
    & $GitPath -C $SourceRepo init -b main | Out-Null
    & $GitPath -C $SourceRepo add compose.yaml .env.example
    & $GitPath -C $SourceRepo -c user.name="Windows Harness" -c user.email="harness@example.invalid" commit -m "fixture" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not prepare local Git fixture." }
}

function Invoke-MockedInstall {
    param([string]$Name, [string]$Target, [string]$Scenario="Success", [bool]$NoGit=$false, [bool]$NoDocker=$false, [int]$Timeout=10)
    $script:MockScenario = $Scenario
    $script:HideGit = $NoGit
    $script:HideDocker = $NoDocker
    $script:MockHealthUrls = @()
    $script:MockDockerCalls = @()
    Push-Location $OriginalLocation
    try {
        $Captured = @(& $Installer -InstallDir $Target -RepoUrl $SourceRepo -Branch "main" -StartTimeout $Timeout 6>&1)
        return [PSCustomObject]@{ Error = $null; HealthUrls = @($script:MockHealthUrls); DockerCalls = @($script:MockDockerCalls); Output = ($Captured | Out-String) }
    }
    catch {
        return [PSCustomObject]@{ Error = $_.Exception.Message; HealthUrls = @($script:MockHealthUrls); DockerCalls = @($script:MockDockerCalls); Output = "" }
    }
    finally { Set-Location $OriginalLocation }
}

try {
    New-Item -ItemType Directory -Path $TestRoot -Force | Out-Null
    New-TestRepository

    [Environment]::SetEnvironmentVariable("S6_PORT", $null, "Process")
    [Environment]::SetEnvironmentVariable("S6_ENGINE_PORT", $null, "Process")
    $DefaultPath = Join-Path $TestRoot "default install with spaces"
    $Default = Invoke-MockedInstall -Name "default" -Target $DefaultPath
    Assert-Equal $null $Default.Error "Default installer path should succeed."
    Assert-Equal "http://127.0.0.1:8080/api/health" $Default.HealthUrls[0] "Default readiness URL should use the numeric default."
    Assert-True ($Default.Output -match 'Frontend: http://localhost:8080') "Default frontend URL was not reported correctly."
    Assert-True ($Default.Output -match 'Backend:\s+http://localhost:8001') "Default backend URL was not reported correctly."
    Assert-True ($Default.DockerCalls -contains "compose up -d --build") "Default Compose command was not issued."

    $PreservedEnvHash = (Get-FileHash -LiteralPath (Join-Path $DefaultPath ".env") -Algorithm SHA256).Hash
    $DataFile = Join-Path $DefaultPath "data\projects\harness.txt"
    New-Item -ItemType Directory -Path (Split-Path $DataFile -Parent) -Force | Out-Null
    [IO.File]::WriteAllText($DataFile, "project media sentinel")
    [Environment]::SetEnvironmentVariable("S6_PORT", "18080", "Process")
    [Environment]::SetEnvironmentVariable("S6_ENGINE_PORT", "18001", "Process")
    $Exported = Invoke-MockedInstall -Name "exported" -Target $DefaultPath
    Assert-Equal $null $Exported.Error "Exported settings should override conflicting .env values."
    Assert-Equal "http://127.0.0.1:18080/api/health" $Exported.HealthUrls[0] "Exported numeric frontend port should control readiness."
    Assert-True ($Exported.Output -match 'Frontend: http://localhost:18080') "Exported frontend URL was not reported correctly."
    Assert-True ($Exported.Output -match 'Backend:\s+http://localhost:18001') "Exported backend URL was not reported correctly."
    Assert-True (($Exported.DockerCalls -contains "compose up -d --build") -and (Test-Path -LiteralPath $DataFile)) "Update should keep Compose configuration and stored media available."
    Assert-Equal $PreservedEnvHash ((Get-FileHash -LiteralPath (Join-Path $DefaultPath ".env") -Algorithm SHA256).Hash) ".env bytes changed on update."

    [Environment]::SetEnvironmentVariable("S6_PORT", "127.0.0.1:18082", "Process")
    [Environment]::SetEnvironmentVariable("S6_ENGINE_PORT", "18003", "Process")
    $Bound = Invoke-MockedInstall -Name "bound" -Target $DefaultPath
    Assert-Equal "http://127.0.0.1:18082/api/health" $Bound.HealthUrls[0] "IPv4 binding should be split before readiness URL construction."
    Assert-True ($Bound.Output -match 'Frontend: http://127\.0\.0\.1:18082') "IPv4 frontend URL was not reported correctly."
    Assert-True ($Bound.Output -match 'Backend:\s+http://localhost:18003') "IPv4 case backend URL was not reported correctly."

    [Environment]::SetEnvironmentVariable("S6_PORT", "0.0.0.0:18084", "Process")
    [Environment]::SetEnvironmentVariable("S6_ENGINE_PORT", "18005", "Process")
    $Wildcard = Invoke-MockedInstall -Name "wildcard" -Target $DefaultPath
    Assert-Equal "http://127.0.0.1:18084/api/health" $Wildcard.HealthUrls[0] "Wildcard bind should be health-checked through loopback."
    Assert-True ($Wildcard.Output -match 'Frontend: http://localhost:18084') "Wildcard frontend should report a usable local URL."
    Assert-True ($Wildcard.Output -match 'Backend:\s+http://localhost:18005') "Wildcard case backend URL was not reported correctly."

    [Environment]::SetEnvironmentVariable("S6_PORT", $null, "Process")
    [Environment]::SetEnvironmentVariable("S6_ENGINE_PORT", $null, "Process")

    Set-Content -LiteralPath (Join-Path $DefaultPath ".env") -Value @("S6_PORT=18086", "S6_ENGINE_PORT=18087") -Encoding Ascii
    $EnvFile = Invoke-MockedInstall -Name "custom env file values" -Target $DefaultPath
    Assert-Equal "http://127.0.0.1:18086/api/health" $EnvFile.HealthUrls[0] "Custom .env frontend port should control readiness when no process override exists."
    Assert-True ($EnvFile.Output -match 'Backend:\s+http://localhost:18087') "Custom .env engine port was not reported correctly."

    Set-Content -LiteralPath (Join-Path $DefaultPath ".env") -Value @("S6_PORT: 18090", "S6_ENGINE_PORT: 18091") -Encoding Ascii
    $ColonEnv = Invoke-MockedInstall -Name "colon Compose env syntax" -Target $DefaultPath
    Assert-Equal "http://127.0.0.1:18090/api/health" $ColonEnv.HealthUrls[0] "Colon-assigned Compose web port should control readiness."
    Assert-True ($ColonEnv.Output -match 'Backend:\s+http://localhost:18091') "Colon-assigned Compose engine port was not reported correctly."

    Set-Content -LiteralPath (Join-Path $DefaultPath ".env") -Value @('S6_PORT=${WEB_PORT:-18092}', "S6_ENGINE_PORT: 18093") -Encoding Ascii
    $InterpolatedEnv = Invoke-MockedInstall -Name "interpolated Compose env value" -Target $DefaultPath
    Assert-Equal "http://127.0.0.1:18092/api/health" $InterpolatedEnv.HealthUrls[0] "Compose interpolation fallback should control readiness."
    Assert-True ($InterpolatedEnv.Output -match 'Backend:\s+http://localhost:18093') "Interpolated case engine port was not reported correctly."

    $FallbackPath = Join-Path $TestRoot "docker git fallback install"
    $Fallback = Invoke-MockedInstall -Name "fallback" -Target $FallbackPath -NoGit $true
    Assert-Equal $null $Fallback.Error "Docker Git fallback should install from the local repository."
    Assert-True (($Fallback.DockerCalls | Where-Object { $_.StartsWith("run ") }).Count -ge 1) "Git-unavailable run did not use the Docker Git fallback."

    $InvalidPath = Join-Path $TestRoot "invalid port install"
    New-Item -ItemType Directory -Path $InvalidPath -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $SourceRepo "compose.yaml") -Destination $InvalidPath
    Copy-Item -LiteralPath (Join-Path $SourceRepo ".env.example") -Destination $InvalidPath
    Set-Content -LiteralPath (Join-Path $InvalidPath ".env.example") -Value "S6_PORT=65536" -Encoding Ascii
    $Invalid = Invoke-MockedInstall -Name "invalid" -Target $InvalidPath
    Assert-True ($Invalid.Error -match 'S6_PORT must be a numeric port from 1 through 65535') "Invalid port must fail clearly before Compose starts; got: $($Invalid.Error)"
    Assert-True (-not ($Invalid.DockerCalls | Where-Object { $_.StartsWith("compose up ") })) "Invalid port reached docker compose up."

    $MalformedPath = Join-Path $TestRoot "malformed port install"
    New-Item -ItemType Directory -Path $MalformedPath -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $SourceRepo "compose.yaml") -Destination $MalformedPath
    Set-Content -LiteralPath (Join-Path $MalformedPath ".env.example") -Value "S6_PORT=not-a-port" -Encoding Ascii
    [Environment]::SetEnvironmentVariable("S6_PORT", $null, "Process")
    $Malformed = Invoke-MockedInstall -Name "malformed" -Target $MalformedPath
    Assert-True ($Malformed.Error -match 'S6_PORT must be a numeric port or an IPv4 binding') "Malformed binding must be rejected clearly; got: $($Malformed.Error)"
    Assert-True (-not ($Malformed.DockerCalls | Where-Object { $_.StartsWith("compose up ") })) "Malformed binding reached docker compose up."

    $EngineInvalidPath = Join-Path $TestRoot "invalid engine port install"
    New-Item -ItemType Directory -Path $EngineInvalidPath -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $SourceRepo "compose.yaml") -Destination $EngineInvalidPath
    Set-Content -LiteralPath (Join-Path $EngineInvalidPath ".env") -Value "S6_ENGINE_PORT=65536" -Encoding Ascii
    $EngineInvalid = Invoke-MockedInstall -Name "invalid engine port" -Target $EngineInvalidPath
    Assert-True ($EngineInvalid.Error -match 'S6_ENGINE_PORT must be a numeric port from 1 through 65535') "Invalid engine port must fail clearly; got: $($EngineInvalid.Error)"
    Assert-True (-not ($EngineInvalid.DockerCalls | Where-Object { $_.StartsWith("compose up ") })) "Invalid engine port reached docker compose up."

    $CasePath = Join-Path $TestRoot "case-sensitive env install"
    New-Item -ItemType Directory -Path $CasePath -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $SourceRepo "compose.yaml") -Destination $CasePath
    Set-Content -LiteralPath (Join-Path $CasePath ".env") -Value "s6_port=18088" -Encoding Ascii
    $CaseSensitive = Invoke-MockedInstall -Name "case-sensitive env" -Target $CasePath
    Assert-Equal "http://127.0.0.1:8080/api/health" $CaseSensitive.HealthUrls[0] "A lowercase .env key must not override the documented uppercase Compose variable."

    $NoDocker = Invoke-MockedInstall -Name "missing docker" -Target $DefaultPath -NoDocker $true
    Assert-True ($NoDocker.Error -match 'Docker is not installed') "Missing Docker diagnostic changed: $($NoDocker.Error)"
    $NoCompose = Invoke-MockedInstall -Name "missing Compose" -Target $DefaultPath -Scenario "ComposeMissing"
    Assert-True ($NoCompose.Error -match "Docker Compose v2 is required") "Missing Compose diagnostic changed: $($NoCompose.Error)"
    $NoEngine = Invoke-MockedInstall -Name "unreachable Docker" -Target $DefaultPath -Scenario "DockerUnavailable"
    Assert-True ($NoEngine.Error -match "Docker is installed but its engine is not running") "Unreachable Docker diagnostic changed: $($NoEngine.Error)"
    $NoReady = Invoke-MockedInstall -Name "readiness failure" -Target $DefaultPath -Scenario "ReadinessFailure" -Timeout 4
    Assert-True ($NoReady.Error -match "S6_cut failed to start") "Readiness failure diagnostic changed: $($NoReady.Error)"
    Assert-True (($NoReady.DockerCalls -contains "compose ps") -and ($NoReady.DockerCalls -contains "compose logs --tail=60")) "Readiness failure did not show both diagnostics."

    Write-Host "PASS: native Windows PowerShell installer regression harness"
}
finally {
    [Environment]::SetEnvironmentVariable("S6_PORT", $OriginalPort, "Process")
    [Environment]::SetEnvironmentVariable("S6_ENGINE_PORT", $OriginalEnginePort, "Process")
    Set-Location $OriginalLocation
    if (Test-Path -LiteralPath $TestRoot) { Remove-Item -LiteralPath $TestRoot -Recurse -Force }
}
