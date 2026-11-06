#!/usr/bin/env python3
"""Stage the credential-free package through existing trusted fleet access.

Run on the planning checkout while no Windows verification worker is running.
The unattended SSH key cannot upload or replace this code.
"""
import argparse
import base64
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

PACKAGE = Path(__file__).resolve().parent
REPO = PACKAGE.parents[2]
WINDOWS_ROOT = 'C:/Users/charl/AppData/Local/S6InstallerVerification'


def run(args, timeout=90):
    p = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if p.returncode:
        raise RuntimeError('Deployment failed: ' + p.stderr[-1200:])
    return p.stdout


def native(script):
    code = base64.b64encode(("$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';" + script).encode('utf-16le')).decode()
    return run(['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', 'windowspc', 'powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', code])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--controller-only', action='store_true')
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='s6win-deploy-') as directory:
        stage = Path(directory)
        package = stage / 'package'
        package.mkdir()
        for p in PACKAGE.iterdir():
            if p.is_file() and p.suffix in {'.py', '.ps1', '.md'}:
                shutil.copyfile(p, package / p.name)
        for name in ('package.json', 'playwright.config.ts', 'tests/acceptance/windows-installer-verification.spec.ts', 'tests/acceptance/support/workspace.ts'):
            p = package / 'browser' / name
            p.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(REPO / name, p)
        archive = stage / 'package.tar.gz'
        with tarfile.open(archive, 'w:gz') as tar:
            tar.add(package, arcname='package')
        if not args.controller_only:
            native("$r='" + WINDOWS_ROOT + "';New-Item -ItemType Directory -Path $r -Force|Out-Null;$o=Join-Path $r 'deployment-owner.json';if(Test-Path $o){if((Get-Content $o -Raw|ConvertFrom-Json).owner -ne 's6-windows-installer-verification-v1'){throw 'Foreign deployment root'}}else{[IO.File]::WriteAllText($o,'{\"owner\":\"s6-windows-installer-verification-v1\"}')};$a=Join-Path $r 'active.json';if(Test-Path $a){$id=(Get-Content $a -Raw|ConvertFrom-Json).run_id;$state=Get-Content (Join-Path $r ('runs/'+$id+'/state.json')) -Raw|ConvertFrom-Json;if($state.status -eq 'RUNNING'){throw 'Do not replace a running worker package'}}")
            run(['scp', str(archive), 'windowspc:' + WINDOWS_ROOT + '/package.tar.gz'])
            native("& tar.exe -xzf " + WINDOWS_ROOT + '/package.tar.gz -C ' + WINDOWS_ROOT + ";if($LASTEXITCODE -ne 0){throw 'Package extraction failed'};$link='" + WINDOWS_ROOT + "/package/browser/node_modules';if(-not (Test-Path -LiteralPath $link)){& wsl.exe -d Ubuntu -e ln -s /home/charl/Git_projects/S6_CUT/node_modules /mnt/c/Users/charl/AppData/Local/S6InstallerVerification/package/browser/node_modules;if($LASTEXITCODE -ne 0){throw 'Existing Playwright dependency link failed'}}")
        run(['scp', str(archive), 'mbpro1:/tmp/s6win-deployment-package.tar.gz'])
        output = run(['ssh', 'mbpro1', 'mkdir -p /Users/dummy/.hermes/s6-cut-windows-verification && chmod 700 /Users/dummy/.hermes/s6-cut-windows-verification && tar -xzf /tmp/s6win-deployment-package.tar.gz -C /Users/dummy/.hermes/s6-cut-windows-verification && cd /Users/dummy/.hermes/s6-cut-windows-verification/package && /Users/dummy/.hermes/hermes-agent/venv/bin/python deploy.py'])
        print(output)


if __name__ == '__main__':
    main()
