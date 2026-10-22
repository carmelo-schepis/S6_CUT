#!/usr/bin/env python3
"""Rebuild the Music typography faces from their pinned upstream sources.

Usage: python scripts/build-music-fonts.py <download-dir> <output-root>

Downloads Gaegu Bold and the Oswald variable font from google/fonts at one
pinned commit, verifies their SHA-256, then writes:

* engine/fonts/oswald/Oswald-Regular.ttf  - static wght=400 instance (fontTools instancer)
* engine/fonts/gaegu/Gaegu-Bold.ttf       - the unmodified upstream file
* web/public/fonts/{oswald,gaegu}/*.ttf   - Latin subsets for the in-app theme previews

Requires fonttools (pip install fonttools==4.55.3). The output is deterministic:
timestamps are not recalculated, so the checksums recorded in
third_party_provenance.json reproduce exactly. Not used at runtime.
"""
from __future__ import annotations

import hashlib
import sys
import urllib.request
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

COMMIT = "45e3d5269e4a17d823f6d84470bc084dc5ae46f6"
BASE = f"https://raw.githubusercontent.com/google/fonts/{COMMIT}/ofl"
SOURCES = {
    "Oswald-wght.ttf": (f"{BASE}/oswald/Oswald%5Bwght%5D.ttf", "5b38c246e255a12f5712d640d56bcced0472466fc68983d2d0410ec0457c2817"),
    "Gaegu-Bold.ttf": (f"{BASE}/gaegu/Gaegu-Bold.ttf", "cc38a4af9506a45254d1ce07c589ec473d9e5f0be319e5a77b17c214903f8c1c"),
}
LICENCES = {"oswald": f"{BASE}/oswald/OFL.txt", "gaegu": f"{BASE}/gaegu/OFL.txt"}
LATIN = list(range(0x20, 0x7F)) + list(range(0xA0, 0x100)) + [0x2013, 0x2018, 0x2019, 0x201C, 0x201D, 0x2026]


def fetch(url: str, target: Path) -> bytes:
    data = urllib.request.urlopen(url, timeout=60).read()
    target.write_bytes(data)
    return data


def latin_subset(source: Path, target: Path) -> None:
    options = subset.Options()
    options.layout_features = ["*"]
    options.name_IDs = ["*"]
    options.notdef_outline = True
    font = TTFont(source, recalcTimestamp=False)
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=LATIN)
    subsetter.subset(font)
    font.save(target)


def main(download: Path, root: Path) -> None:
    download.mkdir(parents=True, exist_ok=True)
    for name, (url, expected) in SOURCES.items():
        digest = hashlib.sha256(fetch(url, download / name)).hexdigest()
        if digest != expected:
            raise SystemExit(f"{name}: upstream checksum {digest} != pinned {expected}")
    for family, url in LICENCES.items():
        for tree in ("engine/fonts", "web/public/fonts"):
            (root / tree / family).mkdir(parents=True, exist_ok=True)
            fetch(url, root / tree / family / "OFL.txt")
    variable = TTFont(download / "Oswald-wght.ttf", recalcTimestamp=False)
    regular = instancer.instantiateVariableFont(variable, {"wght": 400}, updateFontNames=True)
    regular.save(root / "engine/fonts/oswald/Oswald-Regular.ttf")
    (root / "engine/fonts/gaegu/Gaegu-Bold.ttf").write_bytes((download / "Gaegu-Bold.ttf").read_bytes())
    latin_subset(root / "engine/fonts/oswald/Oswald-Regular.ttf", root / "web/public/fonts/oswald/Oswald-Regular.ttf")
    latin_subset(root / "engine/fonts/gaegu/Gaegu-Bold.ttf", root / "web/public/fonts/gaegu/Gaegu-Bold.ttf")
    for path in sorted(root.glob("*/fonts/*/*.ttf")) + sorted(root.glob("web/public/fonts/*/*.ttf")):
        if path.parent.name in {"oswald", "gaegu"}:
            print(hashlib.sha256(path.read_bytes()).hexdigest(), path.relative_to(root))


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    main(Path(sys.argv[1]), Path(sys.argv[2]))
