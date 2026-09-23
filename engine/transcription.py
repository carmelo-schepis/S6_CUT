"""Interruptible transcription supervision; children never touch the database."""
from __future__ import annotations

import inspect
import multiprocessing as mp
import queue
import signal
import time
import uuid
from pathlib import Path
from typing import Any, Callable

from . import media
from .config import Settings


def _child(
    run_id: str,
    path: str,
    settings: Settings,
    events: Any,
    profile: str = "speech",
    language: str | None = None,
) -> None:
    try:
        events.put({"type": "started", "run_id": run_id})
        def progress(fraction: float, detail: str = "") -> None:
            events.put({"type": "progress", "run_id": run_id, "fraction": fraction, "detail": detail})
        result = media.transcribe(Path(path), settings, progress_callback=progress, cancellation_callback=lambda: False, word_timestamps=True, profile=profile, language=language)
        events.put({"type": "completed", "run_id": run_id, "result": result})
    except BaseException as exc:
        events.put({"type": "failed", "run_id": run_id, "error": str(exc)[:500]})


def worker_exit_message(exitcode: int | None) -> str:
    """Explain a transcription worker that vanished without reporting a result."""
    if exitcode is not None and exitcode < 0:
        number = -exitcode
        if number == int(signal.SIGKILL):
            return (
                "Transcription stopped because the worker was killed (signal 9). "
                "This usually means the machine ran out of memory: give the engine "
                "container more RAM, or set a smaller S6_WHISPER_MODEL."
            )
        return f"Transcription stopped because the worker was killed by signal {number}"
    if exitcode:
        return f"Transcription worker exited with code {exitcode} without a result"
    return "Transcription worker exited without a result"


def startup_budget_seconds(settings: Settings, source_seconds: float | None) -> float:
    """Return the longer startup budget needed for long-source VAD."""
    if not source_seconds or source_seconds <= 0:
        return float(settings.transcription_stall_seconds)
    return max(float(settings.transcription_stall_seconds), source_seconds * 0.25 + 60.0)


def supervise(path: Path, settings: Settings, *, progress: Callable[[float, str], None] | None = None, cancelled: Callable[[], bool] | None = None, heartbeat: Callable[[], None] | None = None, meaningful: Callable[[float], None] | None = None, worker: Callable[..., None] = _child, source_seconds: float | None = None, profile: str = "speech", language: str | None = None) -> dict[str, Any]:
    run_id = uuid.uuid4().hex
    # Jobs run on background threads. Forking the multithreaded Uvicorn process
    # can inherit a locked OpenMP/BLAS runtime and leave Faster-Whisper consuming
    # memory without ever yielding a segment (observed in the Linux container).
    # A fresh interpreter is slightly slower to start, but avoids that unsafe
    # inherited native state and is portable across every supported platform.
    context = mp.get_context("spawn")
    events = context.Queue()
    base_args = (run_id, str(path), settings, events)
    worker_args = base_args
    worker_kwargs: dict[str, Any] = {}
    try:
        signature = inspect.signature(worker)
        try:
            signature.bind(*base_args, profile, language)
        except TypeError:
            signature.bind(*base_args, profile=profile, language=language)
            worker_kwargs = {"profile": profile, "language": language}
        else:
            worker_args += (profile, language)
    except (TypeError, ValueError):
        # Preserve compatibility with injected four-argument adapters whose
        # callable signature cannot be inspected. The production _child has a
        # stable signature and therefore takes the profile above.
        if worker is _child:
            worker_args += (profile, language)
    process = context.Process(target=worker, args=worker_args, kwargs=worker_kwargs, name=f"s6-transcription-{run_id[:8]}")
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
        process.join(2)
        raise media.MediaError(worker_exit_message(process.exitcode))
    finally:
        if process.is_alive():
            process.terminate(); process.join(2)
        events.close()
        events.join_thread()
