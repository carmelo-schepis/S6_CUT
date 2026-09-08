from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Any

from .models import Clip, ScoreBreakdown, Style


SENTENCE_END = re.compile(r"[.!?][\"')\]]*$")
HOOK_WORDS = {"why", "how", "secret", "never", "best", "worst", "truth", "imagine", "mistake", "here's", "what"}
PRACTICAL_WORDS = {"step", "first", "second", "because", "means", "example", "learn", "use", "tip", "method"}
ENERGY_WORDS = {"amazing", "incredible", "crazy", "shocking", "love", "hate", "wow", "huge", "always", "never"}
CREDIT_WORDS = {"credits", "credit", "cast", "starring", "directed", "written", "copyright", "produced", "end", "fin"}
TITLE_CARD_PHRASES = ("previously on", "coming soon", "the end", "a film by", "presented by")

STYLE_WEIGHTS: dict[Style, dict[str, float]] = {
    "funny": {"hook": 1.25, "coherence": .9, "ending": 1.1, "energy": 1.4, "practical": .55, "visual": 1.15, "complete": .95},
    "serious": {"hook": .85, "coherence": 1.35, "ending": 1.2, "energy": .55, "practical": 1.0, "visual": .75, "complete": 1.45},
    "educational": {"hook": .9, "coherence": 1.25, "ending": 1.15, "energy": .6, "practical": 1.55, "visual": 1.0, "complete": 1.35},
    "hype": {"hook": 1.55, "coherence": .75, "ending": 1.0, "energy": 1.55, "practical": .7, "visual": 1.25, "complete": .85},
}


@dataclass(frozen=True)
class Candidate:
    start: float
    end: float
    words: list[dict[str, Any]]
    score: ScoreBreakdown


def _sentence_ranges(words: list[dict[str, Any]]) -> list[tuple[int, int]]:
    ranges: list[tuple[int, int]] = []
    start = 0
    for index, word in enumerate(words):
        if SENTENCE_END.search(str(word["text"])):
            ranges.append((start, index + 1))
            start = index + 1
    if start < len(words):
        ranges.append((start, len(words)))
    return ranges


def _score(words: list[dict[str, Any]], style: Style, target: float) -> ScoreBreakdown:
    text = " ".join(str(item["text"]) for item in words)
    normalized = re.findall(r"[\w']+", text.casefold())
    duration = max(.1, float(words[-1]["end"]) - float(words[0]["start"]))
    first = set(normalized[:12])
    hook = min(100, 35 + 10 * len(first & HOOK_WORDS) + (12 if "?" in text[:100] else 0) + (8 if len(first) >= 8 else 0))
    coherence = min(100, 48 + (18 if SENTENCE_END.search(str(words[-1]["text"])) else -18) + min(20, len(words) / 4))
    ending = 78 if SENTENCE_END.search(str(words[-1]["text"])) else 35
    energy = min(100, 35 + 12 * len(set(normalized) & ENERGY_WORDS) + min(20, text.count("!") * 8))
    practical = min(100, 30 + 11 * len(set(normalized) & PRACTICAL_WORDS))
    visual = min(100, 35 + 7 * len(re.findall(r"\b[A-Z][\w'-]+", text)) + min(20, len(set(normalized)) / 3))
    complete = min(100, 42 + (30 if SENTENCE_END.search(str(words[-1]["text"])) else 0) + (15 if words[0]["text"][0:1].isupper() else 0))
    filler = sum(token in {"um", "uh", "like", "basically", "actually"} for token in normalized)
    penalties = min(40, filler * 4 + abs(duration - target) / max(target, 1) * 15)
    values = {"hook": hook, "coherence": coherence, "ending": ending, "energy": energy, "practical": practical, "visual": visual, "complete": complete}
    weights = STYLE_WEIGHTS[style]
    total = sum(values[key] * weights[key] for key in values) / sum(weights.values()) - penalties
    strongest = max(values, key=values.get)
    reason_map = {"hook": "an immediate opening", "coherence": "a coherent thought", "ending": "a clean ending", "energy": "a strong energy signal", "practical": "clear practical value", "visual": "concrete visual potential", "complete": "a complete idea"}
    return ScoreBreakdown(hook=hook, coherence=coherence, ending=ending, energy=energy, practical_value=practical, visual_potential=visual, completeness=complete, penalties=penalties, total=max(0, min(100, total)), explanation=f"Selected for {reason_map[strongest]} with {style} style weighting.")


