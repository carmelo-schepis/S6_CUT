#!/usr/bin/env python3
"""Managed Windows task/WSL worker; installers and Compose use native PowerShell.

Only fixed actions exposed by entry.ps1 are accepted. No scheduler, account, global
environment, Docker daemon settings or pre-existing application data are changed.
"""
from __future__ import annotations

import argparse
import base64
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request

from contract import COMMAND, OWNER, RAW, REPOSITORY, TERMINAL, fingerprint, load_manifest, owned, sanitize, source_freshness, terminal, valid_id, write_json

PACKAGE = Path(__file__).resolve().parent
ROOT = Path('/mnt/c/Users/charl/AppData/Local/S6InstallerVerification')
LOCKS = Path.home() / '.local/state/s6-windows-installer'
POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
WIN_PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
MAX_RUN = 3600


class Blocked(RuntimeError):
    pass


class ProductFailure(RuntimeError):
    pass


class Inconclusive(RuntimeError):
    pass


def win(path: Path) -> str:
    path = path.absolute()
    parts = path.parts
    if len(parts) < 4 or parts[1] != 'mnt' or len(parts[2]) != 1:
        raise ValueError('native path must be on a Windows drive')
    return parts[2].upper() + ':\\' + '\\'.join(parts[3:])


def quote(value) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def native(script: str, timeout: int = 60):
    body = "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';\n" + script
    body += "\n$j=ConvertTo-Json -InputObject $result -Depth 12 -Compress;[Console]::WriteLine('S6JSON:'+ [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($j)))"
    result = subprocess.run([POWERSHELL, '-NoProfile', '-NonInteractive', '-EncodedCommand', base64.b64encode(body.encode('utf-16le')).decode()], capture_output=True, timeout=timeout)
    lines = result.stdout.decode('utf-8', errors='replace').splitlines()
    messages = [line[7:] for line in lines if line.startswith('S6JSON:')]
    if result.returncode or len(messages) != 1:
        raise Blocked('Native PowerShell bridge failed: ' + sanitize(result.stderr.decode('utf-8', errors='replace')[-1400:]))
    return json.loads(base64.b64decode(messages[0]))


def native_command(args: list[str], *, cwd: Path | None = None, env: dict | None = None, timeout=90) -> dict:
    prefix = ""
    if cwd:
        prefix += 'Set-Location -LiteralPath ' + quote(win(cwd)) + '\n'
    # Remove inherited app/provider configuration from THIS native process.
    prefix += "Get-ChildItem Env: | Where-Object {$_.Name -like 'S6_*' -or $_.Name -like 'COMPOSE_*' -or $_.Name -eq 'OPENROUTER_API_KEY'} | ForEach-Object {Remove-Item -LiteralPath ('Env:'+$_.Name)}\n"
    for key, value in (env or {}).items():
        if not re.fullmatch(r'[A-Z][A-Z0-9_]+', key):
            raise ValueError('invalid environment key')
        prefix += '$env:' + key + '=' + quote(value) + '\n'
    prefix += "$ErrorActionPreference='Continue'\n$out=@(& " + quote(args[0]) + ' ' + ' '.join(quote(x) for x in args[1:]) + " 2>&1)\n$code=$LASTEXITCODE\n$result=@{code=$code;stdout=[string]($out | Out-String)}"
    return native(prefix, timeout)


def require(command: dict, message: str) -> str:
    if command['code']:
        raise Blocked(message + ': ' + sanitize(command['stdout'][-1000:]))
    return command['stdout'].strip()


def env_for(item: dict) -> dict:
    return {'COMPOSE_PROJECT_NAME': item['project'], 'S6_PORT': f"127.0.0.1:{item['web_port']}", 'S6_ENGINE_PORT': str(item['engine_port']), 'S6_DATA_PATH': win(Path(item['install']) / 'data'), 'S6_BUILD_REVISION': item['expected_revision']}


def compose(item: dict, *args: str, timeout=90) -> dict:
    return native_command(['docker.exe', 'compose', '--project-directory', win(Path(item['install'])), '-p', item['project'], *args], cwd=Path(item['install']), env=env_for(item), timeout=timeout)


def probe() -> dict:
    result = native("""
$result=[ordered]@{identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name;windows=[Environment]::OSVersion.VersionString;powershell=$PSVersionTable.PSVersion.ToString();git=[string](& git.exe --version);compose=[string](& docker.exe compose version --short);engine=[string](& docker.exe info --format '{{.OSType}}');free_bytes=(Get-PSDrive C).Free;free_memory_kb=(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory;containers=@()}
if($LASTEXITCODE -ne 0){throw 'Docker daemon unavailable'}
$raw=@(& docker.exe ps -a --format '{{json .}}')
if($LASTEXITCODE -ne 0){throw 'Docker enumeration failed'}
$result.containers=@($raw|ForEach-Object {$_|ConvertFrom-Json}|ForEach-Object {@{id=$_.ID;name=$_.Names;state=$_.State;ports=$_.Ports}})
""", 40)
    version = re.search(r'(\d+)\.(\d+)', result['compose'])
    if not version or tuple(map(int, version.groups())) < (2, 26):
        raise Blocked('Windows requires Docker Compose 2.26 or newer')
    if result['engine'].strip() != 'linux':
        raise Blocked('Docker must use Linux containers')
    if result['free_bytes'] < 15 * 1024 ** 3 or result['free_memory_kb'] < 4 * 1024 ** 2:
        raise Blocked('Insufficient free disk or memory for an isolated build')
    for executable in ('tmux', 'node', 'git'):
        if not shutil.which(executable):
            raise Blocked('WSL prerequisite missing: ' + executable)
    if not (PACKAGE / 'browser/node_modules/@playwright/test').exists():
        raise Blocked('Existing Playwright installation has not been linked to this harness')
    result['wsl_boot_id'] = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    result['node'] = subprocess.check_output(['node', '--version'], text=True).strip()
    result['tmux'] = subprocess.check_output(['tmux', '-V'], text=True).strip()
    return result


