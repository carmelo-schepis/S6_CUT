from __future__ import annotations

import pytest

from engine.jobs import _music_transcription_duration


@pytest.mark.parametrize(
    ("video_duration", "has_selected_track", "maximum_duration", "expected"),
    [
        (120.0, True, 28_800.0, 150.0),
        (120.0, False, 28_800.0, 120.0),
        (28_790.0, True, 28_800.0, 28_800.0),
        (28_800.0, True, 28_800.0, 28_800.0),
        (0.0, True, 28_800.0, 30.0),
    ],
)
def test_music_transcription_adds_only_bounded_song_context(
    video_duration: float, has_selected_track: bool, maximum_duration: float, expected: float,
) -> None:
    assert _music_transcription_duration(video_duration, has_selected_track, maximum_duration) == expected


def test_music_transcription_duration_never_shortens_visual_timeline() -> None:
    assert _music_transcription_duration(28_900.0, True, 28_800.0) == 28_900.0
