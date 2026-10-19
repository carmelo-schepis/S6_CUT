from __future__ import annotations

from pathlib import Path
import re
import shutil
import subprocess

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from engine.app import app
from engine.models import Clip, Job, MusicPresentationConfig, Project

client = TestClient(app)


def test_legacy_project_and_job_payloads_keep_music_defaults() -> None:
    project = Project.model_validate({
        "id": "legacy-project", "name": "Legacy", "mode": "clip", "style": "serious",
        "state": "complete", "source_name": "old.mp4", "source_kind": "upload", "requested_count": 1,
    })
    job = Job.model_validate({
        "id": "legacy-job", "project_id": project.id, "mode": "clip", "state": "complete",
        "stage": "complete", "stage_label": "Done", "progress": 100, "style": "serious",
    })
    assert project.source_profile == job.source_profile == "speech"
    assert "musicPresentation" not in job.model_dump(by_alias=True, exclude_none=True)


def test_music_presentation_config_accepts_only_version_one_and_named_themes() -> None:
    for theme in ("clean", "warm", "serif", "reference_white_sans", "reference_yellow_sans", "reference_white_serif"):
        assert MusicPresentationConfig.model_validate({"version": 1, "subtitleTheme": theme}).subtitle_theme == theme
    assert MusicPresentationConfig().subtitle_theme == "clean"
    for payload in ({"version": 2, "subtitleTheme": "clean"}, {"version": 1, "subtitleTheme": "neon"}, {"version": 1, "unexpected": True}):
        with pytest.raises(ValidationError):
            MusicPresentationConfig.model_validate(payload)


def test_clip_music_metadata_defaults_and_title_limit_are_exact() -> None:
    base = {"id": "clip", "index": 1, "state": "queued", "start": 0, "end": 1, "duration": 1, "opening_line": "line"}
    assert Clip.model_validate(base).music_top_text is None
    exact = "  " + "x" * 96 + "  "
    assert len(exact) == 100
    clip = Clip.model_validate({**base, "music_top_text": exact, "music_treatment": "grayscale"})
    assert clip.music_top_text == exact
    with pytest.raises(ValidationError):
        Clip.model_validate({**base, "music_top_text": exact + "x"})


def test_music_upload_api_preserves_100_char_title_and_rejects_101(monkeypatch) -> None:
    from engine import app as app_module

    monkeypatch.setattr(app_module, "validate_video_upload", lambda *args, **kwargs: {"duration": 40.0, "width": 640, "height": 360, "audio": True})
    monkeypatch.setattr(app_module.profiles, "smart_available", lambda: False)
    monkeypatch.setattr(app_module.manager.queue, "full", lambda: False)
    async def enqueue(_: str) -> None:
        return None

    monkeypatch.setattr(app_module.manager, "enqueue", enqueue)
    exact = "  " + "V" * 96 + "  "
    folder = app_module.db.list_folders()[0]
    fields = {
        "source_profile": "music", "processing_mode": "smart", "count": "1", "min_duration": "8", "max_duration": "20",
        "library_folder_id": folder.id, "music_presentation": '{"version":1,"subtitleTheme":"reference_yellow_sans"}', "music_top_text": exact,
    }
    accepted = client.post("/api/v1/jobs/clip", data=fields, files={"file": ("song.mp4", b"fixture", "video/mp4")})
    assert accepted.status_code == 202, accepted.text
    assert accepted.json()["job"].get("musicPresentation") == {"version": 1, "subtitleTheme": "reference_yellow_sans"}
    persisted = app_module.db.get_job(accepted.json()["job"]["id"])
    assert persisted is not None
    assert persisted.music_presentation is not None
    assert persisted.music_presentation.subtitle_theme == "reference_yellow_sans"
    assert accepted.json()["job"]["mode"] == "clip"
    assert accepted.json()["job"]["sourceProfile"] == "music"
    assert accepted.json()["job"]["processingMode"] == "smart"
    assert accepted.json()["job"].get("musicTopText") == exact

    rejected = client.post("/api/v1/jobs/clip", data={**fields, "music_top_text": exact + "x"}, files={"file": ("song.mp4", b"fixture", "video/mp4")})
    assert rejected.status_code == 422