def fetch(url: str) -> bytes:
    try:
        with urllib.request.urlopen(url, timeout=35) as response:
            return response.read(4 * 1024 * 1024)
    except OSError as exc:
        raise Blocked('Public source download failed: ' + type(exc).__name__) from exc


def current_revision(branch='main') -> str:
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9/_-]{0,99}', branch) or '..' in branch:
        raise ValueError('Invalid fixed-repository branch')
    p = subprocess.run(['git', 'ls-remote', REPOSITORY, 'refs/heads/' + branch], capture_output=True, text=True, timeout=45)
    if p.returncode or not re.match(r'^[0-9a-f]{40}\s', p.stdout):
        raise Blocked('Could not resolve public main revision')
    return p.stdout.split()[0]


@contextlib.contextmanager
def lock(name: str):
    LOCKS.mkdir(parents=True, exist_ok=True)
    with (LOCKS / name).open('a+') as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise Blocked('Another Windows installer worker owns the nonblocking lock') from exc
        yield


def active() -> dict | None:
    p = ROOT / 'active.json'
    return json.loads(p.read_text()) if p.exists() else None


def save(data: dict, stage: str | None = None) -> None:
    if stage:
        data['stage'] = stage
    data['updated_at'] = time.time()
    write_json(ROOT / 'runs' / data['run_id'] / 'state.json', data)


def allocate(data: dict, kind: str, revision: str) -> dict:
    run_root = ROOT / 'runs' / data['run_id']
    profile = owned(run_root / 'payload', run_root / 'payload' / (kind + '-profile'))
    install = profile / 's6_cut' if kind != 'custom' else profile / 'custom path with spaces'
    # Native listeners prove Windows loopback ports are unused, not just WSL ports.
    ports = native("$a=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0);$b=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0);try{$a.Start();$b.Start();$result=@($a.LocalEndpoint.Port,$b.LocalEndpoint.Port)}finally{$a.Stop();$b.Stop()}")
    item = {'kind': kind, 'project': 's6iv-' + data['run_id'] + '-' + kind, 'profile': str(profile), 'install': str(install), 'windows_profile': win(profile), 'windows_install': win(install), 'web_port': int(ports[0]), 'engine_port': int(ports[1]), 'expected_revision': revision}
    data['installations'].append(item)
    # Manifest first, resources second.
    save(data, kind + ':allocated')
    profile.mkdir(parents=True, exist_ok=False)
    return item


def run_native_file(data: dict, script: Path, args: list[str], label: str, timeout: int, *, owned_temp=False) -> dict:
    run_root = ROOT / 'runs' / data['run_id']
    process_file = run_root / ('process-' + label + '.json')
    stdout = run_root / (label + '.stdout.log')
    stderr = run_root / (label + '.stderr.log')
    data.setdefault('process_records', []).append(str(process_file))
    save(data, label)
    argv = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', win(script), *args]
    # Start-Process's argument string is deliberately quoted once, for native Windows.
    argument_string = ' '.join('"' + x.replace('"', '\\"') + '"' for x in argv)
    prefix = ''
    if owned_temp:
        scratch = owned(run_root / 'payload', run_root / 'payload' / 'native-harness-temp')
        scratch.mkdir(parents=True, exist_ok=True)
        prefix = '$env:TEMP=' + quote(win(scratch)) + ';$env:TMP=$env:TEMP\n'
    body = (prefix + '$p=Start-Process -FilePath ' + quote(WIN_PS) + ' -ArgumentList ' + quote(argument_string) + ' -PassThru -RedirectStandardOutput ' + quote(win(stdout)) + ' -RedirectStandardError ' + quote(win(stderr)) + '\n'
            '$handle=$p.Handle\n'
            '$token=$p.StartTime.ToUniversalTime().Ticks;[IO.File]::WriteAllText(' + quote(win(process_file)) + ',(@{pid=$p.Id;start_ticks=[string]$token}|ConvertTo-Json))\n'
            '$timedOut=-not $p.WaitForExit(' + str(timeout * 1000) + ')\n'
            'if($timedOut){$current=Get-Process -Id $p.Id -ErrorAction SilentlyContinue;if($current -and $current.StartTime.ToUniversalTime().Ticks -eq $token){& taskkill.exe /PID $p.Id /T /F > $null 2>&1};$p.WaitForExit(10000)|Out-Null}\n'
            '$exitCode=$p.ExitCode;$result=@{exit=$exitCode;timed_out=$timedOut;pid=$p.Id;start_ticks=[string]$token}')
    result = native(body, timeout + 35)
    result['stdout_tail'] = stdout.read_text(errors='replace')[-2400:] if stdout.exists() else ''
    result['stderr_tail'] = stderr.read_text(errors='replace')[-1200:] if stderr.exists() else ''
    if result['timed_out']:
        raise Inconclusive(label + ' exceeded its owned process deadline')
    return result


