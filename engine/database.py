from __future__ import annotations

import json
import sqlite3
import threading
from pathlib import Path
from typing import Any, TypeVar

from pydantic import BaseModel

from .models import Asset, Job, LibraryFolder, Project, ProviderProfile, UNSORTED_LIBRARY_FOLDER_ID, now_iso

UNSORTED_FOLDER_ID = UNSORTED_LIBRARY_FOLDER_ID
MAX_FOLDER_DEPTH = 3

T = TypeVar("T", bound=BaseModel)


class Database:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self._lock = threading.RLock()
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=30)
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

    def _migrate(self, db: sqlite3.Connection) -> None:
        """Apply additive migrations transactionally; safe to repeat after interruption."""
        version = db.execute("SELECT COALESCE(MAX(version), 0) FROM schema_migrations").fetchone()[0]
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
        with self._connect() as db:
            rows = db.execute("SELECT payload,library_folder_id FROM projects ORDER BY updated_at DESC").fetchall()
        return [Project.model_validate_json(row["payload"]).model_copy(update={"library_folder_id": self.resolve_folder_id(row["library_folder_id"])}) for row in rows]

    def save_job(self, job: Job, private: dict[str, Any] | None = None) -> None:
        with self._lock, self._connect() as db:
            existing = db.execute("SELECT private_payload FROM jobs WHERE id=?", (job.id,)).fetchone()
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

    def get_asset_by_hash(self, content_hash: str) -> Asset | None:
        with self._connect() as db:
            row = db.execute("SELECT * FROM assets WHERE content_hash=? ORDER BY updated_at LIMIT 1", (content_hash,)).fetchone()
        return self._asset_from_row(row) if row else None

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
                    "max_uses_per_project": existing.max_uses_per_project,
                    "active_from": existing.active_from, "active_until": existing.active_until,
                    "licence": existing.licence, "attribution": existing.attribution,
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

    def blob_relative_path(self, blob_id: str) -> str | None:
        with self._connect() as db:
            row = db.execute("SELECT relative_path FROM media_blobs WHERE id=?", (blob_id,)).fetchone()
        return str(row["relative_path"]) if row else None

    def blob_reference_count(self, blob_id: str) -> int:
        with self._connect() as db:
            row = db.execute("SELECT COUNT(*) FROM media_blob_refs WHERE blob_id=?", (blob_id,)).fetchone()
        return int(row[0])

    def delete_asset(self, asset_id: str) -> tuple[Asset, str | None, bool]:
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM assets WHERE id=?", (asset_id,)).fetchone()
            if not row:
                raise KeyError(asset_id)
            asset = self._asset_from_row(row)
            if asset.protected:
                raise ValueError("Protected assets cannot be removed")
            db.execute("DELETE FROM media_blob_refs WHERE ref_type='asset' AND ref_id=?", (asset_id,))
            db.execute("DELETE FROM assets WHERE id=?", (asset_id,))
            blob = db.execute("SELECT relative_path FROM media_blobs WHERE id=?", (asset.blob_id,)).fetchone()
            count = db.execute("SELECT COUNT(*) FROM media_blob_refs WHERE blob_id=?", (asset.blob_id,)).fetchone()[0]
        return asset, str(blob["relative_path"]) if blob else None, bool(blob and count == 0)

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

    def list_folders(self, include_archived: bool = False) -> list[LibraryFolder]:
        where = " WHERE deleted=0" + ("" if include_archived else " AND archived=0")
        with self._connect() as db:
            rows = db.execute("SELECT * FROM library_folders" + where + " ORDER BY system DESC,name_key").fetchall()
        return [LibraryFolder(id=row["id"], name=row["name"], parent_id=row["parent_id"], description=row["description"], color=row["color"], archived=bool(row["archived"]), system=bool(row["system"]), created_at=row["created_at"], updated_at=row["updated_at"]) for row in rows]

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
