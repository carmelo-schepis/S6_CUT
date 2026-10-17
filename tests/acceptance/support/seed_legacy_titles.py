"""Turn a finished isolated-stack job into pre-upgrade Library data.

Run inside the ISOLATED engine container only:
    docker exec -i <engine> python - <job_id> < seed_legacy_titles.py
Rewrites titles to the old "YouTube import — <opening> · Cut NN" pattern,
clears title_source, renames the project to the placeholder, and marks the
last clip's Library title as hand-edited (asset differs from clip), exactly
as older builds stored it. Media, blobs, tags and policy are untouched.
"""

import json
import os
import sys
from pathlib import Path

from engine.database import Database

data = Path(os.environ.get("S6_DATA_PATH", "/app/data"))
db = Database(data / "s6-cut.sqlite3")
job_id = sys.argv[1]
job = db.get_job(job_id)
private = db.get_job_private(job_id)
assert job and job.state == "complete" and job.clips, "job must be complete"
project = db.get_project(job.project_id)
project.name, project.name_is_auto = "YouTube import", False
db.save_project(project)
seeded = []
for position, clip in enumerate(job.clips):
    legacy = f"YouTube import — {' '.join((clip.opening_line or '').split())[:72].rstrip()} · Cut {clip.index:02d}"
    clip.title, clip.title_source, clip.youtube_description = legacy, None, None
    clip.youtube_metadata_status, clip.youtube_metadata_revision = None, 0
    asset = db.get_asset(clip.library_asset_id)
    hand_edited = position == len(job.clips) - 1
    title = "My hand-edited street food title" if hand_edited else legacy
    db.save_asset(asset.model_copy(update={"title": title, "title_source": None, "description": ""}))
    seeded.append({"assetId": asset.id, "clipId": clip.id, "title": title, "handEdited": hand_edited})
db.save_job(job, private)
print(json.dumps({"projectId": project.id, "assets": seeded}))
