from __future__ import annotations

import math
import re
from bisect import bisect_right
from dataclasses import dataclass
from typing import Any

from .models import Clip, PenaltyItem, ScoreBreakdown, Style


SENTENCE_END = re.compile(r"[.!?][\"')\]]*$")
FILLER_WORDS = ("um", "uh", "like", "basically", "actually")
HOOK_WORDS = {"why", "how", "secret", "never", "best", "worst", "truth", "imagine", "mistake", "here's", "what"}
PRACTICAL_WORDS = {"step", "first", "second", "because", "means", "example", "learn", "use", "tip", "method"}
ENERGY_WORDS = {"amazing", "incredible", "crazy", "shocking", "love", "hate", "wow", "huge", "always", "never"}
CREDIT_WORDS = {"credits", "credit", "cast", "starring", "directed", "written", "copyright", "produced", "end", "fin"}
TITLE_CARD_PHRASES = ("previously on", "coming soon", "the end", "a film by", "presented by")
MUSIC_GAP_CREDIT_SECONDS = 0.85

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


def _penalties(normalized: list[str], duration: float, target: float, points_per_filler: int) -> tuple[float, list[PenaltyItem]]:
    filler_word_counts: dict[str, int] = {}
    for token in normalized:
        if token in FILLER_WORDS:
            filler_word_counts[token] = filler_word_counts.get(token, 0) + 1
    filler = sum(filler_word_counts.values())
    filler_points = filler * points_per_filler
    length_points = abs(duration - target) / max(target, 1) * 15
    return min(40, filler_points + length_points), [
        PenaltyItem(kind="filler_words", points=filler_points, filler_word_counts=filler_word_counts, points_per_word=points_per_filler),
        PenaltyItem(kind="length_off_target", points=length_points, speech_seconds=duration, target_seconds=target),
    ]


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
    penalties, penalty_items = _penalties(normalized, duration, target, 4)
    values = {"hook": hook, "coherence": coherence, "ending": ending, "energy": energy, "practical": practical, "visual": visual, "complete": complete}
    weights = STYLE_WEIGHTS[style]
    total = sum(values[key] * weights[key] for key in values) / sum(weights.values()) - penalties
    strongest = max(values, key=values.get)
    reason_map = {"hook": "an immediate opening", "coherence": "a coherent thought", "ending": "a clean ending", "energy": "a strong energy signal", "practical": "clear practical value", "visual": "concrete visual potential", "complete": "a complete idea"}
    return ScoreBreakdown(hook=hook, coherence=coherence, ending=ending, energy=energy, practical_value=practical, visual_potential=visual, completeness=complete, penalties=penalties, penalty_items=penalty_items, total=max(0, min(100, total)), explanation=f"Selected for {reason_map[strongest]} with {style} style weighting.")


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


def select_candidates(words: list[dict[str, Any]], style: Style, count: int, minimum: float, maximum: float, *, strict_bounds: bool = False) -> list[Candidate]:
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
    if strict_bounds:
        for start_index, end_index in sentences:
            sentence = words[start_index:end_index]
            if float(sentence[-1]["end"]) - float(sentence[0]["start"]) <= maximum:
                continue
            offset = start_index
            while offset < end_index:
                end = offset + 1
                while end < end_index:
                    duration = float(words[end]["end"]) - float(words[offset]["start"])
                    if duration > maximum:
                        break
                    end += 1
                    if duration >= minimum:
                        break
                segment = words[offset:end]
                duration = float(segment[-1]["end"]) - float(segment[0]["start"])
                if minimum <= duration <= maximum:
                    eligible, _, _ = candidate_quality(segment)
                    if eligible:
                        candidates.append(Candidate(float(segment[0]["start"]), float(segment[-1]["end"]), segment, _score(segment, style, target)))
                offset = end
    if not candidates and not strict_bounds:
        chunk_words = max(1, math.ceil(len(words) * min(maximum, float(words[-1]["end"])) / max(float(words[-1]["end"]), 1)))
        for index in range(0, len(words), chunk_words):
            segment = words[index:index + chunk_words]
            if segment:
                eligible, _, _ = candidate_quality(segment)
                if eligible:
                    candidates.append(Candidate(float(segment[0]["start"]), float(segment[-1]["end"]), segment, _score(segment, style, target)))
    if strict_bounds:
        candidates = [
            item for item in candidates
            if minimum - 1e-6 <= item.end - item.start <= maximum + 1e-6
        ]
        return _select_non_overlapping_candidates(candidates, count)
    candidates.sort(key=lambda item: (-item.score.total, item.start))
    selected: list[Candidate] = []
    for candidate in candidates:
        overlap = any(max(0, min(candidate.end, other.end) - max(candidate.start, other.start)) > min(candidate.end - candidate.start, other.end - other.start) * .35 for other in selected)
        if not overlap:
            selected.append(candidate)
        if len(selected) >= count:
            break
    return sorted(selected, key=lambda item: item.start)


