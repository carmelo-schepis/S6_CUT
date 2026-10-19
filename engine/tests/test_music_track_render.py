from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from engine.config import Settings
from engine.media import MediaError, prepare_music_track, render_clip, render_fast_clip


@pytest.fixture()
def settings() -> Settings:
    return Settings.from_env()


def _require_media(settings: Settings) -> None:
    if not shutil.which(settings.ffmpeg) or not shutil.which(settings.ffprobe):
        pytest.skip("real soundtrack rendering requires FFmpeg and FFprobe")


def _probe_audio(path: Path, settings: Settings) -> dict:
    result = subprocess.run(
        [settings.ffprobe, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
        capture_output=True, text=True, check=True,
    )
    return json.loads(result.stdout)


def _fixtures(tmp_path: Path, settings: Settings) -> tuple[Path, Path]:
    _require_media(settings)
    video = tmp_path / "silent.mp4"
    song = tmp_path / "short-song.mp3"
    subprocess.run([
        settings.ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
        "color=c=navy:s=320x180:r=24:d=2", "-an", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(video),
    ], check=True, capture_output=True)
    subprocess.run([
        settings.ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
        "sine=frequency=660:sample_rate=44100:duration=0.45", "-codec:a", "libmp3lame", "-q:a", "4", str(song),
    ], check=True, capture_output=True)
    return video, song


@pytest.mark.parametrize("speed", [0.75, 1.0, 1.5])
def test_real_complex_render_replaces_silent_video_audio_at_each_speed(tmp_path: Path, settings: Settings, speed: float) -> None:
    video, song = _fixtures(tmp_path, settings)
    output = tmp_path / f"complex-{speed}.mp4"
    render_clip(
        video, output, start=0.2, end=1.4, aspect="16:9", words=[], visuals=[], overlays=[],
        settings=settings, has_audio=False, subtitles_enabled=False, music_track=song, music_track_speed=speed,
    )
    payload = _probe_audio(output, settings)
    assert any(stream.get("codec_type") == "audio" for stream in payload["streams"])
    assert float(payload["format"]["duration"]) == pytest.approx(1.2, abs=0.2)
    subprocess.run([settings.ffmpeg, "-v", "error", "-xerror", "-i", str(output), "-f", "null", "-"], check=True, capture_output=True)


def test_real_fast_render_accepts_music_on_silent_video(tmp_path: Path, settings: Settings) -> None:
    video, song = _fixtures(tmp_path, settings)
    output = tmp_path / "fast.mp4"
    render_fast_clip(video, output, start=0.2, end=1.4, aspect="16:9", settings=settings, has_audio=False,
                     subtitles_enabled=False, music_track=song, music_track_speed=1.25)
    assert any(stream.get("codec_type") == "audio" for stream in _probe_audio(output, settings)["streams"])


def test_corrupt_mp3_is_rejected_by_ffprobe(tmp_path: Path, settings: Settings) -> None:
    _require_media(settings)
    corrupt = tmp_path / "corrupt.mp3"
    corrupt.write_bytes(b"not an MP3 audio stream")
    with pytest.raises(MediaError):
        from engine.media import probe_audio
        probe_audio(corrupt, settings)


@pytest.mark.parametrize("speed", [0.75, 1.0, 1.5])
def test_prepared_song_loops_and_preserves_pitch_at_late_clip_offsets(tmp_path: Path, settings: Settings, speed: float) -> None:
    import numpy as np

    video, song = _fixtures(tmp_path, settings)
    prepared = prepare_music_track(song, tmp_path / 'prepared.mp3', speed, settings, duration=2)
    output = tmp_path / 'late.mp4'
    render_clip(video, output, start=1, end=1.8, aspect='16:9', words=[], visuals=[], overlays=[],
                settings=settings, has_audio=False, subtitles_enabled=False, music_track=prepared)
    payload = _probe_audio(output, settings)
    audio = next(stream for stream in payload['streams'] if stream['codec_type'] == 'audio')
    assert float(audio['duration']) == pytest.approx(.8, abs=.08)
    decoded = subprocess.run([settings.ffmpeg, '-v', 'error', '-i', str(output), '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'], check=True, capture_output=True).stdout
    samples = np.frombuffer(decoded, dtype='<f4')[1600:9600]
    assert np.sqrt(np.mean(samples ** 2)) > .02
    spectrum = abs(np.fft.rfft(samples * np.hanning(len(samples))))
    frequency = np.fft.rfftfreq(len(samples), 1 / 16000)[np.argmax(spectrum)]
    assert frequency == pytest.approx(660 * speed, abs=12)
