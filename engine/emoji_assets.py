"""Offline exact-sequence lookup for bundled Microsoft Fluent 3D emoji."""
from __future__ import annotations

import hashlib
import json
from functools import lru_cache
from pathlib import Path

_ASSET_ROOT = Path(__file__).parent / "assets" / "fluent-emoji"
_MANIFEST = _ASSET_ROOT / "manifest.json"


@lru_cache(maxsize=1)
def _manifest() -> dict[str, dict[str, object]]:
    """Load the checked-in manifest; never consult a network or host font."""
    try:
        payload = json.loads(_MANIFEST.read_text(encoding="utf-8"))
        entries = payload["assets"]
        if not isinstance(entries, list):
            return {}
        return {
            entry["emoji"]: entry
            for entry in entries
            if isinstance(entry, dict)
            and isinstance(entry.get("emoji"), str)
            and isinstance(entry.get("relativePath"), str)
        }
    except (OSError, ValueError, KeyError, TypeError):
        return {}


@lru_cache(maxsize=64)
def _verified_asset(sequence: str) -> Path | None:
    entry = _manifest().get(sequence)
    if entry is None:
        return None
    relative = Path(str(entry["relativePath"]))
    if relative.is_absolute() or ".." in relative.parts:
        return None
    path = (_ASSET_ROOT / relative).resolve()
    if not path.is_relative_to(_ASSET_ROOT.resolve()):
        return None
    try:
        content = path.read_bytes()
        if not content.startswith(b"\x89PNG\r\n\x1a\n"):
            return None
        if hashlib.sha256(content).hexdigest() != entry.get("sha256"):
            return None
        width, height = int.from_bytes(content[16:20], "big"), int.from_bytes(content[20:24], "big")
        if width != entry.get("width") or height != entry.get("height"):
            return None
        return path
    except (OSError, ValueError, TypeError):
        return None


def resolve_emoji(sequence: str) -> Path | None:
    """Resolve one whole Unicode sequence to its integrity-checked local PNG."""
    if not isinstance(sequence, str) or not sequence:
        return None
    return _verified_asset(sequence)


def emoji_manifest() -> dict[str, str]:
    """Return a copy of the exact sequence-to-relative-path mapping."""
    return {sequence: str(entry["relativePath"]) for sequence, entry in _manifest().items()}


def find_emoji_sequences(text: str) -> list[tuple[int, int, str, Path]]:
    """Find manifest sequences intact, preferring the longest complete match.

    This uses exact manifest keys, not broad Unicode ranges. Thus punctuation,
    variation selectors, modifiers and joiners are only consumed as part of a
    sequence that is actually supported by this bundled manifest.
    """
    if not isinstance(text, str) or not text:
        return []
    sequences = sorted(_manifest(), key=len, reverse=True)
    found: list[tuple[int, int, str, Path]] = []
    index = 0
    consumed_end = -1
    while index < len(text):
        match = next((sequence for sequence in sequences if text.startswith(sequence, index)), None)
        # Never split an unlisted grapheme into a supported base component.
        # In particular, keep unsupported modifier/ZWJ/variation-selector
        # combinations intact rather than rasterizing only their first codepoint.
        if match is not None:
            end = index + len(match)
            next_character = text[end:end + 1]
            previous_character = text[index - 1:index] if index else ""
            structural = lambda character: character == "\u200d" or "\ufe00" <= character <= "\ufe0f" or "\U0001f3fb" <= character <= "\U0001f3ff"
            previous_was_unmatched_structural = previous_character and structural(previous_character) and index - 1 >= consumed_end
            if (next_character and structural(next_character)) or previous_was_unmatched_structural:
                match = None
        if match is None:
            index += 1
            continue
        asset = resolve_emoji(match)
        if asset is not None:
            found.append((index, index + len(match), match, asset))
            consumed_end = index + len(match)
        index += len(match)
    return found