def _timed_words(words: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return usable words in timestamp order without changing the transcript objects."""
    timed: list[tuple[float, float, int, dict[str, Any]]] = []
    for index, word in enumerate(words):
        try:
            start = float(word["start"])
            end = float(word["end"])
        except (KeyError, TypeError, ValueError):
            continue
        if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start:
            continue
        if not str(word.get("text", "")).strip():
            continue
        timed.append((start, end, index, word))
    return [word for _, _, _, word in sorted(timed)]


def group_music_lyric_lines(words: list[dict[str, Any]], *, pause_seconds: float = 0.85) -> list[list[dict[str, Any]]]:
    """Group lyric words at deterministic timing pauses.

    Punctuation is deliberately only a secondary boundary.  Whisper's lyric
    punctuation is often absent or inconsistent; the elapsed time between word
    timestamps is the reliable signal, including during sparse vocal passages
    and instrumental breaks.
    """
    if pause_seconds < 0:
        raise ValueError("pause_seconds must be non-negative")
    lines: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    for word in _timed_words(words):
        if not current:
            current.append(word)
            continue
        gap = float(word["start"]) - float(current[-1]["end"])
        previous = str(current[-1]["text"])
        if gap >= pause_seconds or SENTENCE_END.search(previous):
            lines.append(current)
            current = []
        current.append(word)
    if current:
        lines.append(current)
    return lines


def _score_music(words: list[dict[str, Any]], style: Style, target: float) -> ScoreBreakdown:
    """Score lyric windows without treating prose punctuation as completeness."""
    text = " ".join(str(item["text"]) for item in words)
    normalized = re.findall(r"[\w']+", text.casefold())
    duration = max(.1, float(words[-1]["end"]) - float(words[0]["start"]))
    unique = set(normalized)
    first = set(normalized[:12])
    gaps = [
        float(right["start"]) - float(left["end"])
        for left, right in zip(words, words[1:])
    ]
    line_breaks = sum(gap >= .85 for gap in gaps)
    hook = min(100, 42 + 9 * len(first & HOOK_WORDS) + min(14, len(first)))
    coherence = min(100, 55 + min(25, len(words) / 2) + min(15, line_breaks * 5))
    # A lyric line does not need a full stop.  Keep these neutral rather than
    # applying the speech scorer's sentence-ending penalty.
    ending = 68
    complete = 68
    energy = min(100, 38 + 12 * len(unique & ENERGY_WORDS))
    practical = min(100, 35 + 8 * len(unique & PRACTICAL_WORDS))
    visual = min(100, 38 + min(25, len(unique) / 2))
    penalties, penalty_items = _penalties(normalized, duration, target, 3)
    values = {"hook": hook, "coherence": coherence, "ending": ending, "energy": energy, "practical": practical, "visual": visual, "complete": complete}
    weights = STYLE_WEIGHTS[style]
    total = sum(values[key] * weights[key] for key in values) / sum(weights.values()) - penalties
    strongest = max(values, key=values.get)
    reason_map = {"hook": "an immediate lyric opening", "coherence": "continuous lyric timing", "ending": "a natural musical ending", "energy": "a strong lyric energy signal", "practical": "clear lyrical content", "visual": "concrete visual potential", "complete": "a complete lyric passage"}
    return ScoreBreakdown(hook=hook, coherence=coherence, ending=ending, energy=energy, practical_value=practical, visual_potential=visual, completeness=complete, penalties=penalties, penalty_items=penalty_items, total=max(0, min(100, total)), explanation=f"Selected for {reason_map[strongest]} with music {style} weighting.")


def _music_units(lines: list[list[dict[str, Any]]], maximum: float) -> list[list[dict[str, Any]]]:
    """Keep lyric lines intact, splitting only an overlong punctuation-free run."""
    units: list[list[dict[str, Any]]] = []
    for line in lines:
        duration = float(line[-1]["end"]) - float(line[0]["start"])
        if duration <= maximum:
            units.append(line)
        else:
            # Without punctuation or a pause, word boundaries are the only
            # honest fallback.  This still never invents silence or padding.
            units.extend([word] for word in line)
    return units


def _better_interval_selection(left: tuple[Candidate, ...] | None, right: tuple[Candidate, ...] | None) -> tuple[Candidate, ...] | None:
    if left is None:
        return right
    if right is None:
        return left
    left_score = sum(item.score.total for item in left)
    right_score = sum(item.score.total for item in right)
    if len(left) != len(right):
        return left if len(left) > len(right) else right
    if not math.isclose(left_score, right_score):
        return left if left_score > right_score else right
    left_signature = tuple((item.start, item.end) for item in left)
    right_signature = tuple((item.start, item.end) for item in right)
    return left if left_signature <= right_signature else right


def _select_non_overlapping_candidates(candidates: list[Candidate], count: int) -> list[Candidate]:
    if count <= 0 or not candidates:
        return []
    ordered = sorted(candidates, key=lambda item: (item.end, item.start, -item.score.total))
    ends = [item.end for item in ordered]
    states: list[dict[int, tuple[Candidate, ...]]] = [{0: ()}]
    for index, candidate in enumerate(ordered, start=1):
        previous = states[index - 1].copy()
        compatible = bisect_right(ends, candidate.start, 0, index - 1)
        for size, selection in states[compatible].items():
            if size < count:
                option = selection + (candidate,)
                previous[size + 1] = _better_interval_selection(previous.get(size + 1), option) or option
        states.append(previous)
    selected = states[-1].get(min(count, max(states[-1], default=0)), ())
    return sorted(selected, key=lambda item: (item.start, item.end))


def _music_content_duration(words: list[dict[str, Any]]):
    """Credit vocal intervals fully and each musical rest up to 0.85 seconds."""
    content = 0.0
    previous_end: float | None = None
    for word in words:
        start = float(word["start"])
        end = float(word["end"])
        if previous_end is not None:
            content += min(max(0.0, start - previous_end), MUSIC_GAP_CREDIT_SECONDS)
        content += max(0.0, end - max(start, previous_end or start))
        previous_end = max(end, previous_end or end)
    return content


def select_music_candidates(words: list[dict[str, Any]], style: Style, count: int, minimum: float, maximum: float) -> list[Candidate]:
    """Select distinct lyric windows meeting bounded vocal coverage and output bounds."""
    if count <= 0 or minimum < 0 or maximum < minimum or maximum < 1.0:
        return []
    lines = _music_units(group_music_lyric_lines(words), maximum)
    if not lines:
        return []
    target = (minimum + maximum) / 2
    candidates: list[Candidate] = []
    seen: set[tuple[float, float]] = set()
    for start_index in range(len(lines)):
        segment: list[dict[str, Any]] = []
        for line in lines[start_index:]:
            segment.extend(line)
            duration = float(segment[-1]["end"]) - float(segment[0]["start"])
            if duration > maximum:
                break
            if duration >= max(minimum, 1.0) and _music_content_duration(segment) >= minimum:
                key = (float(segment[0]["start"]), float(segment[-1]["end"]))
                if key not in seen:
                    seen.add(key)
                    candidates.append(Candidate(float(segment[0]["start"]), float(segment[-1]["end"]), list(segment), _score_music(segment, style, target)))
    if not candidates:
        return []

    # Maximise usable clips first, then their deterministic score.
    return _select_non_overlapping_candidates(candidates, count)


def clip_from_candidate(candidate: Candidate, index: int) -> Clip:
    opening = " ".join(str(item["text"]) for item in candidate.words[:18]).strip()
    eligible, reason, review = candidate_quality(candidate.words)
    confidence_values = [float(item["confidence"]) for item in candidate.words if isinstance(item.get("confidence"), (int, float))]
    confidence = sum(confidence_values) / len(confidence_values) if confidence_values else None
    return Clip(id=f"clip-{index}", index=index, state="queued", start=candidate.start, end=candidate.end, duration=max(.1, candidate.end - candidate.start), opening_line=opening, score=candidate.score, review_required=review, review_reason=reason or None, transcript_excerpt=opening, confidence=confidence)
