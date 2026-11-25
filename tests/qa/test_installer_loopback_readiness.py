"""Verify readiness and summary against Docker's reported host binding."""
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest


SOURCE = (Path(__file__).resolve().parents[2] / "install.sh").read_text()


class InstallerReadinessTests(unittest.TestCase):
    def run_installer(self, binding):
        with tempfile.TemporaryDirectory() as tmp:
            docker = Path(tmp) / "docker"
            docker.write_text(
                '#!/bin/bash\n'
                'case "$2:$3" in\n'
                '  port:web) printf "%s\n" "$BOUND_WEB";;\n'
                '  port:engine) echo 127.0.0.1:8001;;\n'
                'esac\n'
            )
            docker.chmod(0o755)
            definitions = [
                re.search(r"^" + name + r"\(\)\s*\{.*?^\}", SOURCE, re.M | re.S)[0]
                for name in ("read_env", "start_containers", "check_published_binding",
                             "wait_for_ready", "print_summary")
            ]
            shell = "\n".join([
                "set -Eeuo pipefail", 'INSTALL_DIR="$PWD"', "FORCE_RECREATE=false",
                "START_TIMEOUT=5", "DEFAULT_WEB_BINDING=127.0.0.1:8080",
                'export PATH="$PWD:$PATH"',
                "step() { :; }; ok() { :; }; fail() { :; }; info() { :; }; warn() { :; }",
                'die() { echo "$*" >&2; exit 1; }',
                'curl() { printf "%s\n" "${!#}" > health-url; }',
                *definitions, "start_containers", "wait_for_ready", "print_summary",
            ])
            env = dict(os.environ, BOUND_WEB=binding)
            proc = subprocess.run(["bash", "-c", shell], cwd=tmp, env=env,
                                  capture_output=True, text=True, timeout=5)
            capture = Path(tmp) / "health-url"
            return proc, capture.read_text().strip() if capture.exists() else None

    def test_published_address_controls_health_and_summary(self):
        for binding, address in (
            ("0.0.0.0:54321\n[::]:54321", "127.0.0.1:54321"),
            ("127.0.0.1:54321", "127.0.0.1:54321"),
            ("192.0.2.5:54321", "192.0.2.5:54321"),
            ("[::]:54321", "[::1]:54321"),
        ):
            with self.subTest(binding=binding):
                proc, health_url = self.run_installer(binding)
                self.assertEqual(proc.returncode, 0, proc.stderr)
                self.assertEqual(health_url, f"http://{address}/api/health")
                self.assertIn(f"Frontend: http://{address}", proc.stdout)

    def test_invalid_published_port_is_rejected_before_probe(self):
        for binding in ("0", "65536", "127.0.0.1:0", "127.0.0.1:65536"):
            with self.subTest(binding=binding):
                proc, health_url = self.run_installer(binding)
                self.assertNotEqual(proc.returncode, 0)
                self.assertIsNone(health_url)
                self.assertIn("Could not determine Docker's published address", proc.stderr)


if __name__ == "__main__":
    unittest.main()
