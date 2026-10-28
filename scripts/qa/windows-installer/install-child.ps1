# Native child process only. The unmodified public bootstrap is invoked below.
param([Parameter(Mandatory=$true)][string]$Manifest,
      [Parameter(Mandatory=$true)][int]$Installation,
      [ValidateSet('published','custom','fixture','candidate')][string]$Invocation='published')
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$m=Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json
if ($m.owner -ne 's6-windows-installer-verification-v1') { throw 'Invalid owner' }
$i=$m.installations[$Installation]
$install=[IO.Path]::GetFullPath($i.windows_install)
$sandbox=[IO.Path]::GetFullPath($m.windows_payload) + '\'
if (-not $install.StartsWith($sandbox,[StringComparison]::OrdinalIgnoreCase)) { throw 'Install outside owned sandbox' }
if ($i.engine_port -notmatch '^\d+$') { throw 'S6_ENGINE_PORT must be numeric' }
# Preserve the Docker connection before redirecting only this child profile.
$dockerConfig=if($env:DOCKER_CONFIG){$env:DOCKER_CONFIG}else{Join-Path $env:USERPROFILE '.docker'}
Get-ChildItem Env: | Where-Object {$_.Name -like 'S6_*' -or $_.Name -like 'COMPOSE_*' -or $_.Name -eq 'OPENROUTER_API_KEY'} | ForEach-Object {Remove-Item -LiteralPath ('Env:'+ $_.Name)}
$env:DOCKER_CONFIG=$dockerConfig
$env:USERPROFILE=$i.windows_profile
$env:COMPOSE_PROJECT_NAME=$i.project
$env:S6_PORT='127.0.0.1:'+ $i.web_port
$env:S6_ENGINE_PORT=[string]$i.engine_port
$env:S6_DATA_PATH=Join-Path $install 'data'
$env:S6_BUILD_REVISION=$i.expected_revision
$global:S6InstallerNativeDocker=(Microsoft.PowerShell.Core\Get-Command docker.exe -ErrorAction Stop).Source
$global:S6InstallerGitFallbackCalls=0
function global:Invoke-RestMethod {
    param([string]$Uri)
    if($Uri -ne 'https://raw.githubusercontent.com/carmelo-schepis/S6_CUT/main/Install-S6_CUT.ps1'){throw 'Unexpected bootstrap URL'}
    $text=Microsoft.PowerShell.Utility\Invoke-RestMethod -Uri $Uri
    $sha=[Security.Cryptography.SHA256]::Create()
    try{$hash=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$text)))).Replace('-','').ToLower()}finally{$sha.Dispose()}
    [IO.File]::WriteAllText((Join-Path $i.windows_profile 'bootstrap-executed.json'),(@{sha256=$hash;retrieved=[DateTime]::UtcNow.ToString('o');uri=$Uri}|ConvertTo-Json))
    if($hash -ne $m.bootstrap_sha256){throw 'Public bootstrap changed after source resolution; freshness is inconclusive'}
    return $text
}

function Assert-OwnedCompose {
    if ([IO.Path]::GetFullPath((Get-Location).Path) -ne $install) { throw 'Unexpected installer working directory' }
    $raw=@(& $global:S6InstallerNativeDocker compose config --format json)
    if($LASTEXITCODE -ne 0){throw 'Compose resolution failed before resource creation'}
    $c=($raw -join "`n")|ConvertFrom-Json
    if($c.name -ne $i.project){throw 'Compose project escaped ownership'}
    foreach($service in @('web','engine')) {
        $s=$c.services.$service
        if([IO.Path]::GetFullPath($s.build.context) -ne $install){throw 'Build context escaped ownership'}
        $p=@($s.ports)
        $want=if($service -eq 'web'){$i.web_port}else{$i.engine_port}
        if($p.Count -ne 1 -or $p[0].host_ip -ne '127.0.0.1' -or [int]$p[0].published -ne [int]$want){throw 'Published port escaped loopback ownership'}
    }
    $mount=@($c.services.engine.volumes|Where-Object {$_.target -eq '/app/data'})
    if($mount.Count -ne 1 -or $mount[0].type -ne 'bind' -or [IO.Path]::GetFullPath($mount[0].source) -ne [IO.Path]::GetFullPath($env:S6_DATA_PATH)){throw 'Data mount escaped ownership'}
    # Persist the proof BEFORE compose up can create anything.
    [IO.File]::WriteAllText((Join-Path $install 'ownership-compose-proof.json'),(@{project=$c.name;install=$install;data=$mount[0].source;web=$i.web_port;engine=$i.engine_port;checked=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json))
}
function global:docker {
    $dockerArgs=@($args)
    if($dockerArgs.Count -ge 2 -and $dockerArgs[0] -eq 'compose' -and $dockerArgs[1] -eq 'up'){Assert-OwnedCompose}
    if($dockerArgs.Count -ge 1 -and $dockerArgs[0] -eq 'run') {
        if($Invocation -ne 'custom'){throw 'Unexpected Docker fallback invocation'}
        $mountIndex=[Array]::IndexOf($dockerArgs,'--mount')
        if($mountIndex -lt 0 -or $dockerArgs[$mountIndex+1] -ne ('type=bind,source='+$install+',target=/s6_cut')){throw 'Git fallback mount escaped ownership'}
        $global:S6InstallerGitFallbackCalls++
        # Label the real, otherwise unchanged fallback container so interrupted
        # Git work is covered by this run's pre-existing ownership manifest.
        $dockerArgs=@('run','--label',('com.docker.compose.project='+$i.project)) + $dockerArgs[1..($dockerArgs.Count-1)]
    }
    & $global:S6InstallerNativeDocker @dockerArgs
    $global:LASTEXITCODE=$LASTEXITCODE
}
if($Invocation -eq 'custom') {
    # Hide only Git command discovery inside this child. Host Git stays installed.
    function Get-Command {
        param([string]$Name,[string]$ErrorAction)
        if($Name -eq 'git'){return $null}
        Microsoft.PowerShell.Core\Get-Command -Name $Name -ErrorAction $ErrorAction
    }
}
New-Item -ItemType Directory -Path $i.windows_profile -Force | Out-Null
Set-Location -LiteralPath $i.windows_profile
if($Invocation -eq 'published') {
    # Exact README one-liner; no patched installer source or alternate arguments.
    irm https://raw.githubusercontent.com/carmelo-schepis/S6_CUT/main/Install-S6_CUT.ps1 | iex
} elseif($Invocation -eq 'custom') {
    & (Join-Path (Split-Path $Manifest) 'bootstrap.ps1') -InstallDir $install
    [IO.File]::WriteAllText((Join-Path $install 'git-fallback-proof.json'),(@{calls=$global:S6InstallerGitFallbackCalls}|ConvertTo-Json))
} elseif($Invocation -eq 'candidate') {
    & (Join-Path (Split-Path $Manifest) 'bootstrap.ps1') -Branch $m.candidate_branch
} else {
    Set-Location -LiteralPath $install
    Assert-OwnedCompose
    docker compose up -d --build
    if($LASTEXITCODE -ne 0){throw 'Old fixture failed to start'}
}
