from __future__ import annotations

from types import SimpleNamespace

from engine import selection
from engine.selection import group_music_lyric_lines, select_candidates, select_music_candidates


def _words(line_count: int = 8) -> list[dict[str, object]]:
    words: list[dict[str, object]] = []
    for line in range(line_count):
        start = float(line * 5)
        words.extend([
            {"text": f"Lyric{line}", "start": start, "end": start + 1.5, "confidence": .9},
            {"text": "continues", "start": start + 1.7, "end": start + 3.8, "confidence": .9},
        ])
    return words


def test_music_tokens_group_by_timing_pauses_deterministically() -> None:
    words = _words(4)
    lines = group_music_lyric_lines(words)
    assert len(lines) == 4
    assert [line[0]["text"] for line in lines] == ["Lyric0", "Lyric1", "Lyric2", "Lyric3"]
    assert group_music_lyric_lines(words) == lines


def test_music_clip_candidates_are_bounded_nonoverlapping_and_repeatable() -> None:
    words = _words()
    chosen = select_music_candidates(words, "educational", 3, 8, 12)
    assert len(chosen) == 3
    assert chosen == select_music_candidates(words, "educational", 3, 8, 12)
    assert all(8 <= item.end - item.start <= 12 for item in chosen)
    assert all(left.end <= right.start for left, right in zip(chosen, chosen[1:]))


def test_music_grouping_handles_sparse_no_punctuation_timing() -> None:
    words = [
        {"text": "first", "start": 0.0, "end": 0.5},
        {"text": "light", "start": 0.7, "end": 1.1},
        {"text": "then", "start": 2.2, "end": 2.6},
        {"text": "quiet", "start": 2.8, "end": 3.3},
        {"text": "again", "start": 5.0, "end": 5.5},
        {"text": "slowly", "start": 5.7, "end": 6.2},
        {"text": "last", "start": 8.0, "end": 8.5},
        {"text": "glow", "start": 8.7, "end": 9.2},
    ]
    lines = group_music_lyric_lines(words)
    assert [[word["text"] for word in line] for line in lines] == [["first", "light"], ["then", "quiet"], ["again", "slowly"], ["last", "glow"]]
    chosen = select_music_candidates(words, "serious", 2, 2.5, 7)
    assert len(chosen) == 2
    assert all(2.5 <= item.end - item.start <= 7 for item in chosen)


def test_music_score_does_not_treat_missing_punctuation_as_a_penalty() -> None:
    plain = _words(3)
    punctuated = [dict(word) for word in plain]
    punctuated[-1]["text"] = "continues."
    plain_choice = select_music_candidates(plain, "serious", 1, 8, 12)[0]
    punctuated_choice = select_music_candidates(punctuated, "serious", 1, 8, 12)[0]
    assert plain_choice.score.penalties == punctuated_choice.score.penalties
    assert plain_choice.score.total == punctuated_choice.score.total


def test_music_clip_candidates_do_not_pad_short_sources_or_duplicate_windows() -> None:
    assert select_music_candidates(_words(2), "serious", 1, 10, 12) == []
    assert select_music_candidates([], "serious", 1, 1, 12) == []
    chosen = select_music_candidates(_words(8), "serious", 8, 8, 12)
    assert len({(item.start, item.end) for item in chosen}) == len(chosen)
    assert all(left.end <= right.start for left, right in zip(chosen, chosen[1:]))
    assert all(8 <= item.end - item.start <= 12 for item in chosen)


def test_music_long_instrumental_gap_does_not_satisfy_minimum_content() -> None:
    words = [
        {"text": "first", "start": 0.0, "end": 0.2},
        {"text": "light", "start": 0.3, "end": 0.5},
        {"text": "then", "start": 0.6, "end": 0.8},
        {"text": "quiet", "start": 48.3, "end": 48.5},
    ]
    # 0.8s of vocal intervals and a 47.5s instrumental gap span 48.5s.
    assert select_music_candidates(words, "serious", 1, 20, 60) == []


