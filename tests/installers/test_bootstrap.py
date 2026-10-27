"""Bootstrap regressions: real Git checkouts, with Docker and HTTP stubbed.

Run with: python3 -m unittest discover -s tests/installers -v
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="s6-bootstrap-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.home = self.base / "home with spaces"
        self.home.mkdir()
        self.source = self.base / "source"
        self.source.mkdir()
        self.git("init", "-b", "main", str(self.source))
        (self.source / "compose.yaml").write_text("services: {}\n")
        (self.source / ".env.example").write_text("S6_PORT=8080\n")
        self.git("-C", str(self.source), "add", ".")
        self.git("-C", str(self.source), "-c", "user.name=Test", "-c",
                 "user.email=test@example.invalid", "commit", "-m", "Fixture")
        self.bin = self.base / "bin"
        self.bin.mkdir()
        # A minimal SSH-like PATH: only known prerequisites, no host Docker.
        for command in ["git", "id", "mkdir", "ls", "cp", "grep", "tail", "cut", "tr", "date", "sleep"]:
            (self.bin / command).symlink_to(shutil.which(command))
        self.executable(self.bin / "uname", "#!/bin/sh\necho Darwin\n")
        self.executable(self.bin / "xcode-select", "#!/bin/sh\nexit 0\n")
        self.log = self.base / "calls.jsonl"
        self.executable(self.bin / "curl", self.stub("curl"))
        self.docker_dir = self.home / ".docker" / "bin"
        self.docker_dir.mkdir(parents=True)
        self.executable(self.docker_dir / "docker", self.stub("discovered-docker"))
        self.env = dict(os.environ, HOME=str(self.home), PATH=str(self.bin),
                        S6_REPO_URL=self.source.as_uri(), S6_TEST_LOG=str(self.log),
                        S6_TEST_GIT=shutil.which("git"),
                        GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1")
        for name in ["S6_INSTALL_DIR", "S6_BRANCH", "S6_PORT", "S6_ENGINE_PORT",
                     "S6_FORCE_RECREATE", "S6_START_TIMEOUT", "GIT_DIR", "GIT_WORK_TREE"]:
            self.env.pop(name, None)

    def git(self, *args):
        return subprocess.run([shutil.which("git"), *args], check=True,
                              text=True, capture_output=True)

    def executable(self, path, content):
        path.write_text(content)
        path.chmod(0o755)

    def stub(self, tool):
        import sys
        return f'''#!{sys.executable}
import json, os, pathlib, subprocess, sys
with open(os.environ['S6_TEST_LOG'], 'a') as log:
    log.write(json.dumps({{'tool': {tool!r}, 'args': sys.argv[1:]}}) + '\\n')
if sys.argv[1:3] == ['compose', 'up']:
    assert pathlib.Path('compose.yaml').exists()
    assert pathlib.Path('.env').exists()
if sys.argv[1:3] == ['compose', 'version']:
    if os.environ.get('S6_TEST_COMPOSE_MISSING'):
        sys.exit(1)
    print(os.environ.get('S6_TEST_COMPOSE_VERSION', 'Docker Compose version v2.26.0'))
if sys.argv[1:2] == ['run']:
    args = sys.argv[1:]
    mount = args[args.index('--mount') + 1]
    source = mount.split('source=', 1)[1].split(',target=', 1)[0]
    image_index = next(i for i, arg in enumerate(args) if arg.startswith('alpine/git:'))
    result = subprocess.run([os.environ['S6_TEST_GIT'], *args[image_index + 1:]], cwd=source)
    sys.exit(result.returncode)
'''

    def install(self):
        result = subprocess.run(["/bin/bash"], input=(ROOT / "install.sh").read_text(),
                                text=True, capture_output=True, env=self.env,
                                cwd=self.home, timeout=120)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("S6_cut is running", result.stdout)
        return result

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def test_mac_minimal_path_fresh_install_and_update_preserve_data(self):
        self.install()
        target = self.home / "s6_cut"
        self.assertEqual(self.git("-C", str(target), "branch", "--show-current").stdout.strip(), "main")
        (target / ".env").write_text("S6_PORT=8080\nCUSTOM=preserve\n")
        (target / "data").mkdir()
        (target / "data" / "project").write_text("preserve this project")
        result = self.install()
        self.assertNotIn("Could not fast-forward", result.stdout)
        self.assertEqual((target / ".env").read_text(), "S6_PORT=8080\nCUSTOM=preserve\n")
        self.assertEqual((target / "data" / "project").read_text(), "preserve this project")
        self.assertTrue(any(c["tool"] == "discovered-docker" for c in self.calls()))

    def test_existing_docker_on_path_keeps_precedence(self):
        self.executable(self.bin / "docker", self.stub("path-docker"))
        self.install()
        tools = {c["tool"] for c in self.calls()}
        self.assertIn("path-docker", tools)
        self.assertNotIn("discovered-docker", tools)

    def test_missing_compose_reports_minimum_version(self):
        self.env["S6_TEST_COMPOSE_MISSING"] = "1"
        result = subprocess.run(["/bin/bash"], input=(ROOT / "install.sh").read_text(),
                                text=True, capture_output=True, env=self.env,
                                cwd=self.home, timeout=30)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Docker Compose 2.26 or newer is required", result.stdout + result.stderr)

    def test_old_compose_version_reports_detected_version_and_minimum(self):
        self.env["S6_TEST_COMPOSE_VERSION"] = "Docker Compose version v2.25.0"
        result = subprocess.run(["/bin/bash"], input=(ROOT / "install.sh").read_text(),
                                text=True, capture_output=True, env=self.env,
                                cwd=self.home, timeout=30)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Docker Compose 2.26 or newer is required; found Docker Compose version v2.25.0",
                      result.stdout + result.stderr)

    def test_exported_compose_ports_control_readiness_and_summary(self):
        self.env.update(S6_PORT="18080", S6_ENGINE_PORT="18001")
        result = self.install()
        requests = [c["args"] for c in self.calls() if c["tool"] == "curl"]
        self.assertTrue(requests)
        self.assertTrue(all("http://127.0.0.1:18080/api/health" in args for args in requests))
        self.assertIn("Frontend: http://127.0.0.1:18080", result.stdout)
        self.assertIn("Backend:  http://localhost:18001", result.stdout)

    def test_missing_git_downloads_and_updates_using_docker(self):
        (self.bin / "git").unlink()
        self.install()
        target = self.home / "s6_cut"
        (target / ".env").write_text("S6_PORT=8080\nCUSTOM=preserve\n")
        (target / "data").mkdir()
        (target / "data" / "project").write_text("preserve this project")
        self.install()
        commands = [c["args"] for c in self.calls() if c["args"][:1] == ["run"]]
        for operation in ["clone", "fetch", "pull"]:
            self.assertTrue(any(operation in args for args in commands), operation)
        self.assertEqual((target / ".env").read_text(), "S6_PORT=8080\nCUSTOM=preserve\n")
        self.assertEqual((target / "data" / "project").read_text(), "preserve this project")

    def test_mac_without_developer_tools_uses_docker_git(self):
        self.executable(self.bin / "xcode-select", "#!/bin/sh\nexit 1\n")
        self.install()
        self.assertTrue(any(c["args"][:1] == ["run"] for c in self.calls()))


if __name__ == "__main__":
    unittest.main()
