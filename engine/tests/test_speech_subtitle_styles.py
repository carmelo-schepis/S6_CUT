from __future__ import annotations

import re
from pathlib import Path

import pytest

from engine.media import write_ass, write_caption_sidecars


STYLES = ("hype", "funny", "educational", "serious")
_CANVASES = ((1080, 1920), (1080, 1350), (1080, 1080), (1920, 1080))


def _word(text: str, start: float, end: float) -> dict[str, object]:
    return {"text": text, "start": start, "end": end}


def _ass(path: Path, words: list[dict[str, object]], *, style: str = "educational", presentation: str | None = "smart_speech_v2", offset: float = 0, duration: float = 20, width: int = 1080, height: int = 1920) -> str:
    write_ass(
        path, words, offset=offset, duration=duration, visuals=[], width=width, height=height,
        style=style, presentation=presentation, content_format="short",
    )
    return path.read_text(encoding="utf-8")


def _caption_style(ass: str) -> dict[str, str]:
    fields = (
        "Name", "Fontname", "Fontsize", "PrimaryColour", "SecondaryColour", "OutlineColour",
        "BackColour", "Bold", "Italic", "Underline", "StrikeOut", "ScaleX", "ScaleY", "Spacing",
        "Angle", "BorderStyle", "Outline", "Shadow", "Alignment", "MarginL", "MarginR", "MarginV", "Encoding",
    )
    line = next(line for line in ass.splitlines() if line.startswith("Style: Caption,"))
    return dict(zip(fields, line.removeprefix("Style: ").split(",")))


def _caption_events(ass: str) -> list[str]:
    return [line for line in ass.splitlines() if line.startswith("Dialogue: 10,")]


def _event_text(event: str) -> str:
    return re.sub(r"\{[^}]*\}", "", event.split(",", 9)[-1]).replace(r"\N", " ")


def test_smart_speech_keeps_style_presets_distinct_and_hype_geometry(tmp_path: Path) -> None:
    rendered = {}
    for style in STYLES:
        rendered[style] = _ass(tmp_path / f"{style}.ass", [_word("One", 0, .3), _word("two", .3, .6)], style=style)

    signatures = {
        style: tuple(_caption_style(ass)[key] for key in ("Fontname", "PrimaryColour", "OutlineColour", "Bold", "Italic", "Spacing"))
        for style, ass in rendered.items()
    }
    assert len(set(signatures.values())) == len(STYLES)
    sizes = {style: int(_caption_style(ass)["Fontsize"]) for style, ass in rendered.items()}
    assert sizes == {"hype": 104, "funny": 86, "educational": 68, "serious": 60}

    legacy = _ass(
        tmp_path / "legacy-hype.ass", [_word("One", 0, .3)], style="hype", presentation="smart_speech_v1",
    )
    smart_hype = _caption_style(rendered["hype"])
    legacy_hype = _caption_style(legacy)
    for field in ("Fontname", "Fontsize", "MarginL", "MarginR", "MarginV"):
        assert smart_hype[field] == legacy_hype[field], f"Hype {field} changed in Smart Speech"
    assert smart_hype["Fontsize"] == "104"
    assert _event_text(_caption_events(rendered["hype"])[0]) == "One two"
    assert r"\pos(540,1037)" in _caption_events(rendered["hype"])[0]


@pytest.mark.parametrize("style", ("hype", "funny", "educational"))
def test_smart_speech_yellow_emphasis_moves_one_word_at_a_time(tmp_path: Path, style: str) -> None:
    words = [_word("First", 0, .3), _word("repeat", .3, .6), _word("repeat!", .6, .9)]
    events = _caption_events(_ass(tmp_path / f"{style}.ass", words, style=style))
    assert len(events) == len(words)
    yellow = r"{\c&H0000D7FF&}"
    for event, word in zip(events, words):
        assert _event_text(event) == "First repeat repeat!"
        assert event.count(yellow) == 1
        active = event.split(yellow, 1)[1].split(r"{\c", 1)[0]
        assert active == word["text"]


