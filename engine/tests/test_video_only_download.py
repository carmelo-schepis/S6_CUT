from __future__ import annotations

import shutil
import subprocess
from dataclasses import replace
from pathlib import Path

import pytest

from engine.config import Settings
from engine.media import download_youtube, probe
from engine.security import MediaSigner, confined


@pytest.fixture

def generated_video(tmp_path: Path, settings: Settings) -> Path:
    """Create a tiny, deterministic video-only MP4; never use shared fixtures."""
    if not shutil.which(settings.ffmpeg) or not shutil.which(settings.ffprobe):
        pytest.skip("real media regression requires ffmpeg and ffprobe")
    source = tmp_path / "generated-input.mp4"
    subprocess.run(
        [settings.ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
         "-i", "color=c=blue:s=320x180:d=1:r=24", "-an", "-c:v", "libx264",
         "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(source)],
        check=True,
        capture_output=True,
    )
    return source


@pytest.fixture

def settings(tmp_path: Path) -> Settings:
    from engine.app import settings as app_settings

    return replace(app_settings, data_path=tmp_path / "isolated-data")


def test_download_path_accepts_controlled_ytdlp_mp4_and_probes_real_video(
    tmp_path: Path, generated_video: Path, settings: Settings, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from engine import media

    job_dir = tmp_path / "isolated-job"
    job_dir.mkdir()
    target = job_dir / "source-fixture.mp4"
    shutil.copyfile(generated_video, target)
    commands: list[list[str]] = []

    def controlled_downloader(command, target_dir, _settings, **_kwargs):
        commands.append(command)
        assert target_dir == job_dir
        return [target]

    monkeypatch.setattr(media, "validate_youtube_url", lambda value: value)
    monkeypatch.setattr(media, "_run_ytdlp_download", controlled_downloader)
    source = download_youtube("https://www.youtube.com/watch?v=fixture", job_dir, settings)

    assert source == target.resolve()
    metadata = probe(source, settings)
    assert metadata["width"] == 320
    assert metadata["height"] == 180
    command = commands[0]
    assert "--merge-output-format" in command
    assert command[command.index("--merge-output-format") + 1] == "mp4"
    assert "--format" in command
    assert "--continue" in command
    assert command[-1] == "https://www.youtube.com/watch?v=fixture"
    assert source.parent == job_dir.resolve()


def test_video_download_rejects_a_controlled_downloader_path_outside_job(
    tmp_path: Path, settings: Settings, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from engine import media

    job_dir = tmp_path / "isolated-job"
    job_dir.mkdir()
    escaped = tmp_path / "outside.mp4"
    escaped.write_bytes(b"not a media file")
    monkeypatch.setattr(media, "validate_youtube_url", lambda value: value)
    monkeypatch.setattr(media, "_run_ytdlp_download", lambda *_args, **_kwargs: [escaped])

    with pytest.raises(media.MediaError, match="outside its job directory"):
        download_youtube("https://www.youtube.com/watch?v=fixture", job_dir, settings)


def test_video_download_links_are_signed_and_confined_to_the_configured_root(tmp_path: Path) -> None:
    root = tmp_path / "isolated-root"
    root.mkdir()
    media_file = root / "source.mp4"
    media_file.write_bytes(b"fixture bytes")
    signer = MediaSigner(root / "signing.key", ttl_seconds=60)
    relative = "jobs/video-only/source.mp4"
    expires, signature = signer.sign(relative)

    assert signer.verify(relative, expires, signature)
    assert not signer.verify("jobs/../outside.mp4", expires, signature)
    assert not signer.verify(relative, expires, "0" * 64)
    assert confined(root, relative) == root / relative
    with pytest.raises(ValueError):
        confined(root, "jobs/../../outside.mp4")
    assert media_file.read_bytes() == b"fixture bytes"


def test_signed_job_mp4_route_serves_only_confined_valid_links(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from fastapi.testclient import TestClient

    from engine import app as app_module

    root = tmp_path / "isolated-engine-data"
    media_file = root / "jobs" / "download-only-job" / "source.mp4"
    media_file.parent.mkdir(parents=True)
    media_file.write_bytes(b"route fixture")
    signer = MediaSigner(tmp_path / "route-signing.key", ttl_seconds=120)
    monkeypatch.setattr(app_module, "settings", replace(app_module.settings, data_path=root))
    monkeypatch.setattr(app_module, "signer", signer)
    relative = "jobs/download-only-job/source.mp4"
    expires, signature = signer.sign(relative)
    client = TestClient(app_module.app)

    response = client.get(f"/api/v1/files/{relative}", params={"expires": expires, "signature": signature})
    assert response.status_code == 200
    assert response.content == b"route fixture"

    tampered = client.get(f"/api/v1/files/{relative}", params={"expires": expires, "signature": "invalid"})
    assert tampered.status_code == 403
    traversal = client.get("/api/v1/files/jobs/%2e%2e/outside.mp4", params={"expires": expires, "signature": signature})
    assert traversal.status_code == 403
