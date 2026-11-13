"""Installer regression checks with controlled Docker outcomes."""
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest


SOURCE = (Path(__file__).resolve().parents[2] / "install.sh").read_text()


def definitions(*names):
    return "\n".join(re.search(r"^" + name + r"\(\)\s*\{.*?^\}", SOURCE, re.M | re.S)[0]
                     for name in names)


class InstallerPortConflictTests(unittest.TestCase):
    def run_installer(self, failure="address already in use", port="8001", exported=False,
                      force=False, retry_fails=False, assigned="127.0.0.1:49152",
                      web_conflict=False, web_port="8080", exported_web=False):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            original = "# user config\nS6_ENGINE_PORT=" + port + "\nS6_PORT=" + web_port + "\nS6_DATA_PATH=/keep/my/data\n"
            (root / ".env").write_text(original)
            shell = "\n".join([
                "set -Eeuo pipefail", 'INSTALL_DIR="$PWD"',
                "FORCE_RECREATE=" + ("true" if force else "false"),
                'step() { :; }; ok() { :; }; info() { :; }; warn() { echo "$*"; }',
                'die() { echo "$*" >&2; exit 1; }',
                "trap 'echo DIAGNOSTICS >&2' ERR",
                '''docker() {
                    if [[ "$2" == ps ]]; then return 0; fi
                    printf '%s | engine=%s\n' "$*" "${S6_ENGINE_PORT:-default}" >> calls
                    if [[ "$*" == "compose port engine 8001" ]]; then
                        echo "$ASSIGNED"; return 0
                    fi
                    if [[ "$*" == "compose port web 8080" ]]; then
                        printf '0.0.0.0:49153\\n[::]:49153\\n'; return 0
                    fi
                    if [[ "$RETRY_FAILS" == true && "${S6_ENGINE_PORT:-}" == "0" ]]; then return 1; fi
                    if [[ "$FAILURE" != none && "${S6_ENGINE_PORT:-}" != "0" ]]; then
                        echo "Error response from daemon: 127.0.0.1:$CONFIG_PORT: $FAILURE"
                        return 17
                    fi
                    if [[ "$WEB_CONFLICT" == true && "${S6_PORT:-}" != "0" ]]; then
                        echo "Error response from daemon: 0.0.0.0:$WEB_PORT: address already in use"
                        return 17
                    fi
                    return 0
                }''',
                definitions("read_env", "start_containers", "web_host_port", "print_summary"), "start_containers", "print_summary",
                'printf "effective=%s\n" "$(read_env S6_ENGINE_PORT 8001)"',
            ])
            env = {k: v for k, v in os.environ.items() if k not in ("S6_ENGINE_PORT", "S6_PORT")}
            env.update(FAILURE=failure, CONFIG_PORT=port, ASSIGNED=assigned,
                       RETRY_FAILS="true" if retry_fails else "false",
                       WEB_CONFLICT="true" if web_conflict else "false", WEB_PORT=web_port)
            if exported:
                env["S6_ENGINE_PORT"] = port
            if exported_web:
                env["S6_PORT"] = web_port
            result = subprocess.run(["bash", "-c", shell], cwd=tmp, env=env,
                                    capture_output=True, text=True, timeout=10)
            return result, (root / ".env").read_text(), (root / "calls").read_text(), original

    def test_occupied_default_recovers_and_preserves_configuration(self):
        for error in ("address already in use", "port is already allocated"):
            with self.subTest(error=error):
                result, config, calls, original = self.run_installer(failure=error)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertTrue(config.startswith(original))
                self.assertIn("effective=49152", result.stdout)
                self.assertIn("compose up -d --no-build | engine=0", calls)
                self.assertEqual(calls.count("--build"), 1)

    def test_frontend_only_and_both_default_conflicts_recover(self):
        for failure in ("none", "address already in use"):
            with self.subTest(engine_failure=failure):
                result, config, calls, original = self.run_installer(
                    failure=failure, web_conflict=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertTrue(config.startswith(original))
                self.assertIn("S6_PORT=49153", config)
                self.assertIn("Frontend: http://127.0.0.1:49153", result.stdout)
                self.assertEqual(calls.count("--build"), 1)
                self.assertEqual(calls.count("--no-build"), 1 if failure == "none" else 2)
                if failure != "none":
                    self.assertIn("S6_ENGINE_PORT=49152", config)

    def test_custom_or_exported_web_ports_remain_fatal(self):
        for options in ({"web_port": "18080"}, {"exported_web": True}):
            with self.subTest(options=options):
                result, config, calls, original = self.run_installer(
                    failure="none", web_conflict=True, **options)
                self.assertEqual(result.returncode, 17)
                self.assertEqual(config, original)
                self.assertEqual(len(calls.splitlines()), 1)

    def test_success_does_not_change_configuration(self):
        result, config, calls, original = self.run_installer(failure="none")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(config, original)
        self.assertEqual(len(calls.splitlines()), 1)

    def test_custom_exported_and_unrelated_errors_remain_fatal(self):
        for options in ({"port": "18001"}, {"exported": True},
                        {"failure": "permission denied"}, {"port": "8080"}):
            with self.subTest(options=options):
                result, config, calls, original = self.run_installer(**options)
                self.assertEqual(result.returncode, 17)
                self.assertEqual(config, original)
                self.assertEqual(len(calls.splitlines()), 1)
                self.assertIn("DIAGNOSTICS", result.stderr)

    def test_force_recreate_is_kept_on_retry(self):
        result, _, calls, _ = self.run_installer(force=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("compose up -d --force-recreate --no-build", calls)

    def test_retry_failure_does_not_save_a_port(self):
        result, config, _, original = self.run_installer(retry_fails=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(config, original)
        self.assertIn("DIAGNOSTICS", result.stderr)

    def test_invalid_assigned_port_does_not_change_configuration(self):
        result, config, _, original = self.run_installer(assigned="invalid")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(config, original)


if __name__ == "__main__":
    unittest.main()
