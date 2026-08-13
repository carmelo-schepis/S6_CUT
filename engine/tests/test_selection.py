from __future__ import annotations

from engine.selection import select_candidates


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


def test_style_weights_change_auditable_ranking() -> None:
    words = fixture_words()
    educational = select_candidates(words, "educational", 1, 8, 24)[0]
    hype = select_candidates(words, "hype", 1, 8, 24)[0]
    assert educational.score.explanation.endswith("educational style weighting.")
    assert hype.score.explanation.endswith("hype style weighting.")
    assert educational.score.total != hype.score.total
