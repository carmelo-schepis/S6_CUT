import sqlite3
from pathlib import Path

import pytest

from engine.database import Database


def test_context_managed_database_connection_closes_after_commit(tmp_path: Path):
    database = Database(tmp_path / "s6-cut.sqlite3")
    connection = database._connect()

    with connection as managed:
        managed.execute(
            "INSERT INTO analysis_cache(cache_key,created_at,payload) VALUES(?,?,?)",
            ("connection-close", "2026-06-05T00:00:00+00:00", '{"saved":true}'),
        )

    assert database.cache_get("connection-close") == {"saved": True}
    with pytest.raises(sqlite3.ProgrammingError, match="closed"):
        connection.execute("SELECT 1")


def test_context_managed_database_connection_closes_after_rollback(tmp_path: Path):
    database = Database(tmp_path / "s6-cut.sqlite3")
    connection = database._connect()

    with pytest.raises(RuntimeError, match="rollback probe"):
        with connection as managed:
            managed.execute(
                "INSERT INTO analysis_cache(cache_key,created_at,payload) VALUES(?,?,?)",
                ("rollback-close", "2026-06-05T00:00:00+00:00", '{"saved":true}'),
            )
            raise RuntimeError("rollback probe")

    assert database.cache_get("rollback-close") is None
    with pytest.raises(sqlite3.ProgrammingError, match="closed"):
        connection.execute("SELECT 1")
