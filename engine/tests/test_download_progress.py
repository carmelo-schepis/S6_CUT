from __future__ import annotations

import json
import stat
import sys
import textwrap
from dataclasses import replace
from pathlib import Path

import pytest

from engine.config import Settings
from engine.media import DownloadStalled, TranscriptionCancelled, YOUTUBE_EXTRACTOR_ARGS, YOUTUBE_FORMAT_SELECTOR, _parse_download_line, _run_ytdlp_download, download_youtube, youtube_import_metadata


@pytest.fixture
def settings() -> Settings:
    return Settings.from_env()


def fake_downloader(tmp_path: Path, body: str) -> Path:
    path = tmp_path / "fake-ytdlp.py"
    script = f"#!{sys.executable}\nimport time\nfrom pathlib import Path\n{textwrap.indent(textwrap.dedent(body).strip(), '')}\n"
    path.write_text(script, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return path


def test_youtube_import_metadata_prefers_channel_and_consumes_sidecar(tmp_path: Path) -> None:
    source = tmp_path / "source-video.mp4"
    source.write_bytes(b"video")
    info = source.with_suffix(".info.json")
    info.write_text(json.dumps({"title": "  A\nVideo  ", "channel": " Maker {One} ", "uploader": "Fallback"}), encoding="utf-8")

    assert youtube_import_metadata(source) == {"title": "A Video", "creator": "Maker {One}"}
    assert not info.exists()


@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        ({"uploader": "Uploader 🎬"}, "Uploader 🎬"),
        ({"creator": "Creator; {One}"}, "Creator; {One}"),
        ({"channel": "   \u0001   "}, None),
    ],
)
def test_youtube_import_metadata_creator_fallbacks_and_sanitization(tmp_path: Path, payload: dict[str, str], expected: str | None) -> None:
    source = tmp_path / "source-video.mp4"
    source.write_bytes(b"video")
    source.with_suffix(".info.json").write_text(json.dumps(payload), encoding="utf-8")

    metadata = youtube_import_metadata(source)
    assert (metadata or {}).get("creator") == expected


def test_youtube_format_selection_prefers_separate_video_audio_with_1080p_ceiling() -> None:
    assert YOUTUBE_FORMAT_SELECTOR == "bv*[height<=1080]+ba/b[height<=1080]"
    assert "+ba" in YOUTUBE_FORMAT_SELECTOR
    assert "height<=1080" in YOUTUBE_FORMAT_SELECTOR


def test_download_youtube_passes_quality_selector_and_keeps_progress_contract(tmp_path: Path, settings, monkeypatch) -> None:
    source = tmp_path / "source-video.mp4"
    source.write_bytes(b"video")
    commands: list[list[str]] = []
    canonical_url = "https://www.youtube.com/watch?v=8xEuFQz4E4A"
    monkeypatch.setattr("engine.media.validate_youtube_url", lambda _value: canonical_url)
    monkeypatch.setattr("engine.media.probe", lambda *args, **kwargs: {"duration": 1})

    def run(command, target_dir, *args, **kwargs):
        commands.append(command)
        return [source]

    monkeypatch.setattr("engine.media._run_ytdlp_download", run)
    assert download_youtube("https://www.youtube.com/watch?v=fixture", tmp_path, settings) == source.resolve()
    command = commands[0]
    assert command[-1] == canonical_url
    assert command[command.index("--format") + 1] == YOUTUBE_FORMAT_SELECTOR
    assert command[command.index("--merge-output-format") + 1] == "mp4"
    extractor_args = [command[index + 1] for index, value in enumerate(command) if value == "--extractor-args"]
    assert extractor_args == list(YOUTUBE_EXTRACTOR_ARGS)


def test_download_youtube_uses_explicit_clients_only_as_compatibility_fallback(tmp_path: Path, settings, monkeypatch) -> None:
    source = tmp_path / "source-video.mp4"
    source.write_bytes(b"video")
    commands: list[list[str]] = []
    monkeypatch.setattr("engine.media.validate_youtube_url", lambda value: value)
    monkeypatch.setattr("engine.media.probe", lambda *args, **kwargs: {"duration": 1})

    def run(command, target_dir, *args, **kwargs):
        commands.append(command)
        return [] if len(commands) == 1 else [source]

    monkeypatch.setattr("engine.media._run_ytdlp_download", run)
    assert download_youtube("https://www.youtube.com/watch?v=fixture", tmp_path, settings) == source.resolve()
    primary_args = [commands[0][index + 1] for index, value in enumerate(commands[0]) if value == "--extractor-args"]
    assert primary_args == list(YOUTUBE_EXTRACTOR_ARGS)
    fallback = commands[1]
    fallback_args = [fallback[index + 1] for index, value in enumerate(fallback) if value == "--extractor-args"]
    assert fallback_args == [*YOUTUBE_EXTRACTOR_ARGS, "youtube:player_client=android,web,web_music"]
    assert fallback[-1] == "https://www.youtube.com/watch?v=fixture"


