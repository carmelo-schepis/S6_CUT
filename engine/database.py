from __future__ import annotations

import json
import math
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Literal, TypeVar

from pydantic import BaseModel

from .models import Asset, Clip, Job, LibraryFolder, Project, ProviderProfile, UNSORTED_LIBRARY_FOLDER_ID, now_iso

# DO-NOT-CHANGE: see DO-NOT-CHANGE/INVARIANTS.md
# Invariants: additive-only migrations, idempotent publication
# bidirectional clip<->asset link, content-addressed blob refs, folder redirects
UNSORTED_FOLDER_ID = UNSORTED_LIBRARY_FOLDER_ID
MAX_FOLDER_DEPTH = 3

T = TypeVar("T", bound=BaseModel)


class MetadataGenerationClaimError(ValueError):
    def __init__(self, category: str, message: str):
        super().__init__(message)
        self.category = category


class _ClosingSQLiteConnection(sqlite3.Connection):
    def __exit__(self, exc_type, exc_value, traceback):
        try:
            return super().__exit__(exc_type, exc_value, traceback)
        finally:
            self.close()


class Database:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self._lock = threading.RLock()
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=30, factory=_ClosingSQLiteConnection)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA busy_timeout=30000")
        return connection

    def _initialize(self) -> None:
        with self._connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS schema_migrations (
                    version INTEGER PRIMARY KEY,
                    applied_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS projects (
                    id TEXT PRIMARY KEY,
                    updated_at TEXT NOT NULL,
                    payload TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL,
                    state TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    private_payload TEXT NOT NULL DEFAULT '{}'
                );
                CREATE INDEX IF NOT EXISTS jobs_project_idx ON jobs(project_id, updated_at DESC);
                CREATE INDEX IF NOT EXISTS jobs_state_idx ON jobs(state, updated_at DESC);
                CREATE TABLE IF NOT EXISTS profiles (
                    id TEXT PRIMARY KEY,
                    selected INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    secret_payload BLOB
                );
                CREATE TABLE IF NOT EXISTS assets (
                    id TEXT PRIMARY KEY,
                    content_hash TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    payload TEXT NOT NULL
                );
                CREATE UNIQUE INDEX IF NOT EXISTS assets_hash_idx ON assets(content_hash);
                CREATE TABLE IF NOT EXISTS analysis_cache (
                    cache_key TEXT PRIMARY KEY,
                    created_at TEXT NOT NULL,
                    payload TEXT NOT NULL
                );
            """)
            self._migrate(db)

# DO-NOT-CHANGE: additive-only migrations — never edit/reorder/delete existing blocks
    def _migrate(self, db: sqlite3.Connection) -> None:
        """Apply additive migrations transactionally; safe to repeat after interruption."""
        version = db.execute("SELECT COALESCE(MAX(version), 0) FROM schema_migrations").fetchone()[0]
        applied_versions = {row[0] for row in db.execute("SELECT version FROM schema_migrations")}
        if version < 1:
            db.execute("INSERT OR IGNORE INTO schema_migrations VALUES(1,?)", (now_iso(),))
        if version < 2:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS library_folders (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL,
                    parent_id TEXT REFERENCES library_folders(id), description TEXT NOT NULL DEFAULT '',
                    color TEXT, archived INTEGER NOT NULL DEFAULT 0, system INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    UNIQUE(parent_id, name_key)
                );
                CREATE UNIQUE INDEX IF NOT EXISTS folder_root_name_idx
                    ON library_folders(name_key) WHERE parent_id IS NULL;
            """)
            stamp = now_iso()
            db.execute("INSERT OR IGNORE INTO library_folders(id,name,name_key,system,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                       (UNSORTED_FOLDER_ID, "Unsorted", "unsorted", 1, stamp, stamp))
            columns = {row[1] for row in db.execute("PRAGMA table_info(assets)")}
            for name, definition in (
                ("folder_id", "TEXT REFERENCES library_folders(id)"), ("origin", "TEXT NOT NULL DEFAULT 'manual-import'"),
                ("blob_id", "TEXT"), ("source_project_id", "TEXT"), ("source_job_id", "TEXT"), ("source_clip_id", "TEXT"),
            ):
                if name not in columns:
                    db.execute(f"ALTER TABLE assets ADD COLUMN {name} {definition}")
            db.execute("UPDATE assets SET folder_id=?, blob_id=content_hash WHERE folder_id IS NULL", (UNSORTED_FOLDER_ID,))
            db.execute("CREATE INDEX IF NOT EXISTS assets_folder_idx ON assets(folder_id, updated_at DESC)")
            db.execute("CREATE INDEX IF NOT EXISTS assets_filter_idx ON assets(origin, updated_at DESC)")
            db.execute("CREATE UNIQUE INDEX IF NOT EXISTS assets_automatic_origin_idx ON assets(origin, COALESCE(source_project_id,''), COALESCE(source_job_id,''), COALESCE(source_clip_id,''), blob_id) WHERE origin <> 'manual-import'")
            for table in ("projects", "jobs"):
                names = {row[1] for row in db.execute(f"PRAGMA table_info({table})")}
                if "library_folder_id" not in names:
                    db.execute(f"ALTER TABLE {table} ADD COLUMN library_folder_id TEXT REFERENCES library_folders(id)")
                db.execute(f"UPDATE {table} SET library_folder_id=? WHERE library_folder_id IS NULL", (UNSORTED_FOLDER_ID,))
            db.execute("INSERT OR IGNORE INTO schema_migrations VALUES(2,?)", (stamp,))
            version = 2
        if version < 3:
            stamp = now_iso()
            db.execute("DROP INDEX IF EXISTS assets_hash_idx")
            db.execute("DROP INDEX IF EXISTS assets_automatic_origin_idx")
            db.executescript("""
                CREATE INDEX IF NOT EXISTS assets_hash_idx ON assets(content_hash);
                CREATE UNIQUE INDEX IF NOT EXISTS assets_source_identity_idx
                    ON assets(origin, source_project_id)
                    WHERE origin='project-source';
                CREATE UNIQUE INDEX IF NOT EXISTS assets_output_identity_idx
                    ON assets(origin, source_project_id, source_job_id, source_clip_id)
                    WHERE origin IN ('generated-clip','script-output');
                CREATE TABLE IF NOT EXISTS media_blobs (
                    id TEXT PRIMARY KEY,
                    content_hash TEXT NOT NULL UNIQUE,
                    relative_path TEXT NOT NULL UNIQUE,
                    byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS media_blob_refs (
                    blob_id TEXT NOT NULL REFERENCES media_blobs(id) ON DELETE RESTRICT,
                    ref_type TEXT NOT NULL CHECK(ref_type IN ('asset','project-source','job-source','clip-output')),
                    ref_id TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY(blob_id, ref_type, ref_id)
                );
                CREATE INDEX IF NOT EXISTS media_blob_refs_target_idx ON media_blob_refs(ref_type, ref_id);
            """)
            rows = db.execute("SELECT id,content_hash,payload FROM assets").fetchall()
            for row in rows:
                try:
                    asset = Asset.model_validate_json(row["payload"])
                    relative = f"library/{asset.id}/{asset.filename}"
                except Exception:
                    relative = f"library/{row['id']}"
                blob_id = row["content_hash"]
                db.execute("INSERT OR IGNORE INTO media_blobs(id,content_hash,relative_path,byte_size,created_at) VALUES(?,?,?,?,?)", (blob_id, row["content_hash"], relative, 0, stamp))
                db.execute("INSERT OR IGNORE INTO media_blob_refs(blob_id,ref_type,ref_id,created_at) VALUES(?,?,?,?)", (blob_id, "asset", row["id"], stamp))
            db.execute("INSERT OR IGNORE INTO schema_migrations VALUES(3,?)", (stamp,))
            version = 3
        if version < 4:
            stamp = now_iso()
            columns = {row[1] for row in db.execute("PRAGMA table_info(library_folders)")}
            if "deleted" not in columns:
                db.execute("ALTER TABLE library_folders ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS library_folder_redirects (
                    folder_id TEXT PRIMARY KEY REFERENCES library_folders(id) ON DELETE RESTRICT,
                    destination_id TEXT NOT NULL REFERENCES library_folders(id) ON DELETE RESTRICT,
                    created_at TEXT NOT NULL
                );
            """)
            db.execute("INSERT OR IGNORE INTO schema_migrations VALUES(4,?)", (stamp,))
        # Check membership as well as the maximum: an interrupted/recovered
        # database can contain a newer migration while an earlier one is
        # missing, and profile payloads still need that earlier rewrite.
        if version < 5 or 5 not in applied_versions:
            stamp = now_iso()
            # Provider profiles used to combine text settings with a second
            # provider's credential and voice. Rewrite only the profile JSON;
            # jobs, projects, media, and the encryption key remain untouched.
            for row in db.execute("SELECT id, payload FROM profiles").fetchall():
                try:
                    old = json.loads(row["payload"])
                except (TypeError, ValueError, json.JSONDecodeError):
                    continue
                if "textModelId" in old or "textStatus" in old:
                    continue
                openrouter_configured = bool(old.get("openrouterConfigured"))
                text_status = old.get("openrouterStatus", "configured" if openrouter_configured else "not_configured")
                if text_status in {"unavailable_model_or_voice", "unsupported_model_or_voice"}:
                    text_status = "unavailable"
                new = {
                    "id": old.get("id", row["id"]), "name": old.get("name", "Provider profile"),
                    "textModelId": old.get("modelId", "openai/gpt-4.1-mini"), "selected": bool(old.get("selected")),
                    "persistence": old.get("persistence", "encrypted"),
                    "openrouterConfigured": openrouter_configured,
                    "openrouterMasked": old.get("openrouterMasked"), "textStatus": text_status,
                    "textMessage": old.get("openrouterMessage"),
                    "textLastCheckedAt": old.get("openrouterLastCheckedAt"),
                    "status": "partial" if text_status == "connected" else ("configured" if openrouter_configured else "local only"),
                    "capabilities": [item for item in old.get("capabilities", []) if "eleven" not in str(item).casefold()],
                    "fallbacks": old.get("fallbacks", {}),
                }
                db.execute("UPDATE profiles SET payload=? WHERE id=?", (json.dumps(new, separators=(",", ":")), row["id"]))
            for row in db.execute("SELECT id, payload FROM jobs").fetchall():
                try:
                    old_job = json.loads(row["payload"])
                except (TypeError, ValueError, json.JSONDecodeError):
                    continue
                changed = False
                for step in old_job.get("steps", []) if isinstance(old_job, dict) else []:
                    if isinstance(step, dict) and step.get("id") == "elevenlabs":
                        step["id"] = "legacy-media"
                        step["label"] = "Legacy media step"
                        if isinstance(step.get("detail"), str):
                            step["detail"] = "Legacy media step"
                        changed = True
                if changed:
                    db.execute("UPDATE jobs SET payload=? WHERE id=?", (json.dumps(old_job, separators=(",", ":")), row["id"]))
            db.execute("INSERT OR IGNORE INTO schema_migrations VALUES(5,?)", (stamp,))
        if version < 6 or 6 not in applied_versions:
            stamp = now_iso()
            columns = {row[1] for row in db.execute("PRAGMA table_info(projects)")}
            if "library_deleted" not in columns:
                db.execute("ALTER TABLE projects ADD COLUMN library_deleted INTEGER NOT NULL DEFAULT 0")
            db.execute("INSERT OR IGNORE INTO schema_migrations VALUES(6,?)", (stamp,))
        if version < 7 or 7 not in applied_versions:
            # Legacy installations could lose Library asset rows while leaving
            # their project/job history behind. Those projects are proven
            # orphaned when no asset still points at their project id. Keep the
            # history for explicit cleanup/recovery, but exclude it everywhere
            # the recent-project list is read.
            db.execute("UPDATE projects SET library_deleted=1 WHERE NOT EXISTS (SELECT 1 FROM assets WHERE assets.source_project_id=projects.id)")
            db.execute("INSERT OR IGNORE INTO schema_migrations VALUES(7,?)", (now_iso(),))
        if version < 8 or 8 not in applied_versions:
            # Long form always renders through the fast pipeline, whatever
            # processing mode was picked. Jobs written before that decision was
            # unified kept the eleven-step smart checklist, so the fast renderer
            # asked them for a 'plan' step they did not have and failed on every
            # retry. Reshape those rows to the fast checklist, carrying the
            # status each shared step had already earned. Complete jobs are left
            # exactly as they are, and no clip, asset or blob is touched.
            fast_labels = {
                "source": "Source received", "probe": "Video validated", "plan": "Cut points planned",
                "render": "Clips rendered and saved", "verify": "Outputs verified", "ready": "Project ready",
            }
            for row in db.execute("SELECT id, payload FROM jobs").fetchall():
                try:
                    old_job = json.loads(row["payload"])
                except (TypeError, ValueError, json.JSONDecodeError):
                    continue
                if not isinstance(old_job, dict) or old_job.get("mode") != "clip" or old_job.get("state") == "complete":
                    continue
                if not (old_job.get("contentFormat") == "long" or old_job.get("processingMode") == "fast"):
                    continue
                steps = old_job.get("steps") or []
                carried = {step.get("id"): step for step in steps if isinstance(step, dict)}
                if not carried or set(carried) == set(fast_labels):
                    continue
                old_job["steps"] = [
                    {**carried[step_id], "id": step_id, "label": label} if step_id in carried
                    else {"id": step_id, "label": label, "status": "pending", "detail": None,
                          "currentItem": None, "totalItems": None, "startedAt": None, "completedAt": None}
                    for step_id, label in fast_labels.items()
                ]
                db.execute("UPDATE jobs SET payload=? WHERE id=?", (json.dumps(old_job, separators=(",", ":")), row["id"]))
            db.execute("INSERT OR IGNORE INTO schema_migrations VALUES(8,?)", (now_iso(),))
        if version < 9 or 9 not in applied_versions:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS deleted_output_assets (
                    origin TEXT NOT NULL,
                    source_project_id TEXT NOT NULL,
                    source_job_id TEXT NOT NULL,
                    source_clip_id TEXT NOT NULL,
                    deleted_at TEXT NOT NULL,
                    PRIMARY KEY(origin, source_project_id, source_job_id, source_clip_id)
                );
            """)
            db.execute("INSERT OR IGNORE INTO schema_migrations VALUES(9,?)", (now_iso(),))
        if version < 10 or 10 not in applied_versions:
            stamp = now_iso()
            for row in db.execute("SELECT id, payload FROM profiles").fetchall():
                try:
                    profile = json.loads(row["payload"])
                except (TypeError, ValueError, json.JSONDecodeError):
                    continue
                if isinstance(profile, dict) and profile.get("ttsMessage") is not None:
                    profile["ttsMessage"] = None
                    db.execute("UPDATE profiles SET payload=? WHERE id=?", (json.dumps(profile, separators=(",", ":")), row["id"]))
            for row in db.execute("SELECT id, payload FROM jobs").fetchall():
                try:
                    job = json.loads(row["payload"])
                except (TypeError, ValueError, json.JSONDecodeError):
                    continue
                changed = False
                for step in job.get("steps", []) if isinstance(job, dict) else []:
                    if isinstance(step, dict) and str(step.get("id", "")).casefold() in {"tts", "elevenlabs", "local_voice"}:
                        step["id"] = "legacy-media"
                        step["label"] = "Legacy media step"
                        if isinstance(step.get("detail"), str):
                            step["detail"] = "Legacy media step"
                        changed = True
                if changed:
                    db.execute("UPDATE jobs SET payload=? WHERE id=?", (json.dumps(job, separators=(",", ":")), row["id"]))
            db.execute("INSERT OR IGNORE INTO schema_migrations VALUES(10,?)", (stamp,))
        if version < 11 or 11 not in applied_versions:
            stamp = now_iso()
            retired_profile_fields = {"ttsModelId", "ttsVoice", "ttsSpeed", "ttsStatus", "ttsMessage", "ttsLastCheckedAt"}
            for row in db.execute("SELECT id, payload FROM profiles").fetchall():
                try:
                    profile = json.loads(row["payload"])
                except (TypeError, ValueError, json.JSONDecodeError):
                    continue
                if isinstance(profile, dict) and retired_profile_fields.intersection(profile):
                    for field in retired_profile_fields:
                        profile.pop(field, None)
                    db.execute("UPDATE profiles SET payload=? WHERE id=?", (json.dumps(profile, separators=(",", ":")), row["id"]))
            db.execute("INSERT OR IGNORE INTO schema_migrations VALUES(11,?)", (stamp,))
        if version < 12 or 12 not in applied_versions:
            stamp = now_iso()
            # Existing Library assets are not eligible for automatic B-roll by
            # default. Explicit opt-in is stored in the canonical model payload.
            for row in db.execute("SELECT id,payload FROM assets").fetchall():
                try:
                    asset = json.loads(row["payload"])
                except (TypeError, ValueError, json.JSONDecodeError):
                    continue
                if isinstance(asset, dict) and "videoOverlayEligible" not in asset:
                    asset["videoOverlayEligible"] = False
                    db.execute("UPDATE assets SET payload=? WHERE id=?", (json.dumps(asset, separators=(",", ":")), row["id"]))
            db.execute("INSERT OR IGNORE INTO schema_migrations VALUES(12,?)", (stamp,))

    @staticmethod
    def _json(model: BaseModel) -> str:
        return model.model_dump_json(by_alias=True)

    def save_project(self, project: Project) -> None:
        with self._lock, self._connect() as db:
            folder_id = project.library_folder_id or UNSORTED_FOLDER_ID
            db.execute("INSERT INTO projects(id,updated_at,payload,library_folder_id) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,payload=excluded.payload,library_folder_id=excluded.library_folder_id", (project.id, project.updated_at, self._json(project), folder_id))

    def resolve_folder_id(self, folder_id: str | None) -> str:
        current = folder_id or UNSORTED_FOLDER_ID
        with self._connect() as db:
            seen: set[str] = set()
            while current not in seen:
                seen.add(current)
                row = db.execute("SELECT destination_id FROM library_folder_redirects WHERE folder_id=?", (current,)).fetchone()
                if not row:
                    break
                current = str(row["destination_id"])
        return current

    def get_project(self, project_id: str) -> Project | None:
        with self._connect() as db:
            row = db.execute("SELECT payload,library_folder_id FROM projects WHERE id=?", (project_id,)).fetchone()
        return Project.model_validate_json(row["payload"]).model_copy(update={"library_folder_id": self.resolve_folder_id(row["library_folder_id"])}) if row else None

    def list_projects(self) -> list[Project]:
        # The state list is "work can still continue from here", not "work is
        # running": `paused` and `stalled` are already listed for that reason.
        # `cancelled_kept` belongs with them — the Workspace offers Retry import
        # for it (workspace-view.tsx), gated on the *download* phase, which is
        # exactly when the project has published no asset yet. Omitting it hid a
        # stopped import from its own retry control and, because the shell then
        # fell back to the newest project, silently moved the customer into an
        # unrelated project's Workspace.
        with self._connect() as db:
            rows = db.execute("""
                SELECT payload,library_folder_id FROM projects
                WHERE library_deleted=0
                  AND (
                    json_extract(payload, '$.state') IN ('queued','active','paused','recovered','stalled','cancelled_kept')
                    OR EXISTS (SELECT 1 FROM assets WHERE assets.source_project_id=projects.id)
                  )
                ORDER BY updated_at DESC
            """).fetchall()
        return [Project.model_validate_json(row["payload"]).model_copy(update={"library_folder_id": self.resolve_folder_id(row["library_folder_id"])}) for row in rows]

    # Merge durable metadata that another writer (Library/Workspace edit, bulk
    # retitle, per-clip generation) committed after this writer loaded its job.
    # Used by save_job and publish_clip_output so a worker's stale in-memory job
    # never reverts a title edit or resets the metadata budget counters.
    @staticmethod
    def _merge_saved_metadata(existing: sqlite3.Row, job: Job, private: dict[str, Any] | None, skip_clip_id: str | None = None) -> None:
        if private is not None:
            saved_private = json.loads(existing["private_payload"])
            for key in ("youtube_metadata_generation_calls", "youtube_metadata_spend_estimate_usd"):
                try:
                    old_value = saved_private.get(key, 0) or 0
                    new_value = private.get(key, 0) or 0
                    private[key] = max(int(old_value), int(new_value)) if key.endswith("_calls") else max(float(old_value), float(new_value))
                except (TypeError, ValueError):
                    private[key] = saved_private.get(key, private.get(key, 0))
            for key in ("youtube_metadata_cache",):
                saved_values = saved_private.get(key)
                new_values = private.get(key)
                if isinstance(saved_values, dict) or isinstance(new_values, dict):
                    private[key] = {**(saved_values if isinstance(saved_values, dict) else {}), **(new_values if isinstance(new_values, dict) else {})}
            key = "youtube_metadata_generation"
            saved_states = saved_private.get(key)
            new_states = private.get(key)
            if isinstance(saved_states, dict) or isinstance(new_states, dict):
                merged_states = dict(saved_states) if isinstance(saved_states, dict) else {}
                priority = {"in_flight": 0, "unavailable": 1, "fallback": 1, "generated": 2}
                for clip_id, state in (new_states.items() if isinstance(new_states, dict) else ()):
                    saved_state = merged_states.get(clip_id)
                    saved_stamp = saved_state.get("updated_at", saved_state.get("started_at", 0)) if isinstance(saved_state, dict) else 0
                    new_stamp = state.get("updated_at", state.get("started_at", 0)) if isinstance(state, dict) else 0
                    if not isinstance(saved_stamp, (int, float)):
                        saved_stamp = 0
                    if not isinstance(new_stamp, (int, float)):
                        new_stamp = 0
                    if not isinstance(saved_state, dict) or not isinstance(state, dict) or new_stamp > saved_stamp or (new_stamp == saved_stamp and priority.get(state.get("status"), 0) >= priority.get(saved_state.get("status"), 0)):
                        merged_states[clip_id] = state
                private[key] = merged_states
        saved_job = Job.model_validate_json(existing["payload"])
        saved_clips = {clip.id: clip for clip in saved_job.clips}
        for clip in job.clips:
            saved_clip = saved_clips.get(clip.id)
            if not saved_clip or clip.id == skip_clip_id:
                continue
            saved_priority = {None: 0, "pending": 1, "unavailable": 2, "fallback": 2, "generated": 3}
            if saved_clip.youtube_metadata_revision > clip.youtube_metadata_revision or (saved_clip.youtube_metadata_revision > 0 and saved_clip.youtube_metadata_revision == clip.youtube_metadata_revision) or saved_priority.get(saved_clip.youtube_metadata_status, 0) > saved_priority.get(clip.youtube_metadata_status, 0):
                for field in ("title", "title_source", "youtube_description", "youtube_metadata_revision", "youtube_metadata_status", "youtube_metadata_reason", "youtube_metadata_model", "youtube_metadata_generated_at", "youtube_metadata_input_tokens", "youtube_metadata_output_tokens", "youtube_metadata_cost_usd", "youtube_metadata_cost_kind"):
                    setattr(clip, field, getattr(saved_clip, field))

    def save_job(self, job: Job, private: dict[str, Any] | None = None) -> None:
        with self._lock, self._connect() as db:
            existing = db.execute("SELECT payload,private_payload FROM jobs WHERE id=?", (job.id,)).fetchone()
            if existing:
                self._merge_saved_metadata(existing, job, private)
            private_json = json.dumps(private, separators=(",", ":")) if private is not None else (existing["private_payload"] if existing else "{}")
            folder_id = job.library_folder_id or UNSORTED_FOLDER_ID
            db.execute("INSERT INTO jobs(id,project_id,state,updated_at,payload,private_payload,library_folder_id) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,state=excluded.state,updated_at=excluded.updated_at,payload=excluded.payload,private_payload=excluded.private_payload,library_folder_id=excluded.library_folder_id", (job.id, job.project_id, job.state, job.updated_at, self._json(job), private_json, folder_id))

    def get_job(self, job_id: str) -> Job | None:
        with self._connect() as db:
            row = db.execute("SELECT payload,library_folder_id FROM jobs WHERE id=?", (job_id,)).fetchone()
        return Job.model_validate_json(row["payload"]).model_copy(update={"library_folder_id": row["library_folder_id"] or UNSORTED_FOLDER_ID}) if row else None

    def get_job_private(self, job_id: str) -> dict[str, Any]:
        with self._connect() as db:
            row = db.execute("SELECT private_payload FROM jobs WHERE id=?", (job_id,)).fetchone()
        return json.loads(row["private_payload"]) if row else {}

    def list_jobs(self, states: tuple[str, ...] | None = None) -> list[Job]:
        with self._connect() as db:
            if states:
                marks = ",".join("?" for _ in states)
                rows = db.execute(f"SELECT payload,library_folder_id FROM jobs WHERE state IN ({marks}) ORDER BY updated_at DESC", states).fetchall()
            else:
                rows = db.execute("SELECT payload,library_folder_id FROM jobs ORDER BY updated_at DESC").fetchall()
        return [Job.model_validate_json(row["payload"]).model_copy(update={"library_folder_id": row["library_folder_id"] or UNSORTED_FOLDER_ID}) for row in rows]

    def list_jobs_page(self, *, limit: int, offset: int = 0, exclude_states: tuple[str, ...] = ()) -> tuple[list[Job], int]:
        """One bounded page of jobs, newest first, with the total that match.

        The mobile overview polls every few seconds, so it must not parse the
        whole job history the way `list_jobs` does.
        """
        where, values = "", tuple(exclude_states)
        if values:
            where = " WHERE state NOT IN (" + ",".join("?" for _ in values) + ")"
        with self._connect() as db:
            total = int(db.execute("SELECT COUNT(*) FROM jobs" + where, values).fetchone()[0])
            rows = db.execute("SELECT payload,library_folder_id FROM jobs" + where + " ORDER BY updated_at DESC LIMIT ? OFFSET ?", (*values, limit, offset)).fetchall()
        jobs = [Job.model_validate_json(row["payload"]).model_copy(update={"library_folder_id": row["library_folder_id"] or UNSORTED_FOLDER_ID}) for row in rows]
        return jobs, total

    def count_jobs_since(self, state: str, since: str) -> int:
        with self._connect() as db:
            return int(db.execute("SELECT COUNT(*) FROM jobs WHERE state=? AND updated_at>=?", (state, since)).fetchone()[0])

    def count_generated_clips_since(self, since: str) -> int:
        """Library clips published since `since` (assets store their creation time as updated_at)."""
        with self._connect() as db:
            return int(db.execute("SELECT COUNT(*) FROM assets WHERE origin='generated-clip' AND updated_at>=?", (since,)).fetchone()[0])

    def project_source_assets(self, project_ids: list[str]) -> dict[str, Asset]:
        """The registered `project-source` asset for each project that has one."""
        ids = sorted(set(project_ids))
        if not ids:
            return {}
        marks = ",".join("?" for _ in ids)
        with self._connect() as db:
            rows = db.execute(f"SELECT * FROM assets WHERE origin='project-source' AND source_project_id IN ({marks})", ids).fetchall()
        return {str(row["source_project_id"]): self._asset_from_row(row) for row in rows}

    def save_profile(self, profile: ProviderProfile, secret_payload: bytes | None = None) -> None:
        with self._lock, self._connect() as db:
            if profile.selected:
                db.execute("UPDATE profiles SET selected=0")
            existing = db.execute("SELECT secret_payload FROM profiles WHERE id=?", (profile.id,)).fetchone()
            secret = secret_payload if secret_payload is not None else (existing["secret_payload"] if existing else None)
            db.execute("INSERT INTO profiles(id,selected,updated_at,payload,secret_payload) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET selected=excluded.selected,updated_at=excluded.updated_at,payload=excluded.payload,secret_payload=excluded.secret_payload", (profile.id, int(profile.selected), profile.model_dump().get("updated_at", "") or "now", self._json(profile), secret))

    def list_profiles(self) -> list[ProviderProfile]:
        with self._connect() as db:
            rows = db.execute("SELECT payload, selected FROM profiles ORDER BY selected DESC, updated_at DESC").fetchall()
        values: list[ProviderProfile] = []
        for row in rows:
            profile = ProviderProfile.model_validate_json(row["payload"])
            profile.selected = bool(row["selected"])
            values.append(profile)
        return values

    def get_profile(self, profile_id: str) -> tuple[ProviderProfile, bytes | None] | None:
        with self._connect() as db:
            row = db.execute("SELECT payload,selected,secret_payload FROM profiles WHERE id=?", (profile_id,)).fetchone()
        if not row:
            return None
        profile = ProviderProfile.model_validate_json(row["payload"])
        profile.selected = bool(row["selected"])
        return profile, row["secret_payload"]

    def delete_profile(self, profile_id: str) -> None:
        with self._connect() as db:
            db.execute("DELETE FROM profiles WHERE id=?", (profile_id,))

    def replace_profile_secret(self, profile_id: str, secret_payload: bytes) -> None:
        """Replace one profile's encrypted secret during provider migration."""
        with self._lock, self._connect() as db:
            db.execute("UPDATE profiles SET secret_payload=? WHERE id=?", (secret_payload, profile_id))

    def save_asset(self, asset: Asset) -> None:
        with self._lock, self._connect() as db:
            folder_id = asset.folder_id or UNSORTED_FOLDER_ID
            blob_id = asset.blob_id or asset.content_hash
            db.execute("INSERT INTO assets(id,content_hash,updated_at,payload,folder_id,origin,blob_id,source_project_id,source_job_id,source_clip_id) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET content_hash=excluded.content_hash,updated_at=excluded.updated_at,payload=excluded.payload,folder_id=excluded.folder_id,origin=excluded.origin,blob_id=excluded.blob_id,source_project_id=excluded.source_project_id,source_job_id=excluded.source_job_id,source_clip_id=excluded.source_clip_id", (asset.id, asset.content_hash, asset.created_at, self._json(asset), folder_id, asset.origin, blob_id, asset.source_project_id, asset.source_job_id, asset.source_clip_id))

    @staticmethod
    def _asset_from_row(row: sqlite3.Row) -> Asset:
        return Asset.model_validate_json(row["payload"]).model_copy(update={
            "folder_id": row["folder_id"] or UNSORTED_FOLDER_ID,
            "origin": row["origin"], "blob_id": row["blob_id"] or row["content_hash"],
        })

    def get_asset(self, asset_id: str) -> Asset | None:
        with self._connect() as db:
            row = db.execute("SELECT * FROM assets WHERE id=?", (asset_id,)).fetchone()
        return self._asset_from_row(row) if row else None

    def claim_youtube_metadata_generation(self, job_id: str, clip_id: str, expected_revision: int, model_id: str, reserve_usd: float):
        """Atomically reserve a bounded provider request and claim one clip."""
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT payload,library_folder_id,private_payload FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not row:
                raise MetadataGenerationClaimError("missing", "The job is no longer available")
            job = Job.model_validate_json(row["payload"]).model_copy(update={"library_folder_id": row["library_folder_id"] or UNSORTED_FOLDER_ID})
            clip = next((item for item in job.clips if item.id == clip_id), None)
            if not clip or clip.youtube_metadata_revision != expected_revision:
                raise MetadataGenerationClaimError("stale", "Metadata changed before generation could start")
            private = json.loads(row["private_payload"])
            state = private.setdefault("youtube_metadata_generation", {})
            if not isinstance(state, dict):
                state = private["youtube_metadata_generation"] = {}
            prior = state.get(clip_id)
            if isinstance(prior, dict) and prior.get("status") == "in_flight":
                started_at = prior.get("started_at")
                if not isinstance(started_at, (int, float)) or time.time() - started_at < 120:
                    raise MetadataGenerationClaimError("in_flight", "Metadata generation is already in flight")
            calls = private.get("youtube_metadata_generation_calls", 0)
            if type(calls) is not int or calls < 0 or calls >= 5:
                raise MetadataGenerationClaimError("limit", "The five-request per-job metadata limit was reached")
            try:
                spent = float(private.get("youtube_metadata_spend_estimate_usd", 0) or 0)
            except (TypeError, ValueError):
                spent = 0.05
            if not math.isfinite(spent) or spent < 0 or spent + reserve_usd > 0.05:
                raise MetadataGenerationClaimError("budget", "The conservative $0.05 metadata budget is exhausted")
            private["youtube_metadata_generation_calls"] = calls + 1
            private["youtube_metadata_spend_estimate_usd"] = spent + reserve_usd
            state[clip_id] = {"status": "in_flight", "model": model_id, "revision": expected_revision, "started_at": time.time(), "updated_at": time.time()}
            clip.youtube_metadata_status = "pending"
            clip.youtube_metadata_model = model_id
            job.updated_at = now_iso()
            db.execute("UPDATE jobs SET updated_at=?,payload=?,private_payload=? WHERE id=?", (job.updated_at, self._json(job), json.dumps(private, separators=(",", ":")), job_id))
            return job, private, clip

    def update_generated_clip_metadata(
        self, asset_id: str, title: str, description: str, expected_revision: int, *,
        model_id: str | None = None, generated_at: str | None = None,
        input_tokens: int | None = None, output_tokens: int | None = None,
        cost_usd: float | None = None, cost_kind: str | None = None,
        metadata_status: Literal["generated", "fallback", "unavailable"] = "generated",
        metadata_reason: str | None = None,
        title_source: Literal["auto", "ai", "user"] | None = None,
    ) -> tuple[Asset, Job, Clip]:
        """Atomically update a generated asset and its linked clip metadata."""
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            asset_row = db.execute("SELECT * FROM assets WHERE id=?", (asset_id,)).fetchone()
            if not asset_row:
                raise KeyError(asset_id)
            asset = self._asset_from_row(asset_row)
            if asset.origin != "generated-clip" or not asset.source_job_id or not asset.source_clip_id:
                raise ValueError("Metadata edits require a linked generated clip")
            job_row = db.execute("SELECT payload,library_folder_id,private_payload FROM jobs WHERE id=?", (asset.source_job_id,)).fetchone()
            if not job_row:
                raise ValueError("The linked job is unavailable")
            job = Job.model_validate_json(job_row["payload"]).model_copy(update={"library_folder_id": job_row["library_folder_id"] or UNSORTED_FOLDER_ID})
            clip = next((item for item in job.clips if item.id == asset.source_clip_id), None)
            if not clip or clip.library_asset_id != asset.id:
                raise ValueError("The generated clip and Library asset link is inconsistent")
            if clip.youtube_metadata_revision != expected_revision:
                raise ValueError("YouTube metadata revision is stale")
            stamp = now_iso()
            source_update = {"title_source": title_source} if title_source else {}
            updated_asset = asset.model_copy(update={"title": title, "description": description, **source_update})
            updated_clip = clip.model_copy(update={
                "title": title, "youtube_description": description[:500], **source_update,
                "youtube_metadata_revision": clip.youtube_metadata_revision + 1,
                "youtube_metadata_status": metadata_status,
                "youtube_metadata_reason": metadata_reason,
                **({
                    "youtube_metadata_model": model_id,
                    "youtube_metadata_generated_at": generated_at,
                    "youtube_metadata_input_tokens": input_tokens,
                    "youtube_metadata_output_tokens": output_tokens,
                    "youtube_metadata_cost_usd": cost_usd,
                    "youtube_metadata_cost_kind": cost_kind,
                } if generated_at is not None else {}),
            })
            job.clips = [updated_clip if item.id == clip.id else item for item in job.clips]
            job.updated_at = stamp
            db.execute("UPDATE assets SET updated_at=?,payload=? WHERE id=?", (stamp, self._json(updated_asset), asset.id))
            db.execute("UPDATE jobs SET updated_at=?,payload=? WHERE id=?", (stamp, self._json(job), job.id))
            self.validate_clip_asset_relationship(updated_clip, updated_asset)
            return updated_asset, job, updated_clip

    def get_asset_by_hash(self, content_hash: str) -> Asset | None:
        with self._connect() as db:
            row = db.execute("SELECT * FROM assets WHERE content_hash=? ORDER BY updated_at LIMIT 1", (content_hash,)).fetchone()
        return self._asset_from_row(row) if row else None

    def validate_clip_asset_relationship(self, clip: Clip, asset: Asset | None) -> str | None:
        """Validate the Clip Board ↔ Media Library bidirectional relationship.

        Returns ``None`` when the pair is consistent, otherwise a human-readable
        reason.  Used by publication and by repair/observability paths to enforce
        the invariant: a ready clip must have its linked asset, and an automatic
        asset must point back at its source clip.
        """
        if clip.state == "complete" and clip.library_asset_id is None:
            return "Clip is ready but has no linked Library asset"
        if clip.library_asset_id is None:
            return None
        if asset is None:
            asset = self.get_asset(clip.library_asset_id)
        if asset is None:
            return "Clip references a Library asset that does not exist"
        if asset.source_clip_id != clip.id:
            return "Asset does not point back at its source clip"
        if clip.blob_id and asset.blob_id and clip.blob_id != asset.blob_id:
            return "Clip and asset reference different blobs"
        return None

    def get_generated_asset(self, origin: str, project_id: str, job_id: str, clip_id: str) -> Asset | None:
        """Look up the automatic asset for a generated output by its stable identity.

        Mirrors the ``assets_output_identity_idx`` unique key used at publication so
        callers can validate the bidirectional clip <-> asset relationship.
        """
        with self._connect() as db:
            row = db.execute(
                "SELECT * FROM assets WHERE origin=? AND source_project_id=? AND source_job_id=? AND source_clip_id=?",
                (origin, project_id, job_id, clip_id),
            ).fetchone()
        return self._asset_from_row(row) if row else None

    # DO-NOT-CHANGE: idempotent — must keep existing metadata (title, tags, policy, folder)
    # when the stable identity (origin, project, job, clip) already exists
    def register_blob_asset(self, asset: Asset, relative_path: str, byte_size: int) -> Asset:
        """Atomically bind a published blob, durable references, and one idempotent asset."""
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            stamp = now_iso()
            asset.folder_id = self.resolve_folder_id(asset.folder_id)
            requested_job_id = asset.source_job_id
            requested_clip_id = asset.source_clip_id
            db.execute(
                "INSERT INTO media_blobs(id,content_hash,relative_path,byte_size,created_at) VALUES(?,?,?,?,?) "
                "ON CONFLICT(id) DO UPDATE SET relative_path=excluded.relative_path,byte_size=excluded.byte_size",
                (asset.blob_id, asset.content_hash, relative_path, byte_size, stamp),
            )
            if asset.source_project_id:
                db.execute("UPDATE projects SET library_deleted=0 WHERE id=?", (asset.source_project_id,))
            if asset.origin == "project-source":
                row = db.execute("SELECT * FROM assets WHERE origin=? AND source_project_id=?", (asset.origin, asset.source_project_id)).fetchone()
            elif asset.origin in {"generated-clip", "script-output"}:
                row = db.execute(
                    "SELECT * FROM assets WHERE origin=? AND source_project_id=? AND source_job_id=? AND source_clip_id=?",
                    (asset.origin, asset.source_project_id, asset.source_job_id, asset.source_clip_id),
                ).fetchone()
            else:
                row = db.execute("SELECT * FROM assets WHERE origin='manual-import' AND content_hash=?", (asset.content_hash,)).fetchone()
            if row:
                existing = self._asset_from_row(row)
                if existing.blob_id != asset.blob_id:
                    db.execute("DELETE FROM media_blob_refs WHERE ref_type='asset' AND ref_id=?", (existing.id,))
                asset = asset.model_copy(update={
                    "id": existing.id, "created_at": existing.created_at,
                    "title": existing.title, "description": existing.description,
                    "folder_id": existing.folder_id, "tags": existing.tags,
                    "brands": existing.brands, "people": existing.people,
                    "triggers": existing.triggers, "aliases": existing.aliases,
                    "negative_triggers": existing.negative_triggers, "policy": existing.policy,
                    "protected": existing.protected, "min_spacing_seconds": existing.min_spacing_seconds,
                    "starred": existing.starred,
                    "max_uses_per_project": existing.max_uses_per_project,
                    "active_from": existing.active_from, "active_until": existing.active_until,
                    "licence": existing.licence, "attribution": existing.attribution,
                    "title_source": existing.title_source,
                    "source_project_id": existing.source_project_id,
                    "source_job_id": existing.source_job_id,
                    "source_clip_id": existing.source_clip_id,
                })
            db.execute(
                "INSERT INTO assets(id,content_hash,updated_at,payload,folder_id,origin,blob_id,source_project_id,source_job_id,source_clip_id) VALUES(?,?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(id) DO UPDATE SET content_hash=excluded.content_hash,updated_at=excluded.updated_at,payload=excluded.payload,folder_id=excluded.folder_id,origin=excluded.origin,blob_id=excluded.blob_id,source_project_id=excluded.source_project_id,source_job_id=excluded.source_job_id,source_clip_id=excluded.source_clip_id",
                (asset.id, asset.content_hash, stamp, self._json(asset), asset.folder_id, asset.origin, asset.blob_id, asset.source_project_id, asset.source_job_id, asset.source_clip_id),
            )
            refs = [("asset", asset.id)]
            if asset.origin in {"generated-clip", "script-output"}:
                db.execute("DELETE FROM media_blob_refs WHERE ref_type='clip-output' AND ref_id=?", (str(requested_clip_id),))
            if asset.origin == "project-source":
                refs.extend((("project-source", str(asset.source_project_id)), ("job-source", str(requested_job_id))))
            elif asset.origin in {"generated-clip", "script-output"}:
                refs.append(("clip-output", str(requested_clip_id)))
            for ref_type, ref_id in refs:
                db.execute("INSERT OR IGNORE INTO media_blob_refs(blob_id,ref_type,ref_id,created_at) VALUES(?,?,?,?)", (asset.blob_id, ref_type, ref_id, stamp))
        return asset

    def validate_publication_folder(self, folder_id: str | None, job: Job) -> tuple[str, str | None]:
        """Resolve the effective folder ID for publication.

        Returns (resolved_folder_id, warning_or_None).
        Falls back to Unsorted with a warning when the folder is archived, deleted, or missing.
        """
        effective = folder_id or UNSORTED_FOLDER_ID
        folder = self.get_folder(effective)
        if folder and (folder.archived or folder.deleted):
            return UNSORTED_FOLDER_ID, f"Business folder '{folder.name}' was archived or removed; assets published to Unsorted."
        if not folder:
            return UNSORTED_FOLDER_ID, "Selected business folder no longer exists; assets published to Unsorted."
        return effective, None

    # DO-NOT-CHANGE: atomic bidirectional publication — one BEGIN IMMEDIATE transaction
    # clip.library_asset_id == asset.id AND asset.source_clip_id == clip.id (validated inline)
    def publish_clip_output(
        self,
        job: Job,
        clip: Clip,
        asset: Asset,
        relative_path: str,
        byte_size: int,
        *,
        private: dict[str, Any] | None = None,
    ) -> tuple[Job, Clip, Asset]:
        """Atomically publish a validated clip output: blob, asset, clip fields, and job checkpoint.

        All database writes happen in one SQLite transaction.  After this method
        returns the clip is considered fully published – both the Clip Board and
        Media Library records are committed, and the job checkpoint is advanced.

        The bidirectional relationship is validated:
        - clip.library_asset_id == asset.id
        - asset.source_clip_id == clip.id

        Returns the updated (job, clip, asset) with final state.
        """
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            stamp = now_iso()

            # 1. Upsert the media_blob
            db.execute(
                "INSERT INTO media_blobs(id,content_hash,relative_path,byte_size,created_at) VALUES(?,?,?,?,?) "
                "ON CONFLICT(id) DO UPDATE SET relative_path=excluded.relative_path,byte_size=excluded.byte_size",
                (asset.blob_id, asset.content_hash, relative_path, byte_size, stamp),
            )

            # 2. Idempotent asset upsert by (origin, source_project_id, source_job_id, source_clip_id)
            existing_row = db.execute(
                "SELECT * FROM assets WHERE origin=? AND source_project_id=? AND source_job_id=? AND source_clip_id=?",
                (asset.origin, asset.source_project_id, asset.source_job_id, asset.source_clip_id),
            ).fetchone()

            if existing_row:
                existing = self._asset_from_row(existing_row)
                if existing.blob_id != asset.blob_id:
                    db.execute("DELETE FROM media_blob_refs WHERE ref_type='asset' AND ref_id=?", (existing.id,))
                # Merge: keep existing metadata, update output fields
                asset = asset.model_copy(update={
                    "id": existing.id, "created_at": existing.created_at,
                    "title": existing.title, "description": existing.description,
                    "folder_id": existing.folder_id, "tags": existing.tags,
                    "brands": existing.brands, "people": existing.people,
                    "triggers": existing.triggers, "aliases": existing.aliases,
                    "negative_triggers": existing.negative_triggers, "policy": existing.policy,
                    "protected": existing.protected, "min_spacing_seconds": existing.min_spacing_seconds,
                    "starred": existing.starred,
                    "max_uses_per_project": existing.max_uses_per_project,
                    "active_from": existing.active_from, "active_until": existing.active_until,
                    "licence": existing.licence, "attribution": existing.attribution,
                    "title_source": existing.title_source,
                    "source_project_id": existing.source_project_id,
                    "source_job_id": existing.source_job_id,
                    "source_clip_id": existing.source_clip_id,
                })

            db.execute(
                "INSERT INTO assets(id,content_hash,updated_at,payload,folder_id,origin,blob_id,source_project_id,source_job_id,source_clip_id) VALUES(?,?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(id) DO UPDATE SET content_hash=excluded.content_hash,updated_at=excluded.updated_at,payload=excluded.payload,folder_id=excluded.folder_id,origin=excluded.origin,blob_id=excluded.blob_id,source_project_id=excluded.source_project_id,source_job_id=excluded.source_job_id,source_clip_id=excluded.source_clip_id",
                (asset.id, asset.content_hash, stamp, self._json(asset), asset.folder_id, asset.origin, asset.blob_id, asset.source_project_id, asset.source_job_id, asset.source_clip_id),
            )
            if asset.source_project_id:
                db.execute("UPDATE projects SET library_deleted=0 WHERE id=?", (asset.source_project_id,))

            # 3. Durable references
            db.execute("DELETE FROM media_blob_refs WHERE ref_type='clip-output' AND ref_id=?", (clip.id,))
            for ref_type, ref_id in [("asset", asset.id), ("clip-output", clip.id)]:
                db.execute("INSERT OR IGNORE INTO media_blob_refs(blob_id,ref_type,ref_id,created_at) VALUES(?,?,?,?)", (asset.blob_id, ref_type, ref_id, stamp))

            # A stable-identity republication retains prior user metadata in both
            # linked records, just as it already does for the Library Asset.
            clip = clip.model_copy(update={"title": asset.title, "title_source": asset.title_source, "youtube_description": asset.description[:500]})

            # 4. Update Clip fields with library_asset_id
            clip = clip.model_copy(update={
                "state": "complete",
                "blob_id": asset.blob_id,
                "library_asset_id": asset.id,
            })

            # 5. Update the job payload (which contains the clip list)
            updated_clips = []
            for c in job.clips:
                if c.id == clip.id:
                    updated_clips.append(clip)
                else:
                    updated_clips.append(c)

            job = job.model_copy(update={
                "clips": updated_clips,
                "updated_at": stamp,
            })

            # 6. Save updated job payload
            folder_id = job.library_folder_id or UNSORTED_FOLDER_ID
            private_json = json.dumps(private, separators=(",", ":")) if private is not None else None
            existing_private = db.execute("SELECT payload,private_payload FROM jobs WHERE id=?", (job.id,)).fetchone()
            if existing_private:
                self._merge_saved_metadata(existing_private, job, private, skip_clip_id=clip.id)
                private_json = json.dumps(private, separators=(",", ":")) if private is not None else None
            if private_json is None:
                private_json = existing_private["private_payload"] if existing_private else "{}"

            db.execute(
                "INSERT INTO jobs(id,project_id,state,updated_at,payload,private_payload,library_folder_id) VALUES(?,?,?,?,?,?,?) "
                "ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,state=excluded.state,updated_at=excluded.updated_at,payload=excluded.payload,private_payload=excluded.private_payload,library_folder_id=excluded.library_folder_id",
                (job.id, job.project_id, job.state, stamp, self._json(job), private_json, folder_id),
            )

            # 7. Validate bidirectional relationship
            if clip.library_asset_id != asset.id:
                raise ValueError(f"Publication invariant violated: clip.library_asset_id ({clip.library_asset_id}) != asset.id ({asset.id})")
            if asset.source_clip_id != clip.id:
                raise ValueError(f"Publication invariant violated: asset.source_clip_id ({asset.source_clip_id}) != clip.id ({clip.id})")

        return job, clip, asset

    # DO-NOT-CHANGE: idempotent repair — never duplicate assets on repeated calls
    def backfill_missing_assets(self, job: Job) -> tuple[Job, int, list[str]]:
        """Create missing Media Library assets for completed clips that lack one.

        Scans completed clips in the job.  For each clip that has ``blob_id``
        and ``output_name`` set but no ``library_asset_id``, creates a new
        automatic asset using the blob and clip metadata.  Uses the stable
        (origin, source_project_id, source_job_id, source_clip_id) identity so
        an asset that already exists for that clip is reused, never duplicated.

        The caller is responsible for persisting the returned job (which carries
        the updated ``clip.library_asset_id`` fields).

        Returns ``(job, backfilled_count, created_asset_ids)``.
        """
        backfilled = 0
        created_ids: list[str] = []
        private = self.get_job_private(job.id)
        dimensions = {"9:16": (1080, 1920), "1:1": (1080, 1080), "16:9": (1920, 1080)}
        width, height = dimensions.get(str(private.get("aspect_ratio") or "9:16"), (1080, 1920))

        for clip in job.clips:
            if clip.state != "complete":
                continue
            if clip.library_asset_id is not None:
                continue
            origin = "script-output" if job.mode == "script" else "generated-clip"
            with self._connect() as db:
                deleted = db.execute(
                    "SELECT 1 FROM deleted_output_assets WHERE origin=? AND source_project_id=? AND source_job_id=? AND source_clip_id=?",
                    (origin, job.project_id, job.id, clip.id),
                ).fetchone()
            if deleted:
                continue
            existing_asset = self.get_generated_asset(origin, job.project_id, job.id, clip.id)
            if existing_asset:
                job.clips = [
                    (c.model_copy(update={"library_asset_id": existing_asset.id, "blob_id": existing_asset.blob_id, "folder_id": existing_asset.folder_id, "width": existing_asset.width, "height": existing_asset.height, "title": existing_asset.title, "published_at": existing_asset.published_at}) if c.id == clip.id else c)
                    for c in job.clips
                ]
                backfilled += 1
                created_ids.append(existing_asset.id)
                continue
            if not clip.blob_id or not clip.output_name:
                continue

            relative = self.blob_relative_path(clip.blob_id)
            if not relative:
                continue
            blob_path = self.path.parent / relative
            if not blob_path.is_file():
                continue

            project = self.get_project(job.project_id)
            project_name = project.name if project else "Project"
            title = f"{project_name} — Script video" if origin == "script-output" else f"{project_name} — Cut {clip.index:02d}"
            folder_id, _ = self.validate_publication_folder(job.library_folder_id, job)

            asset = Asset(
                id=str(uuid.uuid4()),
                title=title[:200],
                media_type="video/mp4",
                filename=clip.output_name,
                content_hash=clip.blob_id,
                blob_id=clip.blob_id,
                origin=origin,
                folder_id=folder_id,
                source_project_id=job.project_id,
                source_job_id=job.id,
                source_clip_id=clip.id,
                duration_seconds=clip.duration,
                width=width,
                height=height,
                policy="neutral",
                licence="Created or supplied by user",
            )
            result = self.register_blob_asset(asset, relative, blob_path.stat().st_size)
            job.clips = [
                (c.model_copy(update={"library_asset_id": result.id}) if c.id == clip.id else c)
                for c in job.clips
            ]
            job.updated_at = now_iso()
            backfilled += 1
            created_ids.append(result.id)

        return job, backfilled, created_ids

    def blob_relative_path(self, blob_id: str) -> str | None:
        with self._connect() as db:
            row = db.execute("SELECT relative_path FROM media_blobs WHERE id=?", (blob_id,)).fetchone()
        return str(row["relative_path"]) if row else None

    def blob_reference_count(self, blob_id: str) -> int:
        with self._connect() as db:
            row = db.execute("SELECT COUNT(*) FROM media_blob_refs WHERE blob_id=?", (blob_id,)).fetchone()
        return int(row[0])

    # DO-NOT-CHANGE: refuses protected assets; returns whether blob is now unreferenced (caller deletes it)
    def delete_asset(self, asset_id: str) -> tuple[Asset, str | None, bool]:
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM assets WHERE id=?", (asset_id,)).fetchone()
            if not row:
                raise KeyError(asset_id)
            asset = self._asset_from_row(row)
            if asset.protected:
                raise ValueError("Protected assets cannot be removed")
            if asset.origin in {"generated-clip", "script-output"} and asset.source_project_id and asset.source_job_id and asset.source_clip_id:
                db.execute(
                    "INSERT OR IGNORE INTO deleted_output_assets(origin,source_project_id,source_job_id,source_clip_id,deleted_at) VALUES(?,?,?,?,?)",
                    (asset.origin, asset.source_project_id, asset.source_job_id, asset.source_clip_id, now_iso()),
                )
            db.execute("DELETE FROM media_blob_refs WHERE ref_type='asset' AND ref_id=?", (asset_id,))
            db.execute("DELETE FROM assets WHERE id=?", (asset_id,))
            if asset.source_project_id and not db.execute("SELECT 1 FROM assets WHERE source_project_id=? LIMIT 1", (asset.source_project_id,)).fetchone():
                db.execute("UPDATE projects SET library_deleted=1 WHERE id=?", (asset.source_project_id,))
            blob = db.execute("SELECT relative_path FROM media_blobs WHERE id=?", (asset.blob_id,)).fetchone()
            count = db.execute("SELECT COUNT(*) FROM media_blob_refs WHERE blob_id=?", (asset.blob_id,)).fetchone()[0]
        return asset, str(blob["relative_path"]) if blob else None, bool(blob and count == 0)

    def recent_clip_assets(self, *, search: str | None, page: int, page_size: int, file_exists) -> tuple[list[Asset], int]:
        """Return playable published video outputs, filtered before count and pagination."""
        if page < 1 or not 1 <= page_size <= 100:
            raise ValueError("Invalid recent clips page")
        with self._connect() as db:
            rows = db.execute(
                "SELECT a.*, b.relative_path FROM assets a "
                "JOIN media_blobs b ON b.id=a.blob_id "
                "JOIN media_blob_refs ar ON ar.blob_id=b.id AND ar.ref_type='asset' AND ar.ref_id=a.id "
                "JOIN media_blob_refs cr ON cr.blob_id=b.id AND cr.ref_type='clip-output' AND cr.ref_id=a.source_clip_id "
                "WHERE a.origin IN ('generated-clip','script-output')"
            ).fetchall()
        needle = search.casefold().strip() if search else ""
        assets = []
        for row in rows:
            asset = self._asset_from_row(row)
            if asset.media_type.casefold().split("/", 1)[0] != "video":
                continue
            if not asset.source_clip_id or not row["relative_path"] or not file_exists(row["relative_path"]):
                continue
            searchable = " ".join([asset.title, asset.filename, asset.description, *asset.tags, *asset.brands, *asset.people, *asset.aliases]).casefold()
            if needle and needle not in searchable:
                continue
            assets.append(asset)
        assets.sort(key=lambda asset: (asset.published_at, asset.id), reverse=True)
        total = len(assets)
        start = (page - 1) * page_size
        return assets[start:start + page_size], total

    def list_assets(self, *, folder_id: str | None = None, media_type: str | None = None, origin: str | None = None, search: str | None = None, include_archived: bool = False) -> list[Asset]:
        clauses, values = [], []
        if not include_archived:
            clauses.append("folder_id IN (SELECT id FROM library_folders WHERE archived=0 AND deleted=0)")
        if folder_id:
            clauses.append("folder_id=?"); values.append(folder_id)
        if origin:
            clauses.append("origin=?"); values.append(origin)
        rows_sql = "SELECT payload,folder_id,origin,blob_id FROM assets"
        if clauses:
            rows_sql += " WHERE " + " AND ".join(clauses)
        with self._connect() as db:
            rows = db.execute(rows_sql + " ORDER BY updated_at DESC", values).fetchall()
        assets = [Asset.model_validate_json(row["payload"]).model_copy(update={"folder_id": row["folder_id"] or UNSORTED_FOLDER_ID, "origin": row["origin"], "blob_id": row["blob_id"]}) for row in rows]
        if media_type:
            assets = [asset for asset in assets if asset.media_type.casefold().split("/", 1)[0] == media_type.casefold() or asset.media_type.casefold() == media_type.casefold()]
        if search:
            needle = search.casefold()
            assets = [asset for asset in assets if needle in " ".join([asset.title, asset.filename, asset.description, *asset.tags, *asset.brands, *asset.people, *asset.aliases]).casefold()]
        return assets

    def list_assets_page(self, *, folder_id: str | None = None, media_type: str | None = None, origin: str | None = None, search: str | None = None, include_archived: bool = False, page: int = 1, page_size: int = 40) -> tuple[list[Asset], bool]:
        """Return one bounded, deterministically ordered asset page."""
        if page < 1 or not 1 <= page_size <= 100:
            raise ValueError("Invalid asset page")
        clauses, values = [], []
        if not include_archived:
            clauses.append("folder_id IN (SELECT id FROM library_folders WHERE archived=0 AND deleted=0)")
        if folder_id:
            clauses.append("folder_id=?"); values.append(folder_id)
        if origin:
            clauses.append("origin=?"); values.append(origin)
        if media_type:
            clauses.append("lower(payload) LIKE ?"); values.append(f'%\"media_type\":\"{media_type.casefold()}%')
        if search:
            needle = search.casefold().replace("%", "\\%").replace("_", "\\_")
            clauses.append("lower(payload) LIKE ? ESCAPE '\\\\'"); values.append(f"%{needle}%")
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        offset = (page - 1) * page_size
        with self._connect() as db:
            rows = db.execute("SELECT payload,folder_id,origin,blob_id FROM assets" + where + " ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?", (*values, page_size + 1, offset)).fetchall()
        assets = [Asset.model_validate_json(row["payload"]).model_copy(update={"folder_id": row["folder_id"] or UNSORTED_FOLDER_ID, "origin": row["origin"], "blob_id": row["blob_id"]}) for row in rows[:page_size]]
        return assets, len(rows) > page_size

    def list_folders(self, include_archived: bool = False) -> list[LibraryFolder]:
        where = " WHERE deleted=0" + ("" if include_archived else " AND archived=0")
        with self._connect() as db:
            rows = db.execute("SELECT * FROM library_folders" + where + " ORDER BY system DESC,name_key").fetchall()
        return [LibraryFolder(id=row["id"], name=row["name"], parent_id=row["parent_id"], description=row["description"], color=row["color"], archived=bool(row["archived"]), deleted=bool(row["deleted"]), system=bool(row["system"]), created_at=row["created_at"], updated_at=row["updated_at"]) for row in rows]

    def get_folder(self, folder_id: str) -> LibraryFolder | None:
        return next((folder for folder in self.list_folders(True) if folder.id == folder_id), None)

    def save_folder(self, folder: LibraryFolder) -> LibraryFolder:
        if not folder.name.strip():
            raise ValueError("Folder name cannot be empty")
        folder = folder.model_copy(update={"name": folder.name.strip()})
        if folder.parent_id:
            parent = self.get_folder(folder.parent_id)
            if not parent or parent.archived:
                raise ValueError("Parent folder not found or archived")
            depth, cursor = 2, parent
            seen = {folder.id}
            while cursor.parent_id:
                if cursor.id in seen:
                    raise ValueError("Folder move would create a cycle")
                seen.add(cursor.id)
                depth += 1
                cursor = self.get_folder(cursor.parent_id) or cursor.model_copy(update={"parent_id": None})
            if depth > MAX_FOLDER_DEPTH:
                raise ValueError(f"Folders may be at most {MAX_FOLDER_DEPTH} levels deep")
        with self._lock, self._connect() as db:
            try:
                db.execute("INSERT INTO library_folders(id,name,name_key,parent_id,description,color,archived,system,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,name_key=excluded.name_key,parent_id=excluded.parent_id,description=excluded.description,color=excluded.color,archived=excluded.archived,updated_at=excluded.updated_at", (folder.id, folder.name.strip(), folder.name.strip().casefold(), folder.parent_id, folder.description, folder.color, int(folder.archived), int(folder.system), folder.created_at, folder.updated_at))
            except sqlite3.IntegrityError as exc:
                raise ValueError("A folder with that name already exists here") from exc
        return folder

    def move_folder(self, folder_id: str, parent_id: str | None) -> LibraryFolder:
        folder = self.get_folder(folder_id)
        if not folder or folder.system:
            raise ValueError("Folder cannot be moved")
        if parent_id and not self.get_folder(parent_id):
            raise ValueError("Parent folder not found")
        descendants, cursor = {folder_id}, [folder_id]
        all_folders = self.list_folders(True)
        while cursor:
            current = cursor.pop()
            children = [item.id for item in all_folders if item.parent_id == current]
            descendants.update(children); cursor.extend(children)
        if parent_id in descendants:
            raise ValueError("Folder move would create a cycle")
        depth, current = 1, parent_id
        while current:
            depth += 1
            current = next(item.parent_id for item in all_folders if item.id == current)
        subtree_depth = max((self._relative_depth(item.id, folder_id, all_folders) for item in all_folders if item.id in descendants), default=0)
        if depth + subtree_depth > MAX_FOLDER_DEPTH:
            raise ValueError(f"Folders may be at most {MAX_FOLDER_DEPTH} levels deep")
        return self.save_folder(folder.model_copy(update={"parent_id": parent_id, "updated_at": now_iso()}))

    @staticmethod
    def _relative_depth(folder_id: str, root_id: str, folders: list[LibraryFolder]) -> int:
        depth, current = 0, folder_id
        while current != root_id:
            depth += 1
            current = next(item.parent_id for item in folders if item.id == current) or root_id
        return depth

    def move_assets(self, asset_ids: list[str], folder_id: str) -> int:
        destination = self.get_folder(folder_id)
        if not destination or destination.archived:
            raise ValueError("Destination folder not found or archived")
        with self._lock, self._connect() as db:
            marks = ",".join("?" for _ in asset_ids)
            rows = db.execute(f"SELECT id,payload FROM assets WHERE id IN ({marks})", asset_ids).fetchall()
            if len(rows) != len(set(asset_ids)):
                raise ValueError("One or more assets were not found")
            for row in rows:
                asset = Asset.model_validate_json(row["payload"]).model_copy(update={"folder_id": folder_id})
                db.execute("UPDATE assets SET folder_id=?,payload=? WHERE id=?", (folder_id, self._json(asset), row["id"]))
        return len(rows)

    # DO-NOT-CHANGE: writes redirect, marks deleted=1, never hard-deletes
    def remove_folder(self, folder_id: str, destination_id: str) -> None:
        folder = self.get_folder(folder_id)
        destination = self.get_folder(destination_id)
        if not folder or folder.system or folder_id == destination_id:
            raise ValueError("Folder cannot be removed")
        if not destination or destination.archived:
            raise ValueError("Destination folder not found or archived")
        folders = self.list_folders(True)
        descendants, cursor = set(), [folder_id]
        while cursor:
            current = cursor.pop()
            children = [item.id for item in folders if item.parent_id == current]
            descendants.update(children)
            cursor.extend(children)
        if destination_id in descendants:
            raise ValueError("Destination cannot be inside the folder being removed")
        direct_children = [item for item in folders if item.parent_id == folder_id]
        for child in direct_children:
            self.move_folder(child.id, destination_id)
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            rows = db.execute("SELECT id,payload FROM assets WHERE folder_id=?", (folder_id,)).fetchall()
            for row in rows:
                asset = Asset.model_validate_json(row["payload"]).model_copy(update={"folder_id": destination_id})
                db.execute("UPDATE assets SET folder_id=?,payload=? WHERE id=?", (destination_id, self._json(asset), row["id"]))
            projects = db.execute("SELECT id,payload FROM projects WHERE library_folder_id=?", (folder_id,)).fetchall()
            for row in projects:
                project = Project.model_validate_json(row["payload"]).model_copy(update={"library_folder_id": destination_id, "updated_at": now_iso()})
                db.execute("UPDATE projects SET library_folder_id=?,updated_at=?,payload=? WHERE id=?", (destination_id, project.updated_at, self._json(project), row["id"]))
            db.execute("INSERT OR REPLACE INTO library_folder_redirects(folder_id,destination_id,created_at) VALUES(?,?,?)", (folder_id, destination_id, now_iso()))
            db.execute("UPDATE library_folders SET name=?,name_key=?,parent_id=NULL,archived=1,deleted=1,updated_at=? WHERE id=?", (f"Removed folder {folder_id[:8]}", f"removed:{folder_id}", now_iso(), folder_id))

    def delete_project(self, project_id: str) -> None:
        if not self.get_project(project_id):
            raise KeyError(project_id)
        jobs = [job for job in self.list_jobs() if job.project_id == project_id]
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("DELETE FROM media_blob_refs WHERE ref_type='project-source' AND ref_id=?", (project_id,))
            for job in jobs:
                db.execute("DELETE FROM media_blob_refs WHERE ref_type='job-source' AND ref_id=?", (job.id,))
                for clip in job.clips:
                    db.execute("DELETE FROM media_blob_refs WHERE ref_type='clip-output' AND ref_id=?", (clip.id,))
                db.execute("DELETE FROM jobs WHERE id=?", (job.id,))
            db.execute("DELETE FROM projects WHERE id=?", (project_id,))

    def delete_project_everywhere(self, project_id: str, *, allow_protected: bool = False) -> list[str]:
        """Atomically delete one project's records, assets, and durable refs.

        This compatibility wrapper preserves the original path-only return
        value. The coordinated purge uses the stats-bearing variant below.
        """
        paths, _ = self.delete_project_everywhere_with_stats(project_id, allow_protected=allow_protected)
        return paths

    def delete_project_everywhere_with_stats(self, project_id: str, *, allow_protected: bool = False) -> tuple[list[str], int]:
        """Atomically delete one project's records, assets, and durable refs.

        Returned paths have no references after the transaction. Files are left
        for the caller to remove after commit, so a failure can leave an orphan
        but can never remove a blob another record still needs. ``allow_protected``
        is reserved for the explicit global Library purge; ordinary project
        deletion keeps the pinned-media safeguard.
        """
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if not db.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone():
                raise KeyError(project_id)
            job_rows = db.execute("SELECT id,payload,library_folder_id FROM jobs WHERE project_id=?", (project_id,)).fetchall()
            jobs = [Job.model_validate_json(row["payload"]).model_copy(update={"library_folder_id": row["library_folder_id"] or UNSORTED_FOLDER_ID}) for row in job_rows]
            asset_rows = db.execute("SELECT * FROM assets WHERE source_project_id=?", (project_id,)).fetchall()
            assets = [self._asset_from_row(row) for row in asset_rows]
            if not allow_protected and any(asset.protected for asset in assets):
                raise ValueError("Unprotect associated media before deleting this project everywhere")

            job_ids = [job.id for job in jobs]
            clip_ids = [clip.id for job in jobs for clip in job.clips]
            asset_ids = [asset.id for asset in assets]
            ref_filters = [("project-source", project_id)]
            ref_filters.extend(("job-source", job_id) for job_id in job_ids)
            ref_filters.extend(("clip-output", clip_id) for clip_id in clip_ids)
            ref_filters.extend(("asset", asset_id) for asset_id in asset_ids)
            affected_blob_ids = {asset.blob_id for asset in assets}
            for ref_type, ref_id in ref_filters:
                affected_blob_ids.update(row["blob_id"] for row in db.execute("SELECT blob_id FROM media_blob_refs WHERE ref_type=? AND ref_id=?", (ref_type, ref_id)).fetchall())
                db.execute("DELETE FROM media_blob_refs WHERE ref_type=? AND ref_id=?", (ref_type, ref_id))

            if asset_ids:
                marks = ",".join("?" for _ in asset_ids)
                db.execute(f"DELETE FROM assets WHERE id IN ({marks})", asset_ids)
            if job_ids:
                marks = ",".join("?" for _ in job_ids)
                db.execute(f"DELETE FROM jobs WHERE id IN ({marks})", job_ids)
            db.execute("DELETE FROM projects WHERE id=?", (project_id,))

            unreferenced_paths: list[str] = []
            bytes_reclaimed = 0
            for blob_id in affected_blob_ids:
                row = db.execute("SELECT relative_path,byte_size FROM media_blobs WHERE id=?", (blob_id,)).fetchone()
                count = db.execute("SELECT COUNT(*) FROM media_blob_refs WHERE blob_id=?", (blob_id,)).fetchone()[0]
                if row and count == 0:
                    unreferenced_paths.append(str(row["relative_path"]))
                    bytes_reclaimed += max(0, int(row["byte_size"] or 0))
                    db.execute("DELETE FROM media_blobs WHERE id=?", (blob_id,))
        return unreferenced_paths, bytes_reclaimed

    def purge_library_assets(self) -> tuple[int, list[str], int]:
        """Delete every remaining Library asset in one protected transaction.

        This is intentionally separate from ``delete_asset``: it is only called
        after the API has validated the global purge confirmation and removed
        linked projects through JobManager. It bypasses protected-item rules but
        still removes only asset references and only drops a blob row when its
        reference count reaches zero.
        """
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            rows = db.execute("SELECT id,blob_id FROM assets").fetchall()
            asset_ids = [str(row["id"]) for row in rows]
            affected_blob_ids = {str(row["blob_id"]) for row in rows if row["blob_id"]}
            if asset_ids:
                marks = ",".join("?" for _ in asset_ids)
                db.execute(f"DELETE FROM media_blob_refs WHERE ref_type='asset' AND ref_id IN ({marks})", asset_ids)
                db.execute(f"DELETE FROM assets WHERE id IN ({marks})", asset_ids)

            unreferenced_paths: list[str] = []
            bytes_reclaimed = 0
            for blob_id in affected_blob_ids:
                row = db.execute("SELECT relative_path,byte_size FROM media_blobs WHERE id=?", (blob_id,)).fetchone()
                count = db.execute("SELECT COUNT(*) FROM media_blob_refs WHERE blob_id=?", (blob_id,)).fetchone()[0]
                if row and count == 0:
                    unreferenced_paths.append(str(row["relative_path"]))
                    bytes_reclaimed += max(0, int(row["byte_size"] or 0))
                    db.execute("DELETE FROM media_blobs WHERE id=?", (blob_id,))
        return len(asset_ids), unreferenced_paths, bytes_reclaimed

    def update_project_folder(self, project_id: str, folder_id: str, move_existing_assets: bool) -> Project:
        destination = self.get_folder(folder_id)
        project = self.get_project(project_id)
        if not destination or destination.archived:
            raise ValueError("Destination folder not found or archived")
        if not project:
            raise KeyError(project_id)
        project.library_folder_id = folder_id
        project.updated_at = now_iso()
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("UPDATE projects SET library_folder_id=?,updated_at=?,payload=? WHERE id=?", (folder_id, project.updated_at, self._json(project), project_id))
            if move_existing_assets:
                rows = db.execute("SELECT id,payload FROM assets WHERE source_project_id=?", (project_id,)).fetchall()
                for row in rows:
                    asset = Asset.model_validate_json(row["payload"]).model_copy(update={"folder_id": folder_id})
                    db.execute("UPDATE assets SET folder_id=?,payload=? WHERE id=?", (folder_id, self._json(asset), row["id"]))
        return project

    def cache_get(self, key: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute("SELECT payload FROM analysis_cache WHERE cache_key=?", (key,)).fetchone()
        return json.loads(row["payload"]) if row else None

    def cache_put(self, key: str, created_at: str, payload: dict[str, Any]) -> None:
        with self._connect() as db:
            db.execute("INSERT INTO analysis_cache(cache_key,created_at,payload) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET created_at=excluded.created_at,payload=excluded.payload", (key, created_at, json.dumps(payload, separators=(",", ":"))))
