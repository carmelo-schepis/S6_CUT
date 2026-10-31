"""Narrow adapters for the existing Hermes collector and transactional sender.

Dispatch is not a terminal test result. Only the configured Windows job with an
exact protected local receipt can defer its source summary to the worker owner.
"""
import datetime
import json
from pathlib import Path
import re
import time

JOB_ID = '2172e34e98bc'
OWNER = 's6-windows-installer-verification-v1'
TARGET = 'slack:D0C6DSHG2LE'
USER = 'U0BJSCGSBKJ'


def validate_destination(payload, target, user_id, verified=None):
    if payload.get('owner') != OWNER:
        return
    if target != TARGET or user_id != USER or payload.get('required_target') != TARGET or payload.get('required_user_id') != USER:
        raise RuntimeError('Windows installer terminal result requires the exact owner personal DM; no fallback')
    if verified is not None and (verified.get('target') != TARGET or verified.get('user_id') != USER or not verified.get('verified_target')):
        raise RuntimeError('Windows installer owner DM verification changed; delivery deferred')


def defer_source_summary(store, run, job, output, control_root=None):
    if run['job_id'] != JOB_ID or job.get('no_agent') is not True or not output or run.get('status') != 'completed':
        return False
    markers = []
    for line in output.splitlines():
        if not line.startswith('{') or 'managed_terminal_worker' not in line:
            continue
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if value.get('managed_terminal_worker') is True and value.get('job_id') == JOB_ID and re.fullmatch('[a-f0-9]{32}', str(value.get('run_id', ''))):
            markers.append(value)
    if not markers:
        return False
    marker = markers[-1]
    root = Path(control_root or Path.home() / '.hermes/s6-cut-windows-verification')
    path = root / 'runs' / marker['run_id'] / 'state.json'
    if path.is_symlink() or not path.is_file():
        return False
    state = json.loads(path.read_text())
    if state.get('owner') != OWNER or state.get('run_id') != marker['run_id'] or state.get('source_job_id') != JOB_ID:
        return False
    finished = datetime.datetime.fromisoformat(run['finished_at']).timestamp()
    payload = json.dumps({'mode': 'managed_worker', 'task_outcome': 'deferred', 'worker_run_id': marker['run_id'], 'summary': 'Terminal result belongs to the durable Windows worker; dispatch is not installer acceptance.'})
    with store.transaction() as db:
        db.execute('INSERT OR IGNORE INTO summary_runs(execution_id,job_id,finished,payload,batch_id) VALUES(?,?,?,?,?)', (run['id'], JOB_ID, finished, payload, 'external-windows-worker-' + marker['run_id']))
    return True
