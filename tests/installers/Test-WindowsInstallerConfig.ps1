$ErrorActionPreference = "Stop"
$Installer = Join-Path (Split-Path $PSScriptRoot -Parent | Split-Path -Parent) "Install-S6_CUT.ps1"
$Tokens = $null
$ParseErrors = $null
$Ast = [System.Management.Automation.Language.Parser]::ParseFile($Installer, [ref]$Tokens, [ref]$ParseErrors)
if ($ParseErrors.Count) { throw ($ParseErrors -join "`n") }

function Die { param([string]$Message) throw $Message }
foreach ($Name in @("Get-PublishedPort", "Get-ResolvedPort")) {
    $Definition = $Ast.Find({ param($Node) $Node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq $Name }, $true)
    if (-not $Definition) { throw "Installer function not found: $Name" }
    . ([scriptblock]::Create($Definition.Extent.Text))
}

function Assert-Equal {
    param($Expected, $Actual, [string]$Label)
    if ($Expected -ne $Actual) { throw "$Label`: expected '$Expected', got '$Actual'" }
}
function Assert-InvalidPort {
    param($Binding)
    try { Get-PublishedPort $Binding "test port" | Out-Null }
    catch { return }
    throw "Expected invalid published port to fail: $($Binding.published)"
}

$Web = [pscustomobject]@{ published = "8080"; host_ip = $null; target = 8080 }
$Engine = [pscustomobject]@{ published = "8001"; host_ip = "127.0.0.1"; target = 8001 }
$Config = [pscustomobject]@{ services = [pscustomobject]@{
    web = [pscustomobject]@{ ports = @($Web) }
    engine = [pscustomobject]@{ ports = @($Engine) }
} }

$WebPort = Get-ResolvedPort $Config "web" 8080
Assert-Equal "127.0.0.1" $WebPort.Host "default readiness host"
Assert-Equal 8080 $WebPort.Port "default frontend port"
Assert-Equal 8001 (Get-ResolvedPort $Config "engine" 8001).Port "backend port"

$Web = [pscustomobject]@{ published = "18080"; host_ip = "192.168.1.20"; target = 8080 }
$Config.services.web.ports = @($Web)
$WebPort = Get-ResolvedPort $Config "web" 8080
Assert-Equal "192.168.1.20" $WebPort.Host "IPv4 readiness host"
Assert-Equal 18080 $WebPort.Port "custom frontend port"

$Web.host_ip = "0.0.0.0"
Assert-Equal "127.0.0.1" (Get-ResolvedPort $Config "web" 8080).Host "wildcard readiness host"
foreach ($Binding in @(
    [pscustomobject]@{ published = "0"; host_ip = $null },
    [pscustomobject]@{ published = "65536"; host_ip = $null },
    [pscustomobject]@{ published = "8080-8081"; host_ip = $null },
    [pscustomobject]@{ published = "8080"; host_ip = "999.0.0.1" },
    [pscustomobject]@{ published = "8080"; host_ip = "::1" }
)) { Assert-InvalidPort $Binding }
Write-Host "Windows installer configuration tests passed."
