from __future__ import annotations

import asyncio
import json
import os
import threading
import time
import uuid
import zipfile
from collections import defaultdict
from pathlib import Path
from typing import Any

from . import media as media_module
from .config import Settings
from .database import Database
from .library import LibraryRules
from .media import (
    MediaError, available, download_youtube, probe, probe_audio, render_clip, render_script,
    sha256_file, synthesize_local, transcribe,
)
from .models import (
    Clip, Job, ProcessingMode, ProcessingStep, ProvenanceRecord, ScoreBreakdown, now_iso,
)
from .providers import ProfileService, provider_runtime_message
from .script import align_script_words, plan_beats
from .security import redact, safe_filename
from .selection import clip_from_candidate, select_candidates


class QueueFullError(RuntimeError):
    pass


class SwitchFastError(RuntimeError):
    pass


def job_processing_mode(job: Job, private: dict[str, Any]) -> ProcessingMode:
    """Resolved processing mode: private snapshot first, public record next, legacy jobs default to smart."""
    value = private.get("processing_mode") or job.processing_mode or "smart"
    return value if value in {"fast", "smart"} else "smart"


def _media_fn(name: str):
    fn = getattr(media_module, name, None)
    if not callable(fn):
        raise MediaError(f"{name} is not available in this engine runtime")
    return fn


