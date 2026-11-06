# The on-demand Windows task keeps wsl.exe (and its native interop endpoint)
# alive until the worker exits. There are deliberately no recurring triggers.
param([Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{32}$')][string]$RunId)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$env:WSL_UTF8='1'
& wsl.exe -d Ubuntu -e python3 /mnt/c/Users/charl/AppData/Local/S6InstallerVerification/package/worker.py run $RunId
exit $LASTEXITCODE
