from __future__ import annotations

import asyncio
import inspect
import json
import logging
import math
import os
import shutil
import threading
import time
import uuid
import zipfile
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from . import media as media_module
from .config import Settings
from .database import Database
from .library import LibraryRules, ResolvedVisual
from .media import (
    DownloadStalled, MediaError, available, download_youtube, probe, render_clip,
    _metadata_text, sha256_file, transcribe, transcription_cache_key, youtube_import_metadata, youtube_import_title,
)
from .models import (
    Asset, CaptionCue, Clip, ContentFormat, Job, ProcessingMode, ProcessingStep, ProvenanceRecord, ScoreBreakdown, now_iso,
)
from .providers import ProfileService, provider_runtime_message
from .security import confined, redact, safe_archive_title, safe_filename
from .selection import Candidate, _score, _timed_words, candidate_quality, clip_from_candidate, select_candidates, select_music_candidates

logger = logging.getLogger(__name__)


def _probe_detail(metadata: dict[str, Any]) -> str:
    details: list[str] = []
    duration = metadata.get("duration")
    try:
        duration_value = float(duration)
    except (TypeError, ValueError):
        duration_value = 0.0
    if math.isfinite(duration_value) and duration_value > 0:
        details.append(f"{duration_value:.1f}s")
    dimensions = _displayed_dimensions(metadata)
    if dimensions:
        details.append(f"{dimensions[0]}×{dimensions[1]}")
    try:
        frame_rate = float(metadata.get("frame_rate"))
    except (TypeError, ValueError):
        frame_rate = 0.0
    if math.isfinite(frame_rate) and frame_rate > 0:
        details.append(f"{frame_rate:g} fps")
    if not details:
        return "Source validated"
    detail = f"Source validated — {details[0]}"
    if len(details) > 1:
        detail += f" at {' / '.join(details[1:])}"
    return detail


def _displayed_dimensions(metadata: dict[str, Any]) -> tuple[int, int] | None:
    values: list[int] = []
    for key in ("width", "height"):
        try:
            value = float(metadata.get(key))
        except (TypeError, ValueError):
            return None
        if not math.isfinite(value) or value <= 0 or not value.is_integer():
            return None
        values.append(int(value))
    try:
        rotation = float(metadata.get("rotation") or 0)
    except (TypeError, ValueError):
        rotation = 0.0
    if math.isfinite(rotation) and int(rotation) % 180:
        values.reverse()
    return values[0], values[1]


def _source_quality_warnings(metadata: dict[str, Any]) -> list[str]:
    dimensions = _displayed_dimensions(metadata)
    if not dimensions:
        return []
    width, height = dimensions
    short_edge = min(width, height)
    if short_edge <= 360:
        return [f"Source is {width}×{height} ({metadata.get('video_codec') or 'unknown'}); output resolution does not restore detail missing from 360p-or-lower media."]
    if short_edge < 720:
        return [f"Source is {width}×{height}; output resolution will be higher, but genuine source detail remains below 720p."]
    return []


def _semantic_clip_title(project_name: str, clip: Clip) -> str:
    """Create a bounded, safe title from the opening meaningful transcript."""
    phrase = " ".join((clip.opening_line or "").split()).strip(" .,!?:;-")
    phrase = "".join(char for char in phrase if ord(char) >= 32)
    if not phrase or phrase.casefold() == f"cut {clip.index:02d}".casefold():
        return f"{project_name} — Cut {clip.index:02d}"[:200]
    phrase = phrase[:72].rstrip()
    return f"{project_name} — {phrase} · Cut {clip.index:02d}"[:200]


def _openrouter_fallback_warning(error: Exception) -> str:
    reason = " ".join(redact(provider_runtime_message(error, "OpenRouter")).split()).strip(" .")
    return f"OpenRouter API failed: {reason}. Continuing with deterministic local planning."


def resolve_batch_target(requested: int, batch_mode: str, source_duration: float) -> tuple[int, str | None]:
    """Keep the requested count; actual shortage is determined by the planner."""
    if not math.isfinite(source_duration) or source_duration <= 0:
        raise MediaError("A valid FFprobe source duration is required to resolve the batch target")
    return requested, None


