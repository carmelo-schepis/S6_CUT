"""Small diagnostic regression: run the installer's real readiness function.

The curl stub only records its URL. This unit test supplements two real Docker
reproductions; it is never counted as installation or media acceptance evidence.
"""
from pathlib import Path
import re
import subprocess
import tempfile
import unittest


class InstallerReadinessTests(unittest.TestCase):
    def test_numeric_and_loopback_bind_use_a_valid_health_url(self):
        source = (Path(__file__).resolve().parents[2] / "install.sh").read_text()
        definitions = []
        for name in ("read_env", "web_host_port", "wait_for_ready"):
            match = re.search(r"^" + name + r"\(\)\s*\{.*?^\}", source, re.M | re.S)
            self.assertIsNotNone(match, "installer readiness interface changed")
            definitions.append(match[0])
        with tempfile.TemporaryDirectory() as tmp:
            capture = Path(tmp) / "health-url"
            for binding in ("54321", "127.0.0.1:54321"):
                with self.subTest(binding=binding):
                    capture.unlink(missing_ok=True)
                    shell = "\n".join([
                        "set -eu", "START_TIMEOUT=5", "CURRENT_STEP=''",
                        "step() { :; }; ok() { :; }; fail() { :; }; info() { :; }",
                        "die() { exit 1; }; docker() { :; }",
                        'curl() { for arg in "$@"; do :; done; printf "%s" "$arg" > "$CAPTURE"; return 0; }',
                        *definitions, "wait_for_ready"])
                    import os
                    env = {**os.environ, "S6_PORT": binding, "CAPTURE": str(capture)}
                    proc = subprocess.run(["bash", "-c", shell], cwd=tmp, env=env,
                                          capture_output=True, text=True, timeout=5)
                    self.assertEqual(proc.returncode, 0, proc.stderr)
                    self.assertEqual(capture.read_text(), "http://127.0.0.1:54321/api/health")

    def test_summary_prints_valid_local_frontend_url_for_both_bindings(self):
        source = (Path(__file__).resolve().parents[2] / "install.sh").read_text()
        definitions = []
        for name in ("read_env", "web_host_port", "print_summary"):
            match = re.search(r"^" + name + r"\(\)\s*\{.*?^\}", source, re.M | re.S)
            self.assertIsNotNone(match, "installer summary interface changed")
            definitions.append(match[0])
        for binding in ("54321", "127.0.0.1:54321"):
            with self.subTest(binding=binding):
                shell = "\n".join(["set -eu", "INSTALL_DIR=/tmp/s6_cut", "ok() { :; }; info() { :; }",
                                    *definitions, "print_summary"])
                import os
                env = {**os.environ, "S6_PORT": binding, "S6_ENGINE_PORT": "8001"}
                result = subprocess.run(["bash", "-c", shell], env=env, text=True,
                                        capture_output=True, check=True, timeout=5)
                self.assertIn("Frontend: http://127.0.0.1:54321", result.stdout)

    def test_invalid_host_port_is_rejected_before_probe(self):
        source = (Path(__file__).resolve().parents[2] / "install.sh").read_text()
        definitions = []
        for name in ("read_env", "web_host_port", "wait_for_ready"):
            match = re.search(r"^" + name + r"\(\)\s*\{.*?^\}", source, re.M | re.S)
            self.assertIsNotNone(match, "installer readiness interface changed")
            definitions.append(match[0])
        with tempfile.TemporaryDirectory() as tmp:
            capture = Path(tmp) / "health-url"
            for binding in ("0", "65536", "127.0.0.1:65536"):
                with self.subTest(binding=binding):
                    shell = "\n".join([
                        "set -eu", "START_TIMEOUT=5", "CURRENT_STEP=''",
                        "step() { :; }; ok() { :; }; fail() { :; }; info() { :; }",
                        "die() { exit 1; }",
                        'curl() { printf "%s" "${!#}" > "$CAPTURE"; return 0; }',
                        *definitions, "wait_for_ready"])
                    import os
                    env = {**os.environ, "S6_PORT": binding, "CAPTURE": str(capture)}
                    proc = subprocess.run(["bash", "-c", shell], cwd=tmp, env=env,
                                          capture_output=True, timeout=5)
                    self.assertNotEqual(proc.returncode, 0)
                    self.assertFalse(capture.exists())


if __name__ == "__main__":
    unittest.main()
