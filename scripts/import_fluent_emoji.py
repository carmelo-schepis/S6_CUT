#!/usr/bin/env python3
"""Import the curated Fluent Emoji set at its pinned revision.

Run from the repository root: python3 scripts/import_fluent_emoji.py
The importer is deterministic and writes only selected 3D PNGs, the manifest,
license, and provenance notice. Runtime code never invokes this script.
"""

from __future__ import annotations

import hashlib
import json
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "engine" / "assets" / "fluent-emoji"
REPOSITORY = "microsoft/fluentui-emoji"
REVISION = "1ffb34c752ecf5d402f04cfb4b392c77f57c54bc"
# tuple: (Unicode grapheme, upstream asset directory, skin-tone directory or None)
SELECTIONS = (
    ("😂", "Face with tears of joy", None),
    ("😅", "Grinning face with sweat", None),
    ("😮", "Face with open mouth", None),
    ("😬", "Grimacing face", None),
    ("😎", "Smiling face with sunglasses", None),
    ("😄", "Grinning face with smiling eyes", None),
    ("😊", "Smiling face with smiling eyes", None),
    ("🙃", "Upside-down face", None),
    ("😢", "Crying face", None),
    ("😏", "Smirking face", None),
    ("😐", "Neutral face", None),
    ("😲", "Astonished face", None),
    ("😱", "Face screaming in fear", None),
    ("😁", "Beaming face with smiling eyes", None),
    ("😤", "Face with steam from nose", None),
    ("😠", "Angry face", None),
    ("🙂", "Slightly smiling face", None),
    ("😕", "Confused face", None),
    ("😌", "Relieved face", None),
    ("😩", "Weary face", None),
    ("😍", "Smiling face with heart-eyes", None),
    ("🥰", "Smiling face with hearts", None),
    ("❤️", "Red heart", None),
    ("💔", "Broken heart", None),
    ("👍", "Thumbs up", "Default"),
    ("👍🏽", "Thumbs up", "Medium"),
    ("👎", "Thumbs down", "Default"),
    ("👏", "Clapping hands", "Default"),
    ("🙌", "Raising hands", "Default"),
    ("🤝", "Handshake", None),
    ("👩‍💻", "Woman technologist", "Default"),
    ("👩🏽‍💻", "Woman technologist", "Medium"),
)


def download(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "S6-CUT-Fluent-Emoji-importer"})
    with urllib.request.urlopen(request, timeout=45) as response:
        return response.read()


def main() -> None:
    DEST.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=DEST.parent, prefix=".fluent-emoji-import-") as temporary:
        stage = Path(temporary) / "bundle"
        stage.mkdir()
        entries = []
        for index, (emoji, title, tone) in enumerate(SELECTIONS, start=1):
            filename = f"emoji-{index:02d}.png"
            variant = f"{tone}/" if tone else ""
            source_path = f"assets/{title}/{variant}3D/"
            # Fluent's 3D names are generated from the title directory and tone.
            slug = title.lower().replace(":", "").replace(",", "").replace(" ", "_")
            suffix = f"_{tone.lower().replace('-', '_')}" if tone else ""
            source_path += f"{slug}_3d{suffix}.png"
            url = f"https://raw.githubusercontent.com/{REPOSITORY}/{REVISION}/{urllib.request.pathname2url(source_path)}"
            content = download(url)
            if len(content) < 24 or not content.startswith(b"\x89PNG\r\n\x1a\n"):
                raise ValueError(f"Upstream asset is not PNG: {source_path}")
            (stage / filename).write_bytes(content)
            asset_id = "u" + "_".join(f"{ord(character):x}" for character in emoji)
            entries.append({
                "emoji": emoji,
                "assetId": asset_id,
                "name": title,
                "relativePath": filename,
                "file": filename,
                "source": source_path,
                "width": int.from_bytes(content[16:20], "big"),
                "height": int.from_bytes(content[20:24], "big"),
                "sha256": hashlib.sha256(content).hexdigest(),
            })
        manifest = {
            "upstream": f"https://github.com/{REPOSITORY}",
            "revision": REVISION,
            "assets": entries,
        }
        (stage / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        license_url = f"https://raw.githubusercontent.com/{REPOSITORY}/{REVISION}/LICENSE"
        (stage / "LICENSE").write_bytes(download(license_url))
        (stage / "NOTICE.txt").write_text(
            "Fluent Emoji artwork © Microsoft Corporation. All selected artwork is from "
            "microsoft/fluentui-emoji at revision " + REVISION + ".\n"
            "Licensed under the MIT License; see LICENSE. Source paths and per-file "
            "SHA-256 digests are recorded in manifest.json. Only the curated 3D PNG "
            "files listed there are redistributed.\n",
            encoding="utf-8",
        )
        backup = Path(temporary) / "previous"
        if DEST.exists():
            DEST.rename(backup)
        try:
            stage.rename(DEST)
        except Exception:
            if backup.exists():
                backup.rename(DEST)
            raise
    print(f"Imported {len(entries)} Fluent Emoji PNGs at {REVISION}")


if __name__ == "__main__":
    main()