def test_real_mp3_upload_is_persisted_as_a_music_asset_after_video_validation(monkeypatch, tmp_path: Path) -> None:
    from engine import app as app_module
    from engine.config import Settings

    runtime = Settings.from_env()
    if not shutil.which(runtime.ffmpeg):
        pytest.skip("real MP3 API fixture requires FFmpeg")
    mp3 = tmp_path / "song.mp3"
    subprocess.run([runtime.ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=523:duration=2", "-codec:a", "libmp3lame", "-q:a", "4", str(mp3)], check=True, capture_output=True)
    monkeypatch.setattr(app_module, "validate_video_upload", lambda *args, **kwargs: {"duration": 40.0, "width": 640, "height": 360, "audio": False})
    monkeypatch.setattr(app_module.profiles, "smart_available", lambda: False)
    monkeypatch.setattr(app_module.manager.queue, "full", lambda: False)
    async def enqueue(_: str) -> None:
        return None
    monkeypatch.setattr(app_module.manager, "enqueue", enqueue)
    folder = app_module.db.list_folders()[0]
    fields = {"source_profile": "music", "processing_mode": "smart", "count": "1", "min_duration": "8", "max_duration": "20", "library_folder_id": folder.id}
    accepted = client.post("/api/v1/jobs/clip", data=fields, files={"file": ("silent.mp4", b"fixture", "video/mp4"), "music_track_file": ("song.mp3", mp3.read_bytes(), "audio/mpeg")})
    assert accepted.status_code == 202, accepted.text
    assert accepted.json()["project"]["musicTrack"]["title"] == "song"
    assert accepted.json()["job"]["musicTrack"]["source"] == "upload"
    asset_id = accepted.json()["job"]["musicTrack"]["assetId"]
    asset = app_module.db.get_asset(asset_id)
    assert asset is not None and asset.media_type == "audio/mpeg" and asset.content_hash
    private = app_module.db.get_job_private(accepted.json()["job"]["id"])
    assert private["music_track_hash"] == asset.content_hash


def test_rejected_video_does_not_stage_the_uploaded_song(monkeypatch, tmp_path: Path) -> None:
    from engine import app as app_module
    from engine.media import MediaError
    from engine.config import Settings

    runtime = Settings.from_env()
    if not shutil.which(runtime.ffmpeg):
        pytest.skip("real MP3 API fixture requires FFmpeg")
    mp3 = tmp_path / "song.mp3"
    subprocess.run([runtime.ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-codec:a", "libmp3lame", "-q:a", "4", str(mp3)], check=True, capture_output=True)
    monkeypatch.setattr(app_module, "validate_video_upload", lambda *args, **kwargs: (_ for _ in ()).throw(MediaError("invalid video")))
    before = set((app_module.settings.data_path / "jobs").glob("*/source/background.mp3"))
    folder = app_module.db.list_folders()[0]
    fields = {"source_profile": "music", "processing_mode": "smart", "count": "1", "min_duration": "8", "max_duration": "20", "library_folder_id": folder.id}
    rejected = client.post("/api/v1/jobs/clip", data=fields, files={"file": ("bad.mp4", b"invalid", "video/mp4"), "music_track_file": ("song.mp3", mp3.read_bytes(), "audio/mpeg")})
    assert rejected.status_code == 422
    assert set((app_module.settings.data_path / "jobs").glob("*/source/background.mp3")) == before


def test_music_renderer_contract_and_ass_boundaries(tmp_path: Path) -> None:
    from engine.media import write_music_ass

    lyrics = [
        {"text": "before", "start": -1.0, "end": 0.0},
        {"text": "phrase", "start": 9.8, "end": 10.3},
        {"text": "boundary", "start": 10.3, "end": 10.8},
        {"text": "middle", "start": 11.0, "end": 11.4},
        *[{"text": f"line{index}", "start": 11.45 + index * .04, "end": 11.49 + index * .04} for index in range(8)],
        {"text": "after", "start": 12.0, "end": 13.0},
    ]
    exact_title = "  A {title} \\\\ line\n{\\c&H00000000&}\x01  "
    escaped_title = exact_title.replace("\\", "\\\\").replace("{", r"\{").replace("}", r"\}").replace("\x01", "").replace("\n", r"\N")
    assert len(exact_title) <= 100
    for theme in ("clean", "warm", "serif", "reference_white_sans", "reference_yellow_sans", "reference_white_serif"):
        path = tmp_path / f"{theme}.ass"
        write_music_ass(path, lyrics, offset=10, duration=2, width=1080, height=1920, top_text=exact_title, subtitle_theme=theme)
        assert path.exists()
        content = path.read_text(encoding="utf-8")
        assert "PlayResX: 1080" in content and "PlayResY: 1920" in content
        events = [line for line in content.splitlines() if line.startswith("Dialogue:")]
        assert len(events) >= 3
        lyric_events = [line for line in events if ",Caption," in line]
        assert all(word in " ".join(lyric_events) for word in ("phrase", "boundary", "middle", *(f"line{index}" for index in range(8))))
        if theme in {"clean", "warm", "serif"}:
            assert any(r"\N" in line for line in lyric_events)  # legacy presets deliberately wrap on word boundaries
        else:
            assert not any(r"\N" in line for line in lyric_events)  # reference rows use independent positions
        caption_style = next(line for line in content.splitlines() if line.startswith("Style: Caption,"))
        assert caption_style.split(",")[18] == "5"  # Music lyrics occupy the source band, not the lower black margin
        title_event = next(line for line in events if ",MusicTop," in line)
        assert title_event.startswith("Dialogue: 20,0,0:00:02.00,MusicTop,")
        assert title_event.endswith(",," + escaped_title)
        top_style = next(line for line in content.splitlines() if line.startswith("Style: MusicTop,"))
        assert top_style.split(",")[2] == "54"  # top title size is not coupled to lyric scaling
        assert top_style.split(",")[18] == "8"  # top-centred, not coupled to lyric alignment
        for event in events:
            fields = event.split(",", 9)
            def seconds(value: str) -> float:
                if value == "0":
                    return 0
                hours, minutes, rest = value.split(":")
                return int(hours) * 3600 + int(minutes) * 60 + float(rest)
            assert 0 <= seconds(fields[1]) <= 2
            assert 0 <= seconds(fields[2]) <= 2
        if theme == "warm":
            assert r"{\c&H0000D7FF&}" in content
        elif theme == "reference_yellow_sans":
            assert caption_style.split(",")[3:5] == ["&H00AAE8F5&", "&H00AAE8F5&"]
            assert all(r"{\k" in line for line in lyric_events)
        elif theme in {"reference_white_sans", "reference_white_serif"}:
            assert caption_style.split(",")[3:5] == ["&H00FFFFFF&", "&H00FFFFFF&"]
        else:
            assert r"{\c&H00FFFFFF&}" in content
    outputs = []
    for theme in ("clean", "warm", "serif"):
        path = tmp_path / f"theme-{theme}.ass"
        write_music_ass(path, lyrics, offset=10, duration=2, width=1080, height=1920, top_text="Title", subtitle_theme=theme)
        outputs.append(path.read_text(encoding="utf-8"))
    assert len(set(outputs)) == 3
    assert "Style: Caption,Barlow," in outputs[0]
    assert "Style: Caption,Lora," in outputs[1]
    assert "Style: Caption,Lora," in outputs[2]
    assert all("Style: MusicTop,Barlow," in output for output in outputs)
    assert r"{\c&H0000D7FF&}" in outputs[1]


def test_reference_music_layout_preserves_every_word_and_phrase_timing(tmp_path: Path) -> None:
    from engine.media import write_music_ass

    words = [
        {"text": "do", "start": 1.0, "end": 1.2},
        {"text": "you", "start": 1.2, "end": 1.5},
        {"text": "think", "start": 1.5, "end": 1.8},
        {"text": "that", "start": 1.8, "end": 2.0},
        {"text": "i've", "start": 2.0, "end": 2.2},
        {"text": "forgotten", "start": 2.2, "end": 2.7},
        {"text": "about", "start": 2.7, "end": 3.0},
    ]
    for theme, face, color in (
        ("reference_white_sans", "Roboto Condensed", "&H00FFFFFF&"),
        ("reference_yellow_sans", "Roboto Condensed", "&H00AAE8F5&"),
        ("reference_white_serif", "Bodoni Moda", "&H00FFFFFF&"),
    ):
        path = tmp_path / f"{theme}.ass"
        write_music_ass(path, words, offset=0, duration=4, width=1080, height=1920, subtitle_theme=theme)
        content = path.read_text(encoding="utf-8")
        style = next(line for line in content.splitlines() if line.startswith("Style: Caption,"))
        assert style.split(",")[1] == face
        assert style.split(",")[2] == {
            "reference_white_sans": "155",
            "reference_yellow_sans": "140",
            "reference_white_serif": "172",
        }[theme]
        assert style.split(",")[3] == color
        assert style.split(",")[16] == "1" and style.split(",")[17] == "0"
        events = [line for line in content.splitlines() if line.startswith("Dialogue: 10,")]
        assert len(events) == (7 if theme == "reference_white_sans" else 3)
        event = " ".join(events)
        for word in ("do", "you", "think", "that", "i've", "forgotten", "about"):
            assert word in event
        assert len(re.findall(r"\{\\k\d+\}", event)) == len(words)
        assert event.count(r"{\kt") == len(words)
        if theme != "reference_white_sans":
            assert r"{\kt170}" in event
        assert all(r"\pos(" in row for row in events)
        if theme == "reference_white_serif":
            assert r"{\an7\pos(135,1009)}" in events[-1]  # the isolated final word sits back at the left edge
        assert all(r"\N" not in row for row in events)
        assert events[0].startswith("Dialogue: 10,0:00:01.00,")
        assert events[-1].split(",", 3)[2] == "0:00:03.00"


def test_music_size_multiplier_is_applied_once_only_for_explicit_shorts(tmp_path: Path) -> None:
    from engine.media import SHORT_FORM_SUBTITLE_SIZE_MULTIPLIER, write_ass

    canvases = ((1080, 1920), (1080, 1350), (1080, 1080), (1920, 1080))
    reference_sizes = {
        "reference_white_sans": 135,
        "reference_yellow_sans": 122,
        "reference_white_serif": 150,
    }
    for width, height in canvases:
        scale = min(width, height) / 1080
        for theme in ("clean", "warm", "serif", *reference_sizes):
            base = reference_sizes.get(theme, 56)
            rendered_base = max(28, round(base * scale))
            expected_short = round(rendered_base * SHORT_FORM_SUBTITLE_SIZE_MULTIPLIER)
            sizes = {}
            for fmt in (None, "long", "short"):
                path = tmp_path / f"{theme}-{width}x{height}-{fmt or 'omitted'}.ass"
                write_ass(
                    path, [{"text": "Sing", "start": 0.1, "end": 0.5}], offset=0, duration=1,
                    visuals=[], width=width, height=height, music_theme=theme, content_format=fmt,
                )
                style = next(line for line in path.read_text().splitlines() if line.startswith("Style: Caption,"))
                sizes[fmt] = int(style.split(",")[2])
            assert sizes[None] == rendered_base
            assert sizes["long"] == rendered_base
            assert sizes["short"] == expected_short


def test_reference_white_serif_spacing_fits_landscape_short_canvas(tmp_path: Path) -> None:
    from engine.media import _font_advance_metrics, write_music_ass

    words = [
        {"text": text, "start": 0.2 + index * 0.24, "end": 0.4 + index * 0.24}
        for index, text in enumerate(("do", "you", "think", "that", "i’ve", "forgotten", "about"))
    ]
    path = tmp_path / "reference-serif-landscape.ass"
    width, height = 1920, 1080
    write_music_ass(path, words, offset=0, duration=2, width=width, height=height, subtitle_theme="reference_white_serif")
    content = path.read_text(encoding="utf-8")
    style = next(line for line in content.splitlines() if line.startswith("Style: Caption,"))
    events = [line for line in content.splitlines() if line.startswith("Dialogue: 10,")]
    second_line = events[1].split(",,", 1)[1]
    hard_spaces = second_line.count(r"\h")
    units_per_em, glyph_advances = _font_advance_metrics(str(Path(__file__).parents[1] / "fonts/bodoni_moda/BodoniModa-Variable.ttf"))
    font_scale = int(style.split(",")[2]) * int(style.split(",")[11]) / 100 / units_per_em
    natural_width = sum(glyph_advances.get(ord(char), units_per_em * 0.55) for char in "i’veforgotten") * font_scale
    space_width = glyph_advances.get(ord(" "), units_per_em * 0.25) * font_scale

    assert 1 <= hard_spaces < 64
    assert natural_width + hard_spaces * space_width <= width * 0.82


def test_short_reference_serif_keeps_a_word_separator_when_no_extra_spacing_fits(tmp_path: Path) -> None:
    from engine.media import write_music_ass

    words = [
        {"text": text, "start": 0.2 + index * 0.24, "end": 0.4 + index * 0.24}
        for index, text in enumerate(("do", "you", "think", "that", "i’ve", "forgotten", "about"))
    ]
    path = tmp_path / "reference-serif-narrow-short.ass"
    write_music_ass(path, words, offset=0, duration=2, width=1080, height=1350, subtitle_theme="reference_white_serif")
    events = [line for line in path.read_text(encoding="utf-8").splitlines() if line.startswith("Dialogue: 10,")]
    second_line = events[1].split(",,", 1)[1]

    assert second_line.count(r"\h") == 1
    assert r"i’ve\h" in second_line and "forgotten" in second_line


def test_reference_layout_keeps_long_words_apostrophes_accents_and_fallback_glyphs(tmp_path: Path) -> None:
    from engine.media import write_music_ass

    words = [
        {"text": "extraordinaryuncharacteristicallylongword", "start": 0.0, "end": 0.5},
        {"text": "don't", "start": 0.5, "end": 0.8},
        {"text": "café", "start": 0.8, "end": 1.1},
        {"text": "雪", "start": 1.1, "end": 1.4},
    ]
    path = tmp_path / "reference-glyphs.ass"
    write_music_ass(path, words, offset=0, duration=2, width=1080, height=1920, subtitle_theme="reference_yellow_sans")
    content = path.read_text(encoding="utf-8")
    events = [line for line in content.splitlines() if line.startswith("Dialogue: 10,")]
    event = " ".join(events)
    assert all(text in event for text in ("extraordinaryuncharacteristicallylongword", "don't", "café", "雪"))
    assert len(re.findall(r"\{\\k\d+\}", event)) == len(words)
    size_tags = [int(size) for size in re.findall(r"\{\\fs(\d+)\}", event)]
    assert size_tags and max(size_tags) < 60  # the long token is reduced enough to fit the lyric band


def test_reference_layout_scales_font_metrics_and_overrides_with_canvas_size(tmp_path: Path) -> None:
    from engine.media import write_music_ass

    long_word = [{"text": "extraordinaryuncharacteristicallylongword", "start": 0.0, "end": 0.5}]
    for theme, expected_font in (
        ("reference_white_sans", 103),
        ("reference_yellow_sans", 93),
        ("reference_white_serif", 115),
    ):
        path = tmp_path / f"scaled-{theme}.ass"
        write_music_ass(path, long_word, offset=0, duration=1, width=720, height=1280, subtitle_theme=theme)
        content = path.read_text(encoding="utf-8")
        style = next(line for line in content.splitlines() if line.startswith("Style: Caption,"))
        event = next(line for line in content.splitlines() if line.startswith("Dialogue: 10,"))
        assert style.split(",")[2] == str(expected_font)
        size_tag = re.search(r"\{\\fs(\d+)\}", event)
        assert size_tag and 1 <= int(size_tag.group(1)) <= expected_font


def test_music_caption_cues_are_word_timed_local_and_not_decorated_like_speech(tmp_path: Path) -> None:
    from engine.media import music_caption_cues, write_ass, write_caption_sidecars

    words = [
        {"text": "love", "start": 4.9, "end": 5.2, "confidence": 0.94},
        {"text": "again", "start": 5.2, "end": 5.7, "confidence": 0.88},
    ]
    cues = music_caption_cues(words, 5, 6)
    assert cues == [
        {"id": "music-word-1", "start": 0, "end": pytest.approx(0.2), "text": "love", "confidence": 0.94},
        {"id": "music-word-2", "start": pytest.approx(0.2), "end": pytest.approx(0.7), "text": "again", "confidence": 0.88},
    ]
    ass = tmp_path / "music.ass"
    write_ass(ass, words, offset=5, duration=1, visuals=[], width=1080, height=1920, music_theme="clean")
    assert "love" in ass.read_text(encoding="utf-8")
    assert "🙂" not in ass.read_text(encoding="utf-8")
    sidecar = tmp_path / "music.mp4"
    write_caption_sidecars(sidecar, words, offset=5, duration=1, music_theme="clean")
    assert "love" in sidecar.with_suffix(".srt").read_text(encoding="utf-8")
    assert "🙂" not in sidecar.with_suffix(".srt").read_text(encoding="utf-8")


def test_music_title_limit_is_enforced_at_renderer() -> None:
    from engine.media import write_music_ass

    with pytest.raises(ValueError, match="100 characters"):
        write_music_ass(Path("unused.ass"), [], offset=0, duration=1, width=1080, height=1920, top_text="x" * 101, subtitle_theme="clean")


def test_music_layout_uses_raised_black_picture_band_and_source_only_grayscale() -> None:
    from engine.media import _music_source_layout_filter, dimensions

    assert dimensions("9:16") == (1080, 1920)
    default = _music_source_layout_filter(1080, 1920, (1920, 1080), False)
    gray = _music_source_layout_filter(1080, 1920, (1920, 1080), True)
    assert "scale=1080:810:force_original_aspect_ratio=decrease:flags=lanczos" in default
    assert "pad=1080:1920:(ow-iw)/2:570:color=black" in default
    assert "format=gray" not in default
    assert "format=gray" in gray
    assert "setsar=1[base]" in gray
    assert "scale=1080:1920" not in default


def test_music_gray_assignments_are_exact_balanced_and_stable_by_clip_identity() -> None:
    from engine.jobs import _assign_music_treatments

    for count, expected_gray in ((1, 0), (2, 1), (3, 1), (4, 2), (5, 2)):
        project = Project(id="p", name="P", mode="clip", style="serious", state="active", source_name="s.mp4", source_kind="upload", requested_count=count)
        job = Job(id=f"j{count}", project_id=project.id, mode="clip", state="active", stage="render", stage_label="Rendering", progress=40, style="serious")
        job.clips = [Clip(id=f"persistent-{index}", index=index, state="queued", start=index, end=index + 1, duration=1, opening_line="line") for index in range(1, count + 1)]
        snapshots = []
        saver = lambda saved_job, private=None: snapshots.append({"job": saved_job.model_copy(deep=True), "private": dict(private or {})})
        private = {}
        _assign_music_treatments(job, private, saver)
        mapping = {clip.id: clip.music_treatment for clip in job.clips}
        assert list(mapping.values()).count("grayscale") == expected_gray
        assert list(mapping.values()).count("color") == count - expected_gray
        assert {key: value for key, value in private["music_treatments"].items()} == mapping
        assert snapshots
        retry_job = snapshots[-1]["job"]
        retry_private = snapshots[-1]["private"]
        _assign_music_treatments(retry_job, retry_private, lambda *_: None)
        assert {clip.id: clip.music_treatment for clip in retry_job.clips} == mapping
        assert retry_private["music_treatments"] == private["music_treatments"]


def test_music_assignments_survive_database_reload_and_retry(tmp_path: Path) -> None:
    from engine.database import Database
    from engine.jobs import _assign_music_treatments

    db_path = tmp_path / "music.sqlite3"
    database = Database(db_path)
    project = Project(id="durable-project", name="Durable", mode="clip", style="educational", state="active", source_name="song.mp4", source_kind="upload", requested_count=2)
    job = Job(id="durable-job", project_id=project.id, mode="clip", state="active", stage="render", stage_label="Rendering", progress=50, style="educational", source_profile="music")
    job.clips = [Clip(id=f"durable-{index}", index=index, state="queued", start=index * 10, end=index * 10 + 8, duration=8, opening_line="lyric") for index in (1, 2)]
    database.save_project(project)
    private = {"music_treatments": {}}
    _assign_music_treatments(job, private, database.save_job)
    assigned = {clip.id: clip.music_treatment for clip in job.clips}

    reopened = Database(db_path)
    restored_job = reopened.get_job(job.id)
    assert restored_job is not None
    restored_private = reopened.get_job_private(job.id)
    assert {clip.id: clip.music_treatment for clip in restored_job.clips} == assigned
    assert restored_private["music_treatments"] == assigned
    _assign_music_treatments(restored_job, restored_private, reopened.save_job)
    assert {clip.id: clip.music_treatment for clip in restored_job.clips} == assigned
    assert reopened.get_job_private(job.id)["music_treatments"] == assigned


def test_music_api_rejects_non_music_options_on_clip_payload(monkeypatch: pytest.MonkeyPatch) -> None:
    from engine import app as app_module

    monkeypatch.setattr(app_module.manager.queue, "full", lambda: False)
    response = client.post("/api/v1/jobs/clip", data={
        "url": "https://www.youtube.com/watch?v=fixture", "source_profile": "speech",
        "music_top_text": "not music", "music_presentation": '{"version":1,"subtitleTheme":"warm"}',
    })
    assert response.status_code == 422


def test_caption_rerender_preserves_music_presentation_and_clip_treatment(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from types import SimpleNamespace

    import engine.jobs as jobs_module
    import engine.media as media_module
    from engine.jobs import JobManager

    rendered = {}
    monkeypatch.setattr(media_module, "render_clip", lambda *args, **kwargs: rendered.update(kwargs))
    monkeypatch.setattr(jobs_module, "probe", lambda *_args, **_kwargs: {"audio": True, "duration": 100})
    prepared = {}
    def prepare(source, target, speed, settings, **kwargs):
        prepared.update(source=source, speed=speed, **kwargs)
        return tmp_path / "prepared-song.mp3"
    monkeypatch.setattr(media_module, "prepare_music_track", prepare)

    manager = object.__new__(JobManager)
    manager.settings = SimpleNamespace(data_path=tmp_path)
    manager._source = lambda *_args: tmp_path / "source.mp4"
    manager._music_track_source = lambda *_args: tmp_path / "saved-song.mp3"
    manager._save = lambda *_args: None
    manager._publish_output = lambda job, clip, *_args: (job, clip, None)
    clip = Clip(
        id="music-clip", index=1, state="complete", start=50, end=52, duration=2,
        opening_line="old lyrics", music_top_text="Exact title", music_treatment="grayscale",
    )
    job = Job(
        id="music-job", project_id="music-project", mode="clip", state="active", stage="render",
        stage_label="Rendering", progress=50, style="educational", source_profile="music",
        clips=[clip],
    )
    request = {"clip_id": clip.id, "revision": 1, "run_id": "music-caption-edit"}
    private = {
        "aspect_ratio": "9:16",
        "music_presentation": {"version": 1, "subtitle_theme": "warm"},
        "music_top_text": "Exact title",
        "music_track_speed": 1.25,
        "music_treatments": {clip.id: "grayscale"},
        "caption_rerender": request,
        "caption_overrides": {clip.id: {"revision": 1, "cues": [{"id": "edited-word", "start": 0.5, "end": 0.9, "text": "edited"}]}},
    }

    manager._process_caption_rerender(job, private, request)

    assert rendered["music_theme"] == "warm"
    assert rendered["music_top_text"] == "Exact title"
    assert rendered["music_treatment"] == "grayscale"
    assert prepared["source"] == tmp_path / "saved-song.mp3"
    assert prepared["speed"] == 1.25
    assert prepared["duration"] == 100
    assert rendered["music_track"] == tmp_path / "prepared-song.mp3"
    assert rendered["music_track_speed"] == 1.0
    assert rendered["words"] == [{"text": "edited", "start": 50.5, "end": 50.9}]
    assert clip.caption_cues[0].text == "edited"
    assert "caption_rerender" not in private
