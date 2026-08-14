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

from .config import Settings
from .database import Database
from .library import LibraryRules
from .media import (
    MediaError, available, download_youtube, probe, probe_audio, render_clip, render_script,
    sha256_file, synthesize_local, transcribe,
)
from .models import Clip, Job, Project, ProvenanceRecord, ScoreBreakdown, now_iso
from .providers import ProfileService, provider_runtime_message
from .script import align_script_words, plan_beats
from .security import redact, safe_filename
from .selection import clip_from_candidate, select_candidates


class QueueFullError(RuntimeError):
    pass


class JobManager:
    def __init__(self, db: Database, rules: LibraryRules, profiles: ProfileService, settings: Settings):
        self.db = db
        self.rules = rules
        self.profiles = profiles
        self.settings = settings
        self.queue: asyncio.Queue[str] = asyncio.Queue(maxsize=settings.max_queued_jobs)
        self.workers: list[asyncio.Task[None]] = []
        self.job_locks: defaultdict[str, threading.Lock] = defaultdict(threading.Lock)
        self.active_workers = 0
        self._active_lock = threading.Lock()

    async def start(self) -> None:
        if self.workers:
            return
        for index in range(self.settings.job_workers):
            self.workers.append(asyncio.create_task(self._worker(index), name=f"s6-worker-{index}"))
        for job in reversed(self.db.list_jobs(("queued", "active", "recovered"))):
            job.state = "recovered"
            job.stage_label = "Recovered after engine restart"
            self._save(job)
            await self.enqueue(job.id, tolerate_full=True)

    async def stop(self) -> None:
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
        job.updated_at = now_iso()
        self.db.save_job(job, private)
        project = self.db.get_project(job.project_id)
        if project:
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
                return False
            return True

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
            if job.mode == "clip":
                self._process_clip(job, private)
            else:
                self._process_script(job, private)
        except Exception as exc:  # scoped outer guard preserves already-published clips
            job = self.db.get_job(job_id)
            if job:
                successful = any(clip.state == "complete" for clip in job.clips)
                job.state = "partial" if successful else "failed"
                job.stage = "failed"
                job.stage_label = "Stopped with recoverable work" if successful else "Project failed"
                job.error = redact(str(exc))
                self._save(job)
        finally:
            with self._active_lock:
                self.active_workers -= 1
            lock.release()

    def _source(self, job: Job, private: dict[str, Any]) -> Path:
        if private.get("source_path"):
            source = Path(private["source_path"])
            if source.is_file():
                return source
        if private.get("url"):
            self._stage(job, "import", "Importing authorised YouTube source", 5, private=private)
            source = download_youtube(private["url"], self.settings.data_path / "jobs" / job.id / "source", self.settings)
            private["source_path"] = str(source)
            self._save(job, private)
            return source
        raise MediaError("The source file is missing from the mounted data directory")

    def _process_clip(self, job: Job, private: dict[str, Any]) -> None:
        source = self._source(job, private)
        self._stage(job, "probe", "Validating source with FFprobe", 8, private=private)
        metadata = probe(source, self.settings)
        if not metadata["audio"]:
            raise MediaError("This video has no readable audio track. Automatic clips require speech; retain it as a source for manual editing.")
        transcript = private.get("transcript")
        if not transcript:
            self._stage(job, "transcribe", "Transcribing locally with Whisper", 18, private=private)
            cache_key = f"transcript:v1:{sha256_file(source)}:{self.settings.whisper_model}"
            transcript = self.db.cache_get(cache_key)
            if transcript:
                job.warnings.append("Reused a validated local transcript cache entry.")
            else:
                transcript = transcribe(source, self.settings)
                self.db.cache_put(cache_key, now_iso(), transcript)
            private["transcript"] = transcript
            self._save(job, private)
        words = transcript["words"]
        if not job.clips:
            self._stage(job, "select", "Finding coherent, complete moments", 34, private=private)
            candidates = select_candidates(words, job.style, int(private["count"]), float(private["min_duration"]), float(private["max_duration"]))
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
        output_dir = self.settings.data_path / "jobs" / job.id / "clips"
        output_dir.mkdir(parents=True, exist_ok=True)
        for position, clip in enumerate(job.clips, 1):
            if clip.state == "complete":
                continue
            if not self._cooperate(job):
                self._save(job)
                return
            clip.state = "rendering"
            clip.error = None
            self._stage(job, "render", f"Rendering clip {position} of {len(job.clips)}", 40 + (position - 1) / max(len(job.clips), 1) * 54, current=position, total=len(job.clips), private=private)
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
            self._save(job, private)
        successful = [clip for clip in job.clips if clip.state == "complete"]
        failed = [clip for clip in job.clips if clip.state == "failed"]
        job.state = "complete" if successful and not failed else "partial" if successful else "failed"
        job.stage = "complete" if successful else "failed"
        job.stage_label = f"{len(successful)} clips ready" if successful else "No clips rendered"
        job.progress = 100
        if failed:
            job.warnings.append(f"{len(failed)} clip(s) failed independently and can be retried.")
        self._save(job, private)

    def _process_script(self, job: Job, private: dict[str, Any]) -> None:
        script = str(private["script"])
        work = self.settings.data_path / "jobs" / job.id
        work.mkdir(parents=True, exist_ok=True)
        narration: Path | None = None
        if private.get("narration") != "silent":
            self._stage(job, "voice", "Creating paragraph-safe narration", 15, private=private)
            if private.get("narration") == "auto":
                try:
                    candidate = work / "narration-elevenlabs.mp3"
                    if self.profiles.synthesize_elevenlabs(script, candidate):
                        narration = candidate
                except Exception as exc:
                    job.warnings.append(f"{provider_runtime_message(exc, 'ElevenLabs')}; used the local voice fallback.")
            if narration is None and available(self.settings.local_tts):
                narration = synthesize_local(script, work / "narration-local.wav", self.settings)
            if narration is None:
                job.warnings.append("No local or optional narration engine was available. Continued with a clearly labelled silent render.")
        if narration:
            duration = probe_audio(narration, self.settings)["duration"]
            self._stage(job, "align", "Aligning narration to exact script words", 31, private=private)
            try:
                spoken = transcribe(narration, self.settings)["words"]
            except Exception as exc:
                spoken = []
                job.warnings.append(f"Forced alignment used deterministic audio-duration fallback ({redact(str(exc))}).")
        else:
            spoken = []
            duration = max(5.0, len(script.split()) / 2.4)
        words = align_script_words(script, duration, spoken)
        self._stage(job, "plan", "Planning semantic visuals every 2–3 seconds", 43, private=private)
        beats = plan_beats(script, words, self.rules)
        for beat in beats:
            if script[beat.char_start:beat.char_end] != beat.text:
                raise MediaError("Beat planner violated the exact source-script span invariant")
        job.beats = beats
        self._save(job, private)
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
        score = ScoreBreakdown(hook=70, coherence=85, ending=80, energy=65, practical_value=75, visual_potential=82, completeness=90, penalties=0, total=81, explanation="Script video preserves the exact narration and uses deterministic semantic beat planning.")
        clip = job.clips[0] if job.clips else Clip(id=str(uuid.uuid4()), index=1, state="queued", start=0, end=duration, duration=duration, opening_line=" ".join(script.split()[:18]), score=score, provenance=provenance)
        job.clips = [clip]
        clip.state = "rendering"
        self._stage(job, "render", "Rendering narration, captions, and visual beats", 67, current=1, total=1, private=private)
        output = work / "clips" / "01-script-video.mp4"
        try:
            render_script(output, duration=duration, aspect=private["aspect_ratio"], narration=narration, words=words, visuals=visuals, overlays=overlays, settings=self.settings)
            clip.state = "complete"
            clip.output_name = output.name
            clip.selected = True
            job.state = "complete"
            job.stage = "complete"
            job.stage_label = "Script video ready"
            job.progress = 100
        except Exception as exc:
            clip.state = "failed"
            clip.error = redact(str(exc))
            clip.selected = False
            job.state = "failed"
            job.stage = "failed"
            job.stage_label = "Script render failed"
            job.error = clip.error
        self._save(job, private)

    async def control(self, job_id: str, action: str) -> Job:
        job = self.db.get_job(job_id)
        if not job:
            raise KeyError(job_id)
        if action == "pause" and job.state in {"queued", "active", "recovered"}:
            job.state, job.stage_label = "paused", "Paused after current safe checkpoint"
        elif action == "resume" and job.state == "paused":
            job.state, job.stage_label = "queued", "Queued to resume from checkpoint"
            await self.enqueue(job.id)
        elif action == "stop-keep" and job.state not in {"complete", "failed"}:
            job.state, job.stage_label = "cancelled_kept", "Stopped; completed outputs kept"
        elif action == "retry-failed":
            for clip in job.clips:
                if clip.state == "failed":
                    clip.state, clip.error = "queued", None
            job.state, job.stage_label, job.error = "queued", "Retrying failed outputs", None
            await self.enqueue(job.id)
        self._save(job)
        return job

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