def test_music_normal_rests_contribute_to_minimum_content() -> None:
    words = [
        {"text": f"word{index}", "start": index * 1.0, "end": index * 1.0 + 0.5}
        for index in range(6)
    ]
    chosen = select_music_candidates(words, "serious", 1, 5, 6)
    assert len(chosen) == 1
    assert 5 <= chosen[0].end - chosen[0].start <= 6


def test_music_punctuation_free_run_can_form_a_bounded_candidate() -> None:
    words = [
        {"text": f"word{index}", "start": index * 0.5, "end": index * 0.5 + 0.4}
        for index in range(12)
    ]
    chosen = select_music_candidates(words, "serious", 1, 4, 6)
    assert len(chosen) == 1
    assert 4 <= chosen[0].end - chosen[0].start <= 6
    assert len(chosen[0].words) > 1


def test_music_invalid_timestamps_are_ignored() -> None:
    words = [
        {"text": "bad", "start": float("nan"), "end": 2.0},
        {"text": "backwards", "start": 3.0, "end": 2.0},
        {"text": "missing", "end": 4.0},
        {"text": "good", "start": 0.0, "end": 0.5},
    ]
    assert select_music_candidates(words, "serious", 1, 1, 5) == []
    assert group_music_lyric_lines(words) == [[words[-1]]]


def test_music_repeated_chorus_selection_is_deterministic() -> None:
    chorus = [
        {"text": text, "start": start, "end": start + 0.4}
        for start, text in zip((0.0, 0.5, 1.0, 10.0, 10.5, 11.0), ("we", "sing", "again", "we", "sing", "again"))
    ]
    first = select_music_candidates(chorus, "serious", 2, 1, 4)
    assert len(first) == 2
    assert first == select_music_candidates(chorus, "serious", 2, 1, 4)


def test_music_candidates_never_return_subsecond_or_under_minimum_windows() -> None:
    words = [
        {"text": "one", "start": 0.0, "end": 0.2},
        {"text": "two", "start": 0.3, "end": 0.5},
        {"text": "three", "start": 0.6, "end": 0.8},
    ]
    assert select_music_candidates(words, "serious", 1, 0, 5) == []
    selected = select_music_candidates(_words(4), "serious", 5, 3, 12)
    assert all(item.end - item.start >= 3 for item in selected)


def test_strict_speech_selection_maximizes_valid_nonoverlapping_count(monkeypatch):
    words = []
    for base, prefix in ((0.0, "first"), (8.0, "second")):
        for index in range(5):
            start = base + index * 1.6
            text = f"{prefix} {index}"
            if index == 4:
                text += "."
            words.append({"text": text, "start": start, "end": start + 0.3})
        words[-1]["end"] = base + 8.0

    monkeypatch.setattr(
        selection, "_score",
        lambda segment, _style, _target: SimpleNamespace(
            total=100.0 if float(segment[-1]["end"]) - float(segment[0]["start"]) > 12 else 20.0
        ),
    )

    selected = select_candidates(words, "serious", 2, 8, 16, strict_bounds=True)

    assert [(item.start, item.end) for item in selected] == [(0.0, 8.0), (8.0, 16.0)]


def test_strict_speech_selection_splits_punctuation_free_runs_into_bounded_clips():
    words = [
        {"text": f"word{index}", "start": index * 0.75, "end": index * 0.75 + 0.25}
        for index in range(40)
    ]

    selected = select_candidates(words, "serious", 3, 8, 10, strict_bounds=True)

    assert len(selected) == 3
    assert all(8 <= item.end - item.start <= 10 for item in selected)
    assert all(left.end <= right.start for left, right in zip(selected, selected[1:]))


def test_strict_speech_selection_does_not_use_short_chunk_fallback():
    words = [{"text": "Only short speech.", "start": 0.0, "end": 4.0}]

    assert select_candidates(words, "serious", 1, 8, 12, strict_bounds=True) == []
