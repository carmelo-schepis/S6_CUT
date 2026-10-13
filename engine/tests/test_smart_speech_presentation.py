from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

from engine.config import Settings
from engine.media import render_clip, render_fast_clip, write_ass


def _word(text: str, start: float, end: float) -> dict[str, object]:
    return {"text": text, "start": start, "end": end}


def _write(path: Path, words: list[dict[str, object]], *, width: int = 1080, height: int = 1920, **kwargs: object) -> str:
    write_ass(
        path, words, offset=0, duration=20, visuals=[], width=width, height=height,
        presentation="smart_speech_v1", **kwargs,
    )
    return path.read_text(encoding="utf-8")


def _styles(ass: str) -> dict[str, dict[str, str]]:
    fields = (
        "Name", "Fontname", "Fontsize", "PrimaryColour", "SecondaryColour", "OutlineColour",
        "BackColour", "Bold", "Italic", "Underline", "StrikeOut", "ScaleX", "ScaleY", "Spacing",
        "Angle", "BorderStyle", "Outline", "Shadow", "Alignment", "MarginL", "MarginR", "MarginV", "Encoding",
    )
    result = {}
    for line in ass.splitlines():
        if line.startswith("Style: "):
            values = line[len("Style: "):].split(",")
            result[values[0]] = dict(zip(fields, values))
    return result


def _caption_events(ass: str) -> list[str]:
    return [line for line in ass.splitlines() if line.startswith("Dialogue: 10,")]


def _visible_text(event: str) -> str:
    text = event.split(",", 9)[-1]
    return re.sub(r"\{[^}]*\}", "", text).replace(r"\N", " ")


def test_historical_private_payload_keeps_renderer_presentation_default() -> None:
    from engine.jobs import _presentation_render_kwargs

    def renderer(*, words, style):
        return None

    assert _presentation_render_kwargs(renderer, {}) == {}
    assert _presentation_render_kwargs(renderer, {"presentation": {"version": 1, "caption": "legacy"}}) == {}
    assert _presentation_render_kwargs(renderer, {"presentation": {"version": 1, "caption": "smart_speech_v1"}}) == {}

    def compatible_renderer(*, words, style, presentation=None):
        return None

    assert _presentation_render_kwargs(compatible_renderer, {}) == {}
    assert _presentation_render_kwargs(compatible_renderer, {
        "presentation": {"version": 1, "caption": "smart_speech_v1"},
    }) == {"presentation": "smart_speech_v1"}


def test_caption_rerender_forwards_saved_presentation_and_subtitle_flag(tmp_path: Path, monkeypatch) -> None:
    from types import SimpleNamespace

    import engine.jobs as jobs
    import engine.media as media
    from engine.jobs import JobManager
    from engine.models import Clip, Job

    captured = {}
    monkeypatch.setattr(media, "render_fast_clip", lambda *args, **kwargs: captured.update(kwargs))
    monkeypatch.setattr(jobs, "probe", lambda *_args, **_kwargs: {"audio": True})
    manager = object.__new__(JobManager)
    manager.settings = SimpleNamespace(data_path=tmp_path)
    manager._source = lambda *_args: tmp_path / "source.mp4"
    manager._save = lambda *_args: None
    manager._publish_output = lambda job, clip, *_args: (job, clip, None)
    clip = Clip(id="rerender-clip", index=1, state="complete", start=2, end=4, duration=2, opening_line="words")
    job = Job(
        id="rerender-job", project_id="rerender-project", mode="clip", state="active", stage="render",
        stage_label="Rendering", progress=50, style="educational", clips=[clip], burn_subtitles=False,
    )
    request = {"clip_id": clip.id, "revision": 1, "run_id": "edit"}
    private = {
        "aspect_ratio": "9:16", "presentation": {"version": 1, "caption": "smart_speech_v1"},
        "burn_subtitles": False, "caption_rerender": request,
        "caption_overrides": {clip.id: {"revision": 1, "cues": [{"id": "word", "start": .2, "end": .8, "text": "edited"}]}},
    }

    manager._process_caption_rerender(job, private, request)

    assert captured["presentation"] == "smart_speech_v1"
    assert captured["subtitles_enabled"] is False
    assert captured["words"] == [{"text": "edited", "start": .2, "end": .8}]


