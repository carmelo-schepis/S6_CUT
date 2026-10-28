"""Lifecycle/ownership regressions. Live native/browser evidence is recorded separately."""
import contextlib
import importlib
import json
from pathlib import Path
import sqlite3
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

PACKAGE = Path(__file__).resolve().parents[2] / 'scripts/qa/windows-installer'
sys.path.insert(0, str(PACKAGE))
contract = importlib.import_module('contract')
worker = importlib.import_module('worker')
controller = importlib.import_module('controller')
notifications = importlib.import_module('notifications')
RUN = 'a' * 32


class Store:
    def __init__(self):
        self.db = sqlite3.connect(':memory:')
        self.db.execute('CREATE TABLE summary_runs(execution_id TEXT PRIMARY KEY,job_id TEXT,finished REAL,payload TEXT,batch_id TEXT)')

    @contextlib.contextmanager
    def transaction(self):
        with self.db:
            yield self.db


class OwnershipTests(unittest.TestCase):
    def test_foreign_paths_and_symlink_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            foreign = root / 'foreign'
            foreign.mkdir()
            owned = root / 'owned'
            owned.mkdir()
            (owned / 'link').symlink_to(foreign)
            for path in (owned, foreign, owned / 'link' / 'data', owned / '..' / 'foreign'):
                with self.subTest(path=path), self.assertRaises(ValueError):
                    contract.owned(owned, path)

    def test_manifest_refuses_foreign_project_or_engine_binding_before_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            data = {'owner': contract.OWNER, 'run_id': RUN, 'installations': [{'install': str(root / 'runs' / RUN / 'payload/fresh-profile/s6_cut'), 'project': 'existing-user-stack', 'engine_port': 28466, 'web_port': 18408}]}
            path = root / 'runs' / RUN / 'state.json'
            contract.write_json(path, data)
            with self.assertRaises(ValueError):
                contract.load_manifest(root, RUN)
            data['installations'][0]['project'] = 's6iv-' + RUN + '-fresh'
            data['installations'][0]['engine_port'] = '127.0.0.1:28466'
            contract.write_json(path, data)
            with self.assertRaisesRegex(ValueError, 'numeric'):
                contract.load_manifest(root, RUN)

    def test_real_nonblocking_lock_rejects_overlap(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(worker, 'LOCKS', Path(directory)):
            with worker.lock('worker.lock'):
                with self.assertRaises(worker.Blocked):
                    with worker.lock('worker.lock'):
                        self.fail('an overlapping worker acquired the lock')

    def test_recovery_removes_only_owned_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            run = root / 'runs' / RUN
            (run / 'payload').mkdir(parents=True)
            (run / 'payload/data').write_text('owned')
            (root / 'preexisting-media').write_text('keep')
            contract.write_json(run / 'state.json', {'owner': contract.OWNER, 'run_id': RUN, 'status': 'RUNNING', 'installations': [], 'preflight': {'containers': []}})
            def native_cleanup(script):
                self.assertIn(str(run / 'payload'), script)
                shutil.rmtree(run / 'payload')
                return {'removed': True}
            with mock.patch.object(worker, 'ROOT', root), mock.patch.object(worker, 'LOCKS', root / 'locks'), mock.patch.object(worker, 'probe_containers', return_value=[]), mock.patch.object(worker, 'win', side_effect=str), mock.patch.object(worker, 'native', side_effect=native_cleanup):
                result = worker.recover(RUN)
            self.assertEqual(result['status'], 'INCONCLUSIVE')
            self.assertEqual(result['cleanup']['status'], 'PASS')
            self.assertFalse((run / 'payload').exists())
            self.assertEqual((root / 'preexisting-media').read_text(), 'keep')

    def test_recovery_cannot_race_a_live_lock(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(worker, 'LOCKS', Path(directory)):
            with worker.lock('worker.lock'):
                with self.assertRaises(worker.Blocked):
                    worker.recover(RUN)

    def test_retention_keeps_active_foreign_and_undelivered_runs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            old = {'owner': contract.OWNER, 'source_job_id': contract.JOB_ID, 'status': 'PASS', 'finished_at': 1, 'cleanup': {'status': 'PASS'}, 'notification': {'status': 'acknowledged'}}
            for letter, change in [('a', {}), ('b', {}), ('c', {'owner': 'foreign'}), ('d', {'notification': {'status': 'queued'}}), ('e', {'cleanup': {'status': 'FAILED'}})]:
                contract.write_json(root / 'runs' / (letter * 32) / 'state.json', {**old, **change, 'run_id': letter * 32})
            with mock.patch.object(controller, 'CONTROL', root):
                controller.prune_history('b' * 32)
            self.assertEqual({p.name for p in (root / 'runs').iterdir()}, {letter * 32 for letter in 'bcde'})


class OutcomesTests(unittest.TestCase):
    def test_freshness_never_passes_stale_or_moving_source(self):
        self.assertEqual(contract.source_freshness('a', 'a', 'a'), 'PASS')
        for installed, after in [('old', 'a'), ('a', 'new'), ('', 'a')]:
            self.assertEqual(contract.source_freshness('a', installed, after), 'INCONCLUSIVE')

    def test_missing_upgrade_coverage_cannot_be_pass(self):
        data = {'tests': {'fresh': 'PASS', 'smoke': 'PASS'}, 'cleanup': {'status': 'PASS'}}
        self.assertEqual(contract.terminal(data, 'PASS')['status'], 'INCONCLUSIVE')

    def test_cleanup_failure_overrides_test_success(self):
        data = {'test_case': 'timeout', 'cleanup': {'status': 'FAILED'}}
        self.assertEqual(contract.terminal(data, 'PASS')['status'], 'CLEANUP_FAILED')

    def test_native_timeout_is_not_installer_success(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            data = {'run_id': RUN}
            (root / 'runs' / RUN).mkdir(parents=True)
            with mock.patch.object(worker, 'ROOT', root), mock.patch.object(worker, 'win', side_effect=str), mock.patch.object(worker, 'native', return_value={'timed_out': True, 'exit': 1}), mock.patch.object(worker, 'save'):
                with self.assertRaises(worker.Inconclusive):
                    worker.run_native_file(data, root / 'sleep.ps1', [], 'timeout', 1)
            self.assertEqual(data['process_records'], [str(root / 'runs' / RUN / 'process-timeout.json')])

    def test_stub_harness_temp_stays_inside_recoverable_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            with mock.patch.object(worker, 'ROOT', root), mock.patch.object(worker, 'win', side_effect=str), mock.patch.object(worker, 'native', return_value={'timed_out': False, 'exit': 0}) as native, mock.patch.object(worker, 'save'):
                worker.run_native_file({'run_id': RUN}, root / 'test.ps1', [], 'harness', 120, owned_temp=True)
            scratch = root / 'runs' / RUN / 'payload/native-harness-temp'
            self.assertTrue(scratch.is_dir())
            self.assertIn('$env:TEMP=' + worker.quote(str(scratch)), native.call_args.args[0])

    def test_fingerprint_and_existing_pr_deduplicate_retries(self):
        first = contract.fingerprint('fresh-install', 'Port 18408 failed at C:\\sandbox\\' + 'a' * 32)
        second = contract.fingerprint('fresh-install', 'Port 19409 failed at C:\\sandbox\\' + 'b' * 32)
        self.assertEqual(first, second)
        pr = {'url': 'https://github.com/carmelo-schepis/S6_CUT/pull/1', 'body': 'S6-WINDOWS-INSTALLER:' + first}
        self.assertEqual(contract.matching_pr([{'body': 'unrelated'}, pr], second), pr)
        self.assertIsNone(contract.matching_pr([pr], 'different-root'))

    def test_ssh_loss_preserves_one_run_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            with mock.patch.object(controller, 'CONTROL', root), mock.patch.object(controller, 'rpc', side_effect=[{'identity': 'WINDOWSPC\\charl'}, ConnectionError('SSH lost after possible dispatch')]), mock.patch.object(controller, 'kick_monitor'):
                first = controller.dispatch()
                second = controller.dispatch()
            self.assertEqual(first['run_id'], second['run_id'])
            self.assertEqual(len(list((root / 'runs').iterdir())), 1)
            state = json.loads((root / 'runs' / first['run_id'] / 'state.json').read_text())
            self.assertEqual(state['status'], 'RUNNING')
            self.assertIn('SSH lost', state['transport_error'])

    def test_unreachable_preflight_is_terminal_blocker_without_dispatch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            with mock.patch.object(controller, 'CONTROL', root), mock.patch.object(controller, 'rpc', side_effect=ConnectionError('SSH unavailable')) as rpc, mock.patch.object(controller, 'kick_monitor'):
                result = controller.dispatch()
            rpc.assert_called_once_with('probe')
            state = json.loads((root / 'runs' / result['run_id'] / 'state.json').read_text())
            self.assertEqual(state['status'], 'BLOCKED')
            self.assertFalse(state['cleanup']['resources_created'])

    def test_running_worker_cannot_notify(self):
        with self.assertRaises(ValueError):
            controller.enqueue({'status': 'RUNNING'})

    def test_restart_does_not_launch_a_second_investigation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            data = {'run_id': RUN, 'status': 'PRODUCT_FAILURE', 'defect_fingerprint': 'known', 'investigation_started_at': 1}
            with mock.patch.object(controller, 'CONTROL', root), mock.patch.object(controller.subprocess, 'run') as launch:
                controller.investigate(data)
            launch.assert_not_called()
            self.assertEqual(data['status'], 'INCONCLUSIVE')
            self.assertTrue(data['investigation_finished'])

    def test_monitor_retries_terminal_cleanup_before_admitting_new_run(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            failed = {'owner': contract.OWNER, 'run_id': RUN, 'status': 'CLEANUP_FAILED', 'cleanup': {'status': 'FAILED'}, 'notification': {'event_id': 'already-sent', 'status': 'acknowledged'}}
            recovered = {**failed, 'status': 'INCONCLUSIVE', 'cleanup': {'status': 'PASS'}}
            contract.write_json(root / 'active.json', {'run_id': RUN})
            contract.write_json(root / 'runs' / RUN / 'state.json', failed)
            with mock.patch.object(controller, 'CONTROL', root), mock.patch.object(controller, 'rpc', side_effect=[failed, recovered]) as rpc, mock.patch.object(controller, 'notification', return_value=True):
                controller.monitor()
            self.assertEqual(rpc.call_args_list, [mock.call('status', RUN), mock.call('recover', RUN)])
            state = json.loads((root / 'runs' / RUN / 'state.json').read_text())
            self.assertEqual(state['cleanup']['status'], 'PASS')
            self.assertEqual(state['notification']['event_id'], 'already-sent')


class NotificationTests(unittest.TestCase):
    def test_terminal_outbox_is_idempotent_and_freezes_result(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            (root / 'config.json').write_text(json.dumps({'slack': {'target': notifications.TARGET, 'user_id': notifications.USER}}))
            store = Store()
            store.db.row_factory = sqlite3.Row
            store.db.execute('CREATE TABLE outbox(id TEXT PRIMARY KEY,event_key TEXT UNIQUE,entity TEXT,kind TEXT,revision TEXT,payload TEXT,status TEXT,created REAL)')
            data = {'run_id': RUN, 'status': 'PASS', 'cleanup': {'status': 'PASS'}, 'action': 'none'}
            with mock.patch.object(controller, 'CONTROL', root), mock.patch.object(controller, 'COORDINATOR', root), mock.patch.object(controller, 'store', return_value=store):
                controller.enqueue(data)
                controller.enqueue(data)
                data['status'] = 'BLOCKED'
                with self.assertRaisesRegex(RuntimeError, 'Terminal result changed'):
                    controller.enqueue(data)
            self.assertEqual(store.db.execute('SELECT COUNT(*) FROM outbox').fetchone()[0], 1)

    def test_owner_destination_cannot_fallback_on_retry(self):
        payload = {'owner': contract.OWNER, 'required_target': notifications.TARGET, 'required_user_id': notifications.USER}
        for target, user in [('slack:CGENERAL', notifications.USER), ('slack:DOTHER', notifications.USER), (notifications.TARGET, 'UOTHER')]:
            with self.subTest(target=target, user=user), self.assertRaises(RuntimeError):
                notifications.validate_destination(payload, target, user)
        notifications.validate_destination(payload, notifications.TARGET, notifications.USER, {'verified_target': True, 'target': notifications.TARGET, 'user_id': notifications.USER})
        with self.assertRaises(RuntimeError):
            notifications.validate_destination(payload, notifications.TARGET, notifications.USER, {'verified_target': True, 'target': 'slack:DOTHER', 'user_id': notifications.USER})
        notifications.validate_destination({'owner': 'unrelated'}, 'slack:CGENERAL', 'OTHER')

    def test_only_exact_protected_dispatch_receipt_defers_source_summary(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            store = Store()
            run = {'id': 'b' * 32, 'job_id': contract.JOB_ID, 'status': 'completed', 'finished_at': '2026-10-28T00:00:00+00:00'}
            job = {'no_agent': True}
            output = json.dumps({'managed_terminal_worker': True, 'job_id': contract.JOB_ID, 'run_id': RUN})
            self.assertFalse(notifications.defer_source_summary(store, run, job, output, root))
            contract.write_json(root / 'runs' / RUN / 'state.json', {'owner': contract.OWNER, 'run_id': RUN, 'source_job_id': contract.JOB_ID})
            self.assertTrue(notifications.defer_source_summary(store, run, job, output, root))
            self.assertTrue(notifications.defer_source_summary(store, run, job, output, root))
            self.assertEqual(store.db.execute('SELECT COUNT(*) FROM summary_runs').fetchone()[0], 1)
            self.assertFalse(notifications.defer_source_summary(store, {**run, 'job_id': 'unrelated'}, job, output, root))
            self.assertFalse(notifications.defer_source_summary(store, run, {'no_agent': False}, output, root))


if __name__ == '__main__':
    unittest.main()
