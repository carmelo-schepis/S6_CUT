#!/usr/bin/env python3
"""Build deterministic, distinct local videos for isolated thumbnail acceptance."""
from __future__ import annotations

import argparse
import subprocess
from pathlib import Path


def render(output: Path, *, size: str, duration: float, color: str, audio: str | None = None, black_intro: bool = False) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    video = f"color=c={color}:s={size}:r=24:d={duration}"
    if black_intro:
        video = f"color=c=black:s={size}:r=24:d=0.8[black];{video}[color];[black][color]concat=n=2:v=1:a=0"
    command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", video]
    if audio == "silent":
        command += ["-an"]
    elif audio == "tone":
        command += ["-f", "lavfi", "-i", f"sine=frequency=880:duration={duration}", "-shortest", "-c:a", "aac"]
    command += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(output)]
    subprocess.run(command, check=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    out = args.output
    # Saturated, unmistakably distinct frames make accidental fixture reuse visible.
    render(out / "portrait-source.mp4", size="360x640", duration=4, color="0xD02020", audio="silent")
    render(out / "landscape-source.mp4", size="640x360", duration=4, color="0x2060D0", audio="tone")
    render(out / "black-intro.mp4", size="640x360", duration=4, color="0x20C060", audio="silent", black_intro=True)
    render(out / "very-short.mp4", size="360x640", duration=0.35, color="0xD0B020", audio="silent")
    # Paired source/generated assets prove the acceptance path sees the actual uploaded bytes.
    render(out / "generated-clip.mp4", size="360x640", duration=3, color="0xC020D0", audio="silent")
    print(f"Created five local thumbnail fixtures in {out.resolve()}")


if __name__ == "__main__":
    main()
