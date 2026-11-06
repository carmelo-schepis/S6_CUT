#!/usr/bin/env python3
"""Hermes dispatch and restart-safe launchd owner for the native Windows worker."""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import uuid

from contract import JOB_ID, OWNER, TERMINAL, matching_pr, owned, sanitize, summary, valid_id, write_json
from notifications import validate_destination

PACKAGE = Path(__file__).resolve().parent
CONTROL = Path.home() / '.hermes/s6-cut-windows-verification'
COORDINATOR = Path.home() / '.hermes/s6-cut-automation'
LABEL = 'com.s6cut.windows-installer-verification'
TARGET = 'slack:D0C6DSHG2LE'
USER = 'U0BJSCGSBKJ'


def rpc(action: str, run_id=None, fault=None) -> dict:
    if action not in {'probe', 'dispatch', 'status', 'recover', 'evidence'}:
        raise ValueError('invalid workflow action')
    command = 's6win ' + action
    if action != 'probe':
        command += ' ' + valid_id(run_id)
    if fault:
        if fault not in {'crash', 'timeout', 'crash-after-fresh'} or action != 'dispatch':
            raise ValueError('invalid fault case')
        command += ' ' + fault
    try:
        p = subprocess.run(['/usr/bin/ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=yes', 'windowspc', command], capture_output=True, text=True, timeout=65)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ConnectionError('SSH result unavailable; inspect the same durable run ID') from exc
    lines = [x for x in p.stdout.splitlines() if x.startswith('{')]
    if not lines:
        raise ConnectionError('Windows workflow RPC unavailable: ' + sanitize(p.stderr[-500:]))
    data = json.loads(lines[-1])
    if p.returncode and action not in {'probe', 'recover'}:
        raise ConnectionError('Windows workflow RPC failed: ' + data.get('error', 'no validated result'))
    return data


@contextlib.contextmanager
def lock(name):
    CONTROL.mkdir(parents=True, exist_ok=True)
    with (CONTROL / name).open('a+') as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('An existing Windows workflow owner holds this lock')
        yield


def save(data):
    write_json(CONTROL / 'runs' / data['run_id'] / 'state.json', data)


def kick_monitor():
    subprocess.run(['/bin/launchctl', 'kickstart', 'gui/' + str(os.getuid()) + '/' + LABEL], check=True, capture_output=True, timeout=15)


def marker(run_id):
    return {'managed_terminal_worker': True, 'job_id': JOB_ID, 'run_id': run_id, 'dispatch_only': True}


def prune_history(active_id=None):
    for path in (CONTROL / 'runs').glob('*'):
        if path.name == active_id or not re.fullmatch('[a-f0-9]{32}', path.name) or path.is_symlink():
            continue
        try:
            data = json.loads((path / 'state.json').read_text())
            if (data.get('owner') == OWNER and data.get('source_job_id') == JOB_ID and data.get('run_id') == path.name
                    and data.get('status') in TERMINAL and data.get('cleanup', {}).get('status') == 'PASS'
                    and data.get('notification', {}).get('status') == 'acknowledged'
                    and data.get('finished_at', time.time()) < time.time() - 30 * 86400):
                shutil.rmtree(owned(CONTROL / 'runs', path))
        except (OSError, ValueError):
            continue  # Unknown ownership or pending delivery is retained.


