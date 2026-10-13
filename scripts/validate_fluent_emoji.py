#!/usr/bin/env python3
"""Validate the bundled Fluent Emoji manifest and asset integrity."""

import hashlib
import json
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "engine" / "assets" / "fluent-emoji"
EXPECTED_REVISION = "1ffb34c752ecf5d402f04cfb4b392c77f57c54bc"


def main() -> None:
    manifest = json.loads((ASSETS / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["revision"] == EXPECTED_REVISION
    entries = manifest["assets"]
    assert entries and len({item["emoji"] for item in entries}) == len(entries)
    assert len({item["file"] for item in entries}) == len(entries)
    for item in entries:
        assert item["assetId"] == "u" + "_".join(f"{ord(char):x}" for char in item["emoji"])
        assert item["name"] and item["relativePath"] == item["file"]
        path = ASSETS / item["relativePath"]
        data = path.read_bytes()
        assert data.startswith(b"\x89PNG\r\n\x1a\n"), path
        assert hashlib.sha256(data).hexdigest() == item["sha256"], path
        width, height = struct.unpack(">II", data[16:24])
        assert (width, height) == (item["width"], item["height"])
        assert item["source"].startswith("assets/") and "/3D/" in item["source"]
    assert (ASSETS / "LICENSE").is_file() and (ASSETS / "NOTICE.txt").is_file()
    print(f"Validated {len(entries)} Fluent Emoji assets ({sum(p.stat().st_size for p in ASSETS.glob('*.png')):,} PNG bytes)")


if __name__ == "__main__":
    main()
