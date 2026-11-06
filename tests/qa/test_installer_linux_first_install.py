"""Regressions found by real Linux installs, where bind mounts keep host ownership."""
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
INSTALLER = (ROOT / "install.sh").read_text()
COMPOSE = (ROOT / "compose.yaml").read_text()


def definitions(*names):
    return "\n".join(re.search(r"^" + name + r"\(\)\s*\{.*?^\}", INSTALLER, re.M | re.S)[0]
                     for name in names)


def service(name):
    return re.search(r"^  " + name + r":\n(.*?)(?=^  \S|^\S)", COMPOSE, re.M | re.S)[1]


class DataOwnershipTests(unittest.TestCase):
    def test_engine_waits_for_the_data_owner_handover(self):
        self.assertRegex(service("engine"), r"data-init:\n\s+condition: service_completed_successfully")

    def test_engine_keeps_its_documented_uid(self):
        self.assertIn('user: "10001:10001"', service("engine"))

    def test_handover_changes_owner_not_permissions(self):
        helper = service("data-init")
        self.assertIn("chown -h 10001:10001", helper)
        self.assertNotIn("chmod", helper)

    def test_handover_has_only_the_capabilities_it_needs(self):
        helper = service("data-init")
        self.assertRegex(helper, r"cap_drop:\n\s+- ALL")
        self.assertEqual(re.findall(r"^\s+- ([A-Z_]+)$", helper.split("cap_add:")[1], re.M), ["CHOWN", "DAC_READ_SEARCH"])
        self.assertIn("network_mode: none", helper)


class FailedStartRecoveryTests(unittest.TestCase):
    def up_command(self, created):
        with tempfile.TemporaryDirectory() as tmp:
            shell = "\n".join([
                "set -Eeuo pipefail", 'INSTALL_DIR="$PWD"', "FORCE_RECREATE=false",
                "step() { :; }; ok() { :; }; info() { :; }; warn() { :; }",
                'docker() { if [[ "$2" == ps ]]; then printf "%s" "' + created + '"; return 0; fi; echo "$*" >> calls; }',
                definitions("read_env", "start_containers"), "start_containers", "cat calls",
            ])
            return subprocess.run(["bash", "-c", shell], cwd=tmp, capture_output=True, text=True, check=True).stdout

    def test_containers_left_created_are_recreated(self):
        self.assertIn("--force-recreate", self.up_command("abc123"))

    def test_a_healthy_rerun_does_not_recreate_containers(self):
        self.assertNotIn("--force-recreate", self.up_command(""))


if __name__ == "__main__":
    unittest.main()
