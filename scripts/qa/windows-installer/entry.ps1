# Fixed command entry point for the dedicated Windows verification public key.
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$original=[string]$env:SSH_ORIGINAL_COMMAND
if($original -eq 's6win probe'){
    & wsl.exe -d Ubuntu -e python3 /mnt/c/Users/charl/AppData/Local/S6InstallerVerification/package/worker.py probe
    exit $LASTEXITCODE
}
if($original -match '^s6win candidate ([a-f0-9]{32}) ([A-Za-z0-9][A-Za-z0-9/_-]{0,99})$'){
    $run=$Matches[1];$branch=$Matches[2]
    if($branch.Contains('..')){throw 'Invalid repository branch'}
    & wsl.exe -d Ubuntu -e python3 /mnt/c/Users/charl/AppData/Local/S6InstallerVerification/package/worker.py candidate $run --branch $branch
    exit $LASTEXITCODE
}
if($original -notmatch '^s6win (dispatch|status|recover|evidence) ([a-f0-9]{32})(?: (crash|timeout|crash-after-fresh))?$'){
    [Console]::Error.WriteLine('Only the S6_CUT Windows installer workflow is authorized by this key')
    exit 64
}
$action=$Matches[1];$run=$Matches[2];$fault=$Matches[3]
if($fault -and $action -ne 'dispatch'){throw 'Fault selector is only valid for dispatch'}
if($fault){
    & wsl.exe -d Ubuntu -e python3 /mnt/c/Users/charl/AppData/Local/S6InstallerVerification/package/worker.py $action $run --test-case $fault
}else{
    & wsl.exe -d Ubuntu -e python3 /mnt/c/Users/charl/AppData/Local/S6InstallerVerification/package/worker.py $action $run
}
exit $LASTEXITCODE
