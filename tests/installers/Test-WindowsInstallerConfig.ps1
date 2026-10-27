$ErrorActionPreference = "Stop"
$Installer = Join-Path (Split-Path $PSScriptRoot -Parent | Split-Path -Parent) "Install-S6_CUT.ps1"
$Tokens = $null
$ParseErrors = $null
$Ast = [System.Management.Automation.Language.Parser]::ParseFile($Installer, [ref]$Tokens, [ref]$ParseErrors)
if ($ParseErrors.Count) { throw ($ParseErrors -join "`n") }

function Die { param([string]$Message) throw $Message }
foreach ($Name in @("Get-ConfigValue", "Get-PublishedPort")) {
    $Definition = $Ast.Find({ param($Node) $Node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq $Name }, $true)
    if (-not $Definition) { throw "Installer function not found: $Name" }
    . ([scriptblock]::Create($Definition.Extent.Text))
}

function Assert-Equal {
    param($Expected, $Actual, [string]$Label)
    if ($Expected -ne $Actual) { throw "$Label`: expected '$Expected', got '$Actual'" }
}
function Assert-InvalidPort {
    param([string]$Binding)
    try { Get-PublishedPort $Binding "S6_PORT" | Out-Null }
    catch { return }
    throw "Expected invalid S6_PORT to fail: $Binding"
}

$OriginalWebPort = [Environment]::GetEnvironmentVariable("S6_PORT")
$OriginalEnginePort = [Environment]::GetEnvironmentVariable("S6_ENGINE_PORT")
$Temp = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $Temp | Out-Null
try {
    Push-Location $Temp
    [Environment]::SetEnvironmentVariable("S6_PORT", $null)
    [Environment]::SetEnvironmentVariable("S6_ENGINE_PORT", $null)

    Assert-Equal 8080 (Get-PublishedPort (Get-ConfigValue "S6_PORT" "8080") "S6_PORT").Port "default frontend port"
    Assert-Equal 8001 (Get-PublishedPort (Get-ConfigValue "S6_ENGINE_PORT" "8001") "S6_ENGINE_PORT").Port "default backend port"
    Set-Content .env "S6_PORT=18080 # frontend`nS6_ENGINE_PORT=18001 # backend" -Encoding ASCII
    Assert-Equal 18080 (Get-PublishedPort (Get-ConfigValue "S6_PORT" "8080") "S6_PORT").Port "custom numeric frontend port"
    Assert-Equal 18001 (Get-PublishedPort (Get-ConfigValue "S6_ENGINE_PORT" "8001") "S6_ENGINE_PORT").Port "custom backend port"
    Set-Content .env "S6_PORT : 18082`nS6_ENGINE_PORT = 18003" -Encoding ASCII
    Assert-Equal 18082 (Get-PublishedPort (Get-ConfigValue "S6_PORT" "8080") "S6_PORT").Port "colon frontend setting"
    Assert-Equal 18003 (Get-PublishedPort (Get-ConfigValue "S6_ENGINE_PORT" "8001") "S6_ENGINE_PORT").Port "spaced backend setting"
    Set-Content .env 'S6_PORT="127.0.0.1:18080" # loopback binding' -Encoding ASCII
    $Web = Get-PublishedPort (Get-ConfigValue "S6_PORT" "8080") "S6_PORT"
    Assert-Equal "127.0.0.1" $Web.Host "IPv4 readiness host"
    Assert-Equal 18080 $Web.Port "IPv4 published port"

    Set-Content .env "S6_PORT=8080`nS6_ENGINE_PORT=8001" -Encoding ASCII
    [Environment]::SetEnvironmentVariable("S6_PORT", "18081")
    [Environment]::SetEnvironmentVariable("S6_ENGINE_PORT", "18002")
    Assert-Equal 18081 (Get-PublishedPort (Get-ConfigValue "S6_PORT" "8080") "S6_PORT").Port "exported frontend port precedence"
    Assert-Equal 18002 (Get-PublishedPort (Get-ConfigValue "S6_ENGINE_PORT" "8001") "S6_ENGINE_PORT").Port "exported backend port precedence"

    Set-Content .env "S6_PORT=18080`nS6_ENGINE_PORT=18001" -Encoding ASCII
    [Environment]::SetEnvironmentVariable("S6_PORT", "")
    [Environment]::SetEnvironmentVariable("S6_ENGINE_PORT", "")
    Assert-Equal 8080 (Get-PublishedPort (Get-ConfigValue "S6_PORT" "8080") "S6_PORT").Port "empty exported frontend default"
    Assert-Equal 8001 (Get-PublishedPort (Get-ConfigValue "S6_ENGINE_PORT" "8001") "S6_ENGINE_PORT").Port "empty exported backend default"

    [Environment]::SetEnvironmentVariable("S6_PORT", $null)
    [Environment]::SetEnvironmentVariable("S6_ENGINE_PORT", $null)
    $AnyAddress = Get-PublishedPort "0.0.0.0:8082" "S6_PORT"
    Assert-Equal "127.0.0.1" $AnyAddress.Host "wildcard readiness host"
    Assert-Equal 8082 $AnyAddress.Port "wildcard published port"
    Set-Content .env 'S6_PORT="8080 # this is part of the value"' -Encoding ASCII
    Assert-InvalidPort (Get-ConfigValue "S6_PORT" "8080")
    foreach ($Binding in @("0", "65536", "99999", "localhost:8080", "999.0.0.1:8080")) { Assert-InvalidPort $Binding }
    Write-Host "Windows installer configuration tests passed."
}
finally {
    Pop-Location
    Remove-Item -Path $Temp -Recurse -Force
    [Environment]::SetEnvironmentVariable("S6_PORT", $OriginalWebPort)
    [Environment]::SetEnvironmentVariable("S6_ENGINE_PORT", $OriginalEnginePort)
}
