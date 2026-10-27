# Native PowerShell 5.1 integration harness. Docker/Git are command shims scoped to
# the installer child process; this harness never contacts the host Docker daemon.
param(
    [string]$Installer = (Join-Path (Split-Path $PSScriptRoot -Parent | Split-Path -Parent) 'Install-S6_CUT.ps1'),
    [string]$TestRoot = (Join-Path $env:TEMP 's6-installer-behavior')
)
$ErrorActionPreference = 'Stop'
function Assert([bool]$Condition,[string]$Message) { if (-not $Condition) { throw $Message } }
function Put-Text([string]$Path,[string]$Text) { [IO.File]::WriteAllText($Path,$Text,(New-Object Text.UTF8Encoding($false))) }
function New-Scenario([string]$Name,[bool]$Fresh=$false) {
    $Root=Join-Path $TestRoot $Name
    if (Test-Path $Root) { Remove-Item $Root -Recurse -Force }
    $Bin=Join-Path $Root 'bin'; $App=Join-Path $Root 'S6 install with spaces'
    New-Item $Bin -ItemType Directory -Force | Out-Null; New-Item $App -ItemType Directory -Force | Out-Null
    Copy-Item $Installer (Join-Path $Root 'installer-under-test.ps1')
    if (-not $Fresh) {
      Put-Text (Join-Path $App 'compose.yaml') "services:`r`n  web:`r`n    ports:`r`n      - `"`$env:S6_PORT`:8080`"`r`n  engine:`r`n    ports:`r`n      - `"`$env:S6_ENGINE_PORT`:8001`"`r`n"
      Put-Text (Join-Path $App '.env.example') "S6_PORT=8080`r`nS6_ENGINE_PORT=8001`r`n"
    }
    Put-Text (Join-Path $Root 'docker-mock.ps1') @'
$DockerArgs=@($env:S6_SHIM_ARGS -split '\s+')
Add-Content -LiteralPath $env:S6_TEST_LOG -Value ('docker ' + ($DockerArgs -join ' '))
if ($DockerArgs.Count -ge 2 -and $DockerArgs[0] -eq 'compose' -and $DockerArgs[1] -eq 'config') {
 if ($env:S6_TEST_CONFIG_FAIL -eq '1') { exit 1 }
 $web=$env:S6_TEST_WEB; $engine=$env:S6_TEST_ENGINE
 if (-not $web) { $line=Get-Content .env -ErrorAction SilentlyContinue | Where-Object { $_ -match '^S6_PORT=' } | Select-Object -First 1; if ($line) { $web=$line.Substring(9) } }
 if (-not $engine) { $line=Get-Content .env -ErrorAction SilentlyContinue | Where-Object { $_ -match '^S6_ENGINE_PORT=' } | Select-Object -First 1; if ($line) { $engine=$line.Substring(15) } }
 if (-not $web) { $web='8080' }; if (-not $engine) { $engine='8001' }
 if ($env:S6_TEST_BAD_WEB) { $web=$env:S6_TEST_BAD_WEB }
 $webHost=if ($env:S6_TEST_WEB_HOST) {$env:S6_TEST_WEB_HOST} else {'127.0.0.1'}
 if ($web -match '^(.+):(\d+)$') { $webHost=$matches[1]; $web=$matches[2] }
 @('services:','  web:','    ports:','      - mode: ingress','        target: 8080',('        published: "'+$web+'"'),('        host_ip: '+$webHost),'        protocol: tcp','  engine:','    ports:','      - mode: ingress','        target: 8001',('        published: "'+$engine+'"'),'        host_ip: 127.0.0.1','        protocol: tcp')
 exit 0
}
if ($DockerArgs.Count -eq 1 -and $DockerArgs[0] -eq 'info') { if ($env:S6_TEST_DOCKER_FAIL -eq '1') {exit 1}; exit 0 }
if ($DockerArgs.Count -ge 2 -and $DockerArgs[0] -eq 'compose' -and $DockerArgs[1] -eq 'version') { if ($env:S6_TEST_COMPOSE_FAIL -eq '1') {exit 1}; exit 0 }
if ($DockerArgs.Count -ge 2 -and $DockerArgs[0] -eq 'compose' -and $DockerArgs[1] -eq 'up') { if ($env:S6_TEST_UP_FAIL -eq '1') {exit 1}; exit 0 }
if ($DockerArgs.Count -ge 2 -and $DockerArgs[0] -eq 'compose' -and $DockerArgs[1] -in @('ps','logs')) { 'mock diagnostics'; exit 0 }
if ($DockerArgs.Count -ge 1 -and $DockerArgs[0] -eq 'run') {
 $repo=$env:S6_TEST_APP
 if (-not (Test-Path (Join-Path $repo '.git'))) { New-Item -ItemType Directory -Force (Join-Path $repo '.git') | Out-Null; [IO.File]::WriteAllText((Join-Path $repo 'compose.yaml'),'services: {}'); [IO.File]::WriteAllText((Join-Path $repo '.env.example'),"S6_PORT=8080`nS6_ENGINE_PORT=8001`n"); Add-Content -LiteralPath $env:S6_TEST_LOG -Value 'docker-git clone' }
 else { Add-Content -LiteralPath $env:S6_TEST_LOG -Value 'docker-git update' }
 exit 0
}
exit 0
'@
    Put-Text (Join-Path $Bin 'docker.cmd') "@echo off`r`nset `"S6_SHIM_ARGS=%*`"`r`npowershell.exe -NoProfile -ExecutionPolicy Bypass -File `"%~dp0..\docker-mock.ps1`"`r`nexit /b %ERRORLEVEL%`r`n"
    Put-Text (Join-Path $Bin 'git.cmd') "@echo off`r`nset `"S6_SHIM_ARGS=%*`"`r`npowershell.exe -NoProfile -ExecutionPolicy Bypass -File `"%~dp0..\git-mock.ps1`"`r`nexit /b %ERRORLEVEL%`r`n"
    Put-Text (Join-Path $Root 'git-mock.ps1') @'
$GitArgs=@($env:S6_SHIM_ARGS -split '\s+')
Add-Content -LiteralPath $env:S6_TEST_LOG -Value ('git ' + ($GitArgs -join ' '))
if ($GitArgs[0] -eq 'clone') { New-Item -ItemType Directory -Force .git | Out-Null; [IO.File]::WriteAllText('compose.yaml','services: {}'); [IO.File]::WriteAllText('.env.example',"S6_PORT=8080`nS6_ENGINE_PORT=8001`n") }
'mock-commit'
'@
    return @{Root=$Root;Bin=$Bin;App=$App;Log=(Join-Path $Root 'commands.log');Installer=(Join-Path $Root 'installer-under-test.ps1');Web='8080';Engine='8001';EnvWeb='';EnvEngine='';EngineHost='';WebHost='';BadWeb='';DockerFail='';ComposeFail='';ConfigFail='';UpFail='';HealthFail=''}
}
function Invoke-Scenario($S,[int]$Timeout=5) {
    $env:S6_TEST_LOG=$S.Log; $env:S6_TEST_APP=$S.App; $env:S6_TEST_WEB=$S.Web; $env:S6_TEST_ENGINE=$S.Engine; $env:S6_TEST_WEB_HOST=$S.WebHost
    $env:S6_PORT=$S.EnvWeb; $env:S6_ENGINE_PORT=$S.EnvEngine; $env:S6_TEST_BAD_WEB=$S.BadWeb; $env:S6_TEST_ENGINE_HOST=$S.EngineHost
    $env:S6_TEST_CONFIG_FAIL=$S.ConfigFail; $env:S6_TEST_DOCKER_FAIL=$S.DockerFail; $env:S6_TEST_COMPOSE_FAIL=$S.ComposeFail; $env:S6_TEST_UP_FAIL=$S.UpFail; $env:S6_TEST_HEALTH_FAIL=$S.HealthFail
    $env:PATH=$S.Bin+';'+$env:SystemRoot+'\System32;'+$env:SystemRoot+'\System32\WindowsPowerShell\v1.0;'+$env:SystemRoot
    $wrapper=@"
function Invoke-WebRequest { param(`$Uri,`$Method,`$TimeoutSec,`$ErrorAction,[switch]`$UseBasicParsing)
 Add-Content -LiteralPath `$env:S6_TEST_LOG -Value ('health '+`$Uri)
 if (`$env:S6_TEST_HEALTH_FAIL -eq '1') { throw 'mock health unavailable' }; return @{StatusCode=200}
}
function Start-Sleep { param([int]`$Seconds); [Threading.Thread]::Sleep(1100) }
& '$($S.Installer.Replace("'","''"))' -InstallDir '$($S.App.Replace("'","''"))' -StartTimeout $Timeout
"@
    $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($wrapper))
    $outPath=Join-Path $S.Root 'stdout.txt'; $errPath=Join-Path $S.Root 'stderr.txt'
    $p=Start-Process powershell.exe -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand',$encoded) -PassThru -Wait -NoNewWindow -RedirectStandardOutput $outPath -RedirectStandardError $errPath
    return @{Code=$p.ExitCode;Output=([IO.File]::ReadAllText($outPath)+[IO.File]::ReadAllText($errPath));Log=$(if(Test-Path $S.Log){[IO.File]::ReadAllText($S.Log)}else{''})}
}
New-Item $TestRoot -ItemType Directory -Force | Out-Null
$S=New-Scenario 'default-preserve'
$S.Web='18080'; $S.Engine='18001'; Put-Text (Join-Path $S.App '.env') "S6_PORT=18080`r`nS6_ENGINE_PORT=18001`r`nKEEP_BYTES=already-here`r`n"; $envBytesBefore=[Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $S.App '.env')))
New-Item (Join-Path $S.App 'data\media') -ItemType Directory -Force | Out-Null; Put-Text (Join-Path $S.App 'data\media\sentinel.txt') 'keep-media'
$R=Invoke-Scenario $S; Assert ($R.Code -eq 0) 'default run failed'; Assert ($R.Output -match 'Frontend: http://localhost:18080') 'effective frontend URL missing'; Assert ($R.Output -match 'Backend:  http://localhost:18001') 'effective backend URL missing'; Assert ($R.Log -match 'health http://127.0.0.1:18080/api/health') 'readiness did not use effective port'; Assert ($R.Log.IndexOf('docker info') -lt $R.Log.IndexOf('docker compose version') -and $R.Log.IndexOf('docker compose version') -lt $R.Log.IndexOf('docker compose config') -and $R.Log.IndexOf('docker compose config') -lt $R.Log.IndexOf('docker compose up')) 'Docker command sequence changed'; Assert (([Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $S.App '.env'))) -ceq $envBytesBefore)) '.env bytes changed'; Assert ((Get-Content (Join-Path $S.App 'data\media\sentinel.txt') -Raw) -eq 'keep-media') 'media changed'
$R=Invoke-Scenario $S; Assert ($R.Code -eq 0) 'rerun failed'; Assert ($R.Output -match 'Configuration ready \(.env preserved\)') 'rerun did not preserve config'; Assert ($R.Output -match 'Frontend: http://localhost:18080') 'rerun lost custom port'
$S=New-Scenario 'default-ports'; $R=Invoke-Scenario $S; Assert ($R.Code -eq 0) 'default port run failed'; Assert ($R.Output -match 'Frontend: http://localhost:8080') 'default frontend port URL missing'; Assert ($R.Output -match 'Backend:  http://localhost:8001') 'default backend port URL missing'
$S=New-Scenario 'git-present-clone' $true; $R=Invoke-Scenario $S; Assert ($R.Code -eq 0) 'Git clone run failed'; Assert ($R.Log -match 'git clone') 'Git-present clone was not invoked'; Assert (Test-Path (Join-Path $S.App '.git')) 'Git clone did not create checkout marker'
$S=New-Scenario 'git-present-update'; New-Item (Join-Path $S.App '.git') -ItemType Directory -Force | Out-Null; Put-Text (Join-Path $S.App 'compose.yaml') 'services: {}'; Put-Text (Join-Path $S.App '.env') "S6_PORT=8080`r`nS6_ENGINE_PORT=8001`r`nKEEP=rerun`r`n"; $keepBefore=[Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $S.App '.env'))); $R=Invoke-Scenario $S; Assert ($R.Code -eq 0) 'Git update run failed'; Assert ($R.Log -match 'git fetch') 'Git fetch was not invoked'; Assert ($R.Log -match 'git pull') 'Git pull was not invoked'; Assert (([Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $S.App '.env'))) -ceq $keepBefore)) 'Git update changed existing .env bytes'
$S=New-Scenario 'effective-precedence'; Put-Text (Join-Path $S.App '.env') "S6_PORT=19090`r`nS6_ENGINE_PORT=19001`r`n"; $S.EnvWeb='19091'; $S.EnvEngine='19002'; $S.Web='192.168.1.20:19091'; $S.Engine='19002'; $S.WebHost='192.168.1.20'; $R=Invoke-Scenario $S; Assert ($R.Code -eq 0) 'effective mapping run failed'; Assert ($R.Output -match 'Frontend: http://192\.168\.1\.20:19091') 'effective config precedence or custom frontend binding failed'; Assert ($R.Output -match 'Backend:  http://localhost:19002') 'backend URL incorrect'; Assert ($R.Log -match 'health http://192\.168\.1\.20:19091/api/health') 'effective readiness address missing'
foreach ($Case in @(@('docker-missing','Docker is not installed'),@('docker-unreachable','engine is not running'),@('compose-missing','Docker Compose v2 is required'),@('config-failure','could not resolve the configured ports'),@('invalid-port','valid port'),@('start-failure','failed to start'),@('readiness-failure','Diagnostics -- service status'))) {
 Write-Host "Running scenario: $($Case[0])"
 $S=New-Scenario $Case[0]; if($Case[0] -eq 'docker-missing'){Remove-Item (Join-Path $S.Bin 'docker.cmd')}; if($Case[0] -eq 'invalid-port'){$S.BadWeb='70000'}
 if($Case[0] -eq 'docker-unreachable'){$S.DockerFail='1'}; if($Case[0] -eq 'compose-missing'){$S.ComposeFail='1'}; if($Case[0] -eq 'config-failure'){$S.ConfigFail='1'}; if($Case[0] -eq 'start-failure'){$S.UpFail='1'}; if($Case[0] -eq 'readiness-failure'){$S.HealthFail='1'}
 $R=Invoke-Scenario $S 1; Assert ($R.Code -ne 0) "$($Case[0]) unexpectedly succeeded"; Assert ($R.Output -match [regex]::Escape($Case[1])) "$($Case[0]) diagnostic missing"
 if($Case[0] -eq 'invalid-port'){Assert ($R.Log -notmatch 'docker compose up') 'invalid port reached compose up'; Assert ($R.Log -notmatch 'health ') 'invalid port reached readiness'}
 Write-Host "Passed scenario: $($Case[0])"
}
# Separate Git-unavailable path: only Windows system binaries and Docker shim are on PATH.
Write-Host 'Running scenario: git-fallback clone and update'
$S=New-Scenario 'git-fallback' $true; Remove-Item (Join-Path $S.Bin 'git.cmd'); $R=Invoke-Scenario $S; Assert ($R.Code -eq 0) 'Docker Git fallback failed'; Assert ($R.Output -match 'Using Git inside Docker') 'Git absence was not detected'; Assert (($R.Log -split 'docker-git clone').Count -eq 2) 'Docker Git clone was not invoked'; Assert (Test-Path (Join-Path $S.App 'compose.yaml')) 'Docker Git clone did not create repository files'; $fallbackEnv=Join-Path $S.App '.env'; Put-Text $fallbackEnv "S6_PORT=18180`r`nS6_ENGINE_PORT=18081`r`nKEEP=fallback`r`n"; $fallbackBefore=[Convert]::ToBase64String([IO.File]::ReadAllBytes($fallbackEnv)); $R=Invoke-Scenario $S; Assert ($R.Code -eq 0) 'Docker Git update rerun failed'; Assert (($R.Log -split 'docker-git update').Count -eq 3) 'Docker Git fetch and pull update calls were not both invoked'; Assert (([Convert]::ToBase64String([IO.File]::ReadAllBytes($fallbackEnv)) -ceq $fallbackBefore)) 'Docker Git update changed existing .env bytes'
Write-Host 'Passed scenario: git-fallback clone and update'
Write-Host "Windows installer behavior tests passed. Evidence: $TestRoot"