def dispatch(fault=None):
    with lock('dispatch.lock'):
        active = CONTROL / 'active.json'
        if active.exists():
            current = json.loads(active.read_text())
            path = CONTROL / 'runs' / valid_id(current['run_id']) / 'state.json'
            prior = json.loads(path.read_text())
            if prior.get('status') not in TERMINAL or prior.get('cleanup', {}).get('status') != 'PASS' or prior.get('notification', {}).get('status') != 'acknowledged':
                kick_monitor()
                return marker(prior['run_id'])
        prune_history(current['run_id'] if active.exists() else None)
        run_id = uuid.uuid4().hex
        data = {'owner': OWNER, 'run_id': run_id, 'source_job_id': JOB_ID, 'created_at': time.time(), 'status': 'RUNNING', 'stage': 'dispatch', 'tests': {}, 'pr_urls': [], 'test_case': fault, 'notification': {'status': 'not_terminal'}}
        save(data)
        write_json(active, {'owner': OWNER, 'run_id': run_id})
        try:
            readiness = rpc('probe')
            if not str(readiness.get('identity', '')).lower().endswith('\\charl'):
                raise ConnectionError(readiness.get('error', 'Windows preflight identity was not verified'))
            data['dispatch_preflight'] = readiness
        except ConnectionError as exc:
            data.update(status='BLOCKED', error='Windows preflight unavailable: ' + sanitize(str(exc)),
                        cleanup={'status': 'PASS', 'resources_created': False},
                        action='Restore Windows SSH/Docker readiness; no installer was dispatched')
            save(data)
            kick_monitor()
            return marker(run_id)
        try:
            result = rpc('dispatch', run_id, fault)
            if not result.get('accepted') and result.get('run_id') != run_id:
                # A remote orphan takes precedence. Never launch another test over it.
                data.update(status='BLOCKED', error='Remote ownership requires recovery: ' + result.get('run_id', 'unknown'), cleanup={'status': 'PASS', 'resources_created': False}, action='Recover the recorded remote worker before another installation')
            data['dispatch_receipt'] = result
        except ConnectionError as exc:
            # The request may have arrived. Keep the SAME run ID and inspect it after reconnect.
            data['transport_error'] = str(exc)
        save(data)
        kick_monitor()
        return marker(run_id)


def adopt(run_id):
    valid_id(run_id)
    remote = rpc('status', run_id)
    data = {**remote, 'owner': OWNER, 'source_job_id': JOB_ID, 'notification': {'status': 'not_terminal'}}
    save(data)
    write_json(CONTROL / 'active.json', {'owner': OWNER, 'run_id': run_id})
    kick_monitor()
    return marker(run_id)


def store():
    if str(COORDINATOR) not in sys.path:
        sys.path.insert(0, str(COORDINATOR))
    from control import Store
    return Store()


def enqueue(data):
    if data.get('status') not in TERMINAL:
        raise ValueError('A running worker cannot publish a terminal summary')
    config = json.loads((COORDINATOR / 'config.json').read_text())['slack']
    if config.get('target') != TARGET or config.get('user_id') != USER:
        raise RuntimeError('Personal notification configuration changed; no fallback is authorized')
    event = 's6-windows-installer-' + data['run_id']
    payload = {'owner': OWNER, 'message': summary(data), 'execution_id': data['run_id'], 'job_id': JOB_ID, 'outcome': data['status'], 'task_outcome': data['status'], 'scheduler_status': 'worker_terminal', 'priority': 'normal' if data['status'] == 'PASS' else 'failure', 'required_target': TARGET, 'required_user_id': USER}
    s = store()
    with s.transaction() as db:
        previous = db.execute('SELECT payload FROM outbox WHERE event_key=?', (event,)).fetchone()
        if previous and json.loads(previous['payload']) != payload:
            raise RuntimeError('Terminal result changed after it was queued; retain the original receipt')
        db.execute("INSERT OR IGNORE INTO outbox(id,event_key,entity,kind,revision,payload,status,created) VALUES(?,?,?,?,?,?,'pending',?)", (event, event, data['run_id'], 'windows_installer_terminal', data.get('source_revision', 'unverified'), json.dumps(payload, sort_keys=True, separators=(',', ':')), time.time()))
    data['notification'] = {'event_id': event, 'status': 'queued', 'target': TARGET}
    save(data)


