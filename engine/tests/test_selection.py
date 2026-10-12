from __future__ import annotations

from engine.selection import _score, _score_music, select_candidates


def fixture_words() -> list[dict[str, object]]:
    words: list[dict[str, object]] = []
    vocabulary = ["Here", "is", "why", "this", "method", "works", "because", "each", "step", "is", "clear"]
    for index in range(220):
        text = vocabulary[index % len(vocabulary)]
        if index % 22 == 21:
            text += "."
        words.append({"text": text, "start": index * .46, "end": index * .46 + .4})
    return words


def test_candidates_are_deterministic_complete_and_non_overlapping() -> None:
    words = fixture_words()
    first = select_candidates(words, "educational", 4, 8, 24)
    second = select_candidates(words, "educational", 4, 8, 24)
    assert [(item.start, item.end, item.score.total) for item in first] == [(item.start, item.end, item.score.total) for item in second]
    assert first
    assert all(item.words[-1]["text"].endswith(".") for item in first)
    assert all(8 <= item.end - item.start <= 24 for item in first)
    for left, right in zip(first, first[1:]):
        assert left.end <= right.start


def test_score_penalties_are_itemized_without_changing_totals() -> None:
    words = [
        {"text": "Um", "start": 0.0, "end": 0.5},
        {"text": "like", "start": 0.5, "end": 1.0},
        {"text": "hello.", "start": 1.0, "end": 2.5},
    ]
    scored = _score(words, "serious", 4)
    assert scored.penalties == min(40, 2 * 4 + abs(2.5 - 4) / max(4, 1) * 15)
    assert [item.kind for item in scored.penalty_items or []] == ["filler_words", "length_off_target"]
    filler, length = scored.penalty_items or []
    assert filler.points == 8
    assert filler.filler_word_counts == {"um": 1, "like": 1}
    assert filler.points_per_word == 4
    assert length.points == abs(2.5 - 4) / max(4, 1) * 15
    assert length.speech_seconds == 2.5
    assert length.target_seconds == 4

    music_scored = _score_music(words, "serious", 4)
    assert music_scored.penalties == min(40, 2 * 3 + abs(2.5 - 4) / max(4, 1) * 15)
    assert music_scored.penalty_items[0].points_per_word == 3


def test_style_weights_change_auditable_ranking() -> None:
    words = fixture_words()
    educational = select_candidates(words, "educational", 1, 8, 24)[0]
    hype = select_candidates(words, "hype", 1, 8, 24)[0]
    assert educational.score.explanation.endswith("educational style weighting.")
    assert hype.score.explanation.endswith("hype style weighting.")
    assert educational.score.total != hype.score.total


def test_short_source_fallback_returns_candidate_below_requested_minimum() -> None:
    """A source whose entire speech track is shorter than the requested minimum
    still yields a candidate: the no-candidate fallback chunks the transcript
    without the duration filter. Callers must therefore warn rather than let the
    cut read as if it satisfied the requested range (see JobManager._process)."""
    words = [
        {"text": "Welcome", "start": 0.0, "end": 0.4, "confidence": 0.9},
        {"text": "back.", "start": 0.4, "end": 0.96, "confidence": 0.9},
        {"text": "My", "start": 1.18, "end": 1.32, "confidence": 0.9},
        {"text": "guest", "start": 1.32, "end": 1.52, "confidence": 0.9},
        {"text": "tonight", "start": 1.52, "end": 1.9, "confidence": 0.9},
        {"text": "is", "start": 1.9, "end": 2.1, "confidence": 0.9},
        {"text": "the", "start": 2.1, "end": 2.3, "confidence": 0.9},
        {"text": "spokeswoman", "start": 2.3, "end": 3.1, "confidence": 0.9},
        {"text": "for", "start": 3.1, "end": 3.3, "confidence": 0.9},
        {"text": "the", "start": 3.3, "end": 3.5, "confidence": 0.9},
        {"text": "department.", "start": 3.5, "end": 5.48, "confidence": 0.9},
    ]
    picked = select_candidates(words, "serious", 2, 20, 60)
    assert picked, "the fallback must still offer the only available moment"
    assert picked[0].end - picked[0].start < 20
