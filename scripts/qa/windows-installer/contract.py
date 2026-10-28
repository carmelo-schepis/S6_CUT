"""Small shared contracts for the Windows installer worker and its Hermes owner."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import time

JOB_ID = "2172e34e98bc"
OWNER = "s6-windows-installer-verification-v1"
TERMINAL = {"PASS", "PRODUCT_FAILURE", "BLOCKED", "INCONCLUSIVE", "CLEANUP_FAILED"}
REPOSITORY = "https://github.com/carmelo-schepis/S6_CUT.git"
RAW = "https://raw.githubusercontent.com/carmelo-schepis/S6_CUT/"
COMMAND = "irm " + RAW + "main/Install-S6_CUT.ps1 | iex"


def valid_id(value: str) -> str:
    if not re.fullmatch(r"[a-f0-9]{32}", value):
        raise ValueError("run ID must be 32 lowercase hexadecimal characters")
    return value


def owned(root: Path, path: Path, *, include_root: bool = False) -> Path:
    root = root.absolute()
    path = path.absolute()
    if path == root and not include_root:
        raise ValueError("refusing to operate on the ownership root")
    if path != root and root not in path.parents:
        raise ValueError("path is outside the owned root")
    for parent in (path, *path.parents):
        if parent.is_symlink():
            raise ValueError("symlink/reparse paths are not owned")
        if parent == root:
            break
    if path.resolve() != path:
        raise ValueError("path resolves outside its declared location")
    return path


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp-" + str(os.getpid()))
    with tmp.open("w") as stream:
        json.dump(value, stream, indent=2, sort_keys=True)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(tmp, path)


def load_manifest(root: Path, run_id: str) -> dict:
    run_id = valid_id(run_id)
    path = owned(root, root / "runs" / run_id / "state.json")
    data = json.loads(path.read_text())
    if data.get("owner") != OWNER or data.get("run_id") != run_id:
        raise ValueError("ownership manifest identity mismatch")
    for item in data.get("installations", []):
        owned(root / "runs" / run_id / "payload", Path(item["install"]))
        if not re.fullmatch(r"s6iv-" + run_id + r"-(fresh|upgrade|custom)", item["project"]):
            raise ValueError("Compose project is not owned by this run")
        if isinstance(item["engine_port"], bool) or not isinstance(item["engine_port"], int):
            raise ValueError("engine port must be numeric; host IP belongs to Compose")
        if not 1 <= item["engine_port"] <= 65535 or not 1 <= item["web_port"] <= 65535:
            raise ValueError("invalid port")
    return data


def fingerprint(stage: str, message: str) -> str:
    stable = re.sub(r"[a-f0-9]{32,64}|\b\d{4,}\b", "<id>", message.lower())
    stable = re.sub(r"[a-z]:\\[^\s]+|/mnt/[a-z]/[^\s]+", "<path>", stable)
    return hashlib.sha256((stage + ":" + stable[:600]).encode()).hexdigest()[:20]


def source_freshness(expected: str, installed: str, after: str) -> str:
    if installed != expected or after != expected:
        return "INCONCLUSIVE"
    return "PASS"


def summary(data: dict) -> str:
    result = data.get("status", "INCONCLUSIVE")
    tests = data.get("tests", {})
    label = 'Windows worker diagnostic' if data.get('test_case') else 'Windows installer'
    text = (f"S6_CUT {label}: {result}\n"
            f"Run: {data['run_id']} · revision: {data.get('source_revision', 'unverified')}\n"
            f"Fresh: {tests.get('fresh', 'NOT RUN')} · smoke: {tests.get('smoke', 'NOT RUN')} · "
            f"upgrade: {tests.get('upgrade', 'NOT RUN')} · rerun: {tests.get('rerun', 'NOT RUN')}\n"
            f"Cleanup: {data.get('cleanup', {}).get('status', 'UNVERIFIED')}\n")
    if data.get("error"):
        text += "Finding: " + sanitize(data["error"])[:400] + "\n"
    text += "PRs: " + (", ".join(data.get("pr_urls", [])) or "none") + "\n"
    text += "Action: " + data.get("action", "none") + "\n"
    text += "Evidence: " + data.get("evidence", "Windows run manifest")
    return text


def sanitize(value: str) -> str:
    value = re.sub(r"(?i)(bearer\s+|(?:token|password|secret|api[_-]?key)\s*[:=]\s*)\S+", r"\1[REDACTED]", str(value))
    value = re.sub(r"\b(?:xox[baprs]-|sk-)[A-Za-z0-9_-]+", "[REDACTED]", value)
    return value.replace("<", "&lt;").replace(">", "&gt;")


def matching_pr(prs: list[dict], defect: str) -> dict | None:
    marker = "S6-WINDOWS-INSTALLER:" + defect
    return next((pr for pr in prs if marker in pr.get("body", "")), None)


def terminal(data: dict, result: str, *, error: str | None = None) -> dict:
    if result not in TERMINAL:
        raise ValueError("not a terminal result")
    required = {'fresh', 'smoke', 'rerun'} if data.get('candidate_branch') else {'fresh', 'smoke', 'rerun', 'older_fixture', 'upgrade', 'upgrade_idempotence', 'fallback_custom_path_ports', 'native_stub_harness'}
    if result == 'PASS' and not data.get('test_case') and any(not str(data.get('tests', {}).get(key, '')).startswith('PASS') for key in required):
        result = 'INCONCLUSIVE'
        error = 'Required installer coverage was skipped or incomplete'
    data.update(status=result, finished_at=time.time())
    if error:
        data["error"] = sanitize(error)
    if data.get("cleanup", {}).get("status") != "PASS":
        data["status"] = "CLEANUP_FAILED"
    return data