def candidate_quality(words: list[dict[str, Any]], minimum_speech_density: float = 0.18) -> tuple[bool, str, bool]:
    """Deterministic pre-provider quality gate for transcript candidates."""
    if not words:
        return False, "No speech detected", False
    text = " ".join(str(item.get("text", "")).strip() for item in words).strip()
    tokens = re.findall(r"[\w'-]+", text.casefold())
    if not tokens:
        return False, "Empty transcript", False
    try:
        duration = max(.1, float(words[-1]["end"]) - float(words[0]["start"]))
    except (KeyError, TypeError, ValueError):
        return False, "Invalid transcript timing", False
    density = len(tokens) / duration
    if density < minimum_speech_density:
        return False, "Extremely sparse speech", False
    if set(tokens) & CREDIT_WORDS or any(phrase in text.casefold() for phrase in TITLE_CARD_PHRASES):
        return False, "Likely title card or credit roll", False
    confidence_values = []
    for word in words:
        try:
            value = float(word.get("confidence"))
            if math.isfinite(value):
                confidence_values.append(value)
        except (TypeError, ValueError):
            continue
    average = sum(confidence_values) / len(confidence_values) if confidence_values else None
    review = average is not None and average < .55
    return True, "Low transcript confidence; review recommended" if review else "", review


def select_candidates(words: list[dict[str, Any]], style: Style, count: int, minimum: float, maximum: float) -> list[Candidate]:
    if not words:
        return []
    sentences = _sentence_ranges(words)
    candidates: list[Candidate] = []
    target = (minimum + maximum) / 2
    for sentence_index, (start_index, _) in enumerate(sentences):
        for end_sentence in range(sentence_index, min(len(sentences), sentence_index + 8)):
            end_index = sentences[end_sentence][1]
            segment = words[start_index:end_index]
            duration = float(segment[-1]["end"]) - float(segment[0]["start"])
            if duration < minimum:
                continue
            if duration > maximum:
                break
            eligible, _, _ = candidate_quality(segment)
            if not eligible:
                continue
            candidates.append(Candidate(float(segment[0]["start"]), float(segment[-1]["end"]), segment, _score(segment, style, target)))
            if duration >= target * .85:
                break
    if not candidates:
        chunk_words = max(1, math.ceil(len(words) * min(maximum, float(words[-1]["end"])) / max(float(words[-1]["end"]), 1)))
        for index in range(0, len(words), chunk_words):
            segment = words[index:index + chunk_words]
            if segment:
                eligible, _, _ = candidate_quality(segment)
                if eligible:
                    candidates.append(Candidate(float(segment[0]["start"]), float(segment[-1]["end"]), segment, _score(segment, style, target)))
    candidates.sort(key=lambda item: (-item.score.total, item.start))
    selected: list[Candidate] = []
    for candidate in candidates:
        overlap = any(max(0, min(candidate.end, other.end) - max(candidate.start, other.start)) > min(candidate.end - candidate.start, other.end - other.start) * .35 for other in selected)
        if not overlap:
            selected.append(candidate)
        if len(selected) >= count:
            break
    return sorted(selected, key=lambda item: item.start)


def clip_from_candidate(candidate: Candidate, index: int) -> Clip:
    opening = " ".join(str(item["text"]) for item in candidate.words[:18]).strip()
    eligible, reason, review = candidate_quality(candidate.words)
    confidence_values = [float(item["confidence"]) for item in candidate.words if isinstance(item.get("confidence"), (int, float))]
    confidence = sum(confidence_values) / len(confidence_values) if confidence_values else None
    return Clip(id=f"clip-{index}", index=index, state="queued", start=candidate.start, end=candidate.end, duration=max(.1, candidate.end - candidate.start), opening_line=opening, score=candidate.score, review_required=review, review_reason=reason or None, transcript_excerpt=opening, confidence=confidence)
