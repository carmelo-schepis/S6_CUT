from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from engine.config import Settings
from engine.emoji_assets import find_emoji_sequences, resolve_emoji
from engine.media import (
    _EMOJI_CANDIDATES,
    _caption_emoji_plan,
    _caption_words_with_emojis,
    _smart_speech_emoji_filters,
    render_clip,
    write_ass,
)


def test_import_failure_preserves_existing_bundle(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from scripts import import_fluent_emoji

    destination = tmp_path / "fluent-emoji"
    destination.mkdir()
    marker = destination / "existing.txt"
    marker.write_text("keep", encoding="utf-8")
    monkeypatch.setattr(import_fluent_emoji, "DEST", destination)
    monkeypatch.setattr(import_fluent_emoji, "SELECTIONS", (("😂", "Face with tears of joy", None),))
    monkeypatch.setattr(import_fluent_emoji, "download", lambda _url: (_ for _ in ()).throw(OSError("offline")))
    with pytest.raises(OSError, match="offline"):
        import_fluent_emoji.main()
    assert marker.read_text(encoding="utf-8") == "keep"


def test_manifest_covers_existing_candidates_and_common_complete_sequences() -> None:
    candidates = {emoji for groups in _EMOJI_CANDIDATES.values() for values in groups.values() for emoji in values}
    required = candidates | {"😩", "❤️", "👍🏽", "👩\u200d💻", "👩🏽\u200d💻"}
    assert all(resolve_emoji(sequence) is not None for sequence in required)
    assert resolve_emoji("😩") is not None
    assert resolve_emoji("❤️") is not None
    assert resolve_emoji("👩🏽\u200d💻") is not None
    assert find_emoji_sequences("? !, .") == []


def test_sequences_are_matched_whole_and_unsupported_text_is_retained(tmp_path: Path) -> None:
    text = "Hi ❤️ 👩🏽\u200d💻 🤷🏽\u200d♀️ 😂\ufe0f"
    found = find_emoji_sequences(text)
    assert [item[2] for item in found] == ["❤️", "👩🏽\u200d💻"]
    adjacent = find_emoji_sequences("❤️👍")
    assert [item[2] for item in adjacent] == ["❤️", "👍"]
    path = tmp_path / "captions.ass"
    write_ass(path, [{"text": text, "start": 0, "end": 1}], offset=0, duration=2,
              visuals=[], width=1080, height=1920, presentation="smart_speech_v1")
    assert text in path.read_text(encoding="utf-8")


def test_legacy_caption_ass_keeps_unicode_emoji_without_fluent_placeholders(tmp_path: Path) -> None:
    path = tmp_path / "legacy.ass"
    write_ass(path, [{"text": "wow", "start": 0, "end": 1}], offset=0, duration=2,
              visuals=[], width=1080, height=1920, style="funny")
    ass = path.read_text(encoding="utf-8")
    assert "wow 😂" in ass
    assert r"\h\h\h\h" not in ass


def test_missing_or_corrupt_bundle_asset_uses_safe_lookup_fallback(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import engine.emoji_assets as assets

    original_root = assets._ASSET_ROOT
    manifest = json.loads((original_root / "manifest.json").read_text(encoding="utf-8"))
    (tmp_path / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    (tmp_path / "emoji-01.png").write_bytes(b"not a png")
    monkeypatch.setattr(assets, "_ASSET_ROOT", tmp_path)
    assets._manifest.cache_clear()
    assets._verified_asset.cache_clear()
    try:
        assert assets.resolve_emoji("😂") is None
        assert assets.resolve_emoji("😩") is None  # listed but unavailable
    finally:
        monkeypatch.setattr(assets, "_ASSET_ROOT", original_root)
        assets._manifest.cache_clear()
        assets._verified_asset.cache_clear()
    assert resolve_emoji("😂") is not None


def test_existing_or_unsupported_emoji_is_not_duplicated_and_transcript_is_immutable() -> None:
    words = [{"text": "great 😩!", "start": 1.25, "end": 1.75, "confidence": .9}]
    enriched = _caption_words_with_emojis(words, "funny")
    assert enriched[0]["text"] == words[0]["text"]
    unsupported = _caption_words_with_emojis([{"text": "wow 💩"}], "funny")
    assert unsupported[0]["text"] == "wow 💩"
    ordinary = _caption_words_with_emojis([{"text": "Roman"}, {"text": "numeral"}], "funny")
    assert [word["text"] for word in ordinary] == ["Roman", "numeral"]
    assert enriched is not words and enriched[0] is not words[0]
    assert words[0] == {"text": "great 😩!", "start": 1.25, "end": 1.75, "confidence": .9}


def test_emoji_group_plan_uses_clip_local_half_open_intervals_and_bounded_assets() -> None:
    words = [
        {"text": "We", "start": 10.0, "end": 10.2},
        {"text": "love", "start": 10.2, "end": 10.5},
        {"text": "❤️", "start": 10.6, "end": 10.8},
        {"text": "again", "start": 11.0, "end": 11.4},
    ]
    plan = _caption_emoji_plan(words, 1080, 1920, 2.0, offset=10.0, style="funny", presentation="smart_speech_v1", music_theme=None)
    assert [value for _, start, end, *_ in plan for value in (start, end)] == pytest.approx([0.0, .5, .6, .8])
    assert len(_caption_emoji_plan(words[:3], 1080, 1920, 2.0, offset=10.0, style="funny", presentation=None, music_theme=None)) == 0
    graph = _smart_speech_emoji_filters(plan * 20, 3, [plan[0][0]])
    assert graph.count("[3:v]") == 1  # all occurrences reuse one split looped image input
    assert "[3:v]split=40" in graph
    assert "gte(t,0.600000)*lt(t,0.800000)" in graph
    assert "gte(t,0.000000)*lt(t,0.500000)" in graph


def test_automatic_smart_reactions_keep_cooldown_in_active_planner() -> None:
    words = [
        {"text": text, "start": start + index * .2, "end": start + (index + 1) * .2}
        for texts, start in [(("Wow", "that", "happened"), 0), (("A", "huge", "success"), 3), (("Imagine", "this", "idea"), 7)]
        for index, text in enumerate(texts)
    ]
    plan = _caption_emoji_plan(words, 1080, 1920, 10, offset=0, style="funny", presentation="smart_speech_v1", music_theme=None)
    assert [value for _, start, end, *_ in plan for value in (start, end)] == pytest.approx([0, .6, 7, 7.6])


def test_smart_inline_images_do_not_drift_across_multiple_sequences_in_one_word() -> None:
    plan = _caption_emoji_plan(
        [{"text": "❤️👍", "start": .1, "end": .5}], 1080, 1920, 2,
        offset=0, style="funny", presentation="smart_speech_v1", music_theme=None,
    )
    assert len(plan) == 2
    assert plan[1][3] > plan[0][3]
    assert plan[1][3] - plan[0][3] > plan[0][5] * .8


def _run(command: list[str]) -> None:
    subprocess.run(command, capture_output=True, check=True)


@pytest.mark.parametrize(("aspect", "width", "height"), [
    ("9:16", 1080, 1920), ("4:5", 1080, 1350), ("1:1", 1080, 1080), ("16:9", 1920, 1080),
])
def test_real_render_places_fluent_art_and_preserves_unicode_sidecars(tmp_path: Path, aspect: str, width: int, height: int) -> None:
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        pytest.skip("real emoji frame verification requires provisioned FFmpeg/FFprobe")
    source = tmp_path / "source.mp4"
    _run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
        f"color=c=0x777777:s={width}x{height}:r=24:d=2", "-f", "lavfi", "-i",
        "sine=frequency=440:sample_rate=48000:duration=2", "-c:v", "libx264", "-preset", "ultrafast",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(source),
    ])
    output = tmp_path / f"emoji-{aspect.replace(':', 'x')}.mp4"
    words = [
        {"text": "I", "start": .2, "end": .45},
        {"text": "feel", "start": .45, "end": .8},
        {"text": "😩!", "start": .8, "end": 1.3},
    ]
    render_clip(source, output, start=0, end=2, aspect=aspect, words=words, visuals=[], overlays=[],
                settings=Settings.from_env(), style="funny", has_audio=True, content_format="short",
                presentation="smart_speech_v1")
    burn_ass = output.with_name(f"{output.stem}.burn.ass").read_text(encoding="utf-8")
    standalone_ass = output.with_suffix(".ass").read_text(encoding="utf-8")
    srt = output.with_suffix(".srt").read_text(encoding="utf-8")
    assert "😩" not in burn_ass
    assert "😩!" in standalone_ass
    assert "😩!" in srt
    metadata = json.loads(subprocess.run([
        "ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height,sample_rate",
        "-of", "json", str(output),
    ], capture_output=True, text=True, check=True).stdout)
    video = next(stream for stream in metadata["streams"] if stream["codec_type"] == "video")
    audio = next(stream for stream in metadata["streams"] if stream["codec_type"] == "audio")
    assert (video["width"], video["height"]) == (width, height)
    assert audio["sample_rate"] == "48000"
    assert float(metadata["format"]["duration"]) == pytest.approx(2, abs=.1)
    _run(["ffmpeg", "-hide_banner", "-v", "error", "-i", str(output), "-f", "null", "-"])
    before, during, after = (tmp_path / f"{aspect.replace(':', 'x')}-{label}.png" for label in ("before", "during", "after"))
    for timestamp, frame in ((.1, before), (1.0, during), (1.6, after)):
        _run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", str(timestamp), "-i", str(output), "-frames:v", "1", str(frame)])
        assert frame.stat().st_size > 1000
    # The timed output frame contains the image; the same registered image area
    # is absent before/after because the overlay interval is half-open.
    regions = _caption_emoji_plan(words, width, height, 2.0, offset=0, style="funny", presentation="smart_speech_v1", music_theme=None)
    _, _, _, x, y, size = regions[0]
    def crop_mean(frame: Path) -> float:
        raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(frame), "-vf", f"crop={size}:{size}:{x}:{y},format=gray", "-f", "rawvideo", "-"], capture_output=True, check=True).stdout
        return sum(raw) / max(1, len(raw))
    assert abs(crop_mean(during) - crop_mean(before)) > 1
    assert abs(crop_mean(during) - crop_mean(after)) > 1
