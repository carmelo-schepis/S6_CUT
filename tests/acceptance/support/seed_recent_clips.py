#!/usr/bin/env python3
"""Seed a NEW disposable S6_DATA_PATH before launching the acceptance app.

Refuses non-/tmp paths and any database that already has projects/assets. Uses
engine Database/LibraryRules so blobs are confined, hashed, and registered via
normal library code. Requires ffmpeg with libx264. Never point at a live dataset.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import re
import uuid
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from engine.database import Database, UNSORTED_FOLDER_ID
from engine.library import LibraryRules
from engine.models import Clip, DownloadProgress, Job, LibraryFolder, Project


def main() -> None:
    raw = os.environ.get("S6_DATA_PATH")
    if not raw:
        raise SystemExit("Set S6_DATA_PATH to a unique new /tmp/s6-recent-clips-<run-id> directory")
    root = Path(raw).expanduser().resolve()
    if root.parent != Path("/tmp") or not re.fullmatch(r"s6-recent-clips-[a-zA-Z0-9-]{8,}", root.name):
        raise SystemExit("Refusing to seed outside /tmp/s6-recent-clips-<unique-run-id>")
    if not os.environ.get("S6_ACCEPTANCE_URL"):
        raise SystemExit("Set S6_ACCEPTANCE_URL explicitly for the isolated app (use a local non-default port)")
    target = urllib.parse.urlparse(os.environ["S6_ACCEPTANCE_URL"])
    port = target.port or (443 if target.scheme == "https" else 80)
    if target.hostname not in {"127.0.0.1", "localhost", "::1"} or not 20_000 <= port <= 65_535:
        raise SystemExit("Refusing non-local or shared acceptance URL; use a unique loopback port in 20000–65535")
    if root.exists() and any(root.iterdir()):
        raise SystemExit(f"Refusing non-empty data directory: {root}")
    root.mkdir(parents=True, exist_ok=True)
    db = Database(root / "s6-cut.sqlite3")
    if db.list_projects() or db.list_assets():
        raise SystemExit("Refusing to seed a database containing projects or assets")
    ffmpeg = shutil.which(os.environ.get("S6_FFMPEG_BIN", "ffmpeg"))
    if not ffmpeg:
        raise SystemExit("ffmpeg is required to create real previewable fixture media")

    temp = root / "temp" / "recent-clips-seed"
    temp.mkdir(parents=True, exist_ok=True)
    rules = LibraryRules(db, root / "library")
    now = datetime.now(timezone.utc)

    # Historical stopped work intentionally has no output assets and predates
    # the visible output set. It catches accidental project/job-based results.
    for index in range(15):
        project_id, job_id = str(uuid.uuid4()), str(uuid.uuid4())
        stamp = (now - timedelta(days=30 + index)).isoformat()
        project = Project(id=project_id, name=f"RC historical stopped {index + 1:02d}", mode="clip", style="educational", state="cancelled_kept", source_name="unavailable historical source.mp4", source_kind="upload", requested_count=1, latest_job_id=job_id, created_at=stamp, updated_at=stamp)
        download_progress = DownloadProgress(downloaded_bytes=512, total_bytes=1024, percent=50, phase="stopped_partial", last_progress_at=stamp) if index == 0 else None
        job = Job(id=job_id, project_id=project_id, mode="clip", state="cancelled_kept", stage="stopped", stage_label="Stopped before outputs", progress=0, style="educational", download_progress=download_progress, created_at=stamp, updated_at=stamp)
        db.save_project(project)
        db.save_job(job)

    removable_folder_id = str(uuid.uuid4())
    db.save_folder(LibraryFolder(id=removable_folder_id, name="RC removable folder"))
    output_records: list[dict[str, str]] = []
    cascade_project_id = ""
    retained_source_project_id = ""
    for project_index in range(3):
        project_id, job_id = str(uuid.uuid4()), str(uuid.uuid4())
        if project_index == 0:
            cascade_project_id = project_id
        elif project_index == 1:
            retained_source_project_id = project_id
        project_name = f"RC output project {project_index + 1}"
        project = Project(id=project_id, name=project_name, mode="clip", style="educational", state="complete", source_name=f"{project_name} source.mp4", source_kind="upload", requested_count=5, latest_job_id=job_id)
        db.save_project(project)
        clips: list[Clip] = []
        for clip_index in range(5):
            clip_id, asset_id = str(uuid.uuid4()), str(uuid.uuid4())
            color = f"0x{(project_index * 5 + clip_index + 1) * 0x0F0F0F & 0xFFFFFF:06x}"
            media = temp / f"{project_index}-{clip_index}.mp4"
            subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", f"color=c={color}:s=320x180:r=24:d=3,fade=t=in:st=0:d=3", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(media)], check=True)
            # register_file chooses the asset UUID. The test fixture does not
            # need custom asset IDs; retain the durable ID returned by the DB.
            asset = rules.register_file(media, title="RC duplicate title" if clip_index == 0 and project_index > 0 else f"RC project {project_index + 1} clip {clip_index + 1}", media_type="video/mp4", origin="generated-clip", folder_id=removable_folder_id if project_index == 0 and clip_index == 1 else UNSORTED_FOLDER_ID, project_id=project_id, job_id=job_id, clip_id=clip_id, metadata={"duration": 3, "width": 320, "height": 180}, filename=media.name)
            clips.append(Clip(id=clip_id, index=clip_index + 1, state="complete", start=0, end=3, duration=3, opening_line="Acceptance fixture frame progression", output_name=media.name, blob_id=asset.blob_id, library_asset_id=asset.id, title=asset.title, width=320, height=180, published_at=asset.published_at))
            output_records.append({"assetId": asset.id, "projectId": project_id, "jobId": job_id, "clipId": clip_id})
        job = Job(id=job_id, project_id=project_id, mode="clip", state="complete", stage="complete", stage_label="Project ready", progress=100, style="educational", clips=clips, total_items=5)
        db.save_job(job)

    # Add a script-output record and a genuine manual video import.
    script_project_id, script_job_id, script_clip_id = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
    script_project = Project(id=script_project_id, name="RC script project", mode="script", style="educational", state="complete", source_name="fixture script", source_kind="script", requested_count=1, latest_job_id=script_job_id)
    db.save_project(script_project)
    script_media = temp / "script-output.mp4"
    subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=24:d=3,fade=t=in:st=0:d=3", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(script_media)], check=True)
    script_asset = rules.register_file(script_media, title="RC script output", media_type="video/mp4", origin="script-output", folder_id=UNSORTED_FOLDER_ID, project_id=script_project_id, job_id=script_job_id, clip_id=script_clip_id, metadata={"duration": 3, "width": 320, "height": 180}, filename="script-output.mp4")
    db.save_job(Job(id=script_job_id, project_id=script_project_id, mode="script", state="complete", stage="complete", stage_label="Project ready", progress=100, style="educational", clips=[Clip(id=script_clip_id, index=1, state="complete", start=0, end=3, duration=3, opening_line="Script fixture", output_name="script-output.mp4", blob_id=script_asset.blob_id, library_asset_id=script_asset.id, title=script_asset.title, width=320, height=180)]))

    source_project_id = cascade_project_id
    source_media = temp / "source.mp4"
    subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=green:s=320x180:r=24:d=3,fade=t=in:st=0:d=3", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(source_media)], check=True)
    source_asset = rules.register_file(source_media, title="RC project source", media_type="video/mp4", origin="project-source", folder_id=UNSORTED_FOLDER_ID, project_id=source_project_id, metadata={"duration": 3, "width": 320, "height": 180}, filename="source.mp4")
    db.save_project(db.get_project(source_project_id).model_copy(update={"source_blob_id": source_asset.blob_id}))
    retained_source_path = temp / "retained-source.mp4"
    subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=purple:s=320x180:r=24:d=3", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(retained_source_path)], check=True)
    retained_source = rules.register_file(retained_source_path, title="RC retained project source", media_type="video/mp4", origin="project-source", folder_id=UNSORTED_FOLDER_ID, project_id=retained_source_project_id, metadata={"duration": 3, "width": 320, "height": 180}, filename="retained-source.mp4")
    db.save_project(db.get_project(retained_source_project_id).model_copy(update={"source_blob_id": retained_source.blob_id}))
    manual_media = temp / "manual-import.mp4"
    subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=yellow:s=320x180:r=24:d=3,fade=t=in:st=0:d=3", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(manual_media)], check=True)
    rules.register_file(manual_media, title="RC manual import", media_type="video/mp4", origin="manual-import", folder_id=UNSORTED_FOLDER_ID, filename="manual-import.mp4")

    # A separate protected manual asset supports failure-semantics checks.
    protected_path = temp / "protected.bin"
    protected_path.write_bytes(b"protected disposable test asset")
    protected = rules.register_file(protected_path, title="RC protected fixture", media_type="application/octet-stream", origin="manual-import", folder_id=UNSORTED_FOLDER_ID, filename="protected.bin")
    db.save_asset(db.get_asset(protected.id).model_copy(update={"protected": True}))

    (root / "recent-clips-fixture.json").write_text(json.dumps({"createdBy": "tests/acceptance/support/seed_recent_clips.py", "outputAssets": output_records, "protectedAssetId": protected.id, "removableFolderId": removable_folder_id, "sourceCascadeProjectId": source_project_id, "sourceAssetId": source_asset.id, "retainedSourceAssetId": retained_source.id, "retainedSourceProjectId": retained_source_project_id, "historicalProjects": 15}, indent=2))
    shutil.rmtree(temp)
    print(f"Seeded {len(output_records) + 1} playable output assets and 15 stopped historical projects in {root}")


if __name__ == "__main__":
    main()
