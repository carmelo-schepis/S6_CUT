from __future__ import annotations

from pathlib import Path

import pytest


def _phrase_words(phrase: str, start: float = 0.0) -> list[dict[str, object]]:
    return [
        {"text": token, "start": start + index * 0.3, "end": start + index * 0.3 + 0.25}
        for index, token in enumerate(phrase.split())
    ]


@pytest.mark.parametrize(("phrase", "emoji"), [
    ("that was hilarious", "💀"),
    ("because that makes sense", "🧠"),
    ("nothing can go wrong", "🗿"),
    ("plot twist", "🧍"),
    ("i had no idea what to do", "🧍"),
    ("that backfired", "📉"),
    ("are you serious", "🤨"),
    ("that excuse makes no sense", "🤨"),
    ("we reject your offer", "🪦"),
    ("came back stronger", "🥶"),
])
def test_ironic_reactions_use_only_explicit_table_phrases(phrase: str, emoji: str) -> None:
    from engine.media import _IRONIC_REACTION_PHRASES, select_ironic_reactions

    assert any(emoji == category and phrase in examples for category, examples in _IRONIC_REACTION_PHRASES)
    result = select_ironic_reactions(_phrase_words(phrase), 0, 5)
    assert len(result) == 1
    assert result[0][0] == emoji
    assert result[0][1] == pytest.approx(len(phrase.split()) * 0.3 - 0.2)
    assert result[0][2] - result[0][1] == pytest.approx(1.1)


@pytest.mark.parametrize("phrase", [
    "that was hilariously loud", "because it makes sense", "nothing can", "plot twisty",
    "that excuse is wrong", "we reject", "came back",
])
def test_ironic_selector_rejects_partial_or_unlisted_phrases(phrase: str) -> None:
    from engine.media import select_ironic_reactions

    assert select_ironic_reactions(_phrase_words(phrase), 0, 10) == []


def test_ironic_selector_requires_contiguous_words_and_respects_sentence_breaks() -> None:
    from engine.media import select_ironic_reactions

    words = _phrase_words("that was") + _phrase_words("hilarious", 2.0)
    assert select_ironic_reactions(words, 0, 5) == []
    words = _phrase_words("that was") + _phrase_words("hilarious", 0.6)
    words[1]["text"] = "was."
    assert select_ironic_reactions(words, 0, 5) == []


def test_manual_emoji_suppresses_automatic_match_without_mutating_transcript() -> None:
    from engine.media import select_ironic_reactions

    words = _phrase_words("that was hilarious")
    words[-1]["text"] = "hilarious 💀"
    before = [dict(word) for word in words]
    assert select_ironic_reactions(words, 0, 5) == []
    assert words == before


def test_manual_emoji_suppresses_reaction_when_it_overlaps_the_cue_tail() -> None:
    from engine.media import select_ironic_reactions

    words = [*_phrase_words("that was hilarious"), {"text": "😂", "start": 1.2, "end": 1.3}]
    assert select_ironic_reactions(words, 0, 5) == []


def test_ironic_selector_normalizes_case_punctuation_and_preserves_timing() -> None:
    from engine.media import select_ironic_reactions

    words = [
        {"text": "ARE", "start": 1.0, "end": 1.2, "confidence": 0.9},
        {"text": "you", "start": 1.2, "end": 1.4, "confidence": 0.8},
        {"text": "SERIOUS?!", "start": 1.4, "end": 1.8, "confidence": 0.7},
    ]
    before = [dict(word) for word in words]
    result = select_ironic_reactions(words, 0, 5)
    assert result == [("🤨", pytest.approx(1.65), pytest.approx(2.75))]
    assert words == before


def test_ironic_precedence_prefers_earliest_phrase_over_later_overlapping_match() -> None:
    from engine.media import select_ironic_reactions

    words = [
        *_phrase_words("that was hilarious", 0),
        *_phrase_words("are you serious", 0.6),
    ]
    result = select_ironic_reactions(words, 0, 5)
    assert [emoji for emoji, *_ in result] == ["💀"]


def test_ironic_precedence_prefers_longest_phrase_at_same_start(monkeypatch) -> None:
    import engine.media as media

    monkeypatch.setattr(media, "_IRONIC_REACTION_PHRASES", (
        ("💀", ("we reject",)),
        ("🪦", ("we reject your",)),
    ))
    result = media.select_ironic_reactions(_phrase_words("we reject your"), 0, 5)
    assert [emoji for emoji, *_ in result] == ["🪦"]


def test_ironic_selector_applies_cooldown_and_keeps_later_eligible_phrase() -> None:
    from engine.media import select_ironic_reactions

    words = [
        *_phrase_words("that was hilarious", 0),
        *_phrase_words("are you serious", 3),
        *_phrase_words("because that makes sense", 7),
    ]
    result = select_ironic_reactions(words, 0, 12)
    assert [emoji for emoji, *_ in result] == ["💀", "🧠"]
    assert result[1][1] - result[0][1] >= 5
    assert result == select_ironic_reactions(words, 0, 12)


def test_ironic_reaction_cues_clip_to_requested_interval_and_use_local_times() -> None:
    from engine.media import select_ironic_reactions

    before = _phrase_words("are you serious", 9.2)
    assert select_ironic_reactions(before, 10, 5) == [("🤨", 0.0, 1.1)]
    after = _phrase_words("we reject your offer", 9.7)
    assert select_ironic_reactions(after, 10, 1.5) == [("🪦", pytest.approx(0.7), 1.5)]
    assert select_ironic_reactions(after, 10, 0) == []
    assert select_ironic_reactions(after, float("nan"), 5) == []