def _spread_temporal_items(items, requested: int):
    if requested <= 0:
        return []
    if len(items) <= requested:
        return items
    if requested == 1:
        return [items[len(items) // 2]]
    indexes = [round(index * (len(items) - 1) / (requested - 1)) for index in range(requested)]
    return [items[index] for index in indexes]


def _high_volume_smart_candidates(words: list[dict[str, Any]], style: str, requested: int, minimum: float, maximum: float, source_duration: float):
    """Search timed transcript windows, allowing overlap and spreading selections across them."""
    if (
        requested < 1 or not all(math.isfinite(value) for value in (minimum, maximum, source_duration))
        or minimum <= 0 or maximum < minimum or source_duration <= 0
    ):
        return []
    timed = [
        word for word in _timed_words(words)
        if float(word["start"]) < source_duration and float(word["end"]) <= source_duration
    ]
    if not timed:
        return []
    target = (minimum + maximum) / 2
    candidates_by_start: dict[float, tuple[float, float, list[dict[str, Any]]]] = {}
    for start_index in range(len(timed)):
        word_start = float(timed[start_index]["start"])
        # Floor to the supported tenth-second boundary: this preserves the full
        # first word and guarantees selected starts are actually >=0.1s apart.
        start_bucket = math.floor((word_start + 1e-9) * 10) / 10
        if start_bucket in candidates_by_start:
            continue
        start = start_bucket
        # Gather time-only endpoints first. Quality-gate the closest endpoint to
        # the target before trying alternatives; rescanning/tokenizing every
        # growing transcript segment made long Smart sources needlessly costly.
        endpoints: list[int] = []
        target_position = None
        for end_index in range(start_index, len(timed)):
            end = float(timed[end_index]["end"])
            duration = end - start
            if duration > maximum:
                break
            if duration >= minimum:
                if target_position is None and duration >= target:
                    target_position = len(endpoints)
                endpoints.append(end_index)
        if not endpoints:
            continue

        left = target_position - 1 if target_position is not None else len(endpoints) - 1
        right = target_position if target_position is not None else len(endpoints)
        while left >= 0 or right < len(endpoints):
            if left < 0:
                end_index = endpoints[right]
                right += 1
            elif right >= len(endpoints):
                end_index = endpoints[left]
                left -= 1
            else:
                left_end = float(timed[endpoints[left]]["end"])
                right_end = float(timed[endpoints[right]]["end"])
                if abs(left_end - start - target) <= abs(right_end - start - target):
                    end_index = endpoints[left]
                    left -= 1
                else:
                    end_index = endpoints[right]
                    right += 1
            end = float(timed[end_index]["end"])
            segment = timed[start_index:end_index + 1]
            eligible, _, _ = candidate_quality(segment)
            if eligible:
                candidates_by_start[start_bucket] = (start, end, segment)
                break

    candidates = sorted(candidates_by_start.values(), key=lambda candidate: (candidate[0], candidate[1]))
    # Score only the temporally sampled outputs; scores do not affect high-volume
    # selection, so scoring every capacity candidate is wasted work on long sources.
    candidates = _spread_temporal_items(candidates, requested)
    return [Candidate(start, end, segment, _score(segment, style, target)) for start, end, segment in candidates]


def _high_volume_shortfall(requested: int, valid_windows: int, source_duration: float, window_kind: str):
    """Apply the under-30-minute fallback only after a planner proves a shortage."""
    if source_duration < 1800:
        effective = min(requested, 300, valid_windows)
        reason = (
            f"Requested {requested}; FFprobe validated a {source_duration:.1f}s source under 30 minutes and "
            f"the {window_kind} planner found {valid_windows} valid windows. The short-source fallback "
            f"uses min(requested, 300, valid windows), so the effective target is {effective}."
        )
    else:
        effective = min(requested, valid_windows)
        reason = (
            f"Requested {requested}; FFprobe validated a {source_duration:.1f}s source and the {window_kind} "
            f"planner found only {valid_windows} valid windows, so the effective target is {effective}."
        )
    return effective, reason


class QueueFullError(RuntimeError):
    pass


class SwitchFastError(RuntimeError):
    pass


class ProjectDeletingError(RuntimeError):
    pass


class ChecklistShapeError(RuntimeError):
    """A checklist is missing a step its pipeline requires.

    `str()` of this reaches the customer's banner through `job.error`, so it
    carries no job id or step id — those go to the log at the raise site. The
    condition is a defect rather than anything the customer got wrong, and a
    fresh run rebuilds the checklist (see `_repair_step_shape`), so the message
    says that plainly instead of naming internals.
    """

    def __init__(self, job_id: str, step_id: str) -> None:
        super().__init__("This project could not be processed because its progress checklist did not match its pipeline. Start it again to rebuild the checklist.")
        self.job_id, self.step_id = job_id, step_id


def job_processing_mode(job: Job, private: dict[str, Any]) -> ProcessingMode:
    """Resolved processing mode: private snapshot first, public record next, legacy jobs default to smart."""
    value = private.get("processing_mode") or job.processing_mode or "smart"
    return value if value in {"fast", "smart"} else "smart"


def job_content_format(job: Job, private: dict[str, Any]) -> ContentFormat:
    value = private.get("content_format") or job.content_format or "short"
    return value if value in {"short", "long"} else "short"


def uses_fast_pipeline(processing_mode: str | None, content_format: str | None) -> bool:
    """Whether a clip job renders through the fast path.

    Long form always does, whatever processing mode was requested. Every caller
    that builds a checklist or routes a job must ask this one question: when the
    creation route, the checklist builder and the processor disagreed, a
    long-form Smart job was given the smart checklist and then run through the
    fast renderer, which asks for a 'plan' step the smart checklist lacks.
    """
    return content_format == "long" or processing_mode == "fast"


def job_uses_fast_pipeline(job: Job, private: dict[str, Any]) -> bool:
    if job.source_profile == "music":
        return False
    high_volume_smart_landscape = (
        private.get("batch_mode", job.batch_mode) == "high_volume"
        and job_content_format(job, private) == "long"
        and job_processing_mode(job, private) == "smart"
    )
    return uses_fast_pipeline(job_processing_mode(job, private), job_content_format(job, private)) and not high_volume_smart_landscape


def _assign_music_treatments(job: Job, private: dict[str, Any], save) -> None:
    """Persist balanced clip-local treatment before the first Music render."""
    assignments = private.setdefault("music_treatments", {})
    if not isinstance(assignments, dict):
        assignments = private["music_treatments"] = {}
    ordered = sorted(job.clips, key=lambda clip: (clip.index, clip.id))
    grayscale_count = len(ordered) // 2
    changed = False
    for position, clip in enumerate(ordered):
        treatment = assignments.get(clip.id) or clip.music_treatment
        if treatment not in {"color", "grayscale"}:
            treatment = "grayscale" if position < grayscale_count else "color"
            changed = True
        if assignments.get(clip.id) != treatment or clip.music_treatment != treatment:
            assignments[clip.id] = treatment
            clip.music_treatment = treatment
            changed = True
        top_text = private.get("music_top_text") or None
        if clip.music_top_text != top_text:
            clip.music_top_text = top_text
            changed = True
    if changed or ordered:
        save(job, private)


def can_retry_import(job: Job, private: dict[str, Any]) -> bool:
    """Whether this job's source import can actually be re-run.

    The Workspace offers Retry import from this answer rather than inferring it
    from the project's source kind. The two could disagree — a project marked
    youtube whose job holds no url — and the customer then got a 409 from the
    one control the failure screen offered them.
    """
    return job.mode == "clip" and bool(private.get("url")) and job.state in {"failed", "stalled", "cancelled_kept"}


def _youtube_creator_name(value: object) -> str | None:
    return _metadata_text(value, 120)


def youtube_creator_credit(job: Job, private: dict[str, Any]) -> str | None:
    """Return the bounded YouTube credit used by both preview and export."""
    if not private.get("url") or job_content_format(job, private) != "short":
        return None
    # A missing channel is still explicitly identified as a YouTube source;
    # this avoids silently dropping attribution from a valid short while never
    # presenting arbitrary malformed metadata as a creator name.
    creator = _youtube_creator_name(private.get("youtube_creator")) or "YouTube"
    return f"Source: {creator}"


def _consume_youtube_sidecar(source: Path) -> None:
    try:
        source.with_suffix(".info.json").unlink(missing_ok=True)
    except OSError:
        pass


def _source_clip_visual_metadata(visual: ResolvedVisual, duration: float) -> tuple[list[tuple[Path, float, float]], list[ProvenanceRecord]]:
    """Return only source-clip overlays and provenance that will be rendered.

    Source clips no longer use generated text cards. A personal-library asset is
    recorded only when its resolved file exists and the render window is long
    enough for the same overlay branch to composite it.
    """
    if not visual.asset or not visual.asset_path or not visual.asset_path.exists() or duration <= 1:
        return [], []
    overlay = (visual.asset_path, .65, min(3.4, duration - .2))
    provenance = ProvenanceRecord(
        id=str(uuid.uuid4()), provider="personal-library", licence=visual.asset.licence,
        attribution=visual.asset.attribution or visual.asset.title, query=visual.label,
        match_reason=visual.match_reason, content_hash=visual.asset.content_hash,
    )
    return [overlay], [provenance]


def _creator_render_kwargs(render, credit: str | None) -> dict[str, str]:
    if not credit:
        return {}
    try:
        parameters = inspect.signature(render).parameters.values()
    except (TypeError, ValueError):
        return {}
    if any(parameter.name == "creator_credit" or parameter.kind == inspect.Parameter.VAR_KEYWORD for parameter in parameters):
        return {"creator_credit": credit}
    return {}


def _subscribe_render_kwargs(render, config: dict[str, Any] | None) -> dict[str, Any]:
    try:
        parameters = inspect.signature(render).parameters.values()
    except (TypeError, ValueError):
        return {}
    if any(parameter.name == "subscribe_animation" or parameter.kind == inspect.Parameter.VAR_KEYWORD for parameter in parameters):
        return {"subscribe_animation": config}
    return {}


def _music_render_kwargs(render, theme: str, top_text: str | None, treatment: str | None) -> dict[str, Any]:
    try:
        parameters = inspect.signature(render).parameters.values()
    except (TypeError, ValueError):
        return {}
    accepts_any = any(parameter.kind == inspect.Parameter.VAR_KEYWORD for parameter in parameters)
    accepted = {parameter.name for parameter in parameters}
    values = {"music_theme": theme, "music_top_text": top_text, "music_treatment": treatment}
    return values if accepts_any else {name: value for name, value in values.items() if name in accepted}


def _format_render_kwargs(render, content_format: str) -> dict[str, str]:
    """Pass the content format only to renderers that accept it.

    Mirrors `_creator_render_kwargs`: editor and test render adapters from
    older jobs take a narrower signature, and a render is not worth losing to
    an unexpected keyword.
    """
    try:
        parameters = inspect.signature(render).parameters.values()
    except (TypeError, ValueError):
        return {}
    if any(parameter.name == "content_format" or parameter.kind == inspect.Parameter.VAR_KEYWORD for parameter in parameters):
        return {"content_format": content_format}
    return {}


def probe_source(job: Job, private: dict[str, Any], source: Path, settings: Settings):
    if job_content_format(job, private) == "long":
        return probe(source, settings, max_seconds=settings.max_long_source_seconds)
    return probe(source, settings)


def _media_fn(name: str):
    fn = getattr(media_module, name, None)
    if not callable(fn):
        raise MediaError(f"{name} is not available in this engine runtime")
    return fn


# DO-NOT-CHANGE: see DO-NOT-CHANGE/AGENTS.md
# job state machine, staged publication, immutable sources, and the outer
# failure guard that preserves already-published clips are hard invariants


def _singularise(label: str) -> str:
    """`3 fast cuts ready` reads correctly; `1 fast cuts ready` does not.
    Only the counted noun in these fixed labels is adjusted."""
    for plural, singular in (("clips", "clip"), ("cuts", "cut")):
        if plural in label:
            return label.replace(plural, singular, 1)
    return label

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
        self._queued_ids: set[str] = set()
        self._pending_order: deque[str] = deque()
        self._queue_lock = threading.Lock()
        self._deleting_projects: set[str] = set()
        self._deletion_lock = threading.RLock()

    async def start(self) -> None:
        if self.workers:
            return
        for index in range(self.settings.job_workers):
            self.workers.append(asyncio.create_task(self._worker(index), name=f"s6-worker-{index}"))
        recovered: list[str] = []
        for job in reversed(self.db.list_jobs(("queued", "active", "recovered", "paused"))):
            if job.mode == "script":
                settled_at = now_iso()
                job.state = "failed"
                job.stage = "failed"
                job.stage_label = "Legacy Script jobs are no longer processed"
                job.error = "Script rendering has been retired. Existing completed Library assets remain available."
                job.steps = [
                    step.model_copy(update={
                        "status": "failed" if step.status == "active" else "skipped",
                        "completed_at": settled_at,
                        "detail": "Legacy Script work was not resumed after retirement",
                    }) if step.status in {"active", "pending"} else step
                    for step in job.steps
                ]
                job.clips = [
                    clip.model_copy(update={"state": "failed"}) if clip.state in {"queued", "rendering"} else clip
                    for clip in job.clips
                ]
                self._save(job)
                continue
            job.state = "recovered"
            job.stage_label = "Recovered after engine restart"
            self._save(job)
            recovered.append(job.id)
        if recovered:
            self.recovery_task = asyncio.create_task(self._feed_recovered(recovered), name="s6-recovery-feeder")
        # Repair legacy/committed-but-unlinked publications once on startup.  The
        # backfill is idempotent, so repeated startups never duplicate assets.
        self.repair_publications()
        self.prune_retained_jobs()

    def repair_publications(self) -> int:
        """Backfill missing automatic Library assets for completed clips.

        Legacy completed clips, or clips whose blob promotion committed but whose
        transaction was interrupted, get exactly one linked asset created from
        their stable (origin, project, job, clip) identity.  Idempotent by
        construction: the unique asset identity index reuses an existing asset
        instead of creating ``Cut 01 (2)``.

        Returns the number of assets backfilled.
        """
        repaired = 0
        for job in self.db.list_jobs():
            job, backfilled, _ = self.db.backfill_missing_assets(job)
            private = self.db.get_job_private(job.id)
            for clip in list(job.clips):
                if clip.state != "complete" or clip.library_asset_id or not clip.output_name:
                    continue
                output = self.settings.data_path / "jobs" / job.id / "clips" / clip.output_name
                if not output.is_file():
                    continue
                try:
                    probe(output, self.settings)
                    job, _, _ = self._publish_output(job, clip, output, private, script=job.mode == "script")
                    backfilled += 1
                except Exception as exc:
                    job.warnings.append(f"Could not repair legacy output {clip.index}: {redact(str(exc))}")
            if backfilled:
                self._save(job, private)
                repaired += backfilled
        return repaired

    async def _feed_recovered(self, job_ids: list[str]) -> None:
        for job_id in job_ids:
            while self.queue.full():
                await asyncio.sleep(.1)
            await self.enqueue(job_id, tolerate_full=True)

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
        with self._queue_lock:
            if job_id in self._queued_ids:
                return
            try:
                self.queue.put_nowait(job_id)
            except asyncio.QueueFull:
                if not tolerate_full:
                    raise QueueFullError("The local render queue is full. Wait for an active job or raise S6_MAX_QUEUED_JOBS.")
                return
            self._queued_ids.add(job_id)
            self._pending_order.append(job_id)

    def queue_position(self, job_id: str) -> int | None:
        with self._queue_lock:
            try:
                return list(self._pending_order).index(job_id) + 1
            except ValueError:
                return None

    async def _worker(self, _: int) -> None:
        while True:
            job_id = await self.queue.get()
            with self._queue_lock:
                self._queued_ids.discard(job_id)
                try:
                    self._pending_order.remove(job_id)
                except ValueError:
                    pass
            try:
                await asyncio.to_thread(self._process, job_id)
            finally:
                self.queue.task_done()

    def _project_is_deleting(self, project_id: str) -> bool:
        with self._deletion_lock:
            return project_id in self._deleting_projects

    # DO-NOT-CHANGE: always syncs linked Project.state and writes jobs/<id>/state.json
    def _save(self, job: Job, private: dict[str, Any] | None = None) -> None:
        if self._project_is_deleting(job.project_id):
            return
        current = self.db.get_job(job.id)
        # A project deletion waits on the job lock before removing records. A
        # stale worker can still hold an in-memory Job afterwards; never let its
        # final checkpoint recreate the deleted row through the database upsert.
        if not current:
            return
        if current.state == "cancelled_kept" and job.state != "cancelled_kept" and not (private or {}).get("retry_import"):
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
            if self._project_is_deleting(job.project_id):
                return False
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
        logger.error("Job %s has no processing step %r; its checklist does not match its pipeline", job.id, step_id)
        raise ChecklistShapeError(job.id, step_id)

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
            ProcessingStep(id="render", label="Clips rendered and saved"),
            ProcessingStep(id="verify", label="Outputs verified"),
            ProcessingStep(id="ready", label="Project ready"),
        ]

    def _smart_steps(self, use_openrouter: bool = False, source_profile: str = "speech") -> list[ProcessingStep]:
        music = source_profile == "music"
        provider_step = ProcessingStep(id="openrouter", label="Provider bypassed for music profile" if music else "OpenRouter planning")
        if not use_openrouter:
            timestamp = now_iso()
            provider_step.status = "skipped"
            provider_step.detail = "Music profile stays local; provider planning skipped" if music else "No connected provider; used local planning"
            provider_step.started_at = provider_step.completed_at = timestamp
        return [
            ProcessingStep(id="source", label="Source received"),
            ProcessingStep(id="probe", label="Video validated"),
            ProcessingStep(id="audio", label="Audio prepared"),
            ProcessingStep(id="transcribe", label="Music words timed" if music else "Speech transcribed"),
            provider_step,
            ProcessingStep(id="local_planning", label="Lyric windows planned" if music else "Local planning fallback"),
            ProcessingStep(id="select", label="Lyric windows selected" if music else "Complete moments selected"),
            ProcessingStep(id="boundaries", label="Clip boundaries verified"),
            ProcessingStep(id="render", label="Clips rendered and saved"),
            ProcessingStep(id="verify", label="Outputs verified"),
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
        if job.mode == "clip":
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
        if job.mode != "clip":
            return
        job.steps = self._fast_steps() if job_uses_fast_pipeline(job, private) else self._smart_steps(bool(private.get("use_openrouter")), job.source_profile)
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

    def _required_step_ids(self, job: Job, private: dict[str, Any]) -> set[str]:
        """The step ids the pipeline this job actually runs through will ask for.

        Read from the same builders the checklist is created from, so the shape
        on disk and the processor cannot drift apart again.
        """
        if job_uses_fast_pipeline(job, private):
            return {step.id for step in self._fast_steps()}
        return {step.id for step in self._smart_steps(bool(private.get("use_openrouter")), job.source_profile)}

    def _repair_step_shape(self, job: Job, private: dict[str, Any]) -> None:
        """Rebuild a checklist persisted in the wrong shape for its pipeline.

        A long-form Smart job written before the pipeline decision was unified
        holds the eleven-step smart checklist yet renders through the fast path,
        which asks for a 'plan' step that checklist does not contain. Nothing
        reshaped it afterwards: `_init_steps` only builds when there are no
        steps at all, retry-import re-pends statuses and `_reset_steps_for_retry`
        touches render/verify/ready, so every attempt raised the same error.
        Rebuild the right checklist and restore whatever the job can prove.
        """
        if not job.steps or job.state == "complete":
            return
        if {step.id for step in job.steps} == self._required_step_ids(job, private):
            return
        as_of = job.updated_at
        if job.mode != "clip":
            return
        job.steps = self._fast_steps() if job_uses_fast_pipeline(job, private) else self._smart_steps(bool(private.get("use_openrouter")), job.source_profile)
        # Replays nothing: published clips keep the render counters they earned.
        self._restore_proven_steps(job, private, as_of)
        self._save(job, private)

    def _reconcile_steps(self, job: Job, private: dict[str, Any]) -> None:
        """Initialize legacy steps and detect retries triggered outside the control path."""
        self._init_steps(job, private)
        self._repair_step_shape(job, private)
        if job.steps and any(clip.state == "queued" for clip in job.clips):
            render_step = next((step for step in job.steps if step.id == "render"), None)
            if render_step and render_step.status == "complete":
                self._reset_steps_for_retry(job)
                self._save(job, private)

    @staticmethod
    def _transcript_detail(transcript: dict[str, Any], *, source_duration: float | None = None, music: bool = False) -> str:
        words = transcript.get("words") or []
        segments = transcript.get("segments") or []
        duration = max((float(word["end"]) for word in words if "end" in word), default=0.0)
        if music:
            total = source_duration if source_duration is not None else duration
            coverage = min(100.0, duration / total * 100) if total > 0 else 0.0
            return f"{len(words)} word timings · decoded through {duration:.0f}s of {total:.0f}s ({coverage:.0f}% timeline); lyric coverage is not guaranteed"
        if segments:
            return f"{len(segments)} segments · {duration:.0f}s processed"
        return f"{len(words)} words · {duration:.0f}s processed"

    def _finish_render_steps(self, job: Job, private: dict[str, Any], successful: list[Clip], failed: list[Clip], output_dir: Path, noun: str, ready_label: str) -> None:
        total = len(job.clips)
        job.planned_count = total
        job.successful_count = len(successful)
        if failed and not successful:
            self.fail_step(job, "render", detail=f"All {len(failed)} {noun} failed", private=private)
            render_step = self._step_by_id(job, "render")
            render_step.current_item, render_step.total_items = 0, total
        else:
            detail = f"{len(successful)} of {total} rendered" + (f"; {len(failed)} failed" if failed else "")
            self.complete_step(job, "render", detail=detail, current=len(successful), total=total, private=private)
        verified = [
            clip for clip in job.clips
            if clip.state == "complete" and clip.library_asset_id and clip.output_name
            and (output_dir / clip.output_name).is_file()
            and self.db.validate_clip_asset_relationship(clip, self.db.get_asset(clip.library_asset_id)) is None
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
        job.stage_label = f"{len(successful)} {_singularise(ready_label) if len(successful) == 1 else ready_label}" if successful else "No clips rendered"
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

    # DO-NOT-CHANGE: outer guard — on failure mark job failed/partial but NEVER
    # roll back clips that were already published
    def _process(self, job_id: str) -> None:
        lock = self.job_locks[job_id]
        if not lock.acquire(blocking=False):
            return
        with self._active_lock:
            self.active_workers += 1
        try:
            job = self.db.get_job(job_id)
            private = self.db.get_job_private(job_id) if job else {}
            if not job or job.state == "complete" or (job.state == "cancelled_kept" and not private.get("retry_import")):
                return
            if job.mode != "clip":
                raise MediaError("Legacy Script jobs cannot be rendered or recovered")
            self._reconcile_steps(job, private)
            self._process_clip(job, private)
        except media_module.TranscriptionCancelled:
            return
        except DownloadStalled:
            # _source() has already persisted the actionable stalled state and
            # partial-download metadata. Do not downgrade it to generic failed.
            return
        except Exception as exc:  # scoped outer guard preserves already-published clips
            logger.exception("Job %s failed: %s", job_id, redact(str(exc)))
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
                elif not isinstance(exc, ChecklistShapeError):
                    # A checklist that lacks the step the pipeline asked for has
                    # no step to blame: marking the first pending one failed put
                    # the message on an unrelated row ("Audio prepared" for a
                    # missing 'plan'). The job state already reports the failure.
                    pending = next((step for step in job.steps if step.status == "pending"), None)
                    if pending:
                        self._apply_step(job, pending, status="failed", detail=redact(str(exc)))
                self._save(job)
        finally:
            with self._active_lock:
                self.active_workers -= 1
            lock.release()

    # DO-NOT-CHANGE: source is registered as an immutable project-source Library asset
    # and project.source_blob_id is set; sources are never modified in place
    def _register_source(self, job: Job, private: dict[str, Any], source: Path) -> None:
        metadata = private.get("source_metadata")
        if not isinstance(metadata, dict):
            metadata = probe_source(job, private, source, self.settings)
        project = self.db.get_project(job.project_id)
        title = str(private.get("youtube_title") or "YouTube source") if private.get("url") else (project.name if project else source.stem)
        publication_folder, _ = self._publication_folder(job)
        asset = self.rules.register_managed_video(
            source, title=title, origin="project-source", project_id=job.project_id,
            job_id=job.id, metadata=metadata, folder_id=publication_folder,
            content_hash=str(private["source_hash"]) if private.get("source_hash") else None,
        )
        private["source_hash"] = asset.content_hash
        job.source_blob_id = asset.blob_id
        if project and project.source_blob_id != asset.blob_id:
            project.source_blob_id = asset.blob_id
            project.updated_at = now_iso()
            self.db.save_project(project)

    def _resolve_batch_target(self, job: Job, private: dict[str, Any], source_duration: float) -> int:
        existing = private.get("effective_target", job.effective_target)
        if isinstance(existing, int) and 0 <= existing <= 500:
            return existing
        project = self.db.get_project(job.project_id)
        requested = int(private.get("count", project.requested_count if project else 1))
        mode = str(private.get("batch_mode", job.batch_mode))
        target, explanation = resolve_batch_target(requested, mode, source_duration)
        private["effective_target"] = target
        private["cap_explanation"] = explanation
        job.batch_mode = mode if mode in {"standard", "high_volume"} else "standard"
        job.effective_target = target
        job.cap_explanation = explanation
        if project:
            project.batch_mode = job.batch_mode
            project.effective_target = target
            project.cap_explanation = explanation
            project.updated_at = now_iso()
            self.db.save_project(project)
        self._save(job, private)
        return target

    def _publication_folder(self, job: Job) -> tuple[str, str | None]:
        """Resolve the folder for the next output publication.

        The worker always uses the immutable job snapshot; when the selected
        business folder was archived or removed, outputs fall back to Unsorted
        with a visible job warning instead of failing the render.
        """
        effective, warning = self.db.validate_publication_folder(job.library_folder_id, job)
        if warning and warning not in job.warnings:
            job.warnings.append(warning)
        return effective, warning

    # DO-NOT-CHANGE: staged publication — resolve folder, hash+promote blob, atomic DB commit;
    # re-publishing the same (origin, project, job, clip) identity must reuse, never duplicate
    def _publish_output(self, job: Job, clip: Clip, output: Path, private: dict[str, Any], *, script: bool = False) -> tuple[Job, Clip, Asset]:
        """Atomically publish one validated clip output to the Clip Board and Media Library.

        Staged publication protocol:
          1. resolve the effective business folder (archived/removed -> Unsorted + warning);
          2. hash the validated output and atomically promote it into the content-addressed
             blob store (hard link when possible, copy fallback otherwise);
          3. commit the linked Clip record (final fields incl. ``library_asset_id``), the
             automatic Asset record, durable blob references, and the job checkpoint in one
             SQLite transaction.

        Only after the transaction commits is the clip considered published, so the
        workspace event stream can never expose a ready clip without its Library asset.
        Recovery is idempotent: re-publishing the same stable (origin, project, job,
        clip) identity reuses the existing asset and blob instead of duplicating them.
        """
        effective_folder_id, _ = self._publication_folder(job)
        try:
            output_metadata = probe(output, self.settings)
            width, height = int(output_metadata["width"]), int(output_metadata["height"])
        except MediaError:
            width, height = {"9:16": (1080, 1920), "1:1": (1080, 1080), "16:9": (1920, 1080), "4:5": (1080, 1350)}[str(private["aspect_ratio"])]
        project = self.db.get_project(job.project_id)
        project_name = project.name if project else "Project"
        title = f"{project_name} — Script video" if script else _semantic_clip_title(project_name, clip)
        if self._project_is_deleting(job.project_id):
            raise media_module.TranscriptionCancelled("Project was deleted before output publication")
        origin = "script-output" if script else "generated-clip"

        digest = sha256_file(output)
        _, relative = self.rules._publish_blob(output, digest)
        asset = Asset(
            id=str(uuid.uuid4()), title=title[:200], media_type="video/mp4",
            filename=output.name, content_hash=digest, blob_id=digest,
            origin=origin, folder_id=effective_folder_id,
            source_project_id=job.project_id, source_job_id=job.id, source_clip_id=clip.id,
            duration_seconds=clip.duration, width=width, height=height,
            aspect_ratio=str(private["aspect_ratio"]), tags=[], triggers=[], policy="neutral",
            licence="Generated from user-supplied or authorised source",
        )
        published_at = now_iso()
        applied_credit = None if script else youtube_creator_credit(job, private)
        clip = clip.model_copy(update={
            "state": "complete", "output_name": output.name, "title": title,
            "creator_credit": applied_credit,
            "width": width, "height": height, "folder_id": effective_folder_id,
            "published_at": published_at, "selected": True, "error": None,
        })
        published = sum(1 for item in job.clips if item.state == "complete" and item.id != clip.id) + 1
        job.planned_count = len(job.clips)
        job.successful_count = published
        render_step = next((step for step in job.steps if step.id == "render"), None)
        if render_step:
            self._apply_step(job, render_step, status="active", detail=f"{published} of {len(job.clips)} rendered and saved", current=published, total=len(job.clips))
        job.current_item = published
        formats = [extension for extension in ("ass", "srt", "vtt") if output.with_suffix(f".{extension}").is_file()]
        # This private manifest is committed by publish_clip_output in the same
        # transaction as the clip/blob/asset relationship. Files alone are never
        # public capability; public_job signs only committed manifest entries.
        manifests = private.setdefault("caption_artifacts", {})
        manifests[clip.id] = {
            "revision": clip.caption_revision,
            "run_id": (private.get("caption_rerender") or {}).get("run_id"),
            "output_name": output.name,
            "formats": formats,
            "burned": bool(private.get("burn_subtitles", job.burn_subtitles)),
            "embedded": bool(private.get("embed_subtitles", job.embed_subtitles)),
            "updated_at": now_iso(),
        }
        # A stop-keep that lands while this clip was rendering exists only in the
        # database row: the in-memory job still says "active", and publication
        # commits the job checkpoint directly (database.py step 6), so it never
        # passes through _save()'s cancellation precedence and silently
        # resurrects the job. The render loop's next _cooperate() then reads
        # "active" and keeps going, so Stop & keep rendered every remaining clip
        # and held the only worker for the whole job.
        #
        # The output still publishes — keeping finished outputs is exactly what
        # stop-keep promises, and the clip/asset transaction is untouched — but
        # the checkpoint defers to the cancellation exactly as _save() does, so
        # the next cooperation point stops the job and frees the worker.
        current = self.db.get_job(job.id)
        if current and current.state == "cancelled_kept" and job.state != "cancelled_kept" and not private.get("retry_import"):
            job.state = current.state
            job.stage = current.stage
            job.stage_label = current.stage_label
            job.error = current.error
            job.steps = current.steps
        return self.db.publish_clip_output(job, clip, asset, relative, output.stat().st_size, private=private)

    def _download_progress(self, job: Job, private: dict[str, Any], update: dict[str, Any]) -> None:
        previous = job.download_progress
        phase = str(update.get("phase") or "downloading")
        downloaded = int(update.get("downloaded_bytes") or (previous.downloaded_bytes if previous else 0))
        total_raw = update.get("total_bytes")
        total = int(total_raw) if total_raw is not None else (previous.total_bytes if previous else None)
        percent_raw = update.get("percent")
        percent = float(percent_raw) if percent_raw is not None else (downloaded / total * 100 if total else None)
        from .models import DownloadProgress
        progress = DownloadProgress(
            downloaded_bytes=max(0, downloaded), total_bytes=total,
            percent=max(0, min(100, percent)) if percent is not None else None,
            phase=phase if phase in {"queued", "connecting", "downloading", "stalled", "retrying", "stopped_partial", "failed", "complete"} else "downloading",
            last_progress_at=now_iso() if phase != "stalled" else (previous.last_progress_at if previous else now_iso()),
            speed_bytes_per_second=update.get("speed_bytes_per_second"), eta_seconds=update.get("eta_seconds"),
            message=str(update.get("message"))[:500] if update.get("message") else None,
            resumable=True,
        )
        job.download_progress = progress
        if phase == "stalled":
            job.state, job.stage, job.stage_label = "stalled", "source", "YouTube download stalled"
        elif phase not in {"complete", "failed"}:
            job.state, job.stage, job.stage_label = "active", "source", "Downloading YouTube source"
            if percent is not None:
                job.progress = min(15, 5 + percent * 0.1)
        self._save(job, private)

    def _source(self, job: Job, private: dict[str, Any]) -> Path:
        if private.get("source_path"):
            source = Path(private["source_path"])
            if source.is_file():
                if private.get("url") and ("youtube_title" not in private or "youtube_creator" not in private):
                    imported = youtube_import_metadata(source, consume=False)
                    if imported:
                        private["youtube_title"] = imported.get("title") or private.get("youtube_title") or "YouTube source"
                        if imported.get("creator"):
                            private["youtube_creator"] = imported["creator"]
                if private.get("url"):
                    project = self.db.get_project(job.project_id)
                    creator = _youtube_creator_name(private.get("youtube_creator")) or (project.source_creator if project else None)
                    if creator:
                        private["youtube_creator"] = creator
                    if project and project.source_creator != creator:
                        project.source_creator = creator
                        project.updated_at = now_iso()
                        self.db.save_project(project)
                self._register_source(job, private, source)
                self.complete_step(job, "source", detail="Source received, validated, and added to library", private=private)
                if private.get("url"):
                    _consume_youtube_sidecar(source)
                return source
        if private.get("url"):
            self.start_step(job, "source", detail="Preparing authorised YouTube import", label="Preparing YouTube import", progress=5, private=private)
            target_dir = self.settings.data_path / "jobs" / job.id / "source"
            self._download_progress(job, private, {"phase": "retrying" if private.get("retry_import") else "connecting", "message": "Resuming retained partial download" if private.get("retry_import") else "Connecting to YouTube"})
            kwargs: dict[str, Any] = {"progress_callback": lambda update: self._download_progress(job, private, update), "cancellation_callback": lambda: not self._cooperate(job), "resume": True, "max_seconds": self.settings.max_long_source_seconds if job_content_format(job, private) == "long" else self.settings.max_source_seconds}
            parameters = inspect.signature(download_youtube).parameters
            if "progress_callback" not in parameters:
                kwargs = {}
            elif "max_seconds" not in parameters:
                kwargs.pop("max_seconds", None)
            try:
                source = download_youtube(private["url"], target_dir, self.settings, **kwargs)
            except DownloadStalled as stalled:
                # Keep the specific reason the media layer reported; the previous
                # blanket message told users "no byte progress" even when the
                # download never got past setup.
                self._download_progress(job, private, {"phase": "stalled", "message": redact(str(stalled)) or "The download stopped before it finished"})
                raise
            except MediaError:
                self._download_progress(job, private, {"phase": "failed", "message": "YouTube import failed; retry the import or check the source URL"})
                raise
            private["source_path"] = str(source)
            imported = youtube_import_metadata(source, consume=False)
            if imported:
                private["youtube_title"] = imported.get("title") or "YouTube source"
                if imported.get("creator"):
                    private["youtube_creator"] = imported["creator"]
            else:
                # Keep compatibility with older/test download adapters that
                # expose the title through the original helper only.
                private["youtube_title"] = youtube_import_title(source) or "YouTube source"
            if private.get("url"):
                project = self.db.get_project(job.project_id)
                creator = _youtube_creator_name(private.get("youtube_creator"))
                if project and project.source_creator != creator:
                    project.source_creator = creator
                    project.updated_at = now_iso()
                    self.db.save_project(project)
            self._register_source(job, private, source)
            self._download_progress(job, private, {"phase": "complete", "downloaded_bytes": source.stat().st_size, "total_bytes": source.stat().st_size, "percent": 100, "message": "Download complete"})
            self.complete_step(job, "source", detail="YouTube source imported, validated, and added to library", private=private)
            private.pop("retry_import", None)
            self._save(job, private)
            _consume_youtube_sidecar(source)
            return source
        raise MediaError("The source file is missing from the mounted data directory")

    def _process_clip(self, job: Job, private: dict[str, Any]) -> None:
        rerender = private.get("caption_rerender")
        if isinstance(rerender, dict) and rerender.get("run_id"):
            self._process_caption_rerender(job, private, rerender)
            return
        if job_uses_fast_pipeline(job, private):
            self._process_clip_fast(job, private)
        else:
            self._process_clip_smart(job, private)

    def _process_caption_rerender(self, job: Job, private: dict[str, Any], request: dict[str, Any]) -> None:
        """Render a reviewed snapshot to a new immutable output before publishing it."""
        clip_id, revision, run_id = request.get("clip_id"), request.get("revision"), request.get("run_id")
        clip = next((item for item in job.clips if item.id == clip_id), None)
        override = (private.get("caption_overrides") or {}).get(clip_id)
        if not clip or not isinstance(override, dict) or override.get("revision") != revision:
            private.pop("caption_rerender", None)
            self._save(job, private)
            return
        from .captions import normalize_and_validate
        from .models import CaptionCue
        cues, issues = normalize_and_validate(list(override.get("cues") or []), clip.duration)
        if any(issue["severity"] == "error" for issue in issues):
            private["caption_rerender_error"] = "Reviewed captions are invalid"
            private.pop("caption_rerender", None)
            self._save(job, private)
            return
        source = self._source(job, private)
        metadata = probe(source, self.settings)
        output_dir = self.settings.data_path / "jobs" / job.id / "clips"
        output = output_dir / f"{clip.index:02d}-caption-r{revision}.mp4"
        words = [{"text": cue["text"], "start": cue["start"], "end": cue["end"]} for cue in cues]
        try:
            render = _media_fn("render_fast_clip")
            music_presentation = private.get("music_presentation")
            music_treatments = private.get("music_treatments")
            music_kwargs = _music_render_kwargs(
                render,
                music_presentation.get("subtitle_theme", "clean") if isinstance(music_presentation, dict) else "clean",
                clip.music_top_text or private.get("music_top_text"),
                clip.music_treatment or (music_treatments.get(clip.id) if isinstance(music_treatments, dict) else None),
            ) if job.source_profile == "music" else {}
            render(source, output, start=clip.start, end=clip.end, aspect=private["aspect_ratio"], settings=self.settings,
                   has_audio=bool(metadata["audio"]), words=words, style=job.style,
                   subtitles_enabled=bool(private.get("burn_subtitles", job.burn_subtitles)),
                   embed_subtitles=bool(private.get("embed_subtitles", job.embed_subtitles)),
                   **_subscribe_render_kwargs(render, private.get("subscribe_animation")),
                   **_format_render_kwargs(render, job_content_format(job, private)),
                   **_creator_render_kwargs(render, youtube_creator_credit(job, private)), **music_kwargs)
            # publish_clip_output reuses the stable asset identity in its transaction.
            job, clip, _ = self._publish_output(job, clip, output, private)
            clip.caption_cues = [CaptionCue.model_validate(cue) for cue in cues]
            job.clips = [clip if item.id == clip.id else item for item in job.clips]
            private["caption_rerender_applied_revision"] = revision
        except Exception as exc:
            output.unlink(missing_ok=True)
            for extension in ("ass", "srt", "vtt"):
                output.with_suffix(f".{extension}").unlink(missing_ok=True)
            private["caption_rerender_error"] = redact(str(exc))
        finally:
            if private.get("caption_rerender", {}).get("run_id") == run_id:
                private.pop("caption_rerender", None)
            self._save(job, private)

    def _transcribe_with_stages(self, job: Job, audio: Path, duration: float, private: dict[str, Any]) -> dict[str, Any]:
        profile = job.source_profile
        language = private.get("transcription_language")
        # Keep the legacy speech call shape for injected/test adapters; the
        # music branch must explicitly consult its separate selected model.
        cached = media_module.is_whisper_model_cached(self.settings, profile=profile) if profile == "music" else media_module.is_whisper_model_cached(self.settings)
        model_label = "Preparing transcription model" if cached else "Downloading transcription model"
        self.start_step(job, "transcribe", detail=model_label, label=model_label, progress=16, private=private)
        started = time.monotonic()
        job.transcription_started_at = now_iso()
        job.transcription_total_seconds = duration
        job.transcription_activity = model_label
        self._save(job, private)

        def heartbeat() -> None:
            job.last_heartbeat_at = now_iso()
            job.transcription_elapsed_seconds = time.monotonic() - started
            self._save(job, private)

        callback = self._transcription_progress(job, private, duration)
        transcription_label = "Transcribing music without speech VAD" if profile == "music" else "Transcribing audio"
        self.start_step(job, "transcribe", detail=transcription_label, label=transcription_label, progress=18, private=private)
        try:
            from .transcription import supervise
            if getattr(media_module.transcribe, "__module__", "engine.media") != "engine.media":
                # Test/injected adapters remain in-process so their barriers and
                # cancellation callbacks are observable; production Whisper is
                # always isolated by supervise().
                transcript = media_module.transcribe(
                    audio, self.settings, progress_callback=callback,
                    cancellation_callback=lambda: not self._cooperate(job), word_timestamps=True,
                    profile=profile, language=language,
                )
            else:
                transcript = supervise(
                    audio, self.settings, progress=callback,
                    cancelled=lambda: not self._cooperate(job), heartbeat=heartbeat,
                    meaningful=lambda fraction: setattr(job, "transcription_processed_seconds", min(duration, duration * fraction)),
                    source_seconds=duration, profile=profile, language=language,
                )
        finally:
            job.transcription_elapsed_seconds = time.monotonic() - started
            job.last_heartbeat_at = now_iso()
            self._save(job, private)
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
            label = f"Transcribing music — {processed:.0f}s of {duration:.0f}s" if job.source_profile == "music" else f"Transcribing audio — {processed:.0f}s of {duration:.0f}s"
            step = self._step_by_id(job, "transcribe")
            self._apply_step(
                job, step, status="active", detail=label,
                current=int(processed), total=max(1, int(duration + .999)),
            )
            self._sync_legacy(job, step, label=label, progress=18 + 14 * fraction)
            job.transcription_processed_seconds = processed
            job.transcription_total_seconds = duration
            job.transcription_activity = label
            job.last_heartbeat_at = now_iso()
            self._save(job, private)

        return report

    def _local_planning_fallback(self, job: Job, private: dict[str, Any], pool: list[Candidate], error: Exception):
        warning = _openrouter_fallback_warning(error)
        if warning not in job.warnings:
            job.warnings.append(warning)
        self.fail_step(job, "openrouter", detail=warning, private=private)
        self.start_step(job, "local_planning", detail="Using deterministic local planning fallback", label="Using local planning fallback", progress=33, private=private)
        chosen = pool[:int(private["count"])]
        self.complete_step(job, "local_planning", detail=f"{len(chosen)} candidates planned locally", private=private)
        return chosen

    def _plan_smart_candidates(self, job: Job, private: dict[str, Any], words: list[dict[str, Any]]):
        requested = int(private.get("effective_target", private["count"]))
        high_volume = private.get("batch_mode", job.batch_mode) == "high_volume"
        if high_volume:
            source_duration = float((private.get("source_metadata") or {}).get("duration", 0))
            pool = _high_volume_smart_candidates(words, job.style, requested, float(private["min_duration"]), float(private["max_duration"]), source_duration)
        else:
            pool = select_candidates(
                words, job.style, min(30, max(requested, requested * 3)),
                float(private["min_duration"]), float(private["max_duration"]),
            )
        if not pool:
            return []
        if high_volume or not private.get("use_openrouter"):
            self.start_step(job, "local_planning", detail="Using deterministic local planning", label="Planning clips locally", progress=33, private=private)
            chosen = pool[:requested]
            self.complete_step(job, "local_planning", detail=f"{len(chosen)} candidates planned locally", private=private)
            return chosen
        self.start_step(job, "openrouter", detail="Reviewing deterministic candidate excerpts", label="Planning clips with OpenRouter", progress=33, private=private)
        excerpts = [
            {"index": index, "start": candidate.start, "end": candidate.end, "text": " ".join(str(word["text"]) for word in candidate.words)[:800]}
            for index, candidate in enumerate(pool)
        ]
        try:
            result = asyncio.run(self.profiles.openrouter_json(
                [{"role": "user", "content": f"Choose up to {requested} distinct candidate indexes for {job.style} short clips. Candidates: {json.dumps(excerpts, ensure_ascii=False)}"}],
                {
                    "type": "object",
                    "properties": {"indexes": {"type": "array", "items": {"type": "integer", "minimum": 0, "maximum": len(pool) - 1}, "minItems": 1, "maxItems": requested}},
                    "required": ["indexes"], "additionalProperties": False,
                },
            ))
        except Exception as exc:
            # Only the optional provider call is guarded here. Cancellation and
            # process termination inherit BaseException and are never converted
            # into a local-planning fallback.
            return self._local_planning_fallback(job, private, pool, exc)
        indexes = result.get("indexes") if isinstance(result, dict) else None
        if not isinstance(indexes, list) or not indexes or len(indexes) > requested:
            return self._local_planning_fallback(job, private, pool, ValueError("OpenRouter returned a malformed planning response"))
        if any(type(index) is not int or not 0 <= index < len(pool) for index in indexes):
            return self._local_planning_fallback(job, private, pool, ValueError("OpenRouter returned invalid candidate indexes"))
        unique = list(dict.fromkeys(indexes))
        if not unique:
            return self._local_planning_fallback(job, private, pool, ValueError("OpenRouter returned no usable candidate indexes"))
        selected_indexes = set(unique)
        chosen = [pool[index] for index in unique[:requested]]
        # The provider is an ordering enhancement, not a reason to silently
        # reduce the requested output count when the validated local pool is
        # large enough. Fill any omitted slots in deterministic pool order.
        if len(chosen) < min(requested, len(pool)):
            chosen.extend(candidate for index, candidate in enumerate(pool) if index not in selected_indexes and len(chosen) < requested)
        self.complete_step(job, "openrouter", detail=f"AI planning completed for {len(chosen)} candidates", private=private)
        self.skip_step(job, "local_planning", detail="OpenRouter planning succeeded", private=private)
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
            self.complete_step(job, "probe", detail=_probe_detail(metadata), private=private)
        for warning in _source_quality_warnings(metadata):
            if warning not in job.warnings:
                job.warnings.append(warning)
        if not metadata["audio"]:
            requirement = "readable sung vocals" if job.source_profile == "music" else "speech"
            raise MediaError(f"This video has no readable audio track. Automatic clips require {requirement}; retain it as a source for manual editing.")
        source_duration = float(metadata["duration"])
        target = self._resolve_batch_target(job, private, source_duration)
        if job.source_profile == "music":
            feasible_count = math.floor((source_duration + 1e-9) / float(private["min_duration"]))
            if feasible_count < int(private["count"]):
                raise MediaError(f"Cannot create {private['count']} non-overlapping music clips of at least {float(private['min_duration']):g}s from a {source_duration:.1f}s source; at most {feasible_count} can fit without padding or duplication.")
        source_hash = str(private.get("source_hash") or sha256_file(source))
        private["source_hash"] = source_hash
        profile = job.source_profile
        language = private.get("transcription_language")
        beam = self.settings.music_whisper_beam_size if profile == "music" else self.settings.whisper_beam_size
        cache_key = transcription_cache_key(
            source_hash,
            self.settings,
            profile=profile,
            language=language,
            beam_size=beam,
            word_timestamps=True,
        )
        transcript = private.get("transcript")
        if transcript and private.get("transcript_cache_key") != cache_key:
            # A persisted checkpoint is reusable only when it was produced by
            # the exact same decoding profile. Legacy checkpoints without an
            # identity are intentionally re-decoded.
            transcript = None
            private.pop("transcript", None)
        if not transcript:
            if not self._cooperate(job):
                self._save(job)
                return
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
            private["transcript_cache_key"] = cache_key
            self._save(job, private)
            self.complete_step(job, "transcribe", detail=self._transcript_detail(transcript, source_duration=source_duration, music=profile == "music"), private=private)
        words = transcript["words"]
        if not job.clips:
            if not self._cooperate(job):
                self._save(job)
                return
            candidates = select_music_candidates(words, job.style, target, float(private["min_duration"]), float(private["max_duration"])) if profile == "music" else self._plan_smart_candidates(job, private, words)
            if profile == "music":
                self.start_step(job, "local_planning", detail="Grouping timed words into lyric lines", label="Grouping lyric lines locally", progress=33, private=private)
                self.complete_step(job, "local_planning", detail=f"{len(candidates)} duration-bounded lyric windows planned", private=private)
            self.start_step(job, "select", detail="Selecting complete moments", label="Finding coherent, complete moments", progress=34, private=private)
            if not candidates and private.get("batch_mode", job.batch_mode) != "high_volume":
                if profile == "music":
                    raise MediaError("The lyric transcript did not contain a timed, non-overlapping line group inside the requested duration range")
                raise MediaError("The transcript did not contain a valid complete moment inside the requested duration range")
            if len(candidates) < target and private.get("batch_mode", job.batch_mode) == "high_volume":
                requested_count = int(private.get("count", target))
                final_target, reason = _high_volume_shortfall(requested_count, len(candidates), source_duration, "timed-transcript")
                job.effective_target = final_target
                private["effective_target"] = final_target
                job.cap_explanation = reason
                private["cap_explanation"] = reason
                project = self.db.get_project(job.project_id)
                if project:
                    project.effective_target = final_target
                    project.cap_explanation = reason
                    self.db.save_project(project)
                candidates = _spread_temporal_items(candidates, final_target)
                job.warnings.append(reason)
                self._save(job, private)
            elif len(candidates) < int(private["count"]):
                if profile == "music":
                    job.warnings.append(f"Found {len(candidates)} duration-bounded lyric windows instead of {private['count']}; no clips were padded or duplicated, and sparse or unclear vocals may reduce the count.")
                else:
                    job.warnings.append(f"Found {len(candidates)} valid clips instead of {private['count']}; complete boundaries were prioritised over filler.")
            # select_candidates falls back to chunking the transcript when no
            # sentence run fits the requested range, and that fallback cannot
            # honour the floor. Saying so keeps a short cut from reading as if
            # it satisfied the requested duration.
            requested_minimum = float(private["min_duration"])
            short = [item for item in candidates if item.end - item.start < requested_minimum - 0.05]
            if short and profile != "music":
                job.warnings.append(
                    f"{len(short)} clip(s) are shorter than the requested {requested_minimum:g}s minimum "
                    f"(shortest {min(item.end - item.start for item in short):.1f}s); the transcript held no longer complete moment."
                )
            clips: list[Clip] = []
            for index, candidate in enumerate(candidates, 1):
                clip = clip_from_candidate(candidate, index)
                clip.id = str(uuid.uuid4())
                excerpt = " ".join(str(word["text"]) for word in candidate.words)
                visual = self.rules.resolve(excerpt)
                clip.visual_label = visual.label
                # The source renderer uses source footage plus real library
                # media only; it never burns the planner's text-card fallback.
                clip.fallback_used = False
                clips.append(clip)
            job.clips = clips
            job.total_items = len(clips)
            job.planned_count = len(clips)
            self._save(job, private)
            self.complete_step(job, "select", detail=f"{len(clips)} moments selected", private=private)
            self.start_step(job, "boundaries", detail="Verifying clip boundaries against the source timeline", label="Verifying clip boundaries", progress=36, private=private)
            for clip in clips:
                if clip.start < 0 or clip.end > metadata["duration"] or clip.end <= clip.start:
                    raise MediaError(f"Clip {clip.index} falls outside the source timeline")
            self.complete_step(job, "boundaries", detail=f"{len(clips)} boundaries verified", private=private)
        if profile == "music":
            _assign_music_treatments(job, private, self._save)
            minimum = float(private["min_duration"])
            maximum = float(private["max_duration"])
            ordered = sorted(job.clips, key=lambda item: (item.start, item.end, item.index))
            previous_end = 0.0
            for clip in ordered:
                duration = float(clip.end) - float(clip.start)
                if (
                    clip.start < -1e-6
                    or clip.end > source_duration + 1e-6
                    or duration < minimum - 1e-6
                    or duration > maximum + 1e-6
                    or clip.start < previous_end - 1e-6
                ):
                    raise MediaError(
                        f"Music clip {clip.index} does not meet the requested {minimum:g}–{maximum:g}s non-overlapping bounds; no invalid output was published."
                    )
                previous_end = clip.end
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
            subtitles_enabled = bool(private.get("burn_subtitles", private.get("subtitles_enabled", job.burn_subtitles)))
            clip_words = media_module.caption_words_for_clip(words, clip.start, clip.end)
            # render_clip receives source-time words; write_ass performs the
            # same bounded local conversion for Smart outputs.
            clip_words = [
                {**word, "start": float(word["start"]) + clip.start, "end": float(word["end"]) + clip.start}
                for word in clip_words
            ]
            if profile == "music":
                clip.caption_cues = [CaptionCue.model_validate(cue) for cue in media_module.music_caption_cues(clip_words, clip.start, clip.end)]
            visual = self.rules.resolve(" ".join(str(word["text"]) for word in clip_words))
            overlays, provenance = _source_clip_visual_metadata(visual, clip.duration)
            # Provenance describes media actually composited into this source
            # clip. Remove legacy/generated-card records and replace any prior
            # library match when a retry resolves the clip again.
            clip.provenance = [record for record in clip.provenance if record.provider not in {"local-text-card", "personal-library"}]
            clip.provenance.extend(provenance)
            clip.fallback_used = False
            try:
                render_kwargs = {
                    "start": clip.start, "end": clip.end, "aspect": private["aspect_ratio"],
                    "words": clip_words if subtitles_enabled or bool(private.get("embed_subtitles", job.embed_subtitles)) else [],
                    "visuals": [], "overlays": overlays, "settings": self.settings, "style": job.style,
                    **({"embed_subtitles": True} if private.get("embed_subtitles", job.embed_subtitles) else {}),
                    **_subscribe_render_kwargs(render_clip, private.get("subscribe_animation")),
                    **_creator_render_kwargs(render_clip, youtube_creator_credit(job, private)),
                    **_format_render_kwargs(render_clip, job_content_format(job, private)),
                    **(_music_render_kwargs(
                        render_clip,
                        (private.get("music_presentation") or {}).get("subtitle_theme", "clean"),
                        clip.music_top_text, clip.music_treatment,
                    ) if profile == "music" else {}),
                }
                try:
                    render_clip(source, output, **render_kwargs)
                except TypeError as exc:
                    if "unexpected keyword argument 'style'" not in str(exc):
                        raise
                    # Compatibility for editor/test render adapters from older jobs.
                    render_kwargs.pop("style", None)
                    render_clip(source, output, **render_kwargs)
                job, clip, _ = self._publish_output(job, clip, output, private)
            except Exception as exc:
                clip = clip.model_copy(update={"state": "failed", "error": redact(str(exc)), "selected": False})
                job.clips = [clip if c.id == clip.id else c for c in job.clips]
            rendered = sum(1 for item in job.clips if item.state == "complete")
            self._apply_step(job, render_step, status="active", detail=f"{rendered} of {len(job.clips)} rendered", current=rendered)
            job.current_item = rendered
            self._save(job, private)
        successful = [clip for clip in job.clips if clip.state == "complete"]
        failed = [clip for clip in job.clips if clip.state == "failed"]
        self._finish_render_steps(job, private, successful, failed, output_dir, "clip(s)", "clips ready")

    def _transcribe_fast_window(self, job: Job, private: dict[str, Any], source: Path, clip: Clip, output_dir: Path) -> list[dict[str, Any]]:
        """Transcribe only one selected window; returned timings are clip-relative."""
        source_hash = str(private.get("source_hash") or sha256_file(source))
        private["source_hash"] = source_hash
        cache_key = (
            f"fast-transcript:v1:{source_hash}:{clip.start:.6f}:{clip.end:.6f}:"
            f"{self.settings.whisper_model}:{self.settings.whisper_device}:"
            f"{self.settings.whisper_compute_type}:beam{self.settings.whisper_beam_size}:words1"
        )
        transcripts = private.setdefault("fast_transcripts", {})
        cached = self.db.cache_get(cache_key)
        if isinstance(cached, dict) and isinstance(cached.get("words"), list):
            if isinstance(transcripts, dict):
                transcripts[cache_key] = cached["words"]
            return cached["words"]
        if isinstance(transcripts, dict) and isinstance(transcripts.get(cache_key), list):
            return transcripts[cache_key]
        if not self._cooperate(job):
            raise media_module.TranscriptionCancelled("Fast caption transcription cancelled")
        audio = media_module.extract_audio_16k(
            source, self.settings,
            output=output_dir.parent / "transcription" / f"{clip.id}-audio-16k.wav",
            start=clip.start,
            duration=clip.duration,
            cancellation_callback=lambda: not self._cooperate(job),
        )
        render_step = self._step_by_id(job, "render")
        model_detail = "Preparing local caption model" if media_module.is_whisper_model_cached(self.settings) else "Downloading local caption model (real progress begins after download)"
        self._apply_step(job, render_step, status="active", detail=f"{model_detail} — selected fast window {clip.index}", current=0, total=1)
        self._save(job, private)
        transcript = media_module.transcribe(
            audio, self.settings,
            progress_callback=lambda fraction, _: self._fast_transcription_progress(job, private, fraction),
            cancellation_callback=lambda: not self._cooperate(job),
            word_timestamps=True,
        )
        words = [
            word
            for word in media_module.caption_words_for_clip(transcript.get("words", []), 0, clip.duration)
        ]
        self.db.cache_put(cache_key, now_iso(), {"words": words})
        if isinstance(transcripts, dict):
            transcripts[cache_key] = words
        self._save(job, private)
        return words

    def _fast_transcription_progress(self, job: Job, private: dict[str, Any], fraction: float) -> None:
        step = self._step_by_id(job, "render")
        self._apply_step(job, step, status="active", detail=f"Transcribing selected fast window ({min(100, max(0, int(fraction * 100)))}%)")
        self._save(job, private)

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
            self.complete_step(job, "probe", detail=_probe_detail(metadata), private=private)
        target = self._resolve_batch_target(job, private, float(metadata["duration"]))
        for warning in _source_quality_warnings(metadata):
            if warning not in job.warnings:
                job.warnings.append(warning)
        if not self._cooperate(job):
            self._save(job)
            return
        if job.clips:
            if "trim_start" in private:
                requested_start = float(private["trim_start"])
                requested_end = private.get("trim_end")
                if requested_start < 0 or requested_start >= float(metadata["duration"]):
                    raise MediaError(f"Start trim must fall within the {float(metadata['duration']):.2f}-second source")
                resolved_end = float(metadata["duration"]) if requested_end is None else float(requested_end)
                if resolved_end <= requested_start or resolved_end > float(metadata["duration"]):
                    raise MediaError(f"End trim must be greater than start and within the {float(metadata['duration']):.2f}-second source")
                if len(job.clips) != 1:
                    raise MediaError("A source trim can only be applied to its single editor clip")
                job.clips[0] = job.clips[0].model_copy(update={"start": requested_start, "end": resolved_end, "duration": resolved_end - requested_start})
            elif any(clip.start < 0 or clip.end <= clip.start or clip.end > float(metadata["duration"]) for clip in job.clips):
                raise MediaError("A persisted fast-cut window falls outside the validated source timeline")
            job.total_items = len(job.clips)
            self._save(job, private)
        if not job.clips:
            is_long_form = job_content_format(job, private) == "long"
            plan_label = "Planning deterministic landscape scenes" if is_long_form else "Planning neutral fast-cut windows"
            self.start_step(job, "plan", detail=plan_label, label=plan_label, progress=28, private=private)
            high_volume = private.get("batch_mode", job.batch_mode) == "high_volume"
            plan_name = ("plan_long_form_high_volume_windows" if is_long_form else "plan_fast_high_volume_windows") if high_volume else ("plan_long_form_windows" if is_long_form else "plan_fast_windows")
            plan = _media_fn(plan_name)
            windows, warning = plan(
                metadata["duration"], target, float(private["min_duration"]),
                float(private["max_duration"]), self.settings.fast_guard_seconds,
            )
            if warning:
                if isinstance(warning, str):
                    job.warnings.append(warning)
                else:
                    job.warnings.extend(str(item) for item in warning)
            if high_volume and len(windows) < target:
                requested_count = int(private.get("count", target))
                effective, reason = _high_volume_shortfall(requested_count, len(windows), float(metadata["duration"]), "source-timeline")
                job.effective_target = effective
                job.cap_explanation = reason
                private["effective_target"] = effective
                private["cap_explanation"] = reason
                project = self.db.get_project(job.project_id)
                if project:
                    project.effective_target = effective
                    project.cap_explanation = reason
                    self.db.save_project(project)
                job.warnings.append(reason)
                windows = windows[:effective]
                self._save(job, private)
            if not windows:
                raise MediaError("The source did not contain a window long enough for a fast cut")
            job.clips = [
                Clip(
                    id=str(uuid.uuid4()), index=index, state="queued", start=start, end=end,
                    duration=end - start, opening_line=(f"Scene {index:02d}" if is_long_form else f"Cut {index:02d}"), score=None,
                )
                for index, (start, end) in enumerate(windows, 1)
            ]
            job.total_items = len(job.clips)
            job.planned_count = len(job.clips)
            self._save(job, private)
            self.complete_step(job, "plan", detail=f"{len(job.clips)} {'landscape scenes' if is_long_form else 'windows'} planned across the source", private=private)
        output_dir = self.settings.data_path / "jobs" / job.id / "clips"
        output_dir.mkdir(parents=True, exist_ok=True)
        render = _media_fn("render_fast_clip")
        has_audio = bool(metadata["audio"])
        target_width, target_height = media_module.dimensions(str(private["aspect_ratio"]))
        source_dimensions = _displayed_dimensions(metadata)
        if source_dimensions and min(source_dimensions) < min(target_width, target_height):
            warning = f"Source is {source_dimensions[0]}×{source_dimensions[1]}, below the {target_width}×{target_height} delivery canvas; output was upscaled and may have reduced detail."
            if warning not in job.warnings:
                job.warnings.append(warning)
        if not has_audio:
            warning = "Source has no audio; exported fast clips without captions."
            if warning not in job.warnings:
                job.warnings.append(warning)
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
            job.stage_label = f"Rendering {'landscape scene' if job_content_format(job, private) == 'long' else 'fast cut'} {position} of {len(job.clips)}"
            job.progress = 40 + (position - 1) / max(len(job.clips), 1) * 54
            job.current_item = completed_before
            job.total_items = len(job.clips)
            output = output_dir / f"{position:02d}-cut.mp4"
            subtitles_requested = bool(private.get("burn_subtitles", private.get("subtitles_enabled", job.burn_subtitles)))
            embed_subtitles_requested = bool(private.get("embed_subtitles", job.embed_subtitles))
            caption_options_requested = subtitles_requested or embed_subtitles_requested or bool(private.get("caption_downloads_enabled", False)) or bool(private.get("caption_review_enabled", False))
            captions_enabled = job_processing_mode(job, private) != "fast"
            subtitles_enabled = subtitles_requested and captions_enabled
            embed_subtitles = embed_subtitles_requested and captions_enabled
            words: list[dict[str, Any]] = []
            try:
                captions_required = captions_enabled and caption_options_requested
                if caption_options_requested and not captions_enabled and has_audio:
                    warning = "Fast mode skips caption transcription and rendering; choose Smart mode for captions."
                    if warning not in job.warnings:
                        job.warnings.append(warning)
                if captions_required and has_audio:
                    try:
                        words = self._transcribe_fast_window(job, private, source, clip, output_dir)
                    except media_module.TranscriptionCancelled:
                        raise
                    except MediaError as exc:
                        detail = redact(str(exc))
                        if "No speech was detected" in detail:
                            warning = f"Clip {clip.index}: No speech detected; exported without captions."
                        else:
                            warning = f"Clip {clip.index}: Local captioning unavailable; exported without captions. ({detail})"
                        job.warnings.append(warning)
                render_kwargs: dict[str, Any] = {"start": clip.start, "end": clip.end, "aspect": private["aspect_ratio"], "has_audio": has_audio, "settings": self.settings, **_subscribe_render_kwargs(render, private.get("subscribe_animation"))}
                if embed_subtitles:
                    render_kwargs["embed_subtitles"] = True
                if words:
                    render_kwargs.update({"words": words, "style": job.style, "subtitles_enabled": subtitles_enabled})
                render_kwargs.update(_creator_render_kwargs(render, youtube_creator_credit(job, private)))
                render_kwargs.update(_format_render_kwargs(render, job_content_format(job, private)))
                render(source, output, **render_kwargs)
                job, clip, _ = self._publish_output(job, clip, output, private)
            except Exception as exc:
                clip = clip.model_copy(update={"state": "failed", "error": redact(str(exc)), "selected": False})
                job.clips = [clip if c.id == clip.id else c for c in job.clips]
            rendered = sum(1 for item in job.clips if item.state == "complete")
            self._apply_step(job, render_step, status="active", detail=f"{rendered} of {len(job.clips)} rendered", current=rendered)
            job.current_item = rendered
            self._save(job, private)
        successful = [clip for clip in job.clips if clip.state == "complete"]
        failed = [clip for clip in job.clips if clip.state == "failed"]
        result_label = "landscape scene(s)" if job_content_format(job, private) == "long" else "fast cut(s)"
        ready_label = "landscape clips ready" if job_content_format(job, private) == "long" else "fast cuts ready"
        self._finish_render_steps(job, private, successful, failed, output_dir, result_label, ready_label)

    async def delete_project(self, project_id: str, *, delete_assets: bool = False, allow_protected: bool = False):
        """Stop a project's workers before deleting their durable records.

        The marker is visible to every cooperative checkpoint immediately. The
        synchronous deletion then waits for each job lock, so no worker can
        publish or upsert a job after its project has been removed. Protected
        media remains guarded unless the explicit global Library purge opts in.
        """
        with self._deletion_lock:
            if not self.db.get_project(project_id):
                raise KeyError(project_id)
            self._deleting_projects.add(project_id)
        try:
            return await asyncio.to_thread(self._delete_project_records, project_id, delete_assets, allow_protected)
        finally:
            with self._deletion_lock:
                self._deleting_projects.discard(project_id)

    def _delete_project_records(self, project_id: str, delete_assets: bool = False, allow_protected: bool = False):
        jobs = [job for job in self.db.list_jobs() if job.project_id == project_id]
        locks = [self.job_locks[job.id] for job in sorted(jobs, key=lambda item: item.id)]
        for lock in locks:
            lock.acquire()
        try:
            if delete_assets:
                unreferenced_paths, bytes_reclaimed = self.db.delete_project_everywhere_with_stats(project_id, allow_protected=allow_protected)
            else:
                unreferenced_paths, bytes_reclaimed = [], 0
                self.db.delete_project(project_id)
        finally:
            for lock in reversed(locks):
                lock.release()
        warnings: list[str] = []
        blobs_deleted = len(unreferenced_paths)
        for job in jobs:
            try:
                directory = confined(self.settings.data_path, "jobs", job.id)
                if directory.is_symlink():
                    directory.unlink(missing_ok=True)
                elif directory.exists():
                    shutil.rmtree(directory)
            except (OSError, ValueError) as exc:
                logger.warning("Could not remove deleted job workspace: %s", redact(str(exc)))
                warnings.append("Some deleted project workspaces could not be removed from disk.")
        for relative in unreferenced_paths:
            try:
                target = confined(self.settings.data_path, *relative.split("/"))
                if bytes_reclaimed == 0 and target.is_file():
                    try:
                        bytes_reclaimed += target.stat().st_size
                    except OSError:
                        pass
                target.unlink(missing_ok=True)
            except (OSError, ValueError) as exc:
                logger.warning("Could not remove unreferenced project blob: %s", redact(str(exc)))
                warnings.append("Some deleted media files could not be removed from disk.")
        return {"bytes_reclaimed": bytes_reclaimed, "blobs_deleted": blobs_deleted, "warnings": list(dict.fromkeys(warnings))}

    async def purge_library_content(self):
        """Remove all Library content after the API has checked job safety.

        Project-linked media goes through the same coordinated deletion path as
        ordinary project deletion, with protected media overridden only for this
        explicit global operation. Remaining assets are removed in one database
        transaction after all linked projects have committed their deletion.
        """
        blocked_states = {"queued", "active", "paused", "stalled", "recovered"}
        blocked = [job for job in self.db.list_jobs() if job.state in blocked_states]
        if blocked:
            raise ValueError("Library content cannot be purged while processing jobs are queued or running")

        assets = self.db.list_assets(include_archived=True)
        project_ids = sorted({asset.source_project_id for asset in assets if asset.source_project_id and self.db.get_project(asset.source_project_id)})
        assets_deleted = 0
        projects_deleted = 0
        blobs_deleted = 0
        bytes_reclaimed = 0
        warnings: list[str] = []
        for project_id in project_ids:
            assets_deleted += sum(1 for asset in assets if asset.source_project_id == project_id)
            result = await self.delete_project(project_id, delete_assets=True, allow_protected=True)
            projects_deleted += 1
            blobs_deleted += result["blobs_deleted"]
            bytes_reclaimed += result["bytes_reclaimed"]
            warnings.extend(result["warnings"])

        ordinary_assets_deleted, paths, ordinary_bytes = await asyncio.to_thread(self.db.purge_library_assets)
        assets_deleted += ordinary_assets_deleted
        blobs_deleted += len(paths)
        bytes_reclaimed += ordinary_bytes
        for relative in paths:
            try:
                target = confined(self.settings.data_path, *relative.split("/"))
                if ordinary_bytes == 0 and target.is_file():
                    try:
                        bytes_reclaimed += target.stat().st_size
                    except OSError:
                        pass
                target.unlink(missing_ok=True)
            except (OSError, ValueError) as exc:
                logger.warning("Could not remove unreferenced Library blob: %s", redact(str(exc)))
                warnings.append("Some deleted media files could not be removed from disk.")
        return {
            "assets_deleted": assets_deleted,
            "projects_deleted": projects_deleted,
            "blobs_deleted": blobs_deleted,
            "bytes_reclaimed": max(0, bytes_reclaimed),
            "warnings": list(dict.fromkeys(warnings)),
        }

    def prune_retained_jobs(self) -> int:
        """Prune only terminal job workspaces while retaining durable job records.

        Published media remains in the content-addressed Library, allowing old
        clips to remain playable after the transient job directory is removed.
        """
        terminal = {"complete", "failed", "partial", "cancelled_kept"}
        cutoff = datetime.now(timezone.utc) - timedelta(days=self.settings.retention_days)
        pruned = 0
        retained = 0
        for job in self.db.list_jobs():
            if job.state not in terminal:
                continue
            try:
                updated = datetime.fromisoformat(job.updated_at.replace("Z", "+00:00"))
                if updated.tzinfo is None:
                    updated = updated.replace(tzinfo=timezone.utc)
            except ValueError:
                updated = datetime.min.replace(tzinfo=timezone.utc)
            retain_by_count = retained < self.settings.max_retained_jobs
            retained += 1
            if retain_by_count and updated >= cutoff:
                continue
            lock = self.job_locks[job.id]
            if not lock.acquire(blocking=False):
                continue
            try:
                current = self.db.get_job(job.id)
                if not current or current.state not in terminal:
                    continue
                directory = confined(self.settings.data_path, "jobs", job.id)
                if directory.is_symlink():
                    directory.unlink(missing_ok=True)
                    pruned += 1
                elif directory.is_dir():
                    shutil.rmtree(directory)
                    pruned += 1
            except (OSError, ValueError) as exc:
                logger.warning("Could not prune job workspace %s: %s", job.id, redact(str(exc)))
            finally:
                lock.release()
        return pruned

    async def control(self, job_id: str, action: str) -> Job:
        job = self.db.get_job(job_id)
        if not job:
            raise KeyError(job_id)
        if self._project_is_deleting(job.project_id):
            raise ProjectDeletingError("This project is being deleted")
        if job.mode != "clip":
            raise MediaError("Legacy Script jobs cannot be retried or resumed")
        if action == "retry-import":
            private = self.db.get_job_private(job.id)
            if job.state not in {"failed", "stalled", "cancelled_kept"}:
                raise MediaError("This import is already queued or running")
            if not can_retry_import(job, private):
                raise MediaError("This project has no YouTube import to retry")
            private["retry_import"] = True
            job.state, job.stage, job.stage_label, job.error = "queued", "source", "Retrying YouTube import", None
            if job.download_progress:
                job.download_progress = job.download_progress.model_copy(update={"phase": "retrying", "message": "Retry queued; retained partial will be resumed"})
            for step in job.steps:
                if step.id == "source":
                    step.status, step.started_at, step.completed_at, step.detail = "pending", None, None, "Retrying YouTube import"
                elif step.status in {"active", "failed"}:
                    step.status, step.started_at, step.completed_at, step.detail = "pending", None, None, "Waiting for source retry"
            # Persist the requeue before exposing the id to a worker. Otherwise a
            # fast worker can observe the old cancelled checkpoint and _save() will
            # (correctly for ordinary work) restore cancelled_kept.
            self._save(job, private)
            await self.enqueue(job.id)
            return job
        if action == "switch-fast":
            with self._deletion_lock:
                if job.project_id in self._deleting_projects:
                    raise ProjectDeletingError("This project is being deleted")
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
            with self._queue_lock:
                self._queued_ids.discard(job.id)
                try:
                    self._pending_order.remove(job.id)
                except ValueError:
                    pass
            job.state, job.stage_label = "cancelled_kept", "Stopped; completed outputs kept"
            if job.download_progress and job.download_progress.phase not in {"complete", "failed"}:
                job.download_progress = job.download_progress.model_copy(update={"phase": "stopped_partial", "message": "Stopped by user; partial download retained"})
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

    # DO-NOT-CHANGE: creates a NEW job reusing the same source; old job stays cancelled_kept
    def _switch_to_fast(self, job: Job) -> Job:
        with self._deletion_lock:
            if job.project_id in self._deleting_projects:
                raise ProjectDeletingError("This project is being deleted")
        if job.mode != "clip":
            raise SwitchFastError("Only clip projects can switch to fast cut")
        if job.source_profile == "music":
            raise SwitchFastError("Music / sung vocals requires Smart transcription and cannot switch to fast cut")
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
        new_private["library_folder_id"] = job.library_folder_id
        new_private.pop("transcript", None)
        new_id = str(uuid.uuid4())
        new_job = Job(
            id=new_id, project_id=job.project_id, library_folder_id=job.library_folder_id,
            source_blob_id=job.source_blob_id, mode="clip", content_format=job.content_format, processing_mode="fast",
            requested_count=job.requested_count, batch_mode=job.batch_mode, effective_target=job.effective_target,
            cap_explanation=job.cap_explanation, state="queued", stage="queued", stage_label="Queued on this machine",
            progress=0, style=job.style, burn_subtitles=bool(new_private.get("burn_subtitles", job.burn_subtitles)), steps=self._fast_steps(),
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
        selected = set(clip_ids)
        chosen = sorted(
            (clip for clip in job.clips if clip.id in selected and clip.state == "complete" and clip.output_name),
            key=lambda clip: (clip.index, clip.id),
        )
        if not chosen:
            raise ValueError("No successful selected clips are available to export")
        project = self.db.get_project(job.project_id)
        title = safe_archive_title(project.name if project else None)
        export_sources: list[tuple[Clip, Path]] = []
        for clip in chosen:
            try:
                source = confined(self.settings.data_path, "jobs", job.id, "clips", str(clip.output_name))
            except ValueError:
                continue
            temporary = source.name.startswith(".") or any(marker in source.stem.casefold() for marker in (".partial", ".uploading", ".tmp", ".temp", ".ytdl"))
            if temporary:
                continue
            if not (source.is_file() and not source.is_symlink() and source.stat().st_size > 0 and source.suffix.casefold() == ".mp4"):
                # Retention removes a job's transient workspace. Published clips
                # remain in their immutable Library blobs and must still export.
                relative = self.db.blob_relative_path(clip.blob_id) if clip.blob_id else None
                try:
                    source = confined(self.settings.data_path, *(relative or "").split("/"))
                except ValueError:
                    continue
            if source.is_file() and not source.is_symlink() and source.stat().st_size > 0 and source.suffix.casefold() == ".mp4":
                export_sources.append((clip, source))
        if not export_sources:
            raise ValueError("No completed MP4 videos are available to export")

        export_dir = self.settings.data_path / "exports" / job.id
        export_dir.mkdir(parents=True, exist_ok=True)
        output = export_dir / f"{title}.zip"
        manifest_outputs = []
        credits = []
        warning_summary = []
        for number, (clip, source) in enumerate(export_sources, 1):
            filename = f"{number:02d}-{safe_filename(source.stem, 'cut')}.mp4"
            manifest_outputs.append({
                "index": clip.index,
                "filename": filename,
                "title": clip.title,
                "duration_seconds": clip.duration,
                "dimensions": {"width": clip.width, "height": clip.height},
                "source_range_seconds": {"start": clip.start, "end": clip.end},
                "creator_credit": clip.creator_credit,
                "library_asset_id": clip.library_asset_id,
                "blob_id": clip.blob_id,
                "provenance": [record.model_dump(mode="json") for record in clip.provenance],
            })
            if clip.creator_credit or clip.provenance:
                credits.append({
                    "clip_index": clip.index,
                    "filename": filename,
                    "creator_credit": clip.creator_credit,
                    "provenance": [record.model_dump(mode="json") for record in clip.provenance],
                })
            if clip.caption_qa_warnings or clip.error:
                warning_summary.append({
                    "clip_index": clip.index,
                    "caption_warnings": clip.caption_qa_warnings,
                    "error": clip.error,
                })
        manifest = {
            "schema_version": 1,
            "project": {
                "id": project.id if project else None,
                "name": project.name if project else title,
                "mode": project.mode if project else job.mode,
                "source_kind": project.source_kind if project else None,
                "source_name": project.source_name if project else None,
                "source_creator": project.source_creator if project else None,
            },
            "job": {
                "id": job.id,
                "processing_mode": job.processing_mode,
                "content_format": job.content_format,
                "created_at": job.created_at,
                "updated_at": job.updated_at,
            },
            "outputs": manifest_outputs,
        }
        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
            for output_record, (_, source) in zip(manifest_outputs, export_sources, strict=True):
                archive.write(source, f"{title}/{output_record['filename']}")
            archive.writestr(f"{title}/manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
            archive.writestr(f"{title}/credits.json", json.dumps({"schema_version": 1, "credits": credits}, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
            archive.writestr(f"{title}/warning-summary.json", json.dumps({"schema_version": 1, "job_warnings": job.warnings, "clips": warning_summary}, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
        return output