def install(data: dict, item: dict, invocation='published', label=None) -> None:
    label = label or item['kind'] + '-install'
    index = data['installations'].index(item)
    r = run_native_file(data, PACKAGE / 'install-child.ps1', ['-Manifest', win(ROOT / 'runs' / data['run_id'] / 'state.json'), '-Installation', str(index), '-Invocation', invocation], label, 900)
    data.setdefault('installer_runs', []).append({'label': label, **r})
    save(data)
    if r['exit'] is None:
        raise Inconclusive('Native process exited without a trustworthy exit-status receipt')
    if r['exit'] != 0:
        text = r['stdout_tail'] + '\n' + r['stderr_tail']
        if 'bootstrap changed after source resolution' in text:
            raise Inconclusive('Public bootstrap moved during installation')
        if re.search(r'network|name resolution|could not resolve|TLS|timed out|connection.*(?:refused|reset)|no space|engine is not running', text, re.I):
            raise Blocked('Installer infrastructure failure: ' + text[-1200:])
        raise ProductFailure('Installer returned nonzero: ' + text[-1400:])
    if invocation != 'fixture':
        if not re.search(r'Frontend: http://(?:127\.0\.0\.1|localhost):' + str(item['web_port']), r['stdout_tail']):
            raise ProductFailure('Installer did not advertise the verified frontend URL')
    if not (Path(item['install']) / 'ownership-compose-proof.json').is_file():
        raise Inconclusive('Missing pre-creation ownership proof')
    if invocation == 'published':
        proof = json.loads((Path(item['profile']) / 'bootstrap-executed.json').read_text())
        data.setdefault('executed_bootstraps', []).append({'label': label, **proof})
        save(data)


def http_json(url: str):
    with urllib.request.urlopen(url, timeout=12) as response:
        return json.load(response)


def verify(data: dict, item: dict) -> None:
    install_root = Path(item['install'])
    sha = require(native_command(['git.exe', 'rev-parse', 'HEAD'], cwd=install_root), 'Installed revision unavailable')
    if sha != item['expected_revision']:
        if current_revision() != data['source_revision']:
            raise Inconclusive('Public main moved while the checkout was being installed')
        raise ProductFailure('Checkout did not advance to expected revision: ' + sha + ' expected ' + item['expected_revision'])
    deadline = time.monotonic() + 150
    services = []
    while time.monotonic() < deadline:
        raw = require(compose(item, 'ps', '--format', 'json'), 'Service enumeration failed')
        services = json.loads(raw) if raw.startswith('[') else [json.loads(x) for x in raw.splitlines() if x.strip()]
        if len(services) == 3 and all(x.get('Health') == 'healthy' for x in services):
            break
        time.sleep(3)
    else:
        raise ProductFailure('Required Compose services did not all become healthy')
    base = f"http://127.0.0.1:{item['web_port']}"
    health = http_json(base + '/api/health')
    if health.get('buildRevision') != item['expected_revision']:
        raise ProductFailure('Running engine revision differs from installed checkout')
    config = json.loads(require(compose(item, 'config', '--format', 'json'), 'Config unavailable'))
    for name, port in [('web', item['web_port']), ('engine', item['engine_port'])]:
        mapping = config['services'][name]['ports']
        if len(mapping) != 1 or mapping[0].get('host_ip') != '127.0.0.1' or int(mapping[0]['published']) != port:
            raise ProductFailure('Resolved port ownership changed')
    inspections = json.loads(require(native_command(['docker.exe', 'inspect', *[x['ID'] for x in services]]), 'Actual running port inspection failed'))
    for container in inspections:
        for values in container['NetworkSettings']['Ports'].values():
            for mapping in values or []:
                if mapping['HostIp'] != '127.0.0.1':
                    raise ProductFailure('Running container exposed a port beyond loopback')
        if container['Config']['Labels'].get('com.docker.compose.project') != item['project']:
            raise Inconclusive('Container project identity mismatch')
    for suffix in ('/healthz', '/'):
        with urllib.request.urlopen(base + suffix, timeout=15) as response:
            body = response.read()
            if response.status != 200 or not body:
                raise ProductFailure('Frontend assets/readiness failed')
            if suffix == '/':
                item['frontend_index_sha256'] = hashlib.sha256(body).hexdigest()
    code = "import hashlib,json;from pathlib import Path;r=Path('/app/engine');print(json.dumps({p.relative_to(r).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in r.rglob('*.py')}))"
    running = json.loads(require(compose(item, 'exec', '-T', 'engine', 'python', '-c', code), 'Running engine content unavailable'))
    source = {p.relative_to(install_root / 'engine').as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in (install_root / 'engine').rglob('*.py')}
    if running != source:
        raise ProductFailure('Running image contains outdated engine source')
    app_hash = hashlib.sha256(json.dumps(running, sort_keys=True).encode()).hexdigest()
    require(compose(item, 'exec', '-T', 'engine', 'python', '-c', "from pathlib import Path;p=Path('/app/data/.installer-write-check');p.write_text('owned');p.unlink()"), 'Data bind mount not writable')
    item.update(installed_revision=sha, services=[{'name': x['Service'], 'id': x['ID'], 'health': x['Health']} for x in services], running_source_sha256=app_hash,
                running_images=[{'service': x['Config']['Labels'].get('com.docker.compose.service'), 'image_id': x['Image'], 'image': x['Config']['Image']} for x in inspections])
    save(data)