def test_smart_speech_serious_has_no_moving_word_emphasis(tmp_path: Path) -> None:
    ass = _ass(
        tmp_path / "serious.ass",
        [_word("Measured", 0, .3), _word("words", .3, .6), _word("here.", .6, .9)],
        style="serious",
    )
    events = _caption_events(ass)
    assert len(events) == 1
    assert all(r"{\c" not in event for event in events)
    assert [_event_text(event) for event in events] == ["Measured words here."]
    assert events[0].split(",", 3)[1:3] == ["0:00:00.00", "0:00:00.90"]


def test_serious_phrase_events_cover_every_transcript_word_exactly_once(tmp_path: Path) -> None:
    transcript = "This local smart project keeps working when an optional provider fails because deterministic planning uses the transcript to select a coherent short and continue rendering the finished video".split()
    words = [_word(text, index * .3, index * .3 + .24) for index, text in enumerate(transcript)]
    events = _caption_events(_ass(tmp_path / "serious-long.ass", words, style="serious", duration=20))
    rendered = " ".join(_event_text(event) for event in events).split()
    assert rendered == transcript
    assert events[0].split(",", 3)[1] == "0:00:00.00"
    assert events[-1].split(",", 3)[2] == "0:00:08.34"


def test_smart_speech_timing_offset_punctuation_repeats_pauses_and_sidecars(tmp_path: Path) -> None:
    words = [
        _word("Again,", 9.8, 10.2), _word("again", 10.25, 10.6),
        _word("wait...", 11.4, 11.9), _word("again!", 12, 12.35),
    ]
    ass = _ass(tmp_path / "timed.ass", words, offset=10, duration=3)
    events = _caption_events(ass)
    assert len(events) == 4
    assert [(line.split(",", 3)[1], line.split(",", 3)[2]) for line in events] == [
        ("0:00:00.00", "0:00:00.20"), ("0:00:00.25", "0:00:00.60"),
        ("0:00:01.40", "0:00:01.90"), ("0:00:02.00", "0:00:02.35"),
    ]
    assert [_event_text(line) for line in events] == ["Again,", "again", "wait...", "again!"]

    sidecar_path = tmp_path / "transcript.mp4"
    write_caption_sidecars(sidecar_path, words, offset=10, duration=3, presentation="smart_speech_v2")
    sidecar = sidecar_path.with_suffix(".srt").read_text(encoding="utf-8")
    assert [line for line in sidecar.splitlines() if line and not line[0].isdigit()] == ["Again,", "again", "wait...", "again!"]
    assert "00:00:00,000 --> 00:00:00,200" in sidecar
    assert "00:00:01,400 --> 00:00:01,900" in sidecar


def test_smart_speech_wrap_keeps_transcript_words_and_aspect_playres(tmp_path: Path) -> None:
    words = [_word(text, index * .25, index * .25 + .2) for index, text in enumerate(
        ("OpenRouter", "keeps", "extraordinarylongwords", "whole", "and", "keeps", "repeats.")
    )]
    for width, height in _CANVASES:
        ass = _ass(
            tmp_path / f"{width}x{height}.ass", words, width=width, height=height,
        )
        assert f"PlayResX: {width}" in ass and f"PlayResY: {height}" in ass
        events = _caption_events(ass)
        assert events
        assert all(event.count(r"\N") <= 1 for event in events)
        visible_words = " ".join(_event_text(event) for event in events).split()
        for word in words:
            assert visible_words.count(str(word["text"])) >= 1
        assert "extraordinarylongwords" in " ".join(_event_text(event) for event in events)


def test_legacy_presentation_remains_byte_identical_to_default(tmp_path: Path) -> None:
    words = [_word("Keep", 0, .3), _word("legacy", .3, .6), _word("look.", .6, .9)]
    default = _ass(tmp_path / "default.ass", words, style="funny", presentation=None)
    legacy = _ass(tmp_path / "legacy.ass", words, style="funny", presentation="legacy")
    assert default == legacy
