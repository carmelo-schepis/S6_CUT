$ErrorActionPreference = "Stop"
$Installer = Join-Path (Split-Path $PSScriptRoot -Parent | Split-Path -Parent) "Install-S6_CUT.ps1"
$Tokens = $null
$ParseErrors = $null
$Ast = [System.Management.Automation.Language.Parser]::ParseFile($Installer, [ref]$Tokens, [ref]$ParseErrors)
if ($ParseErrors.Count) { throw ($ParseErrors -join "`n") }

function Die { param([string]$Message) throw $Message }
$Definition = $Ast.Find({ param($Node) $Node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq "Get-PublishedPort" }, $true)
if (-not $Definition) { throw "Installer function not found: Get-PublishedPort" }
. ([scriptblock]::Create($Definition.Extent.Text))

function Assert-Equal {
    param($Expected, $Actual, [string]$Label)
    if ($Expected -ne $Actual) { throw "$Label`: expected '$Expected', got '$Actual'" }
}
function Assert-InvalidPort {
    param([object]$Mapping)
    try { Get-PublishedPort $Mapping "test port" | Out-Null }
    catch { return }
    throw "Expected invalid published port to fail: $Mapping"
}

$Default = Get-PublishedPort "0.0.0.0:8080" "S6_PORT"
Assert-Equal "127.0.0.1" $Default.Host "default readiness host"
Assert-Equal 8080 $Default.Port "default frontend port"
$Bound = Get-PublishedPort "192.168.1.20:18080" "S6_PORT"
Assert-Equal "192.168.1.20" $Bound.Host "IPv4 readiness host"
Assert-Equal 18080 $Bound.Port "custom frontend port"
$WithIPv6 = Get-PublishedPort -Mapping @("[::]:18080", "127.0.0.1:18080") -Name "S6_PORT"
Assert-Equal "127.0.0.1" $WithIPv6.Host "IPv4 mapping selection"
foreach ($Mapping in @("not-a-port", "999.0.0.1:8080", "0.0.0.0:0", "0.0.0.0:65536", "0.0.0.0:8080-8081", "[::1]:8080")) {
    Assert-InvalidPort $Mapping
}
Write-Host "Windows installer port tests passed."