def test_progress_parser_preserves_unknown_length() -> None:
    parsed = _parse_download_line("download:downloading|1048576|NA|NA|512000|NA|NA")
    assert parsed == {
        "status": "downloading", "downloaded_bytes": 1048576, "total_bytes": None,
        "speed_bytes_per_second": 512000, "eta_seconds": None, "percent": None,
    }


def test_download_reports_real_bytes_and_completion(tmp_path: Path, settings) -> None:
    executable = fake_downloader(tmp_path, """
        print('download:downloading|100|1000|NA|100|9|10.0%', flush=True)
        time.sleep(.1)
        print('download:downloading|1000|1000|NA|200|0|100.0%', flush=True)
        Path('source-fixture.mp4').write_bytes(b'video')
    """)
    updates: list[dict[str, object]] = []
    result = _run_ytdlp_download(
        [str(executable)], tmp_path, replace(settings, ytdlp_connect_timeout=1, ytdlp_inactivity_timeout=2),
        progress_callback=updates.append,
    )
    assert result == [tmp_path / "source-fixture.mp4"]
    assert [item["downloaded_bytes"] for item in updates if "downloaded_bytes" in item] == [0, 100, 1000]
    assert updates[-1]["phase"] == "downloading"


def test_download_stall_is_detected_without_waiting_for_process_exit(tmp_path: Path, settings) -> None:
    executable = fake_downloader(tmp_path, "print('download:downloading|100|1000|NA|100|9|10.0%', flush=True)\ntime.sleep(1.2)")
    updates: list[dict[str, object]] = []
    with pytest.raises(DownloadStalled, match="stalled"):
        _run_ytdlp_download(
            [str(executable)], tmp_path, replace(settings, ytdlp_connect_timeout=1, ytdlp_inactivity_timeout=.3),
            progress_callback=updates.append,
        )
    assert updates[-1]["phase"] == "stalled"


def test_setup_phase_uses_its_own_budget_not_the_socket_timeout(tmp_path: Path, settings) -> None:
    """A silent setup phase (player fetch, JS challenge, PO token) must not be
    killed by the per-socket connect timeout before the first byte arrives."""
    executable = fake_downloader(tmp_path, """
        time.sleep(.6)
        print('download:downloading|1000|1000|NA|200|0|100.0%', flush=True)
        Path('source-fixture.mp4').write_bytes(b'video')
    """)
    result = _run_ytdlp_download(
        [str(executable)], tmp_path,
        replace(settings, ytdlp_connect_timeout=1, ytdlp_setup_timeout=5, ytdlp_inactivity_timeout=5),
    )
    assert result == [tmp_path / "source-fixture.mp4"]


def test_setup_timeout_reports_the_setup_reason_not_a_byte_stall(tmp_path: Path, settings) -> None:
    executable = fake_downloader(tmp_path, "time.sleep(3)")
    updates: list[dict[str, object]] = []
    with pytest.raises(DownloadStalled, match="Preparing"):
        _run_ytdlp_download(
            [str(executable)], tmp_path,
            replace(settings, ytdlp_connect_timeout=10, ytdlp_setup_timeout=.3, ytdlp_inactivity_timeout=10),
            progress_callback=updates.append,
        )
    assert updates[-1]["phase"] == "stalled"
    assert "Preparing" in str(updates[-1]["message"])


def test_download_cancellation_terminates_worker_and_keeps_partial_directory(tmp_path: Path, settings) -> None:
    executable = fake_downloader(tmp_path, """
        print('download:downloading|100|1000|NA|100|9|10.0%', flush=True)
        time.sleep(2)
    """)
    with pytest.raises(TranscriptionCancelled):
        _run_ytdlp_download(
            [str(executable)], tmp_path, replace(settings, ytdlp_connect_timeout=1, ytdlp_inactivity_timeout=5),
            cancellation_callback=lambda: True,
        )
    assert tmp_path.is_dir()
