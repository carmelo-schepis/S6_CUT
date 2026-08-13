from __future__ import annotations

import re
import uuid
from typing import Any

from .library import LibraryRules, visual_concept
from .models import Beat


TOKEN = re.compile(r"\S+")


def source_tokens(script: str) -> list[dict[str, Any]]:
    return [{"text": match.group(), "char_start": match.start(), "char_end": match.end()} for match in TOKEN.finditer(script)]


def align_script_words(script: str, duration: float, transcript_words: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    tokens = source_tokens(script)
    if not tokens:
        return []
    transcript_words = transcript_words or []
    usable = len(transcript_words) >= len(tokens) * .65
    aligned: list[dict[str, Any]] = []
    for index, token in enumerate(tokens):
        if usable and index < len(transcript_words):
            start = float(transcript_words[index]["start"])
            end = float(transcript_words[index]["end"])
        else:
            start = duration * index / len(tokens)
            end = duration * (index + 1) / len(tokens)
        aligned.append({**token, "start": max(0, start), "end": max(start + .02, end)})
    return aligned


def plan_beats(script: str, words: list[dict[str, Any]], rules: LibraryRules, target_seconds: float = 2.5) -> list[Beat]:
    if not words:
        return []
    beats: list[Beat] = []
    index = 0
    while index < len(words):
        start_index = index
        start_time = float(words[index]["start"])
        ideal = start_time + target_seconds
        while index + 1 < len(words) and float(words[index]["end"]) < ideal:
            index += 1
            if float(words[index]["end"]) - start_time >= 1.8 and re.search(r"[,;:.!?][\"')\]]*$", str(words[index]["text"])):
                break
        end_index = index
        char_start = int(words[start_index]["char_start"])
        char_end = int(words[end_index]["char_end"])
        exact = script[char_start:char_end]
        resolved = rules.resolve(exact)
        beats.append(Beat(
            id=str(uuid.uuid4()), start=start_time, end=float(words[end_index]["end"]),
            char_start=char_start, char_end=char_end, text=exact,
            concept=resolved.label or visual_concept(exact), source=resolved.source,
            confidence=resolved.confidence, rule_state=resolved.asset.policy if resolved.asset else "Fallback",
            match_reason=resolved.match_reason, asset_id=resolved.asset.id if resolved.asset else None,
        ))
        index += 1
    return beats