def browser(data: dict, item: dict, mode: str, label: str) -> None:
    run_root = ROOT / 'runs' / data['run_id']
    output = run_root / 'payload' / (label + '-browser')
    output.mkdir(parents=True, exist_ok=True)
    record = run_root / (item['kind'] + '-application-record.json')
    download = run_root / 'payload' / '.media-check' / (label + '.mp4')
    download.parent.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, 'S6_ACCEPTANCE_URL': f"http://127.0.0.1:{item['web_port']}", 'S6_PLAYWRIGHT_ARTIFACTS': str(output), 'S6_INSTALLER_ISOLATED': '1', 'S6_INSTALLER_MODE': mode, 'S6_INSTALLER_NAME': 'Installer ' + data['run_id'] + ' ' + item['kind'], 'S6_INSTALLER_RECORD': str(record), 'S6_INSTALLER_FIXTURE': str(Path(item['install']) / 'test-video.mp4'), 'S6_INSTALLER_DOWNLOAD': str(download)}
    logfile = run_root / (label + '.browser.log')
    save(data, label + ':browser-' + mode)
    with logfile.open('w') as stream:
        try:
            p = subprocess.Popen(['node', 'node_modules/@playwright/test/cli.js', 'test', 'windows-installer-verification.spec.ts', '--project=Desktop Chromium', '--config=playwright.config.ts'], cwd=PACKAGE / 'browser', env=env, stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
            data.setdefault('browser_processes', []).append({'pid': p.pid, 'start': Path(f'/proc/{p.pid}/stat').read_text().split()[21], 'boot_id': data['boot_id'], 'label': label})
            save(data)
            try:
                p.wait(timeout=360)
            except subprocess.TimeoutExpired:
                os.killpg(p.pid, signal.SIGKILL)
                p.wait(timeout=10)
                raise
        except subprocess.TimeoutExpired as exc:
            raise Inconclusive('Browser smoke test exceeded its deadline') from exc
    if p.returncode:
        # The log tail contains attachment paths, often hiding the actual assertion.
        report = output / 'playwright-results.json'
        error = ''
        if report.exists():
            def errors(node):
                if isinstance(node, dict):
                    if isinstance(node.get('error'), dict) and node['error'].get('message'):
                        yield node['error']['message']
                    for value in node.values():
                        yield from errors(value)
                elif isinstance(node, list):
                    for value in node:
                        yield from errors(value)
            error = next(errors(json.loads(report.read_text())), '')
        raise ProductFailure('Application smoke assertion failed: ' + (error or logfile.read_text(errors='replace'))[:1800])
    results = json.loads((output / 'playwright-results.json').read_text())
    if results['stats']['unexpected'] or results['stats']['skipped'] or results['stats']['expected'] != 1:
        raise Inconclusive('Browser test skipped or did not execute exactly one case')
    # Reuse the real engine's existing decoders; no host FFmpeg dependency.
    media = '/app/data/.installer-media-check/output.mp4'
    native('$target=' + quote(win(Path(item['install']) / 'data/.installer-media-check')) + ';New-Item -ItemType Directory -Path $target -Force|Out-Null;Copy-Item -LiteralPath ' + quote(win(download)) + " -Destination (Join-Path $target 'output.mp4') -Force;$result=@{copied=$true}")
    probe = json.loads(require(compose(item, 'exec', '-T', 'engine', 'ffprobe', '-v', 'error', '-show_entries', 'format=duration,format_name:stream=codec_type,codec_name', '-of', 'json', media), 'Downloaded output is not valid media'))
    if float(probe['format']['duration']) <= 0 or 'mp4' not in probe['format']['format_name'] or not any(x['codec_type'] == 'video' for x in probe['streams']):
        raise ProductFailure('Downloaded output has invalid video metadata')
    require(compose(item, 'exec', '-T', 'engine', 'ffmpeg', '-v', 'error', '-i', media, '-f', 'null', '-', timeout=60), 'Downloaded media cannot be decoded')
    native('Remove-Item -LiteralPath ' + quote(win(Path(item['install']) / 'data/.installer-media-check/output.mp4')) + ' -Force;$result=@{removed=$true}')
    download.unlink()
    data.setdefault('browser_runs', []).append({'label': label, 'mode': mode, 'status': 'PASS', 'record': str(record), 'decoded_media': probe})
    save(data)


def cleanup(data: dict, *, recovery=False) -> dict:
    # Read and validate persisted ownership again before EVERY recovery mutation.
    data = load_manifest(ROOT, data['run_id'])
    errors = []
    for record in data.get('browser_processes', []):
        try:
            pid = int(record['pid'])
            proc = Path(f'/proc/{pid}/stat')
            if record['boot_id'] != Path('/proc/sys/kernel/random/boot_id').read_text().strip() or not proc.exists():
                continue
            stat = proc.read_text().split()
            if stat[21] == record['start'] and stat[2] != 'Z' and os.getpgid(pid) == pid:
                os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except Exception as exc:
            errors.append('owned browser cleanup: ' + sanitize(str(exc))[:200])
    for record in data.get('process_records', []):
        p = owned(ROOT / 'runs' / data['run_id'], Path(record))
        if not p.exists():
            continue
        r = json.loads(p.read_text())
        try:
            native('$p=Get-Process -Id ' + str(int(r['pid'])) + ' -ErrorAction SilentlyContinue;if($p -and [string]$p.StartTime.ToUniversalTime().Ticks -eq ' + quote(r['start_ticks']) + '){& taskkill.exe /PID $p.Id /T /F > $null 2>&1};$result=@{checked=$true}')
        except Exception as exc:
            errors.append('owned process cleanup: ' + str(exc)[:200])
    for item in data.get('installations', []):
        try:
            # Do not rely on a mutable compose file for destructive cleanup.
            raw = require(native_command(['docker.exe', 'ps', '-aq', '--filter', 'label=com.docker.compose.project=' + item['project']]), 'Owned container enumeration failed')
            ids = raw.split()
            if ids:
                records = json.loads(require(native_command(['docker.exe', 'inspect', *ids]), 'Ownership readback failed'))
                if any(x['Config']['Labels'].get('com.docker.compose.project') != item['project'] for x in records):
                    raise ValueError('Foreign container in ownership query')
                require(native_command(['docker.exe', 'rm', '-f', *ids]), 'Owned container removal failed')
            for resource, label in [('network', 'com.docker.compose.project'), ('volume', 'com.docker.compose.project')]:
                raw = require(native_command(['docker.exe', resource, 'ls', '-q', '--filter', f'label={label}=' + item['project']]), 'Owned resource enumeration failed')
                if raw:
                    # Docker's label filter is checked again via inspect before deletion.
                    for resource_id in raw.split():
                        obj = json.loads(require(native_command(['docker.exe', resource, 'inspect', resource_id]), 'Resource labels unavailable'))[0]
                        if (obj.get('Labels') or {}).get(label) != item['project']:
                            raise ValueError('Foreign Docker resource')
                        require(native_command(['docker.exe', resource, 'rm', resource_id]), 'Owned resource removal failed')
            for service in ('web', 'engine'):
                tag = item['project'] + '-' + service
                # Removing an exclusive tag never prunes shared image layers/build caches.
                native_command(['docker.exe', 'image', 'rm', tag])
            remain = require(native_command(['docker.exe', 'ps', '-aq', '--filter', 'label=com.docker.compose.project=' + item['project']]), 'Cleanup readback failed')
            if remain:
                raise ValueError('Owned containers remain')
        except Exception as exc:
            errors.append(item['project'] + ': ' + sanitize(str(exc))[:400])
    if not errors:
        payload = owned(ROOT / 'runs' / data['run_id'], ROOT / 'runs' / data['run_id'] / 'payload')
        if payload.exists():
            # Docker-created Unix 0700 metadata can deny WSL traversal. Native
            # Windows removes only the same owned subtree, without chmod or ACL changes.
            try:
                body = ('$root=' + quote(win(payload)) + ';'
                        '$stack=New-Object "Collections.Generic.Stack[string]";$stack.Push($root);'
                        'while($stack.Count -gt 0){$dir=$stack.Pop();foreach($p in [IO.Directory]::EnumerateFileSystemEntries($dir)){$a=[IO.File]::GetAttributes($p);if(($a -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw "Reparse point blocks owned cleanup"};if(($a -band [IO.FileAttributes]::Directory) -ne 0){$stack.Push($p)}}};'
                        'Remove-Item -LiteralPath $root -Recurse -Force;$result=@{removed=(-not (Test-Path -LiteralPath $root))}')
                receipt = native(body)
                if not receipt['removed']:
                    raise ValueError('Owned payload remains')
            except Exception as exc:
                errors.append('owned payload cleanup: ' + sanitize(str(exc))[:500])
    if data.get('windows_task'):
        task = 'S6CUT-Installer-' + data['run_id']
        if data['windows_task'] != task:
            raise ValueError('Foreign Windows task in ownership manifest')
        try:
            body = ('$t=Get-ScheduledTask -TaskName ' + quote(task) + ' -ErrorAction SilentlyContinue;'
                    'if($t){if($t.Description -ne ' + quote(OWNER) + ' -or @($t.Actions).Count -ne 1 -or $t.Actions[0].Execute -ne ' + quote(WIN_PS) + ' -or $t.Actions[0].Arguments -notlike ' + quote('*host.ps1*' + data['run_id'] + '*') + '){throw "Task ownership mismatch"};'
                    + ('if($t.State -eq "Running"){Stop-ScheduledTask -TaskName ' + quote(task) + '};' if recovery else '')
                    + 'Unregister-ScheduledTask -TaskName ' + quote(task) + ' -Confirm:$false};$result=@{removed=$true}')
            native(body)
        except Exception as exc:
            errors.append('owned task cleanup: ' + sanitize(str(exc))[:400])
    after = probe_containers()
    before = {x['id']: x for x in data.get('preflight', {}).get('containers', [])}
    current = {x['id']: x for x in after}
    # Existing stacks must remain present and running if they were running before.
    changed = [x['name'] for ident, x in before.items() if ident not in current or (x['state'] == 'running' and current[ident]['state'] != 'running')]
    if changed:
        errors.append('Pre-existing container state changed; inspect external activity: ' + ','.join(changed))
    return {'status': 'PASS' if not errors else 'FAILED', 'checked_at': time.time(), 'errors': errors, 'remaining_payload': (ROOT / 'runs' / data['run_id'] / 'payload').exists(), 'preexisting_preserved': not changed}


def probe_containers() -> list:
    raw = require(native_command(['docker.exe', 'ps', '-a', '--format', '{{json .}}']), 'Container inventory failed')
    return [{'id': x['ID'], 'name': x['Names'], 'state': x['State']} for x in [json.loads(line) for line in raw.splitlines() if line]]


def suite(data: dict) -> None:
    data['preflight'] = probe()
    save(data, 'source')
    branch = data.get('candidate_branch') or 'main'
    revision = current_revision(branch)
    readme = fetch(RAW + 'main/README.md')
    if COMMAND.encode() not in readme:
        raise Blocked('Public Windows installation instructions changed; update harness before claiming faithful coverage')
    bootstrap = fetch(RAW + branch + '/Install-S6_CUT.ps1')
    data.update(source_revision=revision, command=COMMAND, bootstrap_sha256=hashlib.sha256(bootstrap).hexdigest(), retrieved_at=time.time(), pre_source_revision=revision)
    run_root = ROOT / 'runs' / data['run_id']
    (run_root / 'bootstrap.ps1').write_bytes(bootstrap)
    (run_root / 'README.sha256').write_text(hashlib.sha256(readme).hexdigest())
    save(data)
    fresh = allocate(data, 'fresh', revision)
    invocation = 'candidate' if data.get('candidate_branch') else 'published'
    install(data, fresh, invocation)
    verify(data, fresh)
    data['tests']['fresh'] = 'PASS'
    browser(data, fresh, 'seed', 'fresh-seed')
    data['tests']['smoke'] = 'PASS'
    if data.get('test_case') == 'crash-after-fresh':
        save(data, 'fault:crash-after-fresh')
        os._exit(99)
    env_bytes = (Path(fresh['install']) / '.env').read_bytes()
    install(data, fresh, invocation, label='fresh-rerun')
    verify(data, fresh)
    if (Path(fresh['install']) / '.env').read_bytes() != env_bytes:
        raise ProductFailure('Fresh rerun changed .env bytes')
    browser(data, fresh, 'verify', 'fresh-rerun')
    data['tests']['rerun'] = 'PASS'
    if data.get('candidate_branch'):
        candidate_harness = run_native_file(data, Path(fresh['install']) / 'tests/installers/test-windows-installer.ps1', [], 'candidate-native-harness', 120, owned_temp=True)
        if candidate_harness['exit'] != 0:
            raise ProductFailure('Candidate native regression harness failed')
        data['tests']['native_stub_harness'] = 'PASS (stubbed)'
        data['candidate_validation'] = {'branch': branch, 'revision': revision, 'fresh': 'PASS', 'smoke': 'PASS', 'rerun': 'PASS', 'published_command_tested': False}
        save(data)
        return
    # The earlier fixture is a real recorded ancestor, not a same-revision rerun.
    require(native_command(['git.exe','fetch','--deepen=8','origin','main'],cwd=Path(fresh['install'])), 'Could not retrieve earlier compatible fixture')
    old_revision = require(native_command(['git.exe','rev-parse',revision+'~3'],cwd=Path(fresh['install'])), 'Older fixture revision unavailable')
    if old_revision == revision:
        raise Inconclusive('No genuine upgrade revision available')
    data['old_revision'] = old_revision
    upgrade = allocate(data, 'upgrade', old_revision)
    require(native_command(['git.exe','clone','--quiet','--depth','12','--branch','main',REPOSITORY,win(Path(upgrade['install']))]), 'Could not download old fixture checkout')
    require(native_command(['git.exe','reset','--hard',old_revision],cwd=Path(upgrade['install'])), 'Could not position owned fixture at earlier revision')
    old_root = Path(upgrade['install'])
    old_env = (old_root / '.env.example').read_bytes() + b'\nS6_INSTALLER_PRESERVATION_MARKER=disposable-nonsecret\n'
    (old_root / '.env').write_bytes(old_env)
    install(data, upgrade, 'fixture', label='upgrade-old-fixture')
    verify(data, upgrade)
    browser(data, upgrade, 'seed', 'upgrade-old-seed')
    data['tests']['older_fixture'] = 'PASS'
    upgrade['expected_revision'] = revision
    save(data, 'upgrade:current')
    install(data, upgrade, label='upgrade-current')
    verify(data, upgrade)
    if (old_root / '.env').read_bytes() != old_env:
        raise ProductFailure('Upgrade changed .env bytes')
    browser(data, upgrade, 'verify', 'upgrade-preserved')
    data['tests']['upgrade'] = 'PASS'
    install(data, upgrade, label='upgrade-idempotence')
    verify(data, upgrade)
    if (old_root / '.env').read_bytes() != old_env:
        raise ProductFailure('Second rerun changed .env bytes')
    browser(data, upgrade, 'verify', 'upgrade-idempotence')
    data['tests']['upgrade_idempotence'] = 'PASS'
    custom = allocate(data, 'custom', revision)
    install(data, custom, 'custom')
    verify(data, custom)
    proof = json.loads((Path(custom['install']) / 'git-fallback-proof.json').read_text())
    if proof['calls'] < 1:
        raise Inconclusive('Git-in-Docker fallback did not execute')
    data['tests']['fallback_custom_path_ports'] = 'PASS'
    harness = run_native_file(data, Path(fresh['install']) / 'tests/installers/test-windows-installer.ps1', [], 'native-stub-harness', 120, owned_temp=True)
    if harness['exit'] or 'PASS: native Windows PowerShell installer regression harness' not in harness['stdout_tail']:
        raise ProductFailure('Native installer stub harness failed: ' + harness['stderr_tail'])
    data['tests']['native_stub_harness'] = 'PASS (stubbed; separate from live evidence)'
    data['post_source_revision'] = current_revision()
    if source_freshness(revision, fresh['installed_revision'], data['post_source_revision']) != 'PASS':
        raise Inconclusive('Public main moved during the run; exact tested revisions are recorded')
    save(data, 'verified')


def run_worker(run_id: str) -> dict:
    with lock('worker.lock'):
        data = load_manifest(ROOT, run_id)
        data.update(status='RUNNING', pid=os.getpid(), boot_id=Path('/proc/sys/kernel/random/boot_id').read_text().strip(), process_start=Path(f'/proc/{os.getpid()}/stat').read_text().split()[21], started_at=time.time())
        save(data, 'preflight')
        result = 'PASS'
        error = None
        def expired(signum, frame):
            raise Inconclusive('Worker reached its own bounded one-hour deadline')
        signal.signal(signal.SIGALRM, expired)
        signal.alarm(MAX_RUN)
        try:
            if data.get('test_case') == 'crash':
                (ROOT / 'runs' / run_id / 'payload').mkdir()
                save(data, 'fault:crash')
                os._exit(99)
            elif data.get('test_case') == 'timeout':
                script = ROOT / 'runs' / run_id / 'sleep.ps1'
                script.write_text('Start-Sleep -Seconds 60')
                try:
                    run_native_file(data, script, [], 'owned-timeout', 1)
                except Inconclusive:
                    data['tests']['owned_timeout'] = 'PASS'
                else:
                    raise Inconclusive('Timeout fault did not time out')
            else:
                suite(data)
        except ProductFailure as exc:
            result, error = 'PRODUCT_FAILURE', str(exc)
            data['defect_fingerprint'] = fingerprint(data['stage'], error)
            data['confirmed'] = False  # Agent reproduction is required before a defect PR.
        except Blocked as exc:
            result, error = 'BLOCKED', str(exc)
        except (Inconclusive, Exception) as exc:
            result, error = 'INCONCLUSIVE', str(exc)
        finally:
            signal.alarm(0)
            save(data, 'cleanup')
            if result != 'PASS':
                # Keep small failure screenshots/JSON; large media and traces stay in payload.
                retained = ROOT / 'runs' / run_id / 'failure-evidence'
                budget = 8 * 1024 ** 2
                for p in (ROOT / 'runs' / run_id / 'payload').glob('*-browser/**/*'):
                    if p.is_file() and p.suffix in {'.png', '.json', '.md'} and not p.is_symlink() and p.stat().st_size <= budget:
                        retained.mkdir(exist_ok=True)
                        target = retained / (hashlib.sha256(str(p).encode()).hexdigest()[:10] + '-' + p.name)
                        shutil.copyfile(p, target)
                        budget -= p.stat().st_size
            try:
                data['cleanup'] = cleanup(data)
            except Exception as exc:
                data['cleanup'] = {'status': 'FAILED', 'errors': [sanitize(str(exc))[:600]]}
            data['test_status'] = result
            terminal(data, result, error=error)
            data['action'] = 'none' if data['status'] == 'PASS' else 'Inspect retained evidence; recover owned resources before retrying' if data['status'] == 'CLEANUP_FAILED' else 'Investigate the recorded failure; no passing test claim'
            save(data, 'terminal')
            for p in (ROOT / 'runs' / run_id).glob('*.log'):
                if p.stat().st_size > 2 * 1024 ** 2:
                    with p.open('rb') as stream:
                        stream.seek(-2 * 1024 ** 2, 2)
                        tail = stream.read()
                    p.write_bytes(tail)
        return data


def dispatch(run_id: str, test_case: str | None = None, candidate_branch=None) -> dict:
    valid_id(run_id)
    ROOT.mkdir(parents=True, exist_ok=True)
    with lock('dispatch.lock'):
        path = ROOT / 'runs' / run_id
        if path.exists():
            return {'accepted': True, 'existing': True, 'run_id': run_id, 'status': load_manifest(ROOT, run_id)['status']}
        current = active()
        if current:
            prior = load_manifest(ROOT, current['run_id'])
            if prior['status'] not in TERMINAL or prior.get('cleanup', {}).get('status') != 'PASS':
                return {'accepted': False, 'status': 'BLOCKED', 'reason': 'Prior ownership or cleanup is unresolved', 'run_id': prior['run_id']}
        # Thirty-day compact history, excluding any unresolved/active ownership.
        for candidate in (ROOT / 'runs').glob('*'):
            if not candidate.is_dir() or candidate.is_symlink() or not re.fullmatch('[a-f0-9]{32}', candidate.name) or (current and candidate.name == current['run_id']):
                continue
            try:
                prior = load_manifest(ROOT, candidate.name)
                if prior['status'] in TERMINAL and prior.get('cleanup', {}).get('status') == 'PASS' and prior.get('finished_at', time.time()) < time.time() - 30 * 86400:
                    # Terminal runs have no payload or process resources left.
                    shutil.rmtree(owned(ROOT / 'runs', candidate))
            except (ValueError, OSError):
                continue  # Unknown ownership is retained, never guessed away.
        path.mkdir(parents=True)
        data = {'owner': OWNER, 'run_id': run_id, 'status': 'RUNNING', 'stage': 'dispatched', 'created_at': time.time(), 'windows_payload': win(path / 'payload'), 'installations': [], 'process_records': [], 'tests': {}, 'test_case': test_case, 'candidate_branch': candidate_branch, 'cleanup': {'status': 'PENDING'}}
        save(data)
        write_json(ROOT / 'active.json', {'owner': OWNER, 'run_id': run_id})
        task = 'S6CUT-Installer-' + run_id
        data['windows_task'] = task
        save(data)
        arguments = '-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File ' + win(PACKAGE / 'host.ps1') + ' -RunId ' + run_id
        try:
            native('$name=' + quote(task) + ';if(Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue){throw "Task already exists"};'
                   '$a=New-ScheduledTaskAction -Execute ' + quote(WIN_PS) + ' -Argument ' + quote(arguments) + ';'
                   '$p=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Highest;'
                   '$s=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 4200) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries;'
                   'Register-ScheduledTask -TaskName $name -Action $a -Principal $p -Settings $s -Description ' + quote(OWNER) + '|Out-Null;'
                   'Start-ScheduledTask -TaskName $name;$result=@{started=$true;task=$name}')
        except Exception as exc:
            # Start may have succeeded before transport/readback failed. Preserve
            # ownership until status/recovery proves what actually happened.
            data['dispatch_error'] = 'Managed task dispatch needs readback: ' + str(exc)
            save(data)
        return {'accepted': data['status'] == 'RUNNING', 'run_id': run_id, 'status': data['status']}


def recover(run_id: str) -> dict:
    with lock('worker.lock'):
        data = load_manifest(ROOT, run_id)
        if data['status'] in TERMINAL and data.get('cleanup', {}).get('status') == 'PASS':
            return data
        if data.get('pid') and data.get('boot_id') == Path('/proc/sys/kernel/random/boot_id').read_text().strip():
            proc = Path('/proc') / str(data['pid']) / 'stat'
            if proc.exists() and proc.read_text().split()[21] == data.get('process_start'):
                raise Blocked('Owned worker is still alive; recovery cannot race it')
        data['cleanup'] = cleanup(data, recovery=True)
        terminal(data, data.get('test_status', 'INCONCLUSIVE'), error=data.get('error') or 'Owned worker interrupted; cleanup recovered from manifest')
        save(data, 'terminal:recovered')
        return data


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['probe', 'dispatch', 'status', 'recover', 'run', 'evidence', 'candidate'])
    parser.add_argument('run_id', nargs='?')
    parser.add_argument('--test-case', choices=['crash', 'timeout', 'crash-after-fresh'])
    parser.add_argument('--branch')
    args = parser.parse_args()
    try:
        if args.action == 'probe':
            result = probe()
        else:
            valid_id(args.run_id or '')
            if args.action == 'status' and not (ROOT / 'runs' / args.run_id / 'state.json').exists():
                result = {'found': False, 'run_id': args.run_id}
            elif args.action == 'evidence':
                result = {'manifest': load_manifest(ROOT, args.run_id), 'logs': {p.name: sanitize(p.read_text(errors='replace')[-12000:]) for p in (ROOT / 'runs' / args.run_id).glob('*.log') if not p.is_symlink()}}
            elif args.action == 'candidate':
                current_revision(args.branch or '')  # Validate the fixed-repository ref before launch.
                result = dispatch(args.run_id, candidate_branch=args.branch)
            else:
                result = {'dispatch': lambda: dispatch(args.run_id, args.test_case), 'status': lambda: load_manifest(ROOT, args.run_id), 'recover': lambda: recover(args.run_id), 'run': lambda: run_worker(args.run_id)}[args.action]()
        print(json.dumps(result, separators=(',', ':')))
        return 0
    except Exception as exc:
        print(json.dumps({'status': 'BLOCKED', 'error': sanitize(str(exc)), 'run_id': args.run_id}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
