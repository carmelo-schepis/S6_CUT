from __future__ import annotations

from engine.selection import group_music_lyric_lines, select_music_candidates


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
    chosen = select_music_candidates(_words(8), "serious", 8, 8, 12)
    assert len({(item.start, item.end) for item in chosen}) == len(chosen)
    assert all(left.end <= right.start for left, right in zip(chosen, chosen[1:]))