def notification(data):
    event = data['notification']['event_id']
    s = store()
    # Dedicated outbox kind: the general sender ignores it. Reuse its deterministic
    # send/readback/reconciliation implementation with an immutable personal route.
    from notifier import drain, verify_target
    config = {'target': TARGET, 'user_id': USER, 'delivery_kinds': ['windows_installer_terminal']}
    protected = {'owner': OWNER, 'required_target': TARGET, 'required_user_id': USER}
    def verify(channel, user):
        result = verify_target(channel, user)
        validate_destination(protected, TARGET, USER, result)
        return result
    # Ambiguous sends remain uncertain. The existing managed reconciler performs
    # exact-message/readback recovery; this owner never blindly resends them.
    # Use the notifier's established direct-send implementation. Its older CLI
    # helper has an eight-second startup timeout and can leave ambiguous sends.
    drain(s, config, verify=verify)
    with s.connection() as db:
        row = db.execute('SELECT status,attempt_count,next_retry,acknowledgement FROM outbox WHERE id=?', (event,)).fetchone()
        if not row:
            raise RuntimeError('Durable terminal notification disappeared')
        status = dict(row)
    ack = json.loads(status['acknowledgement'] or 'null')
    if status['status'] == 'acknowledged':
        exact_reconciliation = (ack or {}).get('reconciled_by') == 'exact_event_identity_history_readback' and (ack or {}).get('user_id') == USER and bool((ack or {}).get('message_sha256'))
        if not ack or not ack.get('message_id') or ack.get('channel') != TARGET.removeprefix('slack:') or not (ack.get('readback_verified') is True or exact_reconciliation):
            raise RuntimeError('Personal DM readback acknowledgement is invalid')
    # The managed sender parks definitive failures after three tries. Re-arm only
    # that parked state with durable backoff; uncertain sends are reconciled, never resent.
    if status['status'] == 'blocked' and time.time() >= data.get('notification_retry_at', 0):
        attempt = data.get('notification_retry_cycles', 0) + 1
        delay = min(3600, 30 * 2 ** min(attempt, 7))
        with s.transaction() as db:
            db.execute("UPDATE outbox SET status='retry',attempt_count=0,next_retry=? WHERE id=? AND status='blocked'", (time.time() + delay, event))
        data.update(notification_retry_cycles=attempt, notification_retry_at=time.time() + delay)
    data['notification'].update(status=status['status'], attempt_count=status['attempt_count'], acknowledgement=ack)
    save(data)
    return status['status'] == 'acknowledged'


def investigate(data):
    """One bounded Hermes investigation; repeat runs deduplicate by root fingerprint."""
    if data.get('investigation_finished'):
        return
    try:
        if data.get('investigation_started_at'):
            # A controller restart must not spend another agent budget. Consume
            # an existing receipt, or report the interrupted investigation.
            read_investigation(data)
        else:
            start_investigation(data)
    except (OSError, ValueError, ConnectionError, subprocess.SubprocessError) as exc:
        data.update(status='INCONCLUSIVE', investigation_finished=True,
                    investigation_readback_error=sanitize(str(exc))[:400],
                    action='Review retained investigation evidence; no validated fix claimed')
        save(data)


