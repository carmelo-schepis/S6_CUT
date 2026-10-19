"""The compact, read-only status data behind the iPhone/iPad view.

Covers the overview projection (small, live jobs first, no signed download
links), the early title/poster for sources that are still downloading, the
signed thumbnail routes, and the opt-in yt-dlp poster flag.
"""
from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
import tempfile
import time
from dataclasses import replace
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi.testclient import TestClient

import engine.app as app_module
from engine import source_preview
from engine.config import settings as app_settings
from engine.database import Database
from engine.jobs import JobManager
from engine.library import LibraryRules
from engine.media import download_youtube
from engine.models import Clip, Job, ProcessingStep, Project, now_iso
from engine.providers import ProfileService
from engine.security import MediaSigner, SecretVault
from engine.video_downloads import VideoDownloadManager, VideoDownloadTask


def _tmpdir() -> Path:
    return Path(tempfile.mkdtemp(prefix="s6-cut-mobile-test-"))


def _cluster(tmp_path: Path):
    settings = replace(app_settings, data_path=tmp_path)
    db = Database(tmp_path / "s6-cut.sqlite3")
    rules = LibraryRules(db, tmp_path / "library")
    manager = JobManager(db, rules, ProfileService(db, SecretVault(tmp_path / "secrets" / "instance.key")), settings)
    return db, manager, rules, settings