class JobManager:
    def __init__(self, db: Database, rules: LibraryRules, profiles: ProfileService, settings: Settings):
        self.db = db
        self.rules = rules
        self.profiles = profiles
        self.settings = settings
        self.queue: asyncio.Queue[str] = asyncio.Queue(maxsize=settings.max_queued_jobs)
        self.workers: list[asyncio.Task[None]] = []
        self.recovery_task: asyncio.Task[None] | None = None
        self.job_locks: defaultdict[str, threading.Lock] = defaultdict(threading.Lock)
        self.active_workers = 0
        self._active_lock = threading.Lock()

    async def start(self) -> None:
        if self.workers:
            return
        for index in range(self.settings.job_workers):
            self.workers.append(asyncio.create_task(self._worker(index), name=f"s6-worker-{index}"))
        recovered: list[str] = []
        for job in reversed(self.db.list_jobs(("queued", "active", "recovered"))):
            job.state = "recovered"
            job.stage_label = "Recovered after engine restart"
            self._save(job)
            recovered.append(job.id)
        if recovered:
            self.recovery_task = asyncio.create_task(self._feed_recovered(recovered), name="s6-recovery-feeder")

    async def _feed_recovered(self, job_ids: list[str]) -> None:
        for job_id in job_ids:
            await self.queue.put(job_id)

    async def stop(self) -> None:
        if self.recovery_task:
            self.recovery_task.cancel()
            await asyncio.gather(self.recovery_task, return_exceptions=True)
            self.recovery_task = None
        for worker in self.workers:
            worker.cancel()
        if self.workers:
            await asyncio.gather(*self.workers, return_exceptions=True)
        self.workers.clear()

    async def enqueue(self, job_id: str, *, tolerate_full: bool = False) -> None:
        try:
            self.queue.put_nowait(job_id)
        except asyncio.QueueFull:
            if not tolerate_full:
                raise QueueFullError("The local render queue is full. Wait for an active job or raise S6_MAX_QUEUED_JOBS.")

    async def _worker(self, _: int) -> None:
        while True:
            job_id = await self.queue.get()
            try:
                await asyncio.to_thread(self._process, job_id)
            finally:
                self.queue.task_done()

    def _save(self, job: Job, private: dict[str, Any] | None = None) -> None:
        current = self.db.get_job(job.id)
        if current and current.state == "cancelled_kept" and job.state != "cancelled_kept":
            job.state = "cancelled_kept"
            job.stage = current.stage
            job.stage_label = current.stage_label
            job.error = current.error
            job.steps = current.steps
        job.updated_at = now_iso()
        self.db.save_job(job, private)
        project = self.db.get_project(job.project_id)
        if project and (project.latest_job_id is None or project.latest_job_id == job.id):
            project.state = job.state
            project.updated_at = job.updated_at
            self.db.save_project(project)
        directory = self.settings.data_path / "jobs" / job.id
        directory.mkdir(parents=True, exist_ok=True)
        temp = directory / "state.json.tmp"
        temp.write_text(job.model_dump_json(by_alias=True, indent=2), encoding="utf-8")
        os.replace(temp, directory / "state.json")

    def _stage(self, job: Job, stage: str, label: str, progress: float, *, current: int = 0, total: int = 0, private: dict[str, Any] | None = None) -> None:
        job.state = "active"
        job.stage = stage
        job.stage_label = label
        job.progress = progress
        job.current_item = current
        job.total_items = total
        self._save(job, private)

    def _cooperate(self, job: Job) -> bool:
        while True:
            current = self.db.get_job(job.id)
            if not current:
                return False
            if current.state == "paused":
                time.sleep(.4)
                continue
            if current.state == "cancelled_kept":
                job.state = current.state
                job.stage = current.stage
                job.stage_label = current.stage_label
                job.steps = current.steps
                return False
            return True

    # ------------------------------------------------------------------
    #  Structured processing checklist
    # ------------------------------------------------------------------

    def _step_by_id(self, job: Job, step_id: str) -> ProcessingStep:
        for step in job.steps:
            if step.id == step_id:
                return step
        raise KeyError(f"Job {job.id} has no processing step {step_id!r}")

    def _apply_step(self, job: Job, step: ProcessingStep, *, status: str, detail: str | None = None, current: int | None = None, total: int | None = None, started_at: str | None = None, completed_at: str | None = None) -> None:
        """In-memory mutation shared by every step transition helper."""
        step.status = status
        if detail is not None:
            step.detail = detail
        if current is not None:
            step.current_item = current
        if total is not None:
            step.total_items = total
        if started_at is not None:
            step.started_at = step.started_at or started_at
        if completed_at is not None:
            step.started_at = step.started_at or completed_at
            step.completed_at = completed_at
        elif status in {"complete", "skipped", "failed"}:
            timestamp = now_iso()
            step.started_at = step.started_at or timestamp
            step.completed_at = step.completed_at or timestamp
        elif status == "active":
            step.completed_at = None
            step.started_at = step.started_at or now_iso()

    def _sync_legacy(self, job: Job, step: ProcessingStep, *, label: str | None = None, progress: float | None = None) -> None:
        """Keep the compatibility stage fields consistent with the active step."""
        job.state = "active"
        job.stage = step.id
        if label is not None:
            job.stage_label = label
        if progress is not None:
            job.progress = progress
        if step.current_item is not None:
            job.current_item = step.current_item
        if step.total_items is not None:
            job.total_items = step.total_items

    def start_step(self, job: Job, step_id: str, *, detail: str | None = None, label: str | None = None, progress: float | None = None, current: int | None = None, total: int | None = None, private: dict[str, Any] | None = None) -> None:
        """Mark a step active (idempotent) while enforcing at most one active step."""
        step = self._step_by_id(job, step_id)
        if step.status in {"complete", "skipped", "failed"}:
            # Terminal outcomes are never reverted by ordinary processing; an
            # explicit retry is the only reset path. Refresh progress detail only.
            self._apply_step(job, step, status=step.status, detail=detail, current=current, total=total)
            self._sync_legacy(job, step, label=label, progress=progress)
            self._save(job, private)
            return
        active = next((other for other in job.steps if other.id != step.id and other.status == "active"), None)
        if active:
            raise RuntimeError(f"Cannot start step {step_id!r} while step {active.id!r} is still active")
        self._apply_step(job, step, status="active", detail=detail, current=current, total=total)
        self._sync_legacy(job, step, label=label, progress=progress)
        self._save(job, private)

    def complete_step(self, job: Job, step_id: str, *, detail: str | None = None, current: int | None = None, total: int | None = None, label: str | None = None, progress: float | None = None, private: dict[str, Any] | None = None) -> None:
        step = self._step_by_id(job, step_id)
        self._apply_step(job, step, status="complete", detail=detail, current=current, total=total)
        if label is not None or progress is not None:
            self._sync_legacy(job, step, label=label, progress=progress)
        self._save(job, private)

    def skip_step(self, job: Job, step_id: str, *, detail: str | None = None, private: dict[str, Any] | None = None) -> None:
        step = self._step_by_id(job, step_id)
        self._apply_step(job, step, status="skipped", detail=detail)
        self._save(job, private)

    def fail_step(self, job: Job, step_id: str, *, detail: str | None = None, private: dict[str, Any] | None = None) -> None:
        step = self._step_by_id(job, step_id)
        self._apply_step(job, step, status="failed", detail=detail)
        self._save(job, private)

    def _fast_steps(self) -> list[ProcessingStep]:
        return [
            ProcessingStep(id="source", label="Source received"),
            ProcessingStep(id="probe", label="Video validated"),
            ProcessingStep(id="plan", label="Cut points planned"),
            ProcessingStep(id="render", label="Clips rendered"),
            ProcessingStep(id="verify", label="Outputs verified"),
            ProcessingStep(id="ready", label="Project ready"),
        ]

    def _smart_steps(self, use_openrouter: bool = False) -> list[ProcessingStep]:
        provider_step = ProcessingStep(id="openrouter", label="OpenRouter planning")
        if not use_openrouter:
            timestamp = now_iso()
            provider_step.status = "skipped"
            provider_step.detail = "No connected provider; used local planning"
            provider_step.started_at = provider_step.completed_at = timestamp
        return [
            ProcessingStep(id="source", label="Source received"),
            ProcessingStep(id="probe", label="Video validated"),
            ProcessingStep(id="audio", label="Audio prepared"),
            ProcessingStep(id="transcribe", label="Speech transcribed"),
            provider_step,
            ProcessingStep(id="local_planning", label="Local planning fallback"),
            ProcessingStep(id="select", label="Complete moments selected"),
            ProcessingStep(id="boundaries", label="Clip boundaries verified"),
            ProcessingStep(id="render", label="Clips rendered"),
            ProcessingStep(id="verify", label="Outputs verified"),
            ProcessingStep(id="ready", label="Project ready"),
        ]

    def _script_steps(self) -> list[ProcessingStep]:
        return [
            ProcessingStep(id="validate", label="Script validated"),
            ProcessingStep(id="narration", label="Narration prepared"),
            ProcessingStep(id="elevenlabs", label="ElevenLabs narration"),
            ProcessingStep(id="local_voice", label="Local narration fallback"),
            ProcessingStep(id="align", label="Words aligned"),
            ProcessingStep(id="plan", label="Visual beats planned"),
            ProcessingStep(id="assets", label="Assets resolved"),
            ProcessingStep(id="render", label="Video rendered"),
            ProcessingStep(id="verify", label="Output verified"),
            ProcessingStep(id="ready", label="Project ready"),
        ]

    @staticmethod
    def _mark_proven(step: ProcessingStep | None, as_of: str) -> None:
        if step and step.status == "pending":
            step.status = "complete"
            step.started_at = step.started_at or as_of
            step.completed_at = as_of

    def _restore_proven_steps(self, job: Job, private: dict[str, Any], as_of: str) -> None:
        """For older active jobs, restore only steps provable from persisted records."""
        by_id = {step.id: step for step in job.steps}
        if job.mode == "script":
            if job.beats:
                for step_id in ("validate", "plan"):
                    self._mark_proven(by_id.get(step_id), as_of)
        else:
            mode = job_processing_mode(job, private)
            source_path = Path(str(private.get("source_path") or ""))
            if source_path.is_file():
                self._mark_proven(by_id.get("source"), as_of)
            if isinstance(private.get("source_metadata"), dict):
                self._mark_proven(by_id.get("probe"), as_of)
            if private.get("transcript"):
                self._mark_proven(by_id.get("transcribe"), as_of)
                audio_step = by_id.get("audio")
                audio_path = self.settings.data_path / "jobs" / job.id / "transcription" / "audio-16k.wav"
                if audio_path.is_file():
                    self._mark_proven(audio_step, as_of)
                elif audio_step and audio_step.status == "pending":
                    audio_step.status = "skipped"
                    audio_step.detail = "Legacy transcript exists; audio preparation history unavailable"
                    audio_step.started_at = audio_step.completed_at = as_of
            if job.clips:
                if mode == "fast":
                    self._mark_proven(by_id.get("plan"), as_of)
                else:
                    for step_id in ("local_planning", "select", "boundaries"):
                        self._mark_proven(by_id.get(step_id), as_of)
        render_step = by_id.get("render")
        if render_step and job.clips:
            verified_done = [
                clip for clip in job.clips
                if clip.state == "complete" and clip.output_name
                and (self.settings.data_path / "jobs" / job.id / "clips" / clip.output_name).is_file()
            ]
            render_step.current_item = len(verified_done)
            render_step.total_items = len(job.clips)

    def _init_steps(self, job: Job, private: dict[str, Any]) -> None:
        """Create the mode-specific checklist once, restoring only provable work.

        Legacy jobs without steps stay empty until their resolved processing
        mode is known (first processing); complete jobs are left untouched so
        the UI can render a compact legacy summary instead of fabricated history.
        """
        if job.steps or job.state == "complete":
            return
        as_of = job.updated_at
        if job.mode == "script":
            job.steps = self._script_steps()
        else:
            mode = job_processing_mode(job, private)
            job.steps = self._fast_steps() if mode == "fast" else self._smart_steps(bool(private.get("use_openrouter")))
        self._restore_proven_steps(job, private, as_of)
        self._save(job, private)

    def _reset_steps_for_retry(self, job: Job) -> None:
        """Retry resets only the render/output/project steps the retried work re-runs."""
        done = sum(1 for clip in job.clips if clip.state == "complete")
        total = len(job.clips)
        for step in job.steps:
            if step.id in {"render", "verify", "ready"}:
                step.status = "pending"
                step.detail = "Retrying failed outputs"
                step.started_at = None
                step.completed_at = None
                if total:
                    step.current_item = done
                    step.total_items = total
        if job.steps:
            job.progress = 0
            job.current_item = done
            job.total_items = total

    def _reconcile_steps(self, job: Job, private: dict[str, Any]) -> None:
        """Initialize legacy steps and detect retries triggered outside the control path."""
        self._init_steps(job, private)
        if job.steps and any(clip.state == "queued" for clip in job.clips):
            render_step = next((step for step in job.steps if step.id == "render"), None)
            if render_step and render_step.status == "complete":
                self._reset_steps_for_retry(job)
                self._save(job, private)

    @staticmethod
    def _transcript_detail(transcript: dict[str, Any]) -> str:
        words = transcript.get("words") or []
        segments = transcript.get("segments") or []
        duration = max((float(word["end"]) for word in words if "end" in word), default=0.0)
        if segments:
            return f"{len(segments)} segments · {duration:.0f}s processed"
        return f"{len(words)} words · {duration:.0f}s processed"

    def _finish_render_steps(self, job: Job, private: dict[str, Any], successful: list[Clip], failed: list[Clip], output_dir: Path, noun: str, ready_label: str) -> None:
        total = len(job.clips)
        if failed and not successful:
            self.fail_step(job, "render", detail=f"All {len(failed)} {noun} failed", private=private)
            render_step = self._step_by_id(job, "render")
            render_step.current_item, render_step.total_items = 0, total
        else:
            detail = f"{len(successful)} of {total} rendered" + (f"; {len(failed)} failed" if failed else "")
            self.complete_step(job, "render", detail=detail, current=len(successful), total=total, private=private)
        verified = [
            clip for clip in job.clips
            if clip.state == "complete" and clip.output_name and (output_dir / clip.output_name).is_file()
        ]
        missing = [
            clip for clip in job.clips
            if clip.state == "complete" and not (clip.output_name and (output_dir / clip.output_name).is_file())
        ]
        if missing:
            job.warnings.append(f"{len(missing)} recorded output(s) missing from disk.")
        if verified:
            parts = [f"{len(verified)} of {total} outputs verified"]
            if failed:
                parts.append(f"{len(failed)} failed")
            if missing:
                parts.append(f"{len(missing)} missing")
            self.complete_step(job, "verify", detail="; ".join(parts), current=len(verified), total=total, private=private)
        else:
            self.fail_step(job, "verify", detail="No outputs produced", private=private)
            verify_step = self._step_by_id(job, "verify")
            verify_step.current_item, verify_step.total_items = 0, total
        job.state = "complete" if successful and not failed else "partial" if successful else "failed"
        job.stage = "complete" if successful else "failed"
        job.stage_label = f"{len(successful)} {ready_label}" if successful else "No clips rendered"
        job.progress = 100
        if failed:
            job.warnings.append(f"{len(failed)} {noun} failed independently and can be retried.")
        self._save(job, private)
        if job.state in {"complete", "partial"}:
            self.complete_step(job, "ready", detail="Project ready" + (" (partial)" if failed else ""), private=private)
        else:
            self.fail_step(job, "ready", detail="Project failed", private=private)

    # ------------------------------------------------------------------
    #  Pipelines
    # ------------------------------------------------------------------

    def _process(self, job_id: str) -> None:
        lock = self.job_locks[job_id]
        if not lock.acquire(blocking=False):
            return
        with self._active_lock:
            self.active_workers += 1
        try:
            job = self.db.get_job(job_id)
            if not job or job.state in {"complete", "cancelled_kept"}:
                return
            private = self.db.get_job_private(job_id)
            self._reconcile_steps(job, private)
            if job.mode == "clip":
                self._process_clip(job, private)
            else:
                self._process_script(job, private)
        except media_module.TranscriptionCancelled:
            return
        except Exception as exc:  # scoped outer guard preserves already-published clips
            job = self.db.get_job(job_id)
            if job:
                successful = any(clip.state == "complete" for clip in job.clips)
                job.state = "partial" if successful else "failed"
                job.stage = "failed"
                job.stage_label = "Stopped with recoverable work" if successful else "Project failed"
                job.error = redact(str(exc))
                active = next((step for step in job.steps if step.status == "active"), None)
                if active:
                    self._apply_step(job, active, status="failed", detail=redact(str(exc)))
                else:
                    pending = next((step for step in job.steps if step.status == "pending"), None)
                    if pending:
                        self._apply_step(job, pending, status="failed", detail=redact(str(exc)))
                self._save(job)
        finally:
            with self._active_lock:
                self.active_workers -= 1
            lock.release()

    def _source(self, job: Job, private: dict[str, Any]) -> Path:
        if private.get("source_path"):
            source = Path(private["source_path"])
            if source.is_file():
                self.complete_step(job, "source", detail="Source received and validated", private=private)
                return source
        if private.get("url"):
            self.start_step(job, "source", detail="Importing authorised YouTube source", label="Importing authorised YouTube source", progress=5, private=private)
            source = download_youtube(private["url"], self.settings.data_path / "jobs" / job.id / "source", self.settings)
            private["source_path"] = str(source)
            self.complete_step(job, "source", detail="YouTube source imported and validated", private=private)
            return source
        raise MediaError("The source file is missing from the mounted data directory")

    def _process_clip(self, job: Job, private: dict[str, Any]) -> None:
        mode = job_processing_mode(job, private)
        if mode == "fast":
            self._process_clip_fast(job, private)
        else:
            self._process_clip_smart(job, private)

    def _transcribe_with_stages(self, job: Job, audio: Path, duration: float, private: dict[str, Any]) -> dict[str, Any]:
        cached = media_module.is_whisper_model_cached(self.settings)
        model_label = "Preparing transcription model" if cached else "Downloading transcription model"
        self.start_step(job, "transcribe", detail=model_label, label=model_label, progress=16, private=private)
        callback = self._transcription_progress(job, private, duration)
        self.start_step(job, "transcribe", detail="Transcribing audio", label="Transcribing audio", progress=18, private=private)
        transcript = media_module.transcribe(
            audio,
            self.settings,
            progress_callback=callback,
            cancellation_callback=lambda: not self._cooperate(job),
            word_timestamps=True,
        )
        self.start_step(job, "transcribe", detail="Finalising timed transcript", label="Finalising timed transcript", progress=32, private=private)
        return transcript

    def _transcription_progress(self, job: Job, private: dict[str, Any], duration: float):
        last_fraction = 0.0

        def report(fraction: float, _: str = "") -> None:
            nonlocal last_fraction
            fraction = max(0.0, min(1.0, float(fraction)))
            if fraction < 1 and fraction - last_fraction < 0.03:
                return
            last_fraction = fraction
            processed = min(duration, duration * fraction)
            label = f"Transcribing audio — {processed:.0f}s of {duration:.0f}s"
            step = self._step_by_id(job, "transcribe")
            self._apply_step(
                job, step, status="active", detail=label,
                current=int(processed), total=max(1, int(duration + .999)),
            )
            self._sync_legacy(job, step, label=label, progress=18 + 14 * fraction)
            self._save(job, private)

        return report

    def _plan_smart_candidates(self, job: Job, private: dict[str, Any], words: list[dict[str, Any]]):
        requested = int(private["count"])
        pool = select_candidates(
            words, job.style, min(30, max(requested, requested * 3)),
            float(private["min_duration"]), float(private["max_duration"]),
        )
        if not pool:
            return []
        if not private.get("use_openrouter"):
            self.start_step(job, "local_planning", detail="Using deterministic local planning", label="Planning clips locally", progress=33, private=private)
            chosen = pool[:requested]
            self.complete_step(job, "local_planning", detail=f"{len(chosen)} candidates planned locally", private=private)
            return chosen
        self.start_step(job, "openrouter", detail="Reviewing deterministic candidate excerpts", label="Planning clips with OpenRouter", progress=33, private=private)
        try:
            excerpts = [
                {"index": index, "start": candidate.start, "end": candidate.end, "text": " ".join(str(word["text"]) for word in candidate.words)[:800]}
                for index, candidate in enumerate(pool)
            ]
            result = asyncio.run(self.profiles.openrouter_json(
                [{"role": "user", "content": f"Choose up to {requested} distinct candidate indexes for {job.style} short clips. Candidates: {json.dumps(excerpts, ensure_ascii=False)}"}],
                {
                    "type": "object",
                    "properties": {"indexes": {"type": "array", "items": {"type": "integer", "minimum": 0, "maximum": len(pool) - 1}, "minItems": 1, "maxItems": requested}},
                    "required": ["indexes"], "additionalProperties": False,
                },
            ))
            indexes = result.get("indexes") if isinstance(result, dict) else None
            if not isinstance(indexes, list):
                raise ValueError("OpenRouter returned a malformed planning response")
            unique = list(dict.fromkeys(int(index) for index in indexes if isinstance(index, int) and 0 <= index < len(pool)))
            if not unique:
                raise ValueError("OpenRouter returned no usable candidate indexes")
            chosen = [pool[index] for index in unique[:requested]]
            self.complete_step(job, "openrouter", detail=f"AI planning completed for {len(chosen)} candidates", private=private)
            self.skip_step(job, "local_planning", detail="OpenRouter planning succeeded", private=private)
            return chosen
        except Exception as exc:
            self.fail_step(job, "openrouter", detail=provider_runtime_message(exc, "OpenRouter"), private=private)
            job.warnings.append(f"{provider_runtime_message(exc, 'OpenRouter')}; used deterministic local planning.")
            self.start_step(job, "local_planning", detail="Using deterministic local planning fallback", label="Using local planning fallback", progress=33, private=private)
            chosen = pool[:requested]
            self.complete_step(job, "local_planning", detail=f"{len(chosen)} candidates planned locally", private=private)
            return chosen

    def _process_clip_smart(self, job: Job, private: dict[str, Any]) -> None:
        source = self._source(job, private)
        if not self._cooperate(job):
            self._save(job)
            return
        metadata = private.get("source_metadata")
        if not isinstance(metadata, dict):
            self.start_step(job, "probe", detail="Running FFprobe validation", label="Validating source with FFprobe", progress=8, private=private)
            metadata = probe(source, self.settings)
            private["source_metadata"] = metadata
            self.complete_step(job, "probe", detail=f"Source validated — {metadata['duration']:.1f}s", private=private)
        if not metadata["audio"]:
            raise MediaError("This video has no readable audio track. Automatic clips require speech; retain it as a source for manual editing.")
        transcript = private.get("transcript")
        if not transcript:
            if not self._cooperate(job):
                self._save(job)
                return
            source_hash = str(private.get("source_hash") or sha256_file(source))
            private["source_hash"] = source_hash
            cache_key = (
                f"transcript:v2:{source_hash}:{self.settings.whisper_model}:"
                f"{self.settings.whisper_device}:{self.settings.whisper_compute_type}:"
                f"beam{self.settings.whisper_beam_size}:words1"
            )
            transcript = self.db.cache_get(cache_key)
            if transcript:
                self.skip_step(job, "audio", detail="Validated transcript cache reused", private=private)
                job.warnings.append("Reused a validated local transcript cache entry.")
            else:
                self.start_step(job, "audio", detail="Extracting 16 kHz mono audio", label="Preparing audio for transcription", progress=12, private=private)
                audio = media_module.extract_audio_16k(
                    source, self.settings,
                    output=self.settings.data_path / "jobs" / job.id / "transcription" / "audio-16k.wav",
                )
                self.complete_step(job, "audio", detail="16 kHz mono audio prepared", private=private)
                transcript = self._transcribe_with_stages(job, audio, float(metadata["duration"]), private)
                self.db.cache_put(cache_key, now_iso(), transcript)
            private["transcript"] = transcript
            self._save(job, private)
            self.complete_step(job, "transcribe", detail=self._transcript_detail(transcript), private=private)
        words = transcript["words"]
        if not job.clips:
            if not self._cooperate(job):
                self._save(job)
                return
            candidates = self._plan_smart_candidates(job, private, words)
            self.start_step(job, "select", detail="Selecting complete moments", label="Finding coherent, complete moments", progress=34, private=private)
            if not candidates:
                raise MediaError("The transcript did not contain a valid complete moment inside the requested duration range")
            if len(candidates) < int(private["count"]):
                job.warnings.append(f"Found {len(candidates)} valid clips instead of {private['count']}; complete boundaries were prioritised over filler.")
            clips: list[Clip] = []
            for index, candidate in enumerate(candidates, 1):
                clip = clip_from_candidate(candidate, index)
                clip.id = str(uuid.uuid4())
                excerpt = " ".join(str(word["text"]) for word in candidate.words)
                visual = self.rules.resolve(excerpt)
                clip.visual_label = visual.label
                clip.fallback_used = visual.source != "library"
                if visual.asset:
                    clip.provenance.append(ProvenanceRecord(id=str(uuid.uuid4()), provider="personal-library", licence=visual.asset.licence, attribution=visual.asset.attribution or visual.asset.title, query=visual.label, match_reason=visual.match_reason, content_hash=visual.asset.content_hash))
                else:
                    clip.provenance.append(ProvenanceRecord(id=str(uuid.uuid4()), provider="local-text-card", licence="Generated locally by S6_cut", attribution="No attribution required", query=visual.label, match_reason=visual.match_reason))
                clips.append(clip)
            job.clips = clips
            job.total_items = len(clips)
            self._save(job, private)
            self.complete_step(job, "select", detail=f"{len(clips)} moments selected", private=private)
            self.start_step(job, "boundaries", detail="Verifying clip boundaries against the source timeline", label="Verifying clip boundaries", progress=36, private=private)
            for clip in clips:
                if clip.start < 0 or clip.end > metadata["duration"] or clip.end <= clip.start:
                    raise MediaError(f"Clip {clip.index} falls outside the source timeline")
            self.complete_step(job, "boundaries", detail=f"{len(clips)} boundaries verified", private=private)
        output_dir = self.settings.data_path / "jobs" / job.id / "clips"
        output_dir.mkdir(parents=True, exist_ok=True)
        for position, clip in enumerate(job.clips, 1):
            if clip.state == "complete":
                continue
            if not self._cooperate(job):
                self._save(job)
                return
            render_step = self._step_by_id(job, "render")
            clip.state = "rendering"
            clip.error = None
            completed_before = sum(1 for item in job.clips if item.state == "complete")
            self._apply_step(job, render_step, status="active", detail=f"Rendering clip {position} of {len(job.clips)}", current=completed_before, total=len(job.clips))
            job.state = "active"
            job.stage = "render"
            job.stage_label = f"Rendering clip {position} of {len(job.clips)}"
            job.progress = 40 + (position - 1) / max(len(job.clips), 1) * 54
            job.current_item = completed_before
            job.total_items = len(job.clips)
            output = output_dir / f"{position:02d}-{safe_filename(clip.opening_line[:36], 'short')}.mp4"
            clip_words = [word for word in words if float(word["end"]) >= clip.start and float(word["start"]) <= clip.end]
            visual = self.rules.resolve(" ".join(str(word["text"]) for word in clip_words))
            overlays = [(visual.asset_path, .65, min(3.4, clip.duration - .2))] if visual.asset_path and visual.asset_path.exists() and clip.duration > 1 else []
            visuals = [(clip.visual_label or "Key idea", .45, min(3.0, clip.duration))]
            try:
                render_clip(source, output, start=clip.start, end=clip.end, aspect=private["aspect_ratio"], words=words, visuals=visuals, overlays=overlays, settings=self.settings)
                clip.state = "complete"
                clip.output_name = output.name
                clip.selected = True
            except Exception as exc:
                clip.state = "failed"
                clip.error = redact(str(exc))
                clip.selected = False
            rendered = sum(1 for item in job.clips if item.state == "complete")
            self._apply_step(job, render_step, status="active", detail=f"{rendered} of {len(job.clips)} rendered", current=rendered)
            job.current_item = rendered
            self._save(job, private)
        successful = [clip for clip in job.clips if clip.state == "complete"]
        failed = [clip for clip in job.clips if clip.state == "failed"]
        self._finish_render_steps(job, private, successful, failed, output_dir, "clip(s)", "clips ready")

    def _process_clip_fast(self, job: Job, private: dict[str, Any]) -> None:
        source = self._source(job, private)
        if not self._cooperate(job):
            self._save(job)
            return
        metadata = private.get("source_metadata")
        if not isinstance(metadata, dict):
            self.start_step(job, "probe", detail="Running FFprobe validation", label="Validating source for fast cuts", progress=10, private=private)
            metadata = probe(source, self.settings)
            private["source_metadata"] = metadata
            self.complete_step(job, "probe", detail=f"Source validated — {metadata['duration']:.1f}s", private=private)
        if not self._cooperate(job):
            self._save(job)
            return
        if not job.clips:
            self.start_step(job, "plan", detail="Planning neutral fast-cut windows", label="Planning neutral fast-cut windows", progress=28, private=private)
            plan = _media_fn("plan_fast_windows")
            windows, warning = plan(
                metadata["duration"], int(private["count"]), float(private["min_duration"]),
                float(private["max_duration"]), self.settings.fast_guard_seconds,
            )
            if warning:
                if isinstance(warning, str):
                    job.warnings.append(warning)
                else:
                    job.warnings.extend(str(item) for item in warning)
            if not windows:
                raise MediaError("The source did not contain a window long enough for a fast cut")
            job.clips = [
                Clip(
                    id=str(uuid.uuid4()), index=index, state="queued", start=start, end=end,
                    duration=end - start, opening_line=f"Cut {index:02d}", score=None,
                )
                for index, (start, end) in enumerate(windows, 1)
            ]
            job.total_items = len(job.clips)
            self._save(job, private)
            self.complete_step(job, "plan", detail=f"{len(job.clips)} windows planned", private=private)
        output_dir = self.settings.data_path / "jobs" / job.id / "clips"
        output_dir.mkdir(parents=True, exist_ok=True)
        render = _media_fn("render_fast_clip")
        has_audio = bool(metadata["audio"])
        for position, clip in enumerate(job.clips, 1):
            if clip.state == "complete":
                continue
            if not self._cooperate(job):
                self._save(job)
                return
            render_step = self._step_by_id(job, "render")
            clip.state = "rendering"
            clip.error = None
            completed_before = sum(1 for item in job.clips if item.state == "complete")
            self._apply_step(job, render_step, status="active", detail=f"Rendering fast cut {position} of {len(job.clips)}", current=completed_before, total=len(job.clips))
            job.state = "active"
            job.stage = "render"
            job.stage_label = f"Rendering fast cut {position} of {len(job.clips)}"
            job.progress = 40 + (position - 1) / max(len(job.clips), 1) * 54
            job.current_item = completed_before
            job.total_items = len(job.clips)
            output = output_dir / f"{position:02d}-cut.mp4"
            try:
                render(source, output, start=clip.start, end=clip.end, aspect=private["aspect_ratio"], has_audio=has_audio, settings=self.settings)
                clip.state = "complete"
                clip.output_name = output.name
                clip.selected = True
            except Exception as exc:
                clip.state = "failed"
                clip.error = redact(str(exc))
                clip.selected = False
            rendered = sum(1 for item in job.clips if item.state == "complete")
            self._apply_step(job, render_step, status="active", detail=f"{rendered} of {len(job.clips)} rendered", current=rendered)
            job.current_item = rendered
            self._save(job, private)
        successful = [clip for clip in job.clips if clip.state == "complete"]
        failed = [clip for clip in job.clips if clip.state == "failed"]
        self._finish_render_steps(job, private, successful, failed, output_dir, "fast cut(s)", "fast cuts ready")

    def _process_script(self, job: Job, private: dict[str, Any]) -> None:
        script = str(private["script"])
        work = self.settings.data_path / "jobs" / job.id
        work.mkdir(parents=True, exist_ok=True)
        narration: Path | None = None
        self.start_step(job, "validate", detail="Validating script input", label="Validating the exact source script", progress=5, private=private)
        if len(script.strip()) < 10:
            raise MediaError("The script is too short to render")
        self.complete_step(job, "validate", detail=f"Script validated — {len(script)} characters", private=private)
        if private.get("narration") != "silent":
            if private.get("narration") == "auto":
                try:
                    self.start_step(job, "elevenlabs", detail="Requesting ElevenLabs narration", label="Creating paragraph-safe narration", progress=15, private=private)
                    candidate = work / "narration-elevenlabs.mp3"
                    if self.profiles.synthesize_elevenlabs(script, candidate):
                        narration = candidate
                        self.complete_step(job, "elevenlabs", detail="ElevenLabs narration complete", private=private)
                    else:
                        self.skip_step(job, "elevenlabs", detail="No connected provider; used local narration", private=private)
                except Exception as exc:
                    self.fail_step(job, "elevenlabs", detail=redact(str(exc)), private=private)
                    job.warnings.append(f"{provider_runtime_message(exc, 'ElevenLabs')}; used the local voice fallback.")
            else:
                self.skip_step(job, "elevenlabs", detail="Local narration selected", private=private)
            if narration is None and available(self.settings.local_tts):
                self.start_step(job, "local_voice", detail="Synthesising local narration", label="Synthesising local narration", progress=15, private=private)
                try:
                    narration = synthesize_local(script, work / "narration-local.wav", self.settings)
                    self.complete_step(job, "local_voice", detail="Local narration complete", private=private)
                except Exception as exc:
                    self.fail_step(job, "local_voice", detail=redact(str(exc)), private=private)
                    job.warnings.append("Local narration failed; continued with a clearly labelled silent render.")
            elif narration is not None:
                self.skip_step(job, "local_voice", detail="ElevenLabs narration succeeded", private=private)
            else:
                self.skip_step(job, "local_voice", detail="Local TTS unavailable; used silent render", private=private)
            if narration is None:
                self.skip_step(job, "narration", detail="No narration engine available; silent render used", private=private)
                job.warnings.append("No local or optional narration engine was available. Continued with a clearly labelled silent render.")
            else:
                self.complete_step(job, "narration", detail="Narration ready", private=private)
        else:
            self.skip_step(job, "narration", detail="Silent render selected", private=private)
            self.skip_step(job, "elevenlabs", detail="Silent render selected", private=private)
            self.skip_step(job, "local_voice", detail="Silent render selected", private=private)
        if narration:
            duration = probe_audio(narration, self.settings)["duration"]
            self.start_step(job, "align", detail="Aligning narration to exact script words", label="Aligning narration to exact script words", progress=31, private=private)
            try:
                spoken = transcribe(narration, self.settings)["words"]
            except Exception as exc:
                spoken = []
                job.warnings.append(f"Forced alignment used deterministic audio-duration fallback ({redact(str(exc))}).")
        else:
            spoken = []
            duration = max(5.0, len(script.split()) / 2.4)
        words = align_script_words(script, duration, spoken)
        self.complete_step(job, "align", detail="Exact word alignment complete" if spoken else "Duration-based alignment fallback", private=private)
        self.start_step(job, "plan", detail="Planning semantic visuals every 2–3 seconds", label="Planning semantic visuals every 2–3 seconds", progress=43, private=private)
        beats = plan_beats(script, words, self.rules)
        for beat in beats:
            if script[beat.char_start:beat.char_end] != beat.text:
                raise MediaError("Beat planner violated the exact source-script span invariant")
        job.beats = beats
        self._save(job, private)
        self.complete_step(job, "plan", detail=f"{len(beats)} visual beats planned", private=private)
        self.start_step(job, "assets", detail="Resolving library and text-card visuals", label="Resolving visual assets", progress=55, private=private)
        visuals = [(beat.concept, beat.start, beat.end) for beat in beats]
        overlays: list[tuple[Path, float, float]] = []
        provenance: list[ProvenanceRecord] = []
        for beat in beats:
            resolved = self.rules.resolve(beat.text)
            if resolved.asset_path and resolved.asset_path.exists() and len(overlays) < 40:
                overlays.append((resolved.asset_path, beat.start, beat.end))
            if resolved.asset:
                provenance.append(ProvenanceRecord(id=str(uuid.uuid4()), provider="personal-library", licence=resolved.asset.licence, attribution=resolved.asset.attribution or resolved.asset.title, query=beat.concept, match_reason=resolved.match_reason, content_hash=resolved.asset.content_hash))
            else:
                provenance.append(ProvenanceRecord(id=str(uuid.uuid4()), provider="local-text-card", licence="Generated locally by S6_cut", attribution="No attribution required", query=beat.concept, match_reason=resolved.match_reason))
        self.complete_step(job, "assets", detail=f"{len(provenance)} visual matches resolved", private=private)
        score = ScoreBreakdown(hook=70, coherence=85, ending=80, energy=65, practical_value=75, visual_potential=82, completeness=90, penalties=0, total=81, explanation="Script video preserves the exact narration and uses deterministic semantic beat planning.")
        clip = job.clips[0] if job.clips else Clip(id=str(uuid.uuid4()), index=1, state="queued", start=0, end=duration, duration=duration, opening_line=" ".join(script.split()[:18]), score=score, provenance=provenance)
        job.clips = [clip]
        clip.state = "rendering"
        self.start_step(job, "render", detail="Rendering narration, captions, and visual beats", label="Rendering narration, captions, and visual beats", progress=67, current=1, total=1, private=private)
        output = work / "clips" / "01-script-video.mp4"
        try:
            render_script(output, duration=duration, aspect=private["aspect_ratio"], narration=narration, words=words, visuals=visuals, overlays=overlays, settings=self.settings)
        except Exception as exc:
            clip.state = "failed"
            clip.error = redact(str(exc))
            clip.selected = False
            self.fail_step(job, "render", detail="Script render failed", private=private)
            self.fail_step(job, "verify", detail="No output to verify", private=private)
            job.state = "failed"
            job.stage = "failed"
            job.stage_label = "Script render failed"
            job.error = clip.error
            self._save(job, private)
            self.fail_step(job, "ready", detail="Project failed", private=private)
            return
        clip.state = "complete"
        clip.output_name = output.name
        clip.selected = True
        self.complete_step(job, "render", detail="Script video rendered", private=private)
        if not output.is_file():
            clip.state = "failed"
            clip.error = "Rendered output is missing from disk"
            clip.selected = False
            self.fail_step(job, "verify", detail="Rendered output missing from disk", private=private)
            job.state = "failed"
            job.stage = "failed"
            job.stage_label = "Script render failed"
            job.error = clip.error
            self._save(job, private)
            self.fail_step(job, "ready", detail="Project failed", private=private)
            return
        self.complete_step(job, "verify", detail="Output verified", current=1, total=1, private=private)
        job.state = "complete"
        job.stage = "complete"
        job.stage_label = "Script video ready"
        job.progress = 100
        self._save(job, private)
        self.complete_step(job, "ready", detail="Project ready", private=private)

    async def control(self, job_id: str, action: str) -> Job:
        job = self.db.get_job(job_id)
        if not job:
            raise KeyError(job_id)
        if action == "switch-fast":
            if self.queue.full():
                raise QueueFullError("The local render queue is full. Wait before switching to fast cut.")
            new_job = self._switch_to_fast(job)
            await self.enqueue(new_job.id)
            return new_job
        if action == "pause" and job.state in {"queued", "active", "recovered"}:
            job.state, job.stage_label = "paused", "Paused after current safe checkpoint"
            active = next((step for step in job.steps if step.status == "active"), None)
            if active and active.detail and not active.detail.startswith("Paused — "):
                active.detail = f"Paused — {active.detail}"
        elif action == "resume" and job.state == "paused":
            job.state, job.stage_label = "queued", "Queued to resume from checkpoint"
            await self.enqueue(job.id)
        elif action == "stop-keep" and job.state not in {"complete", "failed"}:
            job.state, job.stage_label = "cancelled_kept", "Stopped; completed outputs kept"
            completed_outputs = sum(1 for clip in job.clips if clip.state == "complete" and clip.output_name)
            for step in job.steps:
                if step.status == "active":
                    detail = "Stopped by user"
                    if step.id == "render" and job.clips:
                        detail = f"Stopped by user; {completed_outputs} of {len(job.clips)} rendered"
                    self._apply_step(job, step, status="skipped", detail=detail)
                elif step.status == "pending":
                    if step.id == "verify" and completed_outputs:
                        self._apply_step(job, step, status="complete", detail=f"{completed_outputs} completed outputs verified")
                    else:
                        self._apply_step(job, step, status="skipped", detail="Stopped by user")
        elif action == "retry-failed":
            for clip in job.clips:
                if clip.state == "failed":
                    clip.state, clip.error = "queued", None
            job.state, job.stage_label, job.error = "queued", "Retrying failed outputs", None
            self._reset_steps_for_retry(job)
            await self.enqueue(job.id)
        self._save(job)
        return job

    def _switch_to_fast(self, job: Job) -> Job:
        if job.mode != "clip":
            raise SwitchFastError("Only clip projects can switch to fast cut")
        if job.state in {"complete", "cancelled_kept"}:
            raise SwitchFastError("This job has finished; start a new fast cut instead")
        private = self.db.get_job_private(job.id)
        if not (private.get("source_path") or private.get("url")):
            raise SwitchFastError("No reusable source is available for this job")
        job.state = "cancelled_kept"
        job.stage = "cancelled"
        job.stage_label = "Replaced by a fast cut of the same source"
        job.error = None
        for step in job.steps:
            if step.status in {"pending", "active"}:
                self._apply_step(job, step, status="skipped", detail="Replaced by a fast cut of the same source")
        self._save(job)
        new_private = dict(private)
        new_private["processing_mode"] = "fast"
        new_private.pop("transcript", None)
        new_id = str(uuid.uuid4())
        new_job = Job(
            id=new_id, project_id=job.project_id, mode="clip", processing_mode="fast",
            state="queued", stage="queued", stage_label="Queued on this machine",
            progress=0, style=job.style, steps=self._fast_steps(),
        )
        self.db.save_job(new_job, new_private)
        self._save(new_job)
        project = self.db.get_project(job.project_id)
        if project:
            project.latest_job_id = new_id
            project.state = "queued"
            project.updated_at = now_iso()
            self.db.save_project(project)
        return new_job

    def build_export(self, job_id: str, clip_ids: list[str]) -> Path:
        job = self.db.get_job(job_id)
        if not job:
            raise KeyError(job_id)
        chosen = [clip for clip in job.clips if clip.id in set(clip_ids) and clip.state == "complete" and clip.output_name]
        if not chosen:
            raise ValueError("No successful selected clips are available to export")
        export_dir = self.settings.data_path / "exports" / job.id
        export_dir.mkdir(parents=True, exist_ok=True)
        output = export_dir / f"s6-cut-{job.project_id[:8]}.zip"
        manifest = {
            "schemaVersion": 1, "projectId": job.project_id, "jobId": job.id, "mode": job.mode,
            "style": job.style, "createdAt": now_iso(), "clips": [clip.model_dump(by_alias=True, exclude={"download_url"}) for clip in chosen],
            "warnings": job.warnings, "failedClips": [clip.id for clip in job.clips if clip.state == "failed"],
        }
        credits = [record.model_dump(by_alias=True) for clip in chosen for record in clip.provenance]
        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
            for number, clip in enumerate(chosen, 1):
                source = self.settings.data_path / "jobs" / job.id / "clips" / str(clip.output_name)
                if source.is_file():
                    archive.write(source, f"{number:02d}-{safe_filename(source.name, 'short.mp4')}")
            archive.writestr("manifest.json", json.dumps(manifest, indent=2, ensure_ascii=False))
            archive.writestr("credits.json", json.dumps(credits, indent=2, ensure_ascii=False))
            if job.warnings or manifest["failedClips"]:
                warning_lines = job.warnings + [f"Failed clip: {item}" for item in manifest["failedClips"]]
                archive.writestr("warnings.txt", "\n".join(warning_lines))
        return output
