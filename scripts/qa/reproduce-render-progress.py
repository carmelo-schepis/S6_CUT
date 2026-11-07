#!/usr/bin/env python3
"""Observe real FFmpeg activity and assert that a disposable job publishes rendering progress.

Start a Smart clip in a fresh S6_CUT stack, then pass its API job UUID. No mocks,
provider configuration, source changes, job mutation, or container teardown occur.
Exit 0: rendering progress published; 1: reproducible stale progress; 2: incomplete.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import time
import urllib.parse
import urllib.request


def render_processes(processes: str, job_id: str) -> list[str]:
    """Exclude source muxing, audio extraction, and output verification processes."""
    matches = []
    for line in processes.splitlines():
        parts = line.split(None, 2)
        if len(parts) != 3 or parts[1] != "ffmpeg":
            continue
        output = parts[2].rsplit(None, 1)[-1]
        if f"/jobs/{job_id}/clips/" in output and output.endswith(".partial.mp4"):
            matches.append(line)
    return matches


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True, help="Disposable frontend URL, e.g. http://127.0.0.1:56760")
    parser.add_argument("--project", required=True, help="Run-owned s6-install-* Compose project")
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--timeout", type=int, default=600)
    args = parser.parse_args()
    base = urllib.parse.urlparse(args.url)
    assert base.scheme == "http" and base.hostname in ("127.0.0.1", "localhost")
    assert base.port and base.port not in (8080, 8001, 18080, 18001) and base.port > 1024
    assert not base.username and not base.password and base.path in ("", "/")
    assert not base.query and not base.fragment
    assert re.fullmatch(r"s6-install-[a-z0-9_-]{1,64}", args.project)
    assert re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", args.job_id)
    assert 1 <= args.timeout <= 3600
    docker = shutil.which("docker") or "/usr/local/bin/docker"

    def command(*arguments):
        result = subprocess.run([docker, *arguments], capture_output=True, text=True, timeout=30)
        if result.returncode:
            raise RuntimeError(result.stderr[-1000:])
        return result.stdout

    label = command("inspect", "--format", '{{ index .Config.Labels "com.docker.compose.project" }}',
                    args.project + "-web-1").strip()
    assert label == args.project, "the frontend container is not owned by the given disposable project"
    bindings = command("port", args.project + "-web-1", "8080/tcp")
    assert any(line.endswith(":" + str(base.port)) for line in bindings.splitlines()), "URL port does not match this project"

    def get(path):
        with urllib.request.urlopen(args.url.rstrip("/") + path, timeout=20) as response:
            return json.load(response)

    assert get("/api/health")["status"] == "ready"
    assert get("/api/v1/profiles") == [], "reproduction requires no provider profiles"
    observations = []
    until = time.monotonic() + args.timeout
    while time.monotonic() < until:
        job = get("/api/v1/jobs/" + args.job_id)
        if job["state"] in ("complete", "failed", "partial", "cancelled_kept"):
            print(json.dumps({"outcome": "incomplete", "job_state": job["state"],
                              "error": job.get("error"), "observations": observations}, indent=2))
            return 2
        processes = command("top", args.project + "-engine-1", "-eo", "pid,comm,args")
        ffmpeg = render_processes(processes, args.job_id)
        if ffmpeg:
            observed = {"observed_at": time.time(), "job_id": args.job_id, "state": job["state"], "stage": job["stage"],
                        "progress": job["progress"], "updated_at": job["updatedAt"],
                        "clip_states": [clip["state"] for clip in job["clips"]], "ffmpeg": ffmpeg}
            observations.append(observed)
            if len(observations) >= 3:
                recent = observations[-3:]
                published = [entry["stage"] == "render" and "rendering" in entry["clip_states"] for entry in recent]
                if all(published):
                    print(json.dumps({"outcome": "pass", "observations": recent}, indent=2))
                    return 0
                if not any(published):
                    print(json.dumps({"outcome": "stale_render_progress", "expected": "stage=render, clip=rendering while FFmpeg is active",
                                      "observations": recent}, indent=2))
                    return 1
        time.sleep(1)
    print(json.dumps({"outcome": "incomplete", "error": "No stable rendering observation before deadline",
                      "observations": observations}, indent=2))
    return 2


if __name__ == "__main__":
    try:
        result = main()
    except Exception as error:
        print(json.dumps({"outcome": "incomplete", "error": type(error).__name__ + ": " + str(error)}))
        result = 2
    raise SystemExit(result)
