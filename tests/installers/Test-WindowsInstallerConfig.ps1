$ErrorActionPreference = "Stop"
$Installer = Join-Path (Split-Path $PSScriptRoot -Parent | Split-Path -Parent) "Install-S6_CUT.ps1"
$Tokens = $null
$ParseErrors = $null
$Ast = [System.Management.Automation.Language.Parser]::ParseFile($Installer, [ref]$Tokens, [ref]$ParseErrors)
if ($ParseErrors.Count) { throw ($ParseErrors -join "`n") }

function Die { param([string]$Message) throw $Message }
foreach ($Name in @("Get-ComposeValue", "Get-PublishedPort")) {
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
    try { Get-PublishedPort $Binding "test port" | Out-Null }
    catch { return }
    throw "Expected invalid port to fail: $Binding"
}

$Defaults = @("S6_PORT=8080", "S6_ENGINE_PORT=8001")
Assert-Equal "8080" (Get-ComposeValue $Defaults "S6_PORT" "8080") "default frontend port"
Assert-Equal 8080 (Get-PublishedPort (Get-ComposeValue $Defaults "S6_PORT" "8080") "S6_PORT").Port "parsed default frontend port"
Assert-Equal "8001" (Get-ComposeValue $Defaults "S6_ENGINE_PORT" "8001") "default backend port"

$Resolved = @("S6_PORT=127.0.0.1:18080", "S6_ENGINE_PORT=18001")
$Web = Get-PublishedPort (Get-ComposeValue $Resolved "S6_PORT" "8080") "S6_PORT"
Assert-Equal "127.0.0.1" $Web.Host "IPv4 readiness host"
Assert-Equal 18080 $Web.Port "custom frontend port"
Assert-Equal 18001 (Get-PublishedPort (Get-ComposeValue $Resolved "S6_ENGINE_PORT" "8001") "S6_ENGINE_PORT").Port "custom backend port"

$Expanded = @("WEB_PORT=18082", "S6_PORT=18082", "S6_ENGINE_PORT=18003")
Assert-Equal 18082 (Get-PublishedPort (Get-ComposeValue $Expanded "S6_PORT" "8080") "S6_PORT").Port "interpolated port"
$Empty = @("S6_PORT=", "S6_ENGINE_PORT=")
Assert-Equal 8080 (Get-PublishedPort (Get-ComposeValue $Empty "S6_PORT" "8080") "S6_PORT").Port "empty-value default"
Assert-Equal 8001 (Get-PublishedPort (Get-ComposeValue $Empty "S6_ENGINE_PORT" "8001") "S6_ENGINE_PORT").Port "empty backend default"
Assert-Equal "127.0.0.1" (Get-PublishedPort "0.0.0.0:8082" "S6_PORT").Host "wildcard readiness host"

foreach ($Binding in @("invalid", "999.0.0.1:8080", "0", "65536", "99999", "[::1]:8080")) {
    Assert-InvalidPort $Binding
}
Write-Host "Windows installer port tests passed."
