"""Interruptible transcription supervision; children never touch the database."""
from __future__ import annotations

import multiprocessing as mp
import queue
import time
import uuid
from pathlib import Path
from typing import Any, Callable

from . import media
from .config import Settings


def _child(run_id: str, path: str, settings: Settings, events: Any) -> None:
    try:
        events.put({"type": "started", "run_id": run_id})
        def progress(fraction: float, detail: str = "") -> None:
            events.put({"type": "progress", "run_id": run_id, "fraction": fraction, "detail": detail})
        result = media.transcribe(Path(path), settings, progress_callback=progress, cancellation_callback=lambda: False, word_timestamps=True)
        events.put({"type": "completed", "run_id": run_id, "result": result})
    except BaseException as exc:
        events.put({"type": "failed", "run_id": run_id, "error": str(exc)[:500]})


def startup_budget_seconds(settings: Settings, source_seconds: float | None) -> float:
    """How long to wait for the *first* segment.

    Faster-Whisper runs its VAD pass over the whole file before yielding any
    segment, so the silent opening stretch grows with the source rather than
    being a fixed cost. Measured on this deployment: a 2048s source returned
    its generator after 151s and its first segment after 165s, which a flat
    180s stall budget only just survived — and did not survive under load.
    Once segments start arriving the ordinary budget applies again, so a
    genuinely hung decode is still caught as quickly as before.
    """
    if not source_seconds or source_seconds <= 0:
        return float(settings.transcription_stall_seconds)
    return max(float(settings.transcription_stall_seconds), source_seconds * 0.25 + 60.0)


def supervise(path: Path, settings: Settings, *, progress: Callable[[float, str], None] | None = None, cancelled: Callable[[], bool] | None = None, heartbeat: Callable[[], None] | None = None, meaningful: Callable[[float], None] | None = None, worker: Callable[..., None] = _child, source_seconds: float | None = None) -> dict[str, Any]:
    run_id = uuid.uuid4().hex
    # Jobs run on background threads. Forking the multithreaded Uvicorn process
    # can inherit a locked OpenMP/BLAS runtime and leave Faster-Whisper consuming
    # memory without ever yielding a segment (observed in the Linux container).
    # A fresh interpreter is slightly slower to start, but avoids that unsafe
    # inherited native state and is portable across every supported platform.
    context = mp.get_context("spawn")
    events = context.Queue()
    process = context.Process(target=worker, args=(run_id, str(path), settings, events), name=f"s6-transcription-{run_id[:8]}")
    process.start()
    started = time.monotonic()
    last_progress = started
    startup_limit = startup_budget_seconds(settings, source_seconds)
    saw_progress = False
    try:
        while process.is_alive() or not events.empty():
            if heartbeat:
                heartbeat()
            if cancelled and cancelled():
                process.terminate()
                process.join(2)
                if process.is_alive(): process.kill(); process.join(2)
                raise media.TranscriptionCancelled("Transcription cancelled")
            try:
                event = events.get(timeout=.1)
            except queue.Empty:
                limit = settings.transcription_stall_seconds if saw_progress else startup_limit
                if time.monotonic() - last_progress > limit:
                    process.terminate(); process.join(2)
                    if process.is_alive(): process.kill(); process.join(2)
                    raise media.MediaError("Transcription stalled and was safely terminated")
                continue
            if event.get("run_id") != run_id:
                continue
            if event.get("type") == "progress":
                fraction = max(0.0, min(1.0, float(event.get("fraction", 0))))
                last_progress = time.monotonic()
                saw_progress = True
                if meaningful: meaningful(fraction)
                if progress: progress(fraction, str(event.get("detail", "")))
            elif event.get("type") == "completed":
                process.join(2)
                return event["result"]
            elif event.get("type") == "failed":
                raise media.MediaError(str(event.get("error", "Transcription failed")))
        raise media.MediaError("Transcription worker exited without a result")
    finally:
        if process.is_alive():
            process.terminate(); process.join(2)
        events.close()
        events.join_thread()