def test_smart_speech_is_additive_and_legacy_default_is_unchanged(tmp_path: Path) -> None:
    words = [_word("Keep", 0, 0.4), _word("the", 0.4, 0.8), _word("words", 0.8, 1.2)]
    default_path = tmp_path / "default.ass"
    legacy_path = tmp_path / "legacy.ass"
    smart_path = tmp_path / "smart.ass"
    args = dict(offset=0, duration=20, visuals=[], width=1080, height=1920, style="educational")
    write_ass(default_path, words, **args)
    write_ass(legacy_path, words, presentation="legacy", **args)
    write_ass(smart_path, words, presentation="smart_speech_v1", **args)

    default, legacy, smart = (path.read_text(encoding="utf-8") for path in (default_path, legacy_path, smart_path))
    assert default == legacy
    assert smart != legacy
    assert "PlayResX: 1080" in smart and "PlayResY: 1920" in smart


def test_smart_speech_style_has_usable_font_and_in_frame_geometry(tmp_path: Path) -> None:
    for width, height in ((1080, 1920), (1080, 1350), (1080, 1080), (1920, 1080)):
        ass = _write(tmp_path / f"{width}x{height}.ass", [_word("Readable", 0, 1)], width=width, height=height)
        styles = _styles(ass)
        caption = styles["Caption"]
        assert caption["Fontname"].strip()
        assert int(caption["Fontsize"]) > 0
        assert caption["Alignment"] in {"2", "5"}
        assert int(caption["MarginL"]) > 0 and int(caption["MarginR"]) > 0
        assert width - int(caption["MarginL"]) - int(caption["MarginR"]) > 0
        assert f"PlayResX: {width}" in ass and f"PlayResY: {height}" in ass


def test_smart_speech_wrap_retains_words_and_existing_emoji(tmp_path: Path) -> None:
    tokens = ["extraordinarylongword", "still", "retained", "世界", "😂"]
    words = [_word(token, index * 0.5, index * 0.5 + 0.4) for index, token in enumerate(tokens)]
    ass = _write(tmp_path / "words.ass", words)
    events = _caption_events(ass)
    assert events
    text = " ".join(_visible_text(event) for event in events)
    assert all(token in text for token in tokens)
    assert all(_visible_text(event).count(r"\N") <= 1 for event in events)
    assert "😂 😂" not in ass