def start_investigation(data):
    run_root = CONTROL / 'runs' / data['run_id']
    defect = data['defect_fingerprint']
    p = subprocess.run(['/usr/local/bin/gh', 'pr', 'list', '-R', 'carmelo-schepis/S6_CUT', '--state', 'all', '--search', '"S6-WINDOWS-INSTALLER:' + defect + '" in:body', '--limit', '100', '--json', 'url,body,state,headRefName'], capture_output=True, text=True, timeout=35)
    if p.returncode:
        data.update(status='INCONCLUSIVE', investigation_finished=True, action='GitHub unavailable; reproduce the suspected defect before a PR is claimed')
        save(data)
        return
    existing = matching_pr(json.loads(p.stdout), defect)
    if existing:
        data.update(pr_urls=[existing['url']], pr_deduplicated=True)
    receipt = run_root / 'investigation.json'
    prompt = run_root / 'investigation-prompt.md'
    prompt.write_text(f'''Investigate one suspected S6_CUT Windows installer failure. Read {run_root / 'state.json'} and the repository's DO-NOT-CHANGE/AGENTS.md first. This is a suspected defect, not a confirmed product failure. Use the retained source revision and sanitized evidence. The invalid IP incident caused by S6_ENGINE_PORT=IP:port was a harness error; PR 110 is closed and must not be resurrected.

Root fingerprint: S6-WINDOWS-INSTALLER:{defect}
Existing fingerprint-matched PR: {existing['url'] if existing else 'none found'}. Reuse/update it when open; inspect a closed PR before treating recurrence as a new root cause. Do not create another PR for the same unresolved defect.
Repository: carmelo-schepis/S6_CUT, base main. Existing protected GitHub authentication is available. Use an isolated branch/worktree. No merging. Keep all builds/product tests on windowspc or mbpro1. Windows access uses the protected alias windowspc; supported commands are s6win probe/status/evidence/recover, plus s6win dispatch RUN_ID. Candidate validation: push a branch in this same repository, then invoke `ssh windowspc "s6win candidate NEW_32_HEX_RUN_ID BRANCH"`. It validates that branch's installer with native PowerShell, a separate isolated fresh installation, real browser/media smoke, rerun and cleanup. Poll `s6win status ID` until terminal; a dispatch receipt is not validation. Get original evidence using s6win evidence {data['run_id']}. Do not alter other stacks, machine settings, credentials or application contracts. No paid provider calls. Do not send Slack messages.

Reproduce the smallest failure, classify harness/infrastructure versus installer, and search all PRs for this exact fingerprint before publication. For a reproducible installer defect, prepare a focused fix and regression test and validate native PowerShell on windowspc. If a reliable fix cannot be validated, a draft PR may contain a meaningful executable reproducer and investigation evidence, explicitly unresolved. Never create an empty fix or a defect PR for an infrastructure/harness failure. Include trigger, expected/actual, affected SHA, fix or unresolved investigation, native validation, cleanup and limitations. Include S6-WINDOWS-INSTALLER:{defect} in the PR body.

Write {receipt} with JSON fields confirmed (boolean), classification (PRODUCT_FAILURE/BLOCKED/INCONCLUSIVE), reproduction_run_id (a second actual run on the original SHA with the same fingerprint and successful cleanup), pr_urls (array), native_validation (object with actual revision/run_id/result or explicit not-run), and action. Do not claim PASS on dispatch or scheduler completion. Keep the receipt compact and credential-free. Your agent budget is 540 seconds; if evidence is insufficient, record the exact limit instead of fabricating a diagnosis.''')
    data['investigation_started_at'] = time.time()
    save(data)
    with (run_root / 'investigation.log').open('w') as log:
        try:
            subprocess.run(['/Users/dummy/.local/bin/hermes', 'chat', '--oneshot', '--query-file', str(prompt), '--run-budget', '540', '--max-turns', '40', '-Q'], stdout=log, stderr=subprocess.STDOUT, timeout=570, cwd=run_root)
        except subprocess.TimeoutExpired:
            data['investigation_limit'] = 'Hermes investigation reached its installed bounded deadline'
    read_investigation(data)
    log_path = run_root / 'investigation.log'
    if log_path.stat().st_size > 256 * 1024:
        with log_path.open('rb') as stream:
            stream.seek(-256 * 1024, 2)
            retained = stream.read()
        log_path.write_text(sanitize(retained.decode(errors='replace')))


def read_investigation(data):
    receipt = CONTROL / 'runs' / data['run_id'] / 'investigation.json'
    defect = data['defect_fingerprint']
    if receipt.exists():
        result = json.loads(receipt.read_text())
        data['confirmed'] = False
        try:
            reproduction = rpc('status', valid_id(result.get('reproduction_run_id', '')))
            data['confirmed'] = (result.get('confirmed') is True and reproduction.get('status') == 'PRODUCT_FAILURE' and reproduction.get('source_revision') == data.get('source_revision') and reproduction.get('defect_fingerprint') == defect and reproduction.get('cleanup', {}).get('status') == 'PASS')
            data['pr_urls'] = validate_investigation(data, result) if data['confirmed'] else []
        except (ValueError, ConnectionError) as exc:
            data['investigation_readback_error'] = sanitize(str(exc))[:400]
        data['investigation'] = result
        data['action'] = result.get('action', 'Review retained investigation evidence')
        if result.get('classification') in {'BLOCKED', 'INCONCLUSIVE'}:
            data['status'] = result['classification']
    if not data.get('confirmed'):
        if data.get('investigation', {}).get('classification') == 'BLOCKED':
            data['status'] = 'BLOCKED'
        else:
            data['status'] = 'INCONCLUSIVE'
            data['action'] = 'Reproduce the suspected failure before creating an installer-defect PR'
    elif not data.get('pr_urls'):
        data['action'] = 'Confirmed installer defect has no validated PR; review retained investigation evidence'
    data['investigation_finished'] = True
    save(data)


