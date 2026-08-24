from __future__ import annotations

from pathlib import Path

from engine.media import _ass_style_metrics, _wrap_caption_words, write_ass


def _word(text: str, start: float = 0.0, end: float = 1.0) -> dict[str, object]:
    return {"text": text, "start": start, "end": end}


def _words(*texts: str) -> list[dict[str, object]]:
    return [_word(text, start=index * 1.0, end=index * 1.0 + 1.0) for index, text in enumerate(texts)]


def _parse_styles(ass: str) -> dict[str, dict[str, str]]:
    styles: dict[str, dict[str, str]] = {}
    for line in ass.splitlines():
        if not line.startswith("Style: "):
            continue
        fields = line[len("Style: "):].split(",")
        styles[fields[0]] = {name: value for name, value in zip(_STYLE_FIELDS, fields)}
    return styles


_STYLE_FIELDS = [
    "Name", "Fontname", "Fontsize", "PrimaryColour", "SecondaryColour", "OutlineColour",
    "BackColour", "Bold", "Italic", "Underline", "StrikeOut", "ScaleX", "ScaleY", "Spacing",
    "Angle", "BorderStyle", "Outline", "Shadow", "Alignment", "MarginL", "MarginR", "MarginV", "Encoding",
]


def _caption_events(ass: str) -> list[str]:
    events: list[str] = []
    for line in ass.splitlines():
        if line.startswith("Dialogue: 10,"):
            events.append(line)
    return events


def _write(tmp: Path, words: list[dict[str, object]], *, width: int = 1080, height: int = 1920) -> str:
    path = tmp / "test.ass"
    write_ass(path, words, offset=0, duration=30.0, visuals=[], width=width, height=height)
    return path.read_text(encoding="utf-8")


def test_short_subtitle_is_single_centred_line(tmp_path: Path) -> None:
    ass = _write(tmp_path, _words("Hi", "there", "S6"))
    events = _caption_events(ass)
    assert len(events) == 3  # one event per word, highlighting moves word by word
    assert all(",Caption,,0,0,0,," in event for event in events)
    assert all("\\N" not in event for event in events)  # short caption stays on one line
    # The style is bottom-centre (Alignment=2) with symmetric safe margins.
    style = _parse_styles(ass)["Caption"]
    assert style["Alignment"] == "2"
    assert style["MarginL"] == style["MarginR"]


def test_long_subtitle_wraps_without_splitting_words(tmp_path: Path) -> None:
    words = _words(
        "Connect", "OpenRouter", "for", "enhanced", "planning",
        "and", "ElevenLabs", "for", "premium", "narration",
    )
    ass = _write(tmp_path, words)
    events = _caption_events(ass)
    # Every event must be short enough to fit the safe subtitle area, and
    # word breaks may only happen at natural word boundaries.
    metrics = _ass_style_metrics(1080, 1920)
    max_chars = max(8, int((1080 - 2 * metrics["margin_x"]) * 0.85 / (0.55 * metrics["fontsize"])))
    for event in events:
        text = event.split(",,")[-1]
        for line in text.split(r"\N"):
            visible = line.replace(r"{\c&H0077D6FF&}", "").replace(r"{\c&H00F1F2F4&}", "")
            assert len(visible) <= max_chars, f"line too long: {visible!r} ({len(visible)} > {max_chars})"
            assert not visible.startswith(" ") and not visible.endswith(" ")
            # Words themselves are never split across lines.
            assert all(part.strip() for part in visible.split())
    # At least one caption wraps to a second line.
    assert any(r"\N" in event for event in events)


def test_caption_blocks_never_exceed_two_lines(tmp_path: Path) -> None:
    words = _words(*(["longword"] * 30))
    ass = _write(tmp_path, words)
    assert all(event.count(r"\\N") <= 1 for event in _caption_events(ass))


def test_wrap_never_splits_a_single_long_word(tmp_path: Path) -> None:
    words = _words("Supercalifragilisticexpialidocious", "next")
    lines = _wrap_caption_words(words, max_chars=8)
    joined = [" ".join(str(word["text"]) for word in line) for line in lines]
    assert joined == ["Supercalifragilisticexpialidocious", "next"]


def test_nine_by_sixteen_uses_vertical_playres(tmp_path: Path) -> None:
    ass = _write(tmp_path, _words("Hello", "world"), width=1080, height=1920)
    assert "PlayResX: 1080" in ass
    assert "PlayResY: 1920" in ass


def test_square_uses_square_playres(tmp_path: Path) -> None:
    ass = _write(tmp_path, _words("Hello", "world"), width=1080, height=1080)
    assert "PlayResX: 1080" in ass
    assert "PlayResY: 1080" in ass


def test_four_by_five_uses_final_canvas_and_unicode_escaping(tmp_path: Path) -> None:
    ass = _write(tmp_path, _words("Café", "世界", "{safe}"), width=1080, height=1350)
    assert "PlayResX: 1080" in ass and "PlayResY: 1350" in ass
    assert r"\{safe\}" in ass


def test_style_presets_change_caption_treatment(tmp_path: Path) -> None:
    outputs = {}
    for style in ("funny", "serious", "educational", "hype"):
        path = tmp_path / f"{style}.ass"
        write_ass(path, _words("one", "two", "three", "four"), offset=0, duration=10, visuals=[], width=1080, height=1920, style=style)
        outputs[style] = path.read_text(encoding="utf-8")
    assert len({text.split("Style: Caption,")[1].split("\n", 1)[0] for text in outputs.values()}) == 4
    assert all("\\c&H" in text for text in outputs.values())


def test_sixteen_by_nine_uses_landscape_playres_and_scaled_margins(tmp_path: Path) -> None:
    ass = _write(tmp_path, _words("Hello", "world"), width=1920, height=1080)
    assert "PlayResX: 1920" in ass
    assert "PlayResY: 1080" in ass
    style = _parse_styles(ass)["Caption"]
    # Horizontal margins scale with the wider canvas so captions keep the
    # same mobile-safe edge band as the 9:16 reference.
    assert int(style["MarginL"]) > 80
    assert int(style["MarginL"]) == int(style["MarginR"])
    assert style["Alignment"] == "2"


def test_word_by_word_highlighting_is_preserved(tmp_path: Path) -> None:
    words = _words("alpha", "bravo", "charlie", "delta", "echo")
    ass = _write(tmp_path, words)
    events = _caption_events(ass)
    assert len(events) == 5
    for index, event in enumerate(events):
        # Exactly the current word carries the highlight colour; the rest are plain.
        highlighted = event.count(r"{\c&H0077D6FF&}")
        assert highlighted == 1, f"event {index} has {highlighted} highlighted words"
        assert (r"{\c&H0077D6FF&}" + str(words[index]["text"])) in event


def test_visual_style_keeps_top_centre_alignment(tmp_path: Path) -> None:
    ass = _write(tmp_path, _words("Hello"), width=1080, height=1920)
    style = _parse_styles(ass)["Visual"]
    assert style["Alignment"] == "8"


def test_all_aspect_ratios_keep_caption_centred_and_within_frame(tmp_path: Path) -> None:
    words = _words("a", "b", "c", "d", "e", "f", "g", "h")
    for width, height in ((1080, 1920), (1080, 1080), (1920, 1080)):
        ass = _write(tmp_path, words, width=width, height=height)
        style = _parse_styles(ass)["Caption"]
        assert style["Alignment"] == "2"
        left, right = int(style["MarginL"]), int(style["MarginR"])
        assert left >= 40 and right >= 40
        # The rendered caption band never exceeds the final canvas width.
        assert width - left - right > 0
