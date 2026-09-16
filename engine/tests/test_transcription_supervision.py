from __future__ import annotations

import multiprocessing as mp
import os
import signal
from pathlib import Path
from typing import Any

import pytest

from engine import media
from engine.config import Settings
from engine.transcription import supervise, worker_exit_message


def _successful_worker(run_id: str, path: str, settings: Settings, events: Any) -> None:
    """Picklable worker used to exercise the real spawn boundary."""
    events.put({"type": "started", "run_id": run_id})
    events.put({"type": "progress", "run_id": run_id, "fraction": .5, "detail": Path(path).name})
    events.put({"type": "completed", "run_id": run_id, "result": {"language": "en", "words": [], "segments": []}})


def test_supervision_uses_a_fresh_spawned_interpreter(monkeypatch, tmp_path: Path) -> None:
    """A threaded server must not fork native Whisper/OpenMP state."""
    requested: list[str] = []
    real_get_context = mp.get_context

    def observed_get_context(method: str):
        requested.append(method)
        return real_get_context(method)

    monkeypatch.setattr("engine.transcription.mp.get_context", observed_get_context)
    source = tmp_path / "audio.wav"
    source.write_bytes(b"test")

    result = supervise(source, Settings.from_env(), worker=_successful_worker)

    assert requested == ["spawn"]
    assert result == {"language": "en", "words": [], "segments": []}


def _killed_worker(run_id: str, path: str, settings: Settings, events: Any) -> None:
    """Picklable worker that dies the way the OOM killer ends Whisper."""
    events.put({"type": "started", "run_id": run_id})
    os.kill(os.getpid(), signal.SIGKILL)


def test_worker_exit_message_explains_a_killed_worker() -> None:
    killed = worker_exit_message(-int(signal.SIGKILL))
    assert "signal 9" in killed
    assert "memory" in killed.lower()
    assert "S6_WHISPER_MODEL" in killed
    assert "signal 15" in worker_exit_message(-int(signal.SIGTERM))
    assert worker_exit_message(3) == "Transcription worker exited with code 3 without a result"
    assert worker_exit_message(0) == "Transcription worker exited without a result"


def test_supervision_reports_an_out_of_memory_kill(tmp_path: Path) -> None:
    source = tmp_path / "audio.wav"
    source.write_bytes(b"test")
    with pytest.raises(media.MediaError) as error:
        supervise(source, Settings.from_env(), worker=_killed_worker)
    assert "signal 9" in str(error.value)
    assert "memory" in str(error.value).lower()


def _slow_start_worker(run_id: str, path: str, settings: Settings, events: Any) -> None:
    import time
    events.put({"type": "started", "run_id": run_id})
    time.sleep(1.2)
    events.put({"type": "progress", "run_id": run_id, "fraction": .1, "detail": "first segment"})
    events.put({"type": "completed", "run_id": run_id, "result": {"language": "en", "words": [], "segments": []}})


def test_long_source_is_given_time_for_the_pre_segment_pass(tmp_path: Path) -> None:
    from dataclasses import replace
    source = tmp_path / "audio.wav"
    source.write_bytes(b"test")
    impatient = replace(Settings.from_env(), transcription_stall_seconds=30)
    result = supervise(source, impatient, worker=_slow_start_worker, source_seconds=2048.0)
    assert result["language"] == "en"


def test_stall_budget_is_unchanged_for_short_sources(tmp_path: Path) -> None:
    from engine.transcription import startup_budget_seconds
    settings = Settings.from_env()
    assert startup_budget_seconds(settings, None) == settings.transcription_stall_seconds
    assert startup_budget_seconds(settings, 200.0) == settings.transcription_stall_seconds
    assert startup_budget_seconds(settings, 2048.0) > 500
