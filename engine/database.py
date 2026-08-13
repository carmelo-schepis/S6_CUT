from __future__ import annotations

import json
import sqlite3
import threading
from pathlib import Path
from typing import Any, TypeVar

from pydantic import BaseModel

from .models import Asset, Job, Project, ProviderProfile

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

    @staticmethod
    def _json(model: BaseModel) -> str:
        return model.model_dump_json(by_alias=True)

    def save_project(self, project: Project) -> None:
        with self._lock, self._connect() as db:
            db.execute("INSERT INTO projects(id, updated_at, payload) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,payload=excluded.payload", (project.id, project.updated_at, self._json(project)))

    def get_project(self, project_id: str) -> Project | None:
        with self._connect() as db:
            row = db.execute("SELECT payload FROM projects WHERE id=?", (project_id,)).fetchone()
        return Project.model_validate_json(row["payload"]) if row else None

    def list_projects(self) -> list[Project]:
        with self._connect() as db:
            rows = db.execute("SELECT payload FROM projects ORDER BY updated_at DESC").fetchall()
        return [Project.model_validate_json(row["payload"]) for row in rows]

    def save_job(self, job: Job, private: dict[str, Any] | None = None) -> None:
        with self._lock, self._connect() as db:
            existing = db.execute("SELECT private_payload FROM jobs WHERE id=?", (job.id,)).fetchone()
            private_json = json.dumps(private, separators=(",", ":")) if private is not None else (existing["private_payload"] if existing else "{}")
            db.execute("INSERT INTO jobs(id,project_id,state,updated_at,payload,private_payload) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,state=excluded.state,updated_at=excluded.updated_at,payload=excluded.payload,private_payload=excluded.private_payload", (job.id, job.project_id, job.state, job.updated_at, self._json(job), private_json))

    def get_job(self, job_id: str) -> Job | None:
        with self._connect() as db:
            row = db.execute("SELECT payload FROM jobs WHERE id=?", (job_id,)).fetchone()
        return Job.model_validate_json(row["payload"]) if row else None

    def get_job_private(self, job_id: str) -> dict[str, Any]:
        with self._connect() as db:
            row = db.execute("SELECT private_payload FROM jobs WHERE id=?", (job_id,)).fetchone()
        return json.loads(row["private_payload"]) if row else {}

    def list_jobs(self, states: tuple[str, ...] | None = None) -> list[Job]:
        with self._connect() as db:
            if states:
                marks = ",".join("?" for _ in states)
                rows = db.execute(f"SELECT payload FROM jobs WHERE state IN ({marks}) ORDER BY updated_at DESC", states).fetchall()
            else:
                rows = db.execute("SELECT payload FROM jobs ORDER BY updated_at DESC").fetchall()
        return [Job.model_validate_json(row["payload"]) for row in rows]

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
            db.execute("INSERT INTO assets(id,content_hash,updated_at,payload) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET content_hash=excluded.content_hash,updated_at=excluded.updated_at,payload=excluded.payload", (asset.id, asset.content_hash, asset.created_at, self._json(asset)))

    def get_asset(self, asset_id: str) -> Asset | None:
        with self._connect() as db:
            row = db.execute("SELECT payload FROM assets WHERE id=?", (asset_id,)).fetchone()
        return Asset.model_validate_json(row["payload"]) if row else None

    def get_asset_by_hash(self, content_hash: str) -> Asset | None:
        with self._connect() as db:
            row = db.execute("SELECT payload FROM assets WHERE content_hash=?", (content_hash,)).fetchone()
        return Asset.model_validate_json(row["payload"]) if row else None

    def list_assets(self) -> list[Asset]:
        with self._connect() as db:
            rows = db.execute("SELECT payload FROM assets ORDER BY updated_at DESC").fetchall()
        return [Asset.model_validate_json(row["payload"]) for row in rows]

    def cache_get(self, key: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute("SELECT payload FROM analysis_cache WHERE cache_key=?", (key,)).fetchone()
        return json.loads(row["payload"]) if row else None

    def cache_put(self, key: str, created_at: str, payload: dict[str, Any]) -> None:
        with self._connect() as db:
            db.execute("INSERT INTO analysis_cache(cache_key,created_at,payload) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET created_at=excluded.created_at,payload=excluded.payload", (key, created_at, json.dumps(payload, separators=(",", ":"))))