def test_fast_smart_speech_render_preserves_hook_and_words_when_burn_in_is_off(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    import engine.media as media

    captured = {}

    def capture_render_clip(source, output, **kwargs):
        captured.update(kwargs)

    monkeypatch.setattr(media, "render_clip", capture_render_clip)
    words = [_word("Transcript", 0.2, 0.7)]

    render_fast_clip(
        tmp_path / "source.mp4", tmp_path / "clip.mp4", start=4, end=8, aspect="9:16",
        settings=Settings.from_env(), words=words, presentation="smart_speech_v1",
        subtitles_enabled=False, embed_subtitles=True, hook_text="A clear opening hook",
    )

    assert captured["words"] == [{"text": "Transcript", "start": 4.2, "end": 4.7}]
    assert captured["hook_text"] == "A clear opening hook"
    assert captured["subtitles_enabled"] is False
    assert captured["embed_subtitles"] is True


def test_smart_speech_transcript_words_and_timing_survive_phrase_grouping(tmp_path: Path) -> None:
    words = [
        _word("First,", 0.1, 0.3), _word("second", 0.35, 0.6), _word("third!", 0.65, 0.9),
        _word("fourth", 1.2, 1.5), _word("fifth.", 1.55, 1.9),
    ]
    events = _caption_events(_write(tmp_path / "transcript.ass", words))

    assert len(events) == len(words)
    for index, (event, word) in enumerate(zip(events, words)):
        fields = event.split(",", 3)
        assert fields[1] == f"0:{int(word['start'] // 60):02d}:{word['start'] % 60:05.2f}"
        assert fields[2] == f"0:{int(word['end'] // 60):02d}:{word['end'] % 60:05.2f}"
        group_start = index // 3 * 3
        group = words[group_start:group_start + 3]
        assert _visible_text(event).split() == [str(item["text"]) for item in group]


def test_smart_speech_creator_credit_keeps_opening_fade_and_empty_captions(tmp_path: Path) -> None:
    credited = _write(
        tmp_path / "credit.ass", [], creator_credit="Source: Creator 🎬", width=1080, height=1920,
    )
    credit_events = [line for line in credited.splitlines() if line.startswith("Dialogue: 2,")]
    assert len(credit_events) == 1
    assert "0:00:09.00,Credit" in credit_events[0]
    assert r"{\fad(0,1000)}" in credit_events[0]
    assert "Creator 🎬" in credit_events[0]
    assert not _caption_events(credited)


def test_smart_speech_without_words_does_not_emit_caption_events(tmp_path: Path) -> None:
    ass = _write(tmp_path / "off.ass", [])
    assert not _caption_events(ass)
    assert "Style: Caption," in ass  # a style declaration alone is not burned subtitle content


def test_local_emoji_mapping_plan_is_deterministic_and_respects_period_and_cooldown() -> None:
    from engine.media import _SMART_SPEECH_EMOJI_ASSETS, _smart_speech_emoji_plan

    def group(texts: tuple[str, str, str], start: float) -> list[dict[str, object]]:
        return [
            {"text": text, "start": start + index * 0.2, "end": start + (index + 1) * 0.2}
            for index, text in enumerate(texts)
        ]

    words = [
        *group(("That", "was", "hilarious!"), 0),
        *group(("A", "huge", "success"), 3),  # still inside the first image's cooldown
        *group(("Imagine", "this", "idea"), 7),
        *group(("A", "dangerous", "risk"), 9),  # inside the second cooldown
        *group(("Wow", "so", "unexpected"), 14),
        *group(("😂", "win", "success"), 21),  # existing emoji suppresses image mapping
    ]
    first = _smart_speech_emoji_plan(words, 1080, 1920, 30)
    second = _smart_speech_emoji_plan(words, 1080, 1920, 30)
    assert first == second
    assert [entry[0] for entry in first] == [
        _SMART_SPEECH_EMOJI_ASSETS["laughter"],
        _SMART_SPEECH_EMOJI_ASSETS["idea"],
        _SMART_SPEECH_EMOJI_ASSETS["surprise"],
    ]
    assert [value for _, start, end, *_ in first for value in (start, end)] == pytest.approx([0, .6, 7, 7.6, 14, 14.6])
    assert all(path.is_file() and path.suffix == ".png" for path, *_ in first)
    assert all((x, y, size) == (484, 803, 112) for _, _, _, x, y, size in first)
    for path in _SMART_SPEECH_EMOJI_ASSETS.values():
        png = path.read_bytes()
        assert png.startswith(b"\x89PNG\r\n\x1a\n")
        assert png[25] == 6  # PNG RGBA color type


def test_subtitles_disabled_renderer_emits_no_timed_caption_or_emoji_graphics(tmp_path: Path, monkeypatch) -> None:
    from types import SimpleNamespace

    import engine.media as media

    source = tmp_path / "source.mp4"
    source.write_bytes(b"fixture")
    overlays: list[tuple[Path, float, float]] = []

    monkeypatch.setattr(media, "probe", lambda path, *_args, **_kwargs: {
        "width": 1920 if path == source else 1080,
        "height": 1080 if path == source else 1920,
        "rotation": 0, "audio": True, "sample_aspect_ratio": 1.0,
    })
    monkeypatch.setattr(media, "_overlay_inputs", lambda _command, items: overlays.extend(items))
    monkeypatch.setattr(media, "_subscribe_animation_inputs", lambda *_args: [])
    monkeypatch.setattr(media, "_filters", lambda *_args: ("base-filter", "base"))
    monkeypatch.setattr(media, "run", lambda command, **_kwargs: Path(command[-1]).write_bytes(b"rendered"))

    words = [_word("That", 0, .2), _word("was", .2, .4), _word("hilarious", .4, .6)]
    output = tmp_path / "out.mp4"
    media.render_clip(
        source, output, start=0, end=2, aspect="9:16", words=words, visuals=[], overlays=[],
        settings=SimpleNamespace(ffmpeg="ffmpeg"), presentation="smart_speech_v1", subtitles_enabled=False,
    )

    assert output.is_file()
    assert overlays == []
    burn_ass = output.with_name(f"{output.stem}.burn.ass").read_text(encoding="utf-8")
    assert not _caption_events(burn_ass)
    assert "hilarious" in output.with_suffix(".srt").read_text(encoding="utf-8")  # optional caption sidecar stays independent


def _decoded_rgb(path: Path, timestamp: float):
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", str(timestamp), "-i", str(path),
         "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
        capture_output=True, check=True,
    )
    assert len(result.stdout) == 1080 * 1920 * 3
    return result.stdout


def _ass_rgb(path: Path, timestamp: float):
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
         "color=c=0x777777:s=1080x1920:r=24:d=10", "-vf",
         f"trim=start={timestamp},setpts=PTS-STARTPTS+{timestamp}/TB,subtitles={path}",
         "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
        capture_output=True, check=True,
    )
    assert len(result.stdout) == 1080 * 1920 * 3
    return result.stdout


def _solid_rgb(timestamp: float):
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
         "color=c=0x777777:s=1080x1920:r=24:d=10", "-vf",
         f"trim=start={timestamp},setpts=PTS-STARTPTS+{timestamp}/TB", "-frames:v", "1",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
        capture_output=True, check=True,
    )
    assert len(result.stdout) == 1080 * 1920 * 3
    return result.stdout


