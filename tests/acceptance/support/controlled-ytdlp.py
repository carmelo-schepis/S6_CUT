#!/usr/bin/env python3
"""Deterministic yt-dlp substitute for isolated acceptance stacks only."""
import shutil
import sys
from pathlib import Path


def argument(name: str) -> str:
    try:
        return sys.argv[sys.argv.index(name) + 1]
    except (ValueError, IndexError) as exc:
        raise SystemExit(f"missing required argument: {name}") from exc


output = Path(argument("--output"))
output = Path(str(output).replace("%(id)s", "8xEuFQz4E4A").replace("%(ext)s", "mkv"))
fixture = Path("/opt/s6-video-download-test/source-with-audio.mkv")
output.parent.mkdir(parents=True, exist_ok=True)
print("download:downloading|1000000|1000000|NA|1000000|0|100.0%", flush=True)
shutil.copyfile(fixture, output)
print(str(output), flush=True)
