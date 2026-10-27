$ErrorActionPreference = "Stop"
$Installer = Join-Path (Split-Path $PSScriptRoot -Parent | Split-Path -Parent) "Install-S6_CUT.ps1"
$Tokens = $null
$ParseErrors = $null
$Ast = [System.Management.Automation.Language.Parser]::ParseFile($Installer, [ref]$Tokens, [ref]$ParseErrors)
if ($ParseErrors.Count) { throw ($ParseErrors -join "`n") }

function Die { param([string]$Message) throw $Message }
foreach ($Name in @("Get-ComposePort", "Get-PublishedPort")) {
    $Definition = $Ast.Find({ param($Node) $Node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq $Name }, $true)
    if (-not $Definition) { throw "Installer function not found: $Name" }
    . ([scriptblock]::Create($Definition.Extent.Text))
}

function Assert-Equal {
    param($Expected, $Actual, [string]$Label)
    if ($Expected -ne $Actual) { throw "$Label`: expected '$Expected', got '$Actual'" }
}
function Assert-InvalidPort {
    param([string]$Binding, [string]$ExpectedMessage)
    try { Get-PublishedPort $Binding "test port" | Out-Null }
    catch {
        if ($_.Exception.Message -notlike "*$ExpectedMessage*") { throw }
        return
    }
    throw "Expected invalid port to fail: $Binding"
}

$DefaultConfig = @(
    "services:", "  engine:", "    ports:", "      - mode: ingress", "        target: 8001",
    '        published: "8001"', "        host_ip: 127.0.0.1", "        protocol: tcp",
    "  web:", "    ports:", "      - mode: ingress", "        target: 8080",
    '        published: "8080"', "        protocol: tcp"
)
$Web = Get-PublishedPort (Get-ComposePort $DefaultConfig "web" 8080 "S6_PORT") "S6_PORT"
Assert-Equal "127.0.0.1" $Web.Host "default readiness host"
Assert-Equal 8080 $Web.Port "default frontend port"
$Engine = Get-PublishedPort (Get-ComposePort $DefaultConfig "engine" 8001 "S6_ENGINE_PORT") "S6_ENGINE_PORT"
Assert-Equal 8001 $Engine.Port "default backend port"

$CustomConfig = @(
    "services:", "  web:", "    ports:", "      - mode: ingress", "        target: 8080",
    '        published: "18080"', "        host_ip: 192.168.1.20", "        protocol: tcp",
    "  engine:", "    ports:", "      - mode: ingress", "        target: 8001",
    '        published: "18001"', "        host_ip: 127.0.0.1", "        protocol: tcp"
)
$Web = Get-PublishedPort (Get-ComposePort $CustomConfig "web" 8080 "S6_PORT") "S6_PORT"
Assert-Equal "192.168.1.20" $Web.Host "IPv4 bind address"
Assert-Equal 18080 $Web.Port "custom frontend port"
$Engine = Get-PublishedPort (Get-ComposePort $CustomConfig "engine" 8001 "S6_ENGINE_PORT") "S6_ENGINE_PORT"
Assert-Equal 18001 $Engine.Port "custom backend port"
Assert-Equal "127.0.0.1" (Get-PublishedPort "0.0.0.0:8082" "S6_PORT").Host "wildcard readiness host"

foreach ($Binding in @("invalid", "999.0.0.1:8080", "0", "65536", "100000", "[::1]:8080")) {
    Assert-InvalidPort $Binding "valid port (1–65535)"
}
Write-Host "Windows installer port tests passed."
