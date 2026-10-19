from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from engine.config import Settings
from engine.media import MediaError, prepare_music_track, render_clip, render_fast_clip


def test_audio_inspection_timeout_has_no_private_path(settings, monkeypatch):
    from engine import media

    path = Path('/private/soundtracks/secret-song.mp3')
    def timeout(command, **kwargs):
        raise subprocess.TimeoutExpired(command, 120)
    monkeypatch.setattr(media, 'run', timeout)
    with pytest.raises(MediaError, match='Audio inspection timed out') as error:
        media.probe_audio(path, settings)
    assert str(path) not in str(error.value)


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


@pytest.mark.parametrize("speed", [0.75, 0.85, 1.0, 1.25, 1.5])
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


def _with_original_tone(video: Path, target: Path, settings: Settings) -> Path:
    subprocess.run([
        settings.ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(video),
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=2",
        "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-shortest", str(target),
    ], check=True, capture_output=True)
    return target


def _tone_amplitude(path: Path, frequency: float, settings: Settings) -> float:
    import numpy as np

    decoded = subprocess.run([
        settings.ffmpeg, "-v", "error", "-i", str(path), "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "-",
    ], check=True, capture_output=True).stdout
    samples = np.frombuffer(decoded, dtype="<f4")
    samples = samples[int(.15 * 16000):int(.95 * 16000)]
    times = np.arange(len(samples)) / 16000
    window = np.hanning(len(samples))
    projection = 2 * np.sum(samples * window * np.exp(-2j * np.pi * frequency * times)) / np.sum(window)
    return float(abs(projection))


@pytest.mark.parametrize("renderer", ["complex", "fast"])
def test_real_mix_keeps_original_and_quieter_song(tmp_path: Path, settings: Settings, renderer: str) -> None:
    silent, song = _fixtures(tmp_path, settings)
    source = _with_original_tone(silent, tmp_path / "with-original.mp4", settings)
    output = tmp_path / f"mix-{renderer}.mp4"
    if renderer == "complex":
        render_clip(
            source, output, start=.2, end=1.4, aspect="16:9", words=[], visuals=[], overlays=[],
            settings=settings, has_audio=True, subtitles_enabled=False, music_track=song,
            music_audio_mode="mix_original", music_song_gain=.25, music_original_audio_gain=1,
        )
    else:
        render_fast_clip(
            source, output, start=.2, end=1.4, aspect="16:9", settings=settings,
            has_audio=True, subtitles_enabled=False, music_track=song, music_audio_mode="mix_original",
            music_song_gain=.25, music_original_audio_gain=1,
        )
    original = _tone_amplitude(output, 440, settings)
    background = _tone_amplitude(output, 660, settings)
    assert original > .05
    assert background > .01
    assert background / original == pytest.approx(.25, abs=.08)
    assert float(_probe_audio(output, settings)["format"]["duration"]) == pytest.approx(1.2, abs=.15)


def test_real_song_only_excludes_audible_source(tmp_path: Path, settings: Settings) -> None:
    silent, song = _fixtures(tmp_path, settings)
    source = _with_original_tone(silent, tmp_path / "with-original.mp4", settings)
    output = tmp_path / "song-only.mp4"
    render_clip(
        source, output, start=.2, end=1.4, aspect="16:9", words=[], visuals=[], overlays=[],
        settings=settings, has_audio=True, subtitles_enabled=False, music_track=song,
        music_audio_mode="song_only", music_song_gain=1,
    )
    assert _tone_amplitude(output, 440, settings) < .01
    assert _tone_amplitude(output, 660, settings) > .05


def test_real_mix_mode_still_renders_song_for_silent_video(tmp_path: Path, settings: Settings) -> None:
    video, song = _fixtures(tmp_path, settings)
    output = tmp_path / "silent-mix.mp4"
    render_clip(
        video, output, start=.2, end=1.4, aspect="16:9", words=[], visuals=[], overlays=[],
        settings=settings, has_audio=False, subtitles_enabled=False, music_track=song,
        music_audio_mode="mix_original", music_song_gain=.25,
    )
    assert _tone_amplitude(output, 660, settings) > .01
    assert not any(abs(value) > .01 for value in [_tone_amplitude(output, 440, settings)])
