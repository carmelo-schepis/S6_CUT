#!/usr/bin/env python3
"""Install the mbpro1 controller paused. Run from its protected package directory.

Windows package/key provisioning is a separate, trusted deployment operation;
the scheduled identity cannot upload code or execute arbitrary commands.
"""
import datetime
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys

from contract import JOB_ID

PACKAGE = Path(__file__).resolve().parent
ROOT = Path.home() / '.hermes'
CONTROL = ROOT / 's6-cut-windows-verification'
COORDINATOR = ROOT / 's6-cut-automation'
LABEL = 'com.s6cut.windows-installer-verification'


def main():
    if sys.platform != 'darwin':
        raise SystemExit('Controller deployment must run on mbpro1 macOS')
    if PACKAGE != CONTROL / 'package':
        raise SystemExit('Stage the package in the protected Windows verification control directory first')
    backup = CONTROL / 'deployment' / datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup.mkdir(parents=True, mode=0o700)
    sys.path.insert(0, str(ROOT / 'hermes-agent'))
    from cron.jobs import get_job, load_jobs, update_job
    job = get_job(JOB_ID)
    matches = [j for j in load_jobs() if j.get('name') == 'S6_CUT Windows Installer Verification']
    if not job or len(matches) != 1 or job['schedule'].get('minutes') != 4320:
        raise SystemExit('Expected exactly the existing 4320-minute job; no new job is created')
    (backup / 'job.json').write_text(json.dumps(job, indent=2))
    adapter = COORDINATOR / 'windows_installer_notifications.py'
    if adapter.exists():
        shutil.copy2(adapter, backup / adapter.name)
    shutil.copyfile(PACKAGE / 'notifications.py', adapter)
    adapter.chmod(0o600)
    source = COORDINATOR / 'summaries.py'
    text = source.read_text()
    needle = "   summary=summarize(run,known[run['job_id']],saved_output(run,output_root),saved_task_outcome(run))"
    replacement = """   output=saved_output(run,output_root)
   from windows_installer_notifications import defer_source_summary
   if defer_source_summary(store,run,known[run['job_id']],output):
    seen.add(run['id'])
    continue
   summary=summarize(run,known[run['job_id']],output,saved_task_outcome(run))"""
    if 'from windows_installer_notifications import defer_source_summary' not in text:
        if text.count(needle) != 1:
            raise SystemExit('Collector contract changed; inspect before deployment')
        shutil.copy2(source, backup / source.name)
        source.write_text(text.replace(needle, replacement))
    entry = ROOT / 'scripts/s6-win-installer-dispatch.py'
    if entry.exists():
        shutil.copy2(entry, backup / entry.name)
    entry.write_text("#!/usr/bin/env python3\nimport sys\nfrom pathlib import Path\nsys.path.insert(0,str(Path.home()/'.hermes/s6-cut-windows-verification/package'))\nfrom controller import main\nmain(['dispatch'])\n")
    entry.chmod(0o700)
    plist = Path.home() / 'Library/LaunchAgents' / (LABEL + '.plist')
    if plist.exists():
        shutil.copy2(plist, backup / plist.name)
    plist.parent.mkdir(parents=True, exist_ok=True)
    plist.write_bytes(plistlib.dumps({'Label': LABEL, 'ProgramArguments': [sys.executable, '-u', str(PACKAGE / 'controller.py'), 'monitor'], 'RunAtLoad': True, 'KeepAlive': {'SuccessfulExit': False}, 'ThrottleInterval': 30, 'StandardOutPath': str(CONTROL / 'monitor.stdout.log'), 'StandardErrorPath': str(CONTROL / 'monitor.stderr.log'), 'EnvironmentVariables': {'PATH': '/Users/dummy/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin'}}))
    domain = 'gui/' + str(os.getuid())
    loaded = subprocess.run(['/bin/launchctl', 'print', domain + '/' + LABEL], capture_output=True).returncode == 0
    if not loaded:
        subprocess.run(['/bin/launchctl', 'bootstrap', domain, str(plist)], check=True)
    updated = update_job(JOB_ID, {'script': entry.name, 'no_agent': True, 'prompt': 'Deterministic Windows worker dispatcher. A dispatch receipt is not an installer result. The managed controller investigates reproducible failures with Hermes and delivers only the actual terminal worker outcome to the verified personal DM through the existing transactional notifier. Never send source delivery to origin or general.', 'deliver': 'local', 'failure_deliver': 'local', 'enabled': False, 'state': 'paused', 'paused_reason': 'Deployment pilot and scoped SSH identity must pass before activation'})
    print(json.dumps({k: updated.get(k) for k in ('id', 'name', 'schedule', 'script', 'no_agent', 'deliver', 'failure_deliver', 'enabled', 'state', 'next_run_at')}, indent=2))


if __name__ == '__main__':
    main()