def validate_investigation(data, result):
    """GitHub + native readback, rather than trusting an agent's success statement."""
    valid = []
    for url in result.get('pr_urls', []):
        if not re.fullmatch(r'https://github.com/carmelo-schepis/S6_CUT/pull/\d+', url):
            continue
        p = subprocess.run(['/usr/local/bin/gh', 'pr', 'view', url, '--json', 'url,body,baseRefName,isDraft,headRefOid,files'], capture_output=True, text=True, timeout=35)
        if p.returncode:
            continue
        pr = json.loads(p.stdout)
        if pr['url'] != url or pr['baseRefName'] != 'main' or 'S6-WINDOWS-INSTALLER:' + data['defect_fingerprint'] not in pr['body']:
            continue
        if pr['isDraft']:
            if any(x['path'].startswith('tests/') and x['path'].endswith(('.ps1', '.py', '.ts')) and x.get('additions', 0) for x in pr['files']):
                valid.append(url)
            continue
        native = result.get('native_validation', {})
        if not re.fullmatch('[a-f0-9]{32}', str(native.get('run_id', ''))):
            continue
        check = rpc('status', native['run_id'])
        if check.get('status') == 'PASS' and check.get('cleanup', {}).get('status') == 'PASS' and check.get('source_revision') == pr['headRefOid'] and check.get('candidate_validation', {}).get('published_command_tested') is False:
            valid.append(url)
    return valid


def monitor():
    with lock('monitor.lock'):
        while True:
            pointer = CONTROL / 'active.json'
            if not pointer.exists():
                return
            run_id = valid_id(json.loads(pointer.read_text())['run_id'])
            data = json.loads((CONTROL / 'runs' / run_id / 'state.json').read_text())
            if data.get('status') not in TERMINAL or data.get('cleanup', {}).get('status') != 'PASS':
                try:
                    remote = rpc('status', run_id)
                    if remote.get('owner') != OWNER or remote.get('run_id') != run_id:
                        # Dispatch response may have been lost before any worker existed.
                        remote = rpc('dispatch', run_id, data.get('test_case'))
                        if remote.get('accepted'):
                            time.sleep(5)
                            continue
                        raise ConnectionError('No owned remote run could be read back')
                    if remote.get('status') == 'RUNNING' and time.time() - remote.get('updated_at', time.time()) > 90:
                        recovered = rpc('recover', run_id)
                        if recovered.get('owner') == OWNER:
                            remote = recovered
                    if remote.get('status') == 'CLEANUP_FAILED':
                        recovered = rpc('recover', run_id)
                        if recovered.get('owner') == OWNER:
                            remote = recovered
                    notification_state = data.get('notification', {})
                    data.update(remote)
                    data.update(source_job_id=JOB_ID, notification=notification_state, evidence=str(CONTROL / 'runs' / run_id))
                    data.pop('transport_error', None)
                    save(data)
                except Exception as exc:
                    data.update(transport_error=sanitize(str(exc)), transport_checked_at=time.time())
                    save(data)
                    time.sleep(20)
                    continue
            if data.get('status') in TERMINAL:
                if data['status'] == 'PRODUCT_FAILURE':
                    investigate(data)
                if not data.get('notification', {}).get('event_id'):
                    enqueue(data)
                if notification(data) and data.get('cleanup', {}).get('status') == 'PASS':
                    return
            time.sleep(10)


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['dispatch', 'monitor', 'adopt', 'status'])
    parser.add_argument('run_id', nargs='?')
    parser.add_argument('--test-case', choices=['crash', 'timeout', 'crash-after-fresh'])
    args = parser.parse_args(argv)
    if args.action == 'dispatch':
        print(json.dumps(dispatch(args.test_case), separators=(',', ':')))
    elif args.action == 'adopt':
        print(json.dumps(adopt(args.run_id), separators=(',', ':')))
    elif args.action == 'status':
        print(json.dumps(rpc('status', args.run_id), indent=2))
    else:
        monitor()


if __name__ == '__main__':
    main()
