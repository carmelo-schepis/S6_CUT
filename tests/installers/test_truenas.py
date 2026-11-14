"""TrueNAS SCALE installer regressions: real Git and Docker Compose rendering,
with the TrueNAS middleware (midclt), Docker engine and host tools faked.

Run with: python3 -m unittest discover -s tests/installers -v
"""
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import termios
import unittest

import importlib.util

ROOT = Path(__file__).resolve().parents[2]
FAKES = Path(__file__).resolve().parent / "truenas_fakes"
REAL_DOCKER = shutil.which("docker")
HAS_YAML = importlib.util.find_spec("yaml") is not None


def compose_available():
    if not REAL_DOCKER:
        return False
    return subprocess.run([REAL_DOCKER, "compose", "version"], capture_output=True).returncode == 0


@unittest.skipUnless(compose_available(), "needs the Docker Compose CLI to render the app YAML")
class TrueNasInstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="s6-truenas-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.mnt = self.base / "mnt"
        (self.mnt / "tank").mkdir(parents=True)
        self.source = self.base / "upstream"
        self.source.mkdir()
        self.git("init", "-b", "main", str(self.source))
        shutil.copy(ROOT / "compose.yaml", self.source / "compose.yaml")
        shutil.copy(ROOT / ".env.example", self.source / ".env.example")
        shutil.copy(ROOT / "uninstall-truenas.sh", self.source / "uninstall-truenas.sh")
        self.commit("Fixture")

        self.bin = self.base / "bin"
        self.bin.mkdir()
        for fake in ["midclt", "docker"]:
            self.executable(self.bin / fake, (FAKES / fake).read_text().replace(
                "#!/usr/bin/env python3", f"#!{sys.executable}", 1))
        self.executable(self.bin / "id", "#!/bin/sh\necho \"${FAKE_TN_UID:-0}\"\n")
        self.executable(self.bin / "chown", "#!/bin/sh\necho \"chown $*\" >> \"$FAKE_TN_CHOWN_LOG\"\n")
        self.executable(self.bin / "ss", "#!/bin/sh\nfor p in $FAKE_TN_LISTEN; do "
                        "echo \"LISTEN 0 4096 0.0.0.0:$p 0.0.0.0:*\"; done\n")
        self.executable(self.bin / "ip", "#!/bin/sh\necho '1.1.1.1 via 192.168.1.1 dev eno1 src 192.168.1.50 uid 0'\n")
        self.executable(self.bin / "sleep", "#!/bin/sh\nexit 0\n")

        self.log = self.base / "calls.jsonl"
        self.chown_log = self.base / "chown.log"
        self.state_file = self.base / "state.json"
        self.state = {"version": "25.04.2.1", "pool": "tank", "mnt": str(self.mnt),
                      "datasets": {"tank": str(self.mnt / "tank")}, "apps": {}}
        self.save_state()
        self.env = {
            "PATH": f"{self.bin}:{os.environ['PATH']}", "HOME": str(self.base),
            "S6_REPO_URL": self.source.as_uri(), "FAKE_TN_LOG": str(self.log),
            "FAKE_TN_STATE": str(self.state_file), "FAKE_TN_CHOWN_LOG": str(self.chown_log),
            "FAKE_TN_REAL_DOCKER": REAL_DOCKER, "FAKE_TN_LISTEN": "22 80 443",
            "S6_START_TIMEOUT": "30",
            "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1",
            "TMPDIR": str(self.base),
        }
        self.app_root = self.mnt / "tank" / "apps" / "s6-cut"
        self.app_configs = self.base / "ix-apps" / "app_configs"
        self.env["S6_TRUENAS_APP_CONFIGS"] = str(self.app_configs)

    # --- helpers --------------------------------------------------------------

    def git(self, *args):
        return subprocess.run(["git", *args], check=True, text=True, capture_output=True,
                              env=dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1"))

    def commit(self, message):
        self.git("-C", str(self.source), "add", ".")
        self.git("-C", str(self.source), "-c", "user.name=Test", "-c",
                 "user.email=test@example.invalid", "commit", "-qm", message)
        return self.git("-C", str(self.source), "rev-parse", "HEAD").stdout.strip()

    def executable(self, path, content):
        path.write_text(content)
        path.chmod(0o755)

    def save_state(self):
        self.state_file.write_text(json.dumps(self.state))

    def load_state(self):
        self.state = json.loads(self.state_file.read_text())
        return self.state

    def run_script(self, script, *args, stdin=None, check=None, **kwargs):
        # Piped into bash exactly like `curl ... | sudo bash`, without a controlling terminal.
        kwargs.setdefault("start_new_session", True)
        kwargs.setdefault("cwd", self.base)
        if stdin is None:
            result = subprocess.run(["/bin/bash", "-s", "--", *args], input=(ROOT / script).read_text(),
                                    text=True, capture_output=True, env=self.env,
                                    timeout=180, **kwargs)
        else:
            result = subprocess.run(["/bin/bash", str(ROOT / script), *args], stdin=stdin,
                                    text=True, capture_output=True, env=self.env,
                                    timeout=180, **kwargs)
        output = result.stdout + result.stderr
        if check is True:
            self.assertEqual(result.returncode, 0, output)
        elif check is False:
            self.assertNotEqual(result.returncode, 0, output)
        return result, output

    def install(self):
        result, output = self.run_script("install-truenas.sh", check=True)
        self.assertIn("S6_cut is running as the TrueNAS app 's6-cut'", output)
        return output

    def calls(self, tool=None):
        if not self.log.exists():
            return []
        calls = [json.loads(line) for line in self.log.read_text().splitlines()]
        return [c["args"] for c in calls if tool is None or c["tool"] == tool]

    def midclt_methods(self):
        return [next(a for a in args[1:] if a != "-j") for args in self.calls("midclt")]

    def env_file(self):
        return (self.app_root / "source" / ".env").read_text()

    # --- install --------------------------------------------------------------

    def test_fresh_install_creates_datasets_builds_and_creates_app(self):
        output = self.install()
        state = self.load_state()
        self.assertEqual(
            [args[2] for args in self.calls("midclt") if args[1] == "pool.dataset.create"],
            [json.dumps({"name": n, "type": "FILESYSTEM", "share_type": "GENERIC"})
             for n in ["tank/apps", "tank/apps/s6-cut", "tank/apps/s6-cut/source", "tank/apps/s6-cut/data"]])
        data = self.app_root / "data"
        source = self.app_root / "source"
        self.assertEqual(self.git("-C", str(source), "rev-parse", "HEAD").stdout.strip(),
                         self.git("-C", str(self.source), "rev-parse", "HEAD").stdout.strip())

        env = self.env_file()
        self.assertIn(f"S6_DATA_PATH={data}\n", env)
        self.assertIn("S6_PORT=30180\n", env)
        self.assertEqual(env.count("S6_PORT="), 1)
        self.assertEqual((source / ".env").stat().st_mode & 0o777, 0o600)
        self.assertIn(f"chown -h 10001:10001 {data}", self.chown_log.read_text())

        # Images are built with the project name TrueNAS deploys with, before the app exists.
        docker = self.calls("docker")
        build = next(i for i, a in enumerate(docker) if "build" in a)
        self.assertEqual(docker[build][:4], ["compose", "-p", "ix-s6-cut", "-f"])
        methods = self.midclt_methods()
        log = self.calls()
        self.assertLess(next(i for i, a in enumerate(log) if "build" in a),
                        next(i for i, a in enumerate(log) if "app.create" in a))
        self.assertIn("app.create", methods)
        self.assertNotIn("app.update", methods)
        create = next(a for a in self.calls("midclt") if "app.create" in a)
        self.assertEqual(create[:3], ["call", "-j", "app.create"])
        payload = json.loads(create[3])
        self.assertEqual(payload["app_name"], "s6-cut")
        self.assertIs(payload["custom_app"], True)

        # The submitted YAML is the resolved compose model with absolute dataset paths.
        rendered = payload["custom_compose_config_string"]
        self.assertEqual(rendered, (self.app_root / "truenas-app.yaml").read_text())
        self.assertEqual(state["apps"]["s6-cut"]["yaml"], rendered)
        self.assertIn("name: ix-s6-cut", rendered)
        self.assertIn(f"source: {data}", rendered)
        self.assertIn("target: /app/data", rendered)
        self.assertIn(f"context: {source}", rendered)
        self.assertIn('published: "30180"', rendered)
        self.assertIn("host_ip: 127.0.0.1", rendered)
        self.assertIn('published: "8001"', rendered)
        for service in ["pot-provider", "data-init", "engine", "web"]:
            self.assertIn(f"\n  {service}:\n", rendered)
        self.assertEqual((self.app_root / "truenas-app.yaml").stat().st_mode & 0o777, 0o600)

        # The rendered file resolves on its own, as TrueNAS will run it.
        check = subprocess.run([REAL_DOCKER, "compose", "-p", "ix-s6-cut", "-f",
                                str(self.app_root / "truenas-app.yaml"), "config", "--quiet"],
                               capture_output=True, text=True, cwd=self.base)
        self.assertEqual(check.returncode, 0, check.stderr)

        self.assertIn("http://192.168.1.50:30180", output)
        self.assertIn(f"Data:      {data}  (dataset tank/apps/s6-cut/data)", output)
        self.assertIn("re-run the same install command", output)
        self.assertIn("no authentication", output)
        self.assertIn("never port-forward", output)

    def test_rerun_updates_source_and_app_but_preserves_env_and_data(self):
        self.install()
        source = self.app_root / "source"
        env_path = source / ".env"
        env_path.write_text(env_path.read_text() + "CUSTOM=preserve\n")
        (self.app_root / "data" / "project.json").write_text("keep me")
        (self.source / "NEW_FILE").write_text("update\n")
        new_head = self.commit("Upstream change")
        before_env = env_path.read_text()
        self.log.unlink()

        output = self.install()
        self.assertEqual(self.git("-C", str(source), "rev-parse", "HEAD").stdout.strip(), new_head)
        self.assertEqual(env_path.read_text(), before_env)
        self.assertEqual((self.app_root / "data" / "project.json").read_text(), "keep me")
        methods = self.midclt_methods()
        self.assertNotIn("pool.dataset.create", methods)
        self.assertNotIn("app.create", methods)
        self.assertIn("app.update", methods)
        # app.update already recreates a running app's containers.
        self.assertNotIn("app.redeploy", methods)
        update = next(a for a in self.calls("midclt") if "app.update" in a)
        self.assertEqual(update[:4], ["call", "-j", "app.update", "s6-cut"])
        self.assertEqual(set(json.loads(update[4])), {"custom_compose_config_string"})
        self.assertTrue(any("build" in a for a in self.calls("docker")))
        self.assertIn("Configuration preserved", output)

    def test_rerun_redeploys_a_stopped_app(self):
        self.install()
        self.load_state()["apps"]["s6-cut"]["state"] = "STOPPED"
        self.save_state()
        self.log.unlink()
        self.install()
        methods = self.midclt_methods()
        self.assertLess(methods.index("app.update"), methods.index("app.redeploy"))
        self.assertEqual(self.load_state()["apps"]["s6-cut"]["state"], "RUNNING")

    def test_rerun_with_explicit_port_changes_only_the_port(self):
        self.install()
        self.env["S6_PORT"] = "30250"
        self.install()
        env = self.env_file()
        self.assertIn("S6_PORT=30250\n", env)
        self.assertEqual(env.count("S6_PORT="), 1)
        self.assertIn('published: "30250"', self.load_state()["apps"]["s6-cut"]["yaml"])

    def write_rendered(self, app, text):
        rendered = self.app_configs / app / "versions" / "1.0.0" / "templates" / "rendered"
        rendered.mkdir(parents=True)
        (rendered / "docker-compose.yaml").write_text(text)

    def test_port_conflicts_pick_free_ports(self):
        # 30180 is listening on the host; 30181 is published by a running app;
        # 30182 and 30183 belong to a stopped app, which app.query does not report;
        # the engine's loopback default 8001 is also taken.
        self.env["FAKE_TN_LISTEN"] = "22 80 443 8001 30180"
        self.state["apps"]["running"] = {"state": "RUNNING", "yaml": "", "ports": [30181]}
        self.state["apps"]["stopped"] = {"state": "STOPPED", "yaml": "", "ports": [30182]}
        self.save_state()
        self.write_rendered("stopped", "services:\n  a:\n    ports:\n      - mode: ingress\n"
                            "        target: 80\n        published: \"30182\"\n"
                            "  b:\n    ports:\n      - \"0.0.0.0:30183:443/tcp\"\n      - \"9000\"\n")
        # The app's own old configuration does not block its port.
        self.write_rendered("s6-cut", "services:\n  web:\n    ports:\n      - \"30184:8080\"\n")
        output = self.install()
        env = self.env_file()
        self.assertIn("S6_PORT=30184\n", env)
        self.assertIn("S6_ENGINE_PORT=30185\n", env)
        self.assertIn("Port 30180 is in use; using 30184 instead.", output)
        self.assertIn("http://192.168.1.50:30184", output)

    def test_unmounted_existing_dataset_is_reported(self):
        self.state["datasets"]["tank/apps"] = None
        self.save_state()
        _, output = self.run_script("install-truenas.sh", check=False)
        self.assertIn("Dataset tank/apps is not mounted", output)
        self.assertNotIn("pool.dataset.create", self.midclt_methods())

    def test_explicit_port_that_is_taken_is_rejected(self):
        self.env["FAKE_TN_LISTEN"] = "30200"
        self.env["S6_PORT"] = "30200"
        _, output = self.run_script("install-truenas.sh", check=False)
        self.assertIn("Port 30200 (S6_PORT) is already in use", output)
        self.assertIn("S6_PORT=30201", output)
        self.assertNotIn("app.create", self.midclt_methods())

    def test_pool_and_app_name_overrides(self):
        self.state["datasets"]["fast"] = str(self.mnt / "fast")
        (self.mnt / "fast").mkdir()
        self.save_state()
        self.env.update(S6_POOL="fast", S6_APP_NAME="clips")
        self.run_script("install-truenas.sh", check=True)
        state = self.load_state()
        self.assertIn("fast/apps/clips/data", state["datasets"])
        self.assertIn("clips", state["apps"])
        self.assertIn("name: ix-clips", state["apps"]["clips"]["yaml"])
        build = next(a for a in self.calls("docker") if "build" in a)
        self.assertEqual(build[:3], ["compose", "-p", "ix-clips"])

    # --- refusals -------------------------------------------------------------

    def test_non_truenas_host_points_to_install_sh(self):
        (self.bin / "midclt").unlink()
        _, output = self.run_script("install-truenas.sh", check=False)
        self.assertIn("does not look like TrueNAS SCALE", output)
        self.assertIn("install.sh", output)
        self.assertFalse((self.mnt / "tank" / "apps").exists())

    def test_kubernetes_era_truenas_is_rejected(self):
        self.state["version"] = "24.04.2"
        self.save_state()
        _, output = self.run_script("install-truenas.sh", check=False)
        self.assertIn("needs TrueNAS SCALE 24.10 or newer", output)

    def test_requires_root(self):
        self.env["FAKE_TN_UID"] = "1000"
        _, output = self.run_script("install-truenas.sh", check=False)
        self.assertIn("must run as root", output)
        self.assertEqual(self.calls("midclt"), [])

    def test_unconfigured_apps_service_is_explained(self):
        self.state["pool"] = None
        self.save_state()
        _, output = self.run_script("install-truenas.sh", check=False)
        self.assertIn("Apps -> Configuration -> Choose Pool", output)

    def test_failed_app_create_prints_manual_fallback(self):
        self.state["fail"] = ["app.create"]
        self.save_state()
        _, output = self.run_script("install-truenas.sh", check=False)
        self.assertIn("TrueNAS could not create the app", output)
        self.assertIn("Install via YAML", output)
        self.assertTrue((self.app_root / "truenas-app.yaml").exists())

    def test_unhealthy_web_times_out_with_diagnostics(self):
        self.env.update(S6_START_TIMEOUT="0", FAKE_TN_WEB_STATUS="Up 10 seconds (health: starting)")
        _, output = self.run_script("install-truenas.sh", check=False)
        self.assertIn("was not healthy after 0s", output)
        self.assertIn("Diagnostics: containers of ix-s6-cut", output)

    # --- uninstall ------------------------------------------------------------

    def uninstall(self, *args, **kwargs):
        return self.run_script("uninstall-truenas.sh", *args, **kwargs)

    def test_uninstall_deletes_app_and_keeps_datasets(self):
        self.install()
        self.log.unlink()
        _, output = self.uninstall(check=True)
        state = self.load_state()
        self.assertNotIn("s6-cut", state["apps"])
        self.assertIn("tank/apps/s6-cut/data", state["datasets"])
        self.assertTrue((self.app_root / "data").is_dir())
        delete = next(a for a in self.calls("midclt") if "app.delete" in a)
        self.assertEqual(delete[:4], ["call", "-j", "app.delete", "s6-cut"])
        self.assertEqual(json.loads(delete[4]), {"remove_images": False, "remove_ix_volumes": False})
        self.assertNotIn("pool.dataset.delete", self.midclt_methods())
        self.assertIn("tank/apps/s6-cut/data", output)
        # Re-installing reuses the kept data and .env.
        self.install()
        self.assertIn("app.create", self.midclt_methods())

    def test_uninstall_remove_images(self):
        self.install()
        self.uninstall("--remove-images", check=True)
        delete = next(a for a in self.calls("midclt") if "app.delete" in a)
        self.assertEqual(json.loads(delete[4])["remove_images"], True)

    def test_purge_without_terminal_or_yes_destroys_nothing(self):
        self.install()
        _, output = self.uninstall("--purge", check=False)
        self.assertIn("Nothing was destroyed", output)
        self.assertIn(f"tank/apps/s6-cut/data  ({self.app_root / 'data'})", output)
        self.assertIn("tank/apps/s6-cut/data", self.load_state()["datasets"])
        self.assertTrue((self.app_root / "data").is_dir())

    def test_purge_yes_destroys_the_app_datasets_only(self):
        self.install()
        _, output = self.uninstall("--purge", "--yes", check=True)
        state = self.load_state()
        self.assertEqual(sorted(state["datasets"]), ["tank", "tank/apps"])
        self.assertFalse(self.app_root.exists())
        delete = next(a for a in self.calls("midclt") if "pool.dataset.delete" in a)
        self.assertEqual(delete[2:], ['"tank/apps/s6-cut"', '{"recursive": true}'])
        self.assertLess(self.midclt_methods().index("app.delete"), self.midclt_methods().index("pool.dataset.delete"))
        self.assertIn("tank/apps/s6-cut/source", output)

    def test_purge_from_the_documented_path_inside_the_dataset(self):
        # The docs run the copy in the source dataset. bash keeps its script
        # open, which on ZFS makes that dataset busy (the fake refuses too).
        self.install()
        result = subprocess.run(["/bin/bash", str(self.app_root / "source" / "uninstall-truenas.sh"),
                                 "--purge", "--yes"], capture_output=True, text=True, env=self.env,
                                cwd=self.base, start_new_session=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(self.app_root.exists())
        self.assertEqual(sorted(self.load_state()["datasets"]), ["tank", "tank/apps"])
        self.assertEqual(list(self.base.glob("s6-uninstall.*")), [])

    def test_piped_purge_started_inside_the_dataset_moves_out_first(self):
        self.install()
        self.uninstall("--purge", "--yes", check=True, cwd=self.app_root / "source")
        self.assertFalse(self.app_root.exists())

    def test_purge_refuses_while_a_process_uses_the_dataset(self):
        self.install()
        holder = subprocess.Popen(["/bin/sleep", "60"], cwd=self.app_root / "data")
        self.addCleanup(holder.kill)
        _, output = self.uninstall("--purge", "--yes", check=False)
        self.assertIn(f"{holder.pid} /bin/sleep 60", output)
        self.assertIn("Nothing was destroyed", output)
        self.assertNotIn("pool.dataset.delete", self.midclt_methods())
        self.assertTrue((self.app_root / "data").is_dir())

    def run_with_tty(self, answer, *args):
        primary, secondary = os.openpty()
        os.write(primary, answer.encode())

        def controlling_tty():
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)

        try:
            return subprocess.run(["/bin/bash", str(ROOT / "uninstall-truenas.sh"), *args],
                                  stdin=secondary, capture_output=True, text=True, env=self.env,
                                  start_new_session=True, preexec_fn=controlling_tty, timeout=60)
        finally:
            os.close(primary)
            os.close(secondary)

    def test_purge_prompt_requires_the_exact_dataset_name(self):
        self.install()
        result = self.run_with_tty("tank/apps\n", "--purge")
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Confirmation did not match", result.stderr)
        self.assertTrue((self.app_root / "data").is_dir())

        result = self.run_with_tty("tank/apps/s6-cut\n", "--purge")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(self.app_root.exists())

    def test_purge_stops_when_the_app_query_fails(self):
        self.install()
        self.load_state()["fail"] = ["app.query"]
        self.save_state()
        _, output = self.uninstall("--purge", "--yes", check=False)
        self.assertIn("Nothing was changed", output)
        self.assertNotIn("pool.dataset.delete", self.midclt_methods())
        self.assertTrue((self.app_root / "data").is_dir())
        self.assertIn("s6-cut", self.load_state()["apps"])

    def test_uninstall_on_non_truenas_host(self):
        (self.bin / "midclt").unlink()
        _, output = self.uninstall(check=False)
        self.assertIn("does not look like TrueNAS SCALE", output)

    def test_unknown_option_is_rejected(self):
        result, output = self.uninstall("--nope")
        self.assertEqual(result.returncode, 2)
        self.assertIn("Unknown option: --nope", output)


@unittest.skipUnless(compose_available(), "needs the Docker Compose CLI")
class TrueNasYamlTests(unittest.TestCase):
    """truenas/s6-cut.yaml must stay the prebuilt-image twin of compose.yaml."""

    DATA = "/mnt/tank/apps/s6-cut/data"

    def config(self, path, **env):
        result = subprocess.run(
            [REAL_DOCKER, "compose", "-p", "s6-cut", "-f", str(path), "config", "--format", "json"],
            capture_output=True, text=True, cwd=ROOT,
            env={"PATH": os.environ["PATH"], "HOME": os.environ.get("HOME", "/"), **env})
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_yaml_resolves_and_matches_compose_except_images_and_ports(self):
        # COMPOSE_DISABLE_ENV_FILE keeps a local .env from changing the defaults.
        compose = self.config(ROOT / "compose.yaml", S6_DATA_PATH=self.DATA, S6_PORT="30180",
                              COMPOSE_DISABLE_ENV_FILE="1")
        truenas = self.config(ROOT / "truenas" / "s6-cut.yaml", COMPOSE_DISABLE_ENV_FILE="1")
        self.assertEqual(sorted(truenas["services"]), sorted(compose["services"]))
        images = {"data-init": "ghcr.io/carmelo-schepis/s6-cut-engine:latest",
                  "engine": "ghcr.io/carmelo-schepis/s6-cut-engine:latest",
                  "web": "ghcr.io/carmelo-schepis/s6-cut-web:latest"}
        for name, service in compose["services"].items():
            with self.subTest(service=name):
                expected = dict(service)
                actual = dict(truenas["services"][name])
                self.assertNotIn("build", actual)
                if name in images:
                    expected.pop("build")
                    self.assertEqual(actual.pop("image"), images[name])
                    expected.pop("image", None)
                if name == "engine":
                    # The loopback debug port is left out of the paste-in app.
                    expected.pop("ports")
                    self.assertNotIn("ports", actual)
                    expected["environment"]["S6_BUILD_REVISION"] = "unknown"
                self.assertEqual(actual, expected)
        self.assertEqual(truenas["services"]["web"]["ports"][0]["published"], "30180")
        self.assertEqual(truenas["services"]["engine"]["volumes"][0]["source"], self.DATA)


if __name__ == "__main__":
    unittest.main()
