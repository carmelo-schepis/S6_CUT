import asyncio
import threading
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

import engine.jobs as jobs
from engine.jobs import JobManager, ProjectDeletingError, job_allows_provider, job_content_format, probe_source


@pytest.mark.parametrize(("public", "private", "expected"), [
    ("auto", {}, True), ("auto", {"execution_policy": "auto"}, True),
    ("engine_only", {}, False), ("auto", {"execution_policy": "engine_only"}, False),
    ("engine_only", {"execution_policy": "auto"}, False),
    ("auto", {"execution_policy": None}, True),
])
def test_job_allows_provider(public, private, expected):
    assert job_allows_provider(SimpleNamespace(execution_policy=public), private) is expected


@pytest.mark.parametrize(("public", "private", "expected"), [
    ("long", {"content_format": "short"}, "short"),
    ("short", {"content_format": "long"}, "long"),
    ("long", {}, "long"), ("short", {"content_format": None}, "short"),
    ("long", {"content_format": ""}, "long"),
    (None, {}, "short"), ("", {}, "short"),
    ("long", {"content_format": "bogus"}, "short"),
    ("bogus", {}, "short"),
])
def test_job_content_format(public, private, expected):
    assert job_content_format(SimpleNamespace(content_format=public), private) == expected


@pytest.mark.parametrize(("public", "private", "expected"), [
    ("short", {}, "short"), ("long", {}, "long"),
    ("short", {"content_format": "long"}, "long"),
    ("long", {"content_format": "short"}, "short"),
    ("long", {"content_format": None}, "long"),
    ("long", {"content_format": ""}, "long"),
    ("long", {"content_format": "invalid"}, "short"),
])
def test_probe_source_routes_resolved_format(monkeypatch, public, private, expected):
    settings = SimpleNamespace(max_long_source_seconds=913)
    source, result = Path("source.mp4"), object()
    probe = Mock(return_value=result)
    monkeypatch.setattr(jobs, "probe", probe)
    actual = probe_source(SimpleNamespace(content_format=public), private, source, settings)
    assert actual is result
    args, kwargs = probe.call_args
    assert args[0] is source and args[1] is settings
    assert kwargs == ({"max_seconds": 913} if expected == "long" else {})
    assert probe.call_count == 1


def test_probe_source_propagates_original_exception(monkeypatch):
    error = RuntimeError("probe failed")
    probe = Mock(side_effect=error)
    monkeypatch.setattr(jobs, "probe", probe)
    with pytest.raises(RuntimeError) as raised:
        probe_source(SimpleNamespace(content_format="short"), {}, Path("x"), object())
    assert raised.value is error


@pytest.mark.parametrize("action", ["pause", "resume", "retry-import", "retry-failed", "switch-fast"])
def test_control_rejects_deleting_project_before_side_effects(action):
    job = SimpleNamespace(id="j", project_id="p", mode="clip", state="active", marker=object())
    db = SimpleNamespace(get_job=Mock(return_value=job))
    manager = SimpleNamespace(db=db, _project_is_deleting=Mock(return_value=True),
                              _save=Mock(), enqueue=Mock(), _switch_to_fast=Mock())
    with pytest.raises(ProjectDeletingError, match="This project is being deleted"):
        asyncio.run(JobManager.control(manager, "j", action))
    db.get_job.assert_called_once_with("j")
    manager._save.assert_not_called()
    manager.enqueue.assert_not_called()
    manager._switch_to_fast.assert_not_called()
    assert job.state == "active" and job.marker is not None


def test_switch_to_fast_rejects_deleting_project_before_database_lookup():
    manager = SimpleNamespace(_deletion_lock=threading.RLock(), _deleting_projects={"p"}, db=SimpleNamespace())
    job = SimpleNamespace(project_id="p", mode="clip", source_profile="ordinary", state="active")
    with pytest.raises(ProjectDeletingError, match="This project is being deleted"):
        JobManager._switch_to_fast(manager, job)
    assert vars(manager.db) == {}
    assert job.state == "active"