def _region_difference(left: bytes, right: bytes, *, x0: int, y0: int, x1: int, y1: int):
    changed = 0
    stride = 1080 * 3
    for y in range(y0, y1):
        row = y * stride
        for x in range(x0, x1):
            pixel = row + x * 3
            if sum(abs(left[pixel + channel] - right[pixel + channel]) for channel in range(3)) > 45:
                changed += 1
    return changed


def _region_overlay_pixels(overlay: bytes, clean: bytes, *, x0: int, y0: int, x1: int, y1: int):
    pixels = []
    stride = 1080 * 3
    for y in range(y0, y1):
        row = y * stride
        for x in range(x0, x1):
            pixel = row + x * 3
            if sum(abs(overlay[pixel + channel] - clean[pixel + channel]) for channel in range(3)) > 45:
                pixels.append(pixel)
    return pixels


def _masked_energy(left: bytes, right: bytes, pixel_offsets: list[int]):
    return sum(sum(abs(left[pixel + channel] - right[pixel + channel]) for channel in range(3)) for pixel in pixel_offsets)


def test_encoded_smart_speech_frames_show_text_emoji_and_fading_credit(tmp_path: Path) -> None:
    """Compare encoded MP4 frames against matching undecorated control frames."""
    if not shutil.which("ffmpeg") or not shutil.which("fc-match"):
        pytest.skip("encoded Smart speech frame test requires FFmpeg and fontconfig")

    source = tmp_path / "controlled-gray.mp4"
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "color=c=0x777777:s=1080x1920:r=24:d=10",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=10",
        "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-preset", "ultrafast",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(source),
    ], capture_output=True, check=True)

    words = [
        {"text": text, "start": start, "end": end}
        for text, start, end in (
            ("That", 1.0, 1.3), ("was", 1.3, 1.6), ("amazing!", 1.6, 2.2),
            ("A", 2.2, 2.4), ("brilliant", 2.4, 2.8), ("idea.", 2.8, 3.3),
            ("Māori", 3.3, 3.6), ("creator", 3.6, 4.0),
        )
    ]
    settings = Settings.from_env()
    smart = tmp_path / "smart.mp4"
    clean = tmp_path / "clean.mp4"
    off = tmp_path / "off.mp4"
    render_clip(
        source, smart, start=0, end=10, aspect="9:16", words=words, visuals=[], overlays=[],
        settings=settings, style="educational", has_audio=True, content_format="short",
        creator_credit="Source: Élan García", presentation="smart_speech_v1", subtitles_enabled=True,
    )
    render_clip(
        source, clean, start=0, end=10, aspect="9:16", words=[], visuals=[], overlays=[],
        settings=settings, style="educational", has_audio=True, content_format="short",
    )
    render_clip(
        source, off, start=0, end=10, aspect="9:16", words=words, visuals=[], overlays=[],
        settings=settings, style="educational", has_audio=True, content_format="short",
        creator_credit="Source: Élan García", presentation="smart_speech_v1", subtitles_enabled=False,
    )
    off_ass = off.with_name(f"{off.stem}.burn.ass").read_text(encoding="utf-8")
    assert not _caption_events(off_ass)

    speech = _decoded_rgb(smart, 2.0)
    plain_speech = _decoded_rgb(clean, 2.0)
    text_bounds = _region_difference(speech, plain_speech, x0=80, y0=870, x1=1000, y1=1200)
    emoji_bounds = _region_difference(speech, plain_speech, x0=450, y0=790, x1=630, y1=940)
    assert text_bounds > 1_000, f"encoded speech caption has only {text_bounds} changed pixels"
    assert emoji_bounds > 300, f"encoded emoji overlay has only {emoji_bounds} changed pixels"
    off_frame = _decoded_rgb(off, 2.0)
    assert _region_difference(off_frame, plain_speech, x0=80, y0=870, x1=1000, y1=1200) < 10
    assert _region_difference(off_frame, plain_speech, x0=450, y0=790, x1=630, y1=940) < 10

    smart_ass = smart.with_name(f"{smart.stem}.burn.ass")
    clean_frame = _solid_rgb(7.5)
    visible_frame = _ass_rgb(smart_ass, 7.5)
    credit_pixels = _region_overlay_pixels(visible_frame, clean_frame, x0=250, y0=1550, x1=830, y1=1760)
    visible_credit = _masked_energy(visible_frame, clean_frame, credit_pixels)
    half_fade = _masked_energy(_ass_rgb(smart_ass, 8.5), _solid_rgb(8.5), credit_pixels)
    after_fade = _masked_energy(_ass_rgb(smart_ass, 9.5), _solid_rgb(9.5), credit_pixels)
    assert len(credit_pixels) > 200
    assert visible_credit > 10_000
    assert 0.30 < half_fade / visible_credit < 0.70
    assert after_fade < visible_credit * .10