def _png(path: Path, settings, colour: str = "red") -> Path:
    if not shutil.which(settings.ffmpeg):
        pytest.skip("FFmpeg is required to build a real still")
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([settings.ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", f"color=c={colour}:s=96x54:d=1", "-frames:v", "1", str(path)], check=True, capture_output=True)
    return path


def _video(path: Path, settings) -> Path:
    if not shutil.which(settings.ffmpeg):
        pytest.skip("FFmpeg is required to build a real video")
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([settings.ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=2",
                    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(path)],
                   check=True, capture_output=True)
    return path


def _project(db: Database, project_id: str, name: str, **extra: Any) -> None:
    db.save_project(Project(id=project_id, name=name, mode="clip", style="educational", state="complete",
                            source_name="source.mp4", source_kind="upload", requested_count=1, **extra))


def _job(job_id: str, project_id: str, **values: Any) -> Job:
    defaults: dict[str, Any] = dict(id=job_id, project_id=project_id, mode="clip", processing_mode="fast", state="complete",
                                    stage="complete", stage_label="Ready", progress=100, style="educational")
    return Job(**{**defaults, **values})


class _Patched:
    """Point the app at an isolated cluster for one test and restore it after."""

    def __init__(self, db, manager, settings, signer=None, downloads=None):
        self.values = {"db": db, "manager": manager, "settings": settings}
        if signer is not None:
            self.values["signer"] = signer
        if downloads is not None:
            self.values["video_downloads"] = downloads

    def __enter__(self):
        self.saved = {name: getattr(app_module, name) for name in self.values}
        for name, value in self.values.items():
            setattr(app_module, name, value)
        return TestClient(app_module.app)

    def __exit__(self, *_exc):
        for name, value in self.saved.items():
            setattr(app_module, name, value)


def _publish_clip(rules: LibraryRules, tmp_path: Path, project_id: str, job_id: str, clip_id: str):
    output = tmp_path / "jobs" / job_id / "clips" / "01-cut.mp4"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(f"rendered-{clip_id}".encode())
    return rules.register_managed_video(output, title="Cut 01", origin="generated-clip", project_id=project_id, job_id=job_id,
                                        clip_id=clip_id, metadata={"duration": 8.0, "width": 1080, "height": 1920})


def test_overview_is_compact_live_first_and_carries_thumbnails_not_download_links():
    tmp_path = _tmpdir()
    db, manager, rules, settings = _cluster(tmp_path)
    _project(db, "proj-live", "Live project", source_title="A talk about editing")
    _project(db, "proj-done", "Finished project")
    source_file = tmp_path / "jobs" / "job-done" / "source" / "source.mp4"
    source_file.parent.mkdir(parents=True)
    source_file.write_bytes(b"source-bytes")
    source = rules.register_managed_video(source_file, title="Finished source", origin="project-source", project_id="proj-done",
                                          job_id="job-done", metadata={"duration": 60.0, "width": 1920, "height": 1080})
    asset = _publish_clip(rules, tmp_path, "proj-done", "job-done", "clip-1")
    clip = Clip(id="clip-1", index=1, state="complete", start=0, end=8, duration=8, opening_line="Cut 01", title="A strong opener",
                output_name="01-cut.mp4", blob_id=asset.blob_id, library_asset_id=asset.id)
    failed_clip = Clip(id="clip-2", index=2, state="failed", start=9, end=17, duration=8, opening_line="Cut 02")
    db.save_job(_job("job-done", "proj-done", clips=[clip, failed_clip], updated_at="2026-10-18T10:00:00+00:00"), {})
    db.save_job(_job("job-live", "proj-live", state="active", stage="render", stage_label="Rendering clips", progress=42,
                     steps=[ProcessingStep(id="source", label="Prepare source", status="complete", completed_at=now_iso()),
                            ProcessingStep(id="render", label="Render clips", status="active", started_at=now_iso(), current_item=2, total_items=5)]), {})
    db.save_job(_job("job-bad", "proj-done", state="failed", stage="failed", stage_label="Failed", progress=10, error="No speech detected"), {})

    with _Patched(db, manager, settings) as client:
        response = client.get("/api/v1/mobile/overview")
    assert response.status_code == 200, response.text
    body = response.json()

    assert [job["id"] for job in body["running"]] == ["job-live"]
    live = body["running"][0]
    assert live["projectName"] == "Live project" and live["sourceTitle"] == "A talk about editing"
    assert [step["status"] for step in live["steps"]] == ["complete", "active"]
    assert live["progress"] == 42

    assert {job["id"] for job in body["recent"]} == {"job-done", "job-bad"}
    assert body["recentTotal"] == 2
    done = next(job for job in body["recent"] if job["id"] == "job-done")
    assert done["steps"] == []  # finished jobs are summarised by their clips
    assert done["clipsReady"] == 1
    assert [item["title"] for item in done["clips"]] == ["A strong opener"]
    assert done["clips"][0]["thumbnailUrl"].startswith(f"/api/v1/library/assets/{asset.id}/thumbnail?")
    assert done["sourceThumbnailUrl"].startswith(f"/api/v1/library/assets/{source.id}/thumbnail?")
    failed = next(job for job in body["recent"] if job["id"] == "job-bad")
    assert failed["error"] == "No speech detected"

    # Signed download links and per-clip internals stay out of the poll payload.
    text = response.text
    for private in ("downloadUrl", "captionDownloads", "transcriptExcerpt", "scoreBreakdown", "beats"):
        assert private not in text
    assert body["failedLastDay"] == 1 and body["clipsLastDay"] == 1


def test_overview_history_is_bounded_and_reports_total():
    tmp_path = _tmpdir()
    db, manager, _rules, settings = _cluster(tmp_path)
    _project(db, "proj", "Project")
    for index in range(5):
        db.save_job(_job(f"job-{index}", "proj", updated_at=f"2026-10-1{index}T10:00:00+00:00"), {})
    with _Patched(db, manager, settings) as client:
        page = client.get("/api/v1/mobile/overview", params={"history": 2}).json()
        none = client.get("/api/v1/mobile/overview", params={"history": 0}).json()
        too_many = client.get("/api/v1/mobile/overview", params={"history": 101})
    assert [job["id"] for job in page["recent"]] == ["job-4", "job-3"]
    assert page["recentTotal"] == 5
    assert none["recent"] == [] and none["recentTotal"] == 5
    assert too_many.status_code == 422


def test_downloading_job_gets_early_title_and_poster_that_are_served_signed():
    tmp_path = _tmpdir()
    db, manager, _rules, settings = _cluster(tmp_path)
    signer = MediaSigner(tmp_path / "signing.key", 60)
    _project(db, "proj-yt", "YouTube project")
    db.save_job(_job("job-yt", "proj-yt", state="active", stage="source", stage_label="Downloading source", progress=12), {})
    source_dir = tmp_path / "jobs" / "job-yt" / "source"
    _png(source_dir / "source-abc123.png", settings)
    (source_dir / "source-abc123.info.json").write_text(json.dumps({"title": "  How   I edit‮ Shorts "}), encoding="utf-8")

    with _Patched(db, manager, settings, signer=signer) as client:
        live = client.get("/api/v1/mobile/overview").json()["running"][0]
        assert live["sourceTitle"] == "How I edit Shorts"
        url = live["sourceThumbnailUrl"]
        assert url.startswith("/api/v1/jobs/job-yt/source-thumbnail?")
        served = client.get(url)
        assert served.status_code == 200 and served.headers["content-type"] == "image/jpeg"
        assert served.content[:2] == b"\xff\xd8"
        query = parse_qs(urlparse(url).query)
        forged = client.get("/api/v1/jobs/job-yt/source-thumbnail", params={"expires": query["expires"][0], "signature": "x" * 43})
        assert forged.status_code == 403
        # A signature for one job is not valid for another job's poster.
        db.save_job(_job("job-other", "proj-yt", state="active", stage="source", stage_label="Downloading source", progress=1), {})
        assert client.get("/api/v1/jobs/job-other/source-thumbnail", params={"expires": query["expires"][0], "signature": query["signature"][0]}).status_code == 403
        assert client.get("/api/v1/jobs/missing/source-thumbnail", params={"expires": 1, "signature": "x"}).status_code == 404


def test_video_download_poster_is_only_advertised_once_it_exists_and_is_signed():
    tmp_path = _tmpdir()
    db, manager, _rules, settings = _cluster(tmp_path)
    signer = MediaSigner(tmp_path / "signing.key", 60)
    downloads = VideoDownloadManager(settings, signer)
    with_poster, without_poster = "a" * 32, "b" * 32
    for task_id, title in ((with_poster, "A real title"), (without_poster, None)):
        downloads.tasks[task_id] = VideoDownloadTask(id=task_id, url="https://www.youtube.com/watch?v=8xEuFQz4E4A", state="active", phase="downloading",
                                                     downloaded_bytes=10, total_bytes=100, percent=10, title=title, created_at=now_iso(), updated_at=now_iso())
    _png(downloads._directory(with_poster) / "source" / "source-x.png", settings)
    assert source_preview.ensure_preview(downloads._directory(with_poster) / "source", downloads.preview_path(with_poster), settings.ffmpeg)

    with _Patched(db, manager, settings, signer=signer, downloads=downloads) as client:
        listed = {item["id"]: item for item in client.get("/api/v1/video-downloads").json()}
        assert listed[with_poster]["title"] == "A real title" and listed[with_poster]["thumbnailUrl"]
        assert listed[without_poster]["thumbnailUrl"] is None
        assert "downloadUrl" not in listed[with_poster]
        served = client.get(listed[with_poster]["thumbnailUrl"])
        assert served.status_code == 200 and served.headers["content-type"] == "image/jpeg"
        query = parse_qs(urlparse(listed[with_poster]["thumbnailUrl"]).query)
        bad = client.get(f"/api/v1/video-downloads/{with_poster}/thumbnail", params={"expires": query["expires"][0], "signature": "y" * 43})
        assert bad.status_code == 403
        assert client.get(f"/api/v1/video-downloads/{without_poster}/thumbnail", params={"expires": query["expires"][0], "signature": query["signature"][0]}).status_code == 403
        assert client.get("/api/v1/video-downloads/not-a-task/thumbnail", params={"expires": 1, "signature": "x"}).status_code == 404

        overview = client.get("/api/v1/mobile/overview").json()
    mobile = {item["id"]: item for item in overview["downloads"]}
    assert mobile[with_poster]["thumbnailUrl"] and mobile[without_poster]["thumbnailUrl"] is None
    assert mobile[with_poster]["title"] == "A real title"
    assert "downloadUrl" not in json.dumps(overview)


def test_source_preview_helpers_normalise_titles_and_never_raise_on_bad_images():
    tmp_path = _tmpdir()
    settings = replace(app_settings, data_path=tmp_path)
    source_dir = tmp_path / "source"
    source_dir.mkdir()
    assert source_preview.read_info_title(source_dir) is None
    (source_dir / "source-a.info.json").write_text("{not json", encoding="utf-8")
    assert source_preview.read_info_title(source_dir) is None
    (source_dir / "source-b.info.json").write_text(json.dumps({"title": "x" * 500}), encoding="utf-8")
    assert len(source_preview.read_info_title(source_dir) or "") == 200

    preview = tmp_path / "preview.jpg"
    (source_dir / "source-a.jpg").write_bytes(b"this is not an image")
    assert source_preview.ensure_preview(source_dir, preview, settings.ffmpeg) is False
    assert not preview.exists() and not (tmp_path / "preview.tmp.jpg").exists()
    calls: list[int] = []
    original = source_preview._encode
    source_preview._encode = lambda *args, **kwargs: calls.append(1) or original(*args, **kwargs)
    try:
        # The same unreadable still is not re-encoded on every status poll.
        assert source_preview.ensure_preview(source_dir, preview, settings.ffmpeg) is False
        assert calls == []
        _png(source_dir / "source-a.png", settings)
        assert source_preview.ensure_preview(source_dir, preview, settings.ffmpeg) is True
    finally:
        source_preview._encode = original
    assert preview.read_bytes()[:2] == b"\xff\xd8"
    assert source_preview.ensure_preview(tmp_path / "missing", tmp_path / "other.jpg", settings.ffmpeg) is False


def test_download_manager_records_title_and_poster_then_falls_back_to_a_video_frame(monkeypatch):
    tmp_path = _tmpdir()
    settings = replace(app_settings, data_path=tmp_path / "data", max_long_source_seconds=3600)
    signer = MediaSigner(tmp_path / "signing.key", 60)
    manager = VideoDownloadManager(settings, signer)
    media = _video(tmp_path / "source.mkv", settings)
    monkeypatch.setattr("engine.video_downloads.validate_youtube_url", lambda value: value)
    seen: dict[str, Any] = {}

    def fake_download(_url, target_dir, _settings, *, progress_callback=None, write_thumbnail=False, **_kwargs):
        seen["write_thumbnail"] = write_thumbnail
        target_dir.mkdir(parents=True, exist_ok=True)
        (target_dir / "source-fixture.info.json").write_text(json.dumps({"title": "Controlled title"}), encoding="utf-8")
        if seen.get("with_poster"):
            _png(target_dir / "source-fixture.png", settings)
        downloaded = target_dir / "source-fixture.mkv"
        shutil.copyfile(media, downloaded)
        if progress_callback:
            progress_callback({"phase": "downloading", "downloaded_bytes": 10, "total_bytes": 100, "percent": 10})
        return downloaded

    monkeypatch.setattr("engine.video_downloads.download_youtube", fake_download)

    async def run(url: str, with_poster: bool):
        seen["with_poster"] = with_poster
        task, _ = await manager.create(url)
        deadline = time.monotonic() + 30
        while manager.get(task.id).state in {"queued", "active"} and time.monotonic() < deadline:
            await asyncio.sleep(0.05)
        return manager.get(task.id)

    async def scenario():
        await manager.start()
        try:
            return await run("https://www.youtube.com/watch?v=aaaaaaaaaaa", True), await run("https://www.youtube.com/watch?v=bbbbbbbbbbb", False)
        finally:
            await manager.stop()

    poster, framed = asyncio.run(scenario())
    assert seen["write_thumbnail"] is True
    for task in (poster, framed):
        assert task is not None and task.state == "complete", task.error if task else "missing"
        assert task.title == "Controlled title"
        assert manager.has_preview(task.id)
        assert manager.preview_path(task.id).read_bytes()[:2] == b"\xff\xd8"
    # The persisted state keeps the title but never a (short-lived) signed link.
    persisted = json.loads((manager._directory(poster.id) / "state.json").read_text(encoding="utf-8"))
    assert persisted["title"] == "Controlled title" and persisted["thumbnailUrl"] is None


def test_title_and_poster_appear_while_yt_dlp_is_still_silent(monkeypatch):
    """yt-dlp prints no progress while preparing, but writes its sidecars at once."""
    tmp_path = _tmpdir()
    settings = replace(app_settings, data_path=tmp_path / "data", max_long_source_seconds=3600)
    manager = VideoDownloadManager(settings, MediaSigner(tmp_path / "signing.key", 60))
    media = _video(tmp_path / "source.mkv", settings)
    monkeypatch.setattr("engine.video_downloads.validate_youtube_url", lambda value: value)
    seen: dict[str, Any] = {}

    def silent_download(_url, target_dir, _settings, *, progress_callback=None, **_kwargs):
        target_dir.mkdir(parents=True, exist_ok=True)
        (target_dir / "source-quiet.info.json").write_text(json.dumps({"title": "Written early"}), encoding="utf-8")
        _png(target_dir / "source-quiet.png", settings)
        # No progress callback at all for a while, as during yt-dlp's setup.
        deadline = time.monotonic() + 6
        task = next(iter(manager.tasks.values()))
        while time.monotonic() < deadline and not (manager.get(task.id).title and manager.has_preview(task.id)):
            time.sleep(0.1)
        current = manager.get(task.id)
        seen["title"], seen["preview"], seen["state"] = current.title, manager.has_preview(task.id), current.state
        downloaded = target_dir / "source-quiet.mkv"
        shutil.copyfile(media, downloaded)
        return downloaded

    monkeypatch.setattr("engine.video_downloads.download_youtube", silent_download)

    async def scenario():
        await manager.start()
        try:
            task, _ = await manager.create("https://www.youtube.com/watch?v=ccccccccccc")
            deadline = time.monotonic() + 30
            while manager.get(task.id).state in {"queued", "active"} and time.monotonic() < deadline:
                await asyncio.sleep(0.05)
        finally:
            await manager.stop()

    asyncio.run(scenario())
    assert seen == {"title": "Written early", "preview": True, "state": "active"}


def test_download_youtube_asks_for_a_poster_only_when_told_to(tmp_path, monkeypatch):
    settings = replace(app_settings, data_path=tmp_path)
    source = tmp_path / "source-video.mp4"
    source.write_bytes(b"video")
    commands: list[list[str]] = []
    monkeypatch.setattr("engine.media.validate_youtube_url", lambda value: value)
    monkeypatch.setattr("engine.media.probe", lambda *args, **kwargs: {"duration": 1})
    monkeypatch.setattr("engine.media._run_ytdlp_download", lambda command, *args, **kwargs: commands.append(command) or [source])

    url = "https://www.youtube.com/watch?v=8xEuFQz4E4A"
    download_youtube(url, tmp_path, settings)
    download_youtube(url, tmp_path, settings, write_thumbnail=True)
    plain, with_poster = commands
    assert "--write-thumbnail" not in plain
    assert with_poster.count("--write-thumbnail") == 1 and with_poster[-1] == url
    # Everything else about the command (format, clients, merge) is unchanged.
    assert [item for item in with_poster if item != "--write-thumbnail"] == plain