@pytest.mark.parametrize(("style", "expected"), [
    ("funny", ["💀", "🗿", "🧠", "🧍"]),
    ("hype", ["🥶", "💀", "🗿", "🥶"]),
])
def test_clip_reactions_fill_ordinary_speech_every_three_point_five_seconds(style: str, expected: list[str]) -> None:
    from engine.media import select_ironic_reactions

    words = [
        {"text": f"ordinary{index}", "start": index * .5, "end": index * .5 + .4}
        for index in range(24)
    ]
    result = select_ironic_reactions(words, 0, 12, style=style)

    assert [emoji for emoji, *_ in result] == expected
    assert [start for _, start, _ in result] == pytest.approx([0, 3.5, 7, 10.5])
    assert [end - start for _, start, end in result] == pytest.approx([1.1] * 4)


def test_hype_cadence_uses_available_match_outside_its_fallback_cycle() -> None:
    from engine.media import select_ironic_reactions

    result = select_ironic_reactions(_phrase_words("that backfired"), 0, 5, style="hype")

    assert [emoji for emoji, *_ in result] == ["📉"]


def test_funny_cadence_prefers_matching_reaction_and_avoids_manual_emoji_overlap() -> None:
    from engine.media import select_ironic_reactions

    words = [
        {"text": "🔥", "start": 0, "end": .8},
        {"text": "ordinary", "start": .2, "end": .4},
        {"text": "speech", "start": .8, "end": 1.2},
        {"text": "plot", "start": 4, "end": 4.2},
        {"text": "twist", "start": 4.25, "end": 4.45},
    ]

    result = select_ironic_reactions(words, 0, 8, style="funny")

    assert [emoji for emoji, *_ in result] == ["💀", "🧍"]
    assert [start for _, start, _ in result] == pytest.approx([.8, 4.3])
    assert [end for _, _, end in result] == pytest.approx([1.9, 5.4])


def test_ironic_reaction_assets_are_bundled_and_available_offline() -> None:
    from engine.media import _IRONIC_REACTION_ASSETS, _IRONIC_REACTION_PHRASES

    assert set(_IRONIC_REACTION_ASSETS) == {emoji for emoji, _ in _IRONIC_REACTION_PHRASES}
    for path in _IRONIC_REACTION_ASSETS.values():
        assert path is not None and path.is_file()
        assert path.read_bytes().startswith(b"\x89PNG\r\n\x1a\n")


def test_policy_plan_is_independent_of_caption_layout_and_music_theme() -> None:
    from engine.media import _caption_emoji_plan

    words = _phrase_words("are you serious")
    plan = _caption_emoji_plan(
        words, 1080, 1920, 5, offset=0, style="educational", presentation=None,
        music_theme=None, reaction_policy="ironic_v1", source_profile="speech",
    )
    assert len(plan) == 1
    assert plan[0][0].name == "emoji-37.png"
    themed_plan = _caption_emoji_plan(
        words, 1080, 1920, 5, offset=0, style="educational", presentation="smart_speech_v1",
        music_theme="clean", reaction_policy="ironic_v1", source_profile="speech",
    )
    assert [entry[0] for entry in themed_plan] == [plan[0][0]]


def test_music_source_profile_suppresses_reactions_without_music_theme() -> None:
    from engine.media import _caption_emoji_plan

    assert _caption_emoji_plan(
        _phrase_words("are you serious"), 1080, 1920, 5, offset=0, style="educational",
        presentation=None, music_theme=None, reaction_policy="ironic_v1", source_profile="music",
    ) == []


def test_subtitles_disabled_has_no_timed_reaction_overlay(tmp_path, monkeypatch) -> None:
    from types import SimpleNamespace

    import engine.media as media

    source = tmp_path / "source.mp4"
    source.write_bytes(b"fixture")
    overlays = []
    monkeypatch.setattr(media, "probe", lambda path, *_args, **_kwargs: {
        "width": 1920 if path == source else 1080, "height": 1080 if path == source else 1920,
        "rotation": 0, "audio": True, "sample_aspect_ratio": 1.0,
    })
    monkeypatch.setattr(media, "_overlay_inputs", lambda _command, items: overlays.extend(items))
    monkeypatch.setattr(media, "_subscribe_animation_inputs", lambda *_args: [])
    monkeypatch.setattr(media, "_filters", lambda *_args: ("base-filter", "base"))
    monkeypatch.setattr(media, "run", lambda command, **_kwargs: Path(command[-1]).write_bytes(b"rendered"))

    media.render_clip(
        source, tmp_path / "off.mp4", start=0, end=5, aspect="9:16",
        words=_phrase_words("are you serious"), visuals=[], overlays=[],
        settings=SimpleNamespace(ffmpeg="ffmpeg"), reaction_policy="ironic_v1",
        subtitles_enabled=False,
    )
    assert overlays == []
    burn_ass = (tmp_path / "off.burn.ass").read_text(encoding="utf-8")
    assert not any(line.startswith("Dialogue: 10,") for line in burn_ass.splitlines())


@pytest.mark.parametrize(("width", "height"), [(1080, 1920), (1080, 1350), (1080, 1080), (1920, 1080)])
def test_reaction_overlay_position_is_inside_supported_canvas(width: int, height: int) -> None:
    from engine.media import _caption_emoji_plan

    plan = _caption_emoji_plan(
        _phrase_words("are you serious"), width, height, 5, offset=0, style="educational",
        presentation=None, music_theme=None, reaction_policy="ironic_v1", source_profile="speech",
    )
    assert len(plan) == 1
    _, start, end, x, y, size = plan[0]
    assert 0 <= x and x + size <= width
    assert 0 <= y and y + size <= height
    assert 0 <= start < end <= 5
