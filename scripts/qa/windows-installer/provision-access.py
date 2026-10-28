#!/usr/bin/env python3
"""One-time trusted deployment: private key never leaves mbpro1.

Run on the planning host with its existing approved windowspc and mbpro1 aliases.
This provisions a per-key forced command, not another Windows user or sshd policy.
"""
import base64
import json
import subprocess


def run(args, *, stdin=None, check=True, timeout=60):
    result = subprocess.run(args, input=stdin, capture_output=True, text=True, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError('Provisioning step failed: ' + result.stderr[-1000:])
    return result


def windows(script):
    encoded = base64.b64encode(script.encode('utf-16le')).decode()
    return run(['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', 'windowspc', 'powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded])


def main():
    key = '/Users/dummy/.ssh/s6_windows_verification_ed25519'
    run(['ssh', 'mbpro1', 'python3 -'], stdin=f'''from pathlib import Path
import subprocess
p=Path({key!r})
if not p.exists(): subprocess.run(['ssh-keygen','-q','-t','ed25519','-N','','-C','s6-windows-installer-verification','-f',str(p)],check=True)
p.chmod(0o600)
''')
    public = run(['ssh', 'mbpro1', 'cat ' + key + '.pub']).stdout.strip()
    if not public.startswith('ssh-ed25519 ') or len(public.split()) != 3:
        raise RuntimeError('Unexpected public identity format')
    forced = 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File C:/Users/charl/AppData/Local/S6InstallerVerification/package/entry.ps1'
    line = 'restrict,from="100.108.250.42",command="' + forced + '" ' + public
    encoded_line = base64.b64encode(line.encode()).decode()
    windows("""$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$p=Join-Path $env:ProgramData 'ssh/administrators_authorized_keys'
$text=[IO.File]::ReadAllText($p)
$line=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('""" + encoded_line + """'))
if(-not $text.Contains(($line -split ' ')[-2])){
 Copy-Item -LiteralPath $p -Destination ($p+'.s6-verification-'+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')+'.bak')
 [IO.File]::WriteAllText($p,($text.TrimEnd()+"`r`n"+$line+"`r`n"),[Text.UTF8Encoding]::new($false))
}
Write-Output 'Restricted public identity installed; existing ACL preserved'
""")
    config = f'''Host windowspc
    HostName 100.111.238.11
    User charl
    IdentityFile {key}
    IdentitiesOnly yes
    BatchMode yes
    StrictHostKeyChecking yes
    RequestTTY no
'''
    test_config = '/Users/dummy/.ssh/.s6-windows-verification-test-config'
    run(['ssh', 'mbpro1', 'python3 -'], stdin=f'''from pathlib import Path
p=Path({test_config!r});p.write_text({config!r});p.chmod(0o600)
''')
    # These are deliberately separate connections, exercising the actual key rules.
    prefix = 'ssh -F ' + test_config + ' -o ConnectTimeout=15 windowspc '
    positive = run(['ssh', 'mbpro1', prefix + "'s6win probe'"], timeout=90)
    if '"identity"' not in positive.stdout:
        raise RuntimeError('Restricted identity did not reach the native workflow')
    negative = run(['ssh', 'mbpro1', prefix + "'whoami'"], check=False)
    if negative.returncode == 0 or 'Only the S6_CUT Windows installer workflow' not in negative.stderr:
        raise RuntimeError('Arbitrary command rejection was not proven; do not activate identity')
    forwarding = run(['ssh', 'mbpro1', 'ssh -F ' + test_config + ' -o ConnectTimeout=15 -W 127.0.0.1:18521 windowspc'], check=False)
    if forwarding.returncode == 0 or 'administratively prohibited' not in forwarding.stderr:
        raise RuntimeError('Forwarding rejection was not proven; do not activate identity')
    run(['ssh', 'mbpro1', 'python3 -'], stdin=f'''from pathlib import Path
import datetime,shutil,re
p=Path.home()/'.ssh/config';text=p.read_text() if p.exists() else '';lines=text.splitlines(keepends=True)
starts=[i for i,line in enumerate(lines) if re.fullmatch(r'Host\\s+windowspc\\s*',line.strip(),re.I)]
if len(starts)>1: raise RuntimeError('Duplicate literal windowspc blocks require inspection')
start=starts[0] if starts else len(lines);end=next((i for i in range(start+1,len(lines)) if re.match(r'\\s*(Host|Match)\\s',lines[i],re.I)),len(lines))
if p.exists(): shutil.copy2(p,p.with_name('config.s6-verification-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'.bak'))
new=''.join(lines[:start]).rstrip()+'\\n'+{config!r}+''.join(lines[end:])
p.write_text(new)
''')
    final = run(['ssh', 'mbpro1', "ssh -o BatchMode=yes -o ConnectTimeout=15 windowspc 's6win probe'"], timeout=90)
    if '"identity"' not in final.stdout:
        raise RuntimeError('Alias activation readback failed')
    print(json.dumps({'private_identity': 'mbpro1:' + key, 'alias': 'windowspc', 'authentication': 'PASS', 'arbitrary_commands': 'REJECTED', 'forwarding': 'REJECTED', 'source_restriction': 'mbpro1 Tailscale address only'}, indent=2))


if __name__ == '__main__':
    main()
