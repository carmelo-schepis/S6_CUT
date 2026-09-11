from __future__ import annotations

import multiprocessing as mp
from pathlib import Path
from typing import Any

from engine.config import Settings
from engine.transcription import supervise


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


def _slow_start_worker(run_id: str, path: str, settings: Settings, events: Any) -> None:
    """Mimics Faster-Whisper on a long source: its VAD pass runs over the whole
    file before any segment exists, so nothing is emitted for a while."""
    import time

    events.put({"type": "started", "run_id": run_id})
    time.sleep(1.2)
    events.put({"type": "progress", "run_id": run_id, "fraction": .1, "detail": "first segment"})
    events.put({"type": "completed", "run_id": run_id, "result": {"language": "en", "words": [], "segments": []}})


def test_long_source_is_given_time_for_the_pre_segment_pass(tmp_path: Path) -> None:
    """The stall clock must not expire during the whole-file VAD pass.

    Measured on the deployment: a 2048s source returned its generator after
    151s and its first segment after 165s, against a 180s stall budget — so a
    long Smart job died with "Transcription stalled and was safely terminated"
    before it could produce anything.
    """
    from dataclasses import replace

    source = tmp_path / "audio.wav"
    source.write_bytes(b"test")
    impatient = replace(Settings.from_env(), transcription_stall_seconds=30)

    # Without a duration hint the short budget applies and this would trip.
    result = supervise(source, impatient, worker=_slow_start_worker, source_seconds=2048.0)
    assert result["language"] == "en"


def test_stall_budget_is_unchanged_for_short_sources(tmp_path: Path) -> None:
    from engine.transcription import startup_budget_seconds

    settings = Settings.from_env()
    assert startup_budget_seconds(settings, None) == settings.transcription_stall_seconds
    assert startup_budget_seconds(settings, 200.0) == settings.transcription_stall_seconds
    # A 34-minute source needs materially longer than the flat 180s budget.
    assert startup_budget_seconds(settings, 2048.0) > 500
