"""Bulk SEO retitling for existing Library items: suggest (no writes) → apply.

Only titles and descriptions change. Generated clip titles go through
``Database.update_generated_clip_metadata`` so the clip and its Library asset
stay in one transaction. Tags, triggers, policy, files and blobs are never
touched.
"""

from __future__ import annotations

import asyncio
import json
import math
from typing import Any, Literal

from pydantic import Field

from .database import Database
from .models import ApiModel, Asset, Clip, Job, Project, YouTubeMetadataUpdate, now_iso
from .providers import ProfileService, ProviderError, provider_runtime_message
from .security import redact
from .seo_titles import (
    SEO_TITLE_RULES, clip_title_replaceable, generic_stem, is_placeholder_name,
    normalize_seo_description, normalize_seo_title, source_context_title,
)

MAX_ITEMS = 200
MAX_REQUESTS = 10
BATCH_SIZE = 8
PRICE_CEILING = (0.10, 0.40)  # USD per million prompt / completion tokens

Kind = Literal["clip", "source", "project"]


class TitleSuggestionRequest(ApiModel):
    asset_ids: list[str] | None = Field(default=None, max_length=MAX_ITEMS)
    scope: Literal["auto-titled"] | None = None


class TitleSuggestion(ApiModel):
    kind: Kind
    asset_id: str | None = None
    project_id: str | None = None
    current_title: str
    suggested_title: str
    suggested_description: str = ""
    revision: int | None = None


class TitleSkip(ApiModel):
    asset_id: str | None = None
    project_id: str | None = None
    title: str
    reason: str


class TitleSuggestionResponse(ApiModel):
    suggestions: list[TitleSuggestion]
    skipped: list[TitleSkip]
    cost_usd: float = 0
    cost_kind: Literal["actual", "estimated"] = "estimated"
    model: str | None = None
    requests: int = 0
    ai_available: bool = False
    warning: str | None = None


class TitleApplyItem(ApiModel):
    kind: Kind
    asset_id: str | None = None
    project_id: str | None = None
    current_title: str = Field(max_length=200)
    title: str = Field(min_length=1, max_length=160)
    description: str = Field(default="", max_length=500)
    revision: int | None = Field(default=None, ge=0)
    edited: bool = False


class TitleApplyRequest(ApiModel):
    items: list[TitleApplyItem] = Field(min_length=1, max_length=MAX_ITEMS)


class TitleApplyResult(ApiModel):
    kind: Kind
    asset_id: str | None = None
    project_id: str | None = None
    title: str
    reason: str | None = None


class TitleApplyResponse(ApiModel):
    applied: list[TitleApplyResult]
    conflicts: list[TitleApplyResult]


class _Target:
    def __init__(self, kind: Kind, asset: Asset, excerpt: str, source_title: str, channel: str, language: str, revision: int | None):
        self.kind, self.asset, self.excerpt = kind, asset, excerpt
        self.source_title, self.channel, self.language, self.revision = source_title, channel, language, revision


class _Conflict(Exception):
    pass


_suggest_lock = asyncio.Lock()


class TitleBackfill:
    def __init__(self, db: Database, profiles: ProfileService, save_job):
        self.db, self.profiles, self._save_job = db, profiles, save_job

    # ---- suggest -------------------------------------------------------
    async def suggest(self, request: TitleSuggestionRequest) -> TitleSuggestionResponse:
        if _suggest_lock.locked():
            raise RuntimeError("Title suggestions are already being written; wait for them to finish")
        async with _suggest_lock:
            return await self._suggest(request)

    def _job_clip(self, asset: Asset) -> tuple[Job | None, Clip | None, dict[str, Any]]:
        job = self.db.get_job(asset.source_job_id or "")
        clip = next((item for item in job.clips if item.id == asset.source_clip_id), None) if job else None
        return job, clip, (self.db.get_job_private(job.id) if job else {})

    async def _suggest(self, request: TitleSuggestionRequest) -> TitleSuggestionResponse:
        explicit = bool(request.asset_ids)
        all_assets = self.db.list_assets(include_archived=True)
        if explicit:
            wanted = list(dict.fromkeys(request.asset_ids or []))
            by_id = {asset.id: asset for asset in all_assets}
            assets = [by_id[asset_id] for asset_id in wanted if asset_id in by_id]
        else:
            assets = [asset for asset in all_assets if asset.origin in {"generated-clip", "project-source"}]
        targets: list[_Target] = []
        skipped: list[TitleSkip] = []
        suggestions: list[TitleSuggestion] = []
        projects: dict[str, Project] = {project.id: project for project in self.db.list_projects()}
        involved_projects: set[str] = set()

        for asset in assets:
            if asset.source_project_id:
                involved_projects.add(asset.source_project_id)
            if asset.origin == "generated-clip":
                job, clip, private = self._job_clip(asset)
                if not job or not clip:
                    skipped.append(TitleSkip(asset_id=asset.id, title=asset.title, reason="The linked clip is unavailable"))
                    continue
                ok, reason = clip_title_replaceable(asset, clip, allow_ai=explicit)
                if not ok:
                    if explicit or reason != "Already has an AI title":
                        skipped.append(TitleSkip(asset_id=asset.id, title=asset.title, reason=reason or "Not eligible"))
                    continue
                excerpt = " ".join((clip.transcript_excerpt or "").split())[:1600]
                if len(excerpt) < 20:
                    skipped.append(TitleSkip(asset_id=asset.id, title=asset.title, reason="No saved transcript to write from (Fast clips have none)"))
                    continue
                project = projects.get(job.project_id)
                targets.append(_Target("clip", asset, excerpt, source_context_title(project, private), _channel(project, private), _language(private), clip.youtube_metadata_revision))
            elif asset.origin == "project-source":
                project = projects.get(asset.source_project_id or "")
                if asset.title_source == "user":
                    if explicit:
                        skipped.append(TitleSkip(asset_id=asset.id, title=asset.title, reason="Title was edited by hand"))
                    continue
                if project and project.source_kind == "youtube":
                    if explicit:
                        skipped.append(TitleSkip(asset_id=asset.id, title=asset.title, reason="Already uses the YouTube video title"))
                    continue
                if not generic_stem(asset.title):
                    if explicit:
                        skipped.append(TitleSkip(asset_id=asset.id, title=asset.title, reason="Already has a descriptive title"))
                    continue
                job = self.db.get_job(project.latest_job_id) if project and project.latest_job_id else None
                private = self.db.get_job_private(job.id) if job else {}
                words = (private.get("transcript") or {}).get("words") if isinstance(private.get("transcript"), dict) else None
                excerpt = " ".join(str(word.get("text", "")).strip() for word in (words or []) if isinstance(word, dict))
                excerpt = " ".join(excerpt.split())[:1600]
                if len(excerpt) < 20:
                    skipped.append(TitleSkip(asset_id=asset.id, title=asset.title, reason="No saved transcript to write from"))
                    continue
                targets.append(_Target("source", asset, excerpt, "", _channel(project, private), _language(private), None))
            elif explicit:
                skipped.append(TitleSkip(asset_id=asset.id, title=asset.title, reason="Only generated clips and imported sources are retitled"))

        # Placeholder project names are fixed by rule, without AI.
        for project in projects.values():
            if explicit and project.id not in involved_projects:
                continue
            if project.source_kind != "youtube" or not is_placeholder_name(project.name):
                continue
            if project.source_title and not is_placeholder_name(project.source_title):
                suggestions.append(TitleSuggestion(kind="project", project_id=project.id, current_title=project.name, suggested_title=" ".join(project.source_title.split())[:160]))
            else:
                skipped.append(TitleSkip(project_id=project.id, title=project.name, reason="The YouTube video title is not known yet"))

        if len(targets) > MAX_ITEMS:
            for target in targets[MAX_ITEMS:]:
                skipped.append(TitleSkip(asset_id=target.asset.id, title=target.asset.title, reason=f"Over the {MAX_ITEMS}-item limit for one run; run again"))
            targets = targets[:MAX_ITEMS]

        response = TitleSuggestionResponse(suggestions=suggestions, skipped=skipped, ai_available=self.profiles.smart_available())
        # Pydantic copies list fields; keep appending to the response's own lists.
        suggestions, skipped = response.suggestions, response.skipped
        if not targets:
            return response
        profile = next((item for item in self.db.list_profiles() if item.selected), None)
        if not response.ai_available or not profile:
            for target in targets:
                skipped.append(TitleSkip(asset_id=target.asset.id, title=target.asset.title, reason="Connect an OpenRouter profile in Settings to write AI titles"))
            return response
        model_id = profile.youtube_metadata_model_id
        response.model = model_id
        try:
            models = await self.profiles.openrouter_models()
            model = next((item for item in models if item.id == model_id), None)
            if not model or not model.pricing:
                raise ProviderError("unavailable", "The selected title model is unavailable or has unknown pricing.")
            input_rate = float(model.pricing["prompt"]) * 1_000_000
            output_rate = float(model.pricing["completion"]) * 1_000_000
            if not math.isfinite(input_rate) or not math.isfinite(output_rate) or input_rate > PRICE_CEILING[0] or output_rate > PRICE_CEILING[1]:
                raise ProviderError("unavailable", "The selected title model exceeds the $0.10/$0.40 per-million-token price ceiling.")
            if "response_format" not in model.supported_parameters:
                raise ProviderError("unavailable", "The selected title model does not support structured JSON output.")
        except Exception as exc:
            response.warning = _safe(exc)
            for target in targets:
                skipped.append(TitleSkip(asset_id=target.asset.id, title=target.asset.title, reason="AI titles are unavailable right now"))
            return response

        target_ids = {target.asset.id for target in targets}
        avoid = sorted({asset.title for asset in all_assets if asset.id not in target_ids and asset.title})[:200]
        used = {title.casefold() for title in avoid}
        all_actual = True
        for offset in range(0, len(targets), BATCH_SIZE):
            batch = targets[offset:offset + BATCH_SIZE]
            if response.requests >= MAX_REQUESTS:
                for target in batch:
                    skipped.append(TitleSkip(asset_id=target.asset.id, title=target.asset.title, reason=f"Over the {MAX_REQUESTS}-request limit for one run; run again"))
                continue
            items = [{"clip_id": target.asset.id, "source_title": target.source_title, "channel_name": target.channel, "transcript_language": target.language, "transcript": target.excerpt} for target in batch]
            user = json.dumps({"output_format": "short", "avoid_titles": avoid, "clips": items}, ensure_ascii=False)
            max_tokens = 120 + 180 * len(batch)
            schema = {"type": "object", "additionalProperties": False, "required": ["clips"], "properties": {"clips": {
                "type": "array", "minItems": 1, "maxItems": len(batch), "items": {
                    "type": "object", "additionalProperties": False, "required": ["clip_id", "title", "description"],
                    "properties": {"clip_id": {"type": "string", "enum": [target.asset.id for target in batch]}, "title": {"type": "string", "minLength": 1, "maxLength": 100}, "description": {"type": "string", "maxLength": 500}},
                }}}}
            response.requests += 1
            try:
                result = await self.profiles.openrouter_json(
                    [{"role": "system", "content": SEO_TITLE_RULES}, {"role": "user", "content": user}], schema,
                    require_saved_profile=True, model_id=model_id, temperature=0.4, max_tokens=max_tokens,
                    provider={"require_parameters": True, "max_price": {"prompt": PRICE_CEILING[0], "completion": PRICE_CEILING[1]}},
                    reasoning={"enabled": False}, include_usage=True,
                )
                if not result or not isinstance(result, tuple):
                    raise ProviderError("not_configured", "Connect and test the selected OpenRouter profile first.")
                payload, usage = result
                returned = payload.get("clips") if isinstance(payload, dict) else None
                if not isinstance(returned, list):
                    raise ValueError("OpenRouter returned malformed structured output")
            except Exception as exc:  # provider/network/validation: keep what we have
                response.warning = _safe(exc)
                for target in targets[offset:]:
                    skipped.append(TitleSkip(asset_id=target.asset.id, title=target.asset.title, reason="AI request failed; try again"))
                break
            cost = usage.get("cost") if isinstance(usage, dict) else None
            if not isinstance(cost, (int, float)) or cost < 0:
                all_actual = False
                prompt_tokens = usage.get("prompt_tokens") if isinstance(usage, dict) and isinstance(usage.get("prompt_tokens"), int) else (len(SEO_TITLE_RULES) + len(user)) // 4
                completion_tokens = usage.get("completion_tokens") if isinstance(usage, dict) and isinstance(usage.get("completion_tokens"), int) else max_tokens
                cost = (prompt_tokens * input_rate + completion_tokens * output_rate) / 1_000_000
            response.cost_usd += float(cost)
            by_id = {item.get("clip_id"): item for item in returned if isinstance(item, dict)}
            for target in batch:
                item = by_id.get(target.asset.id)
                title = normalize_seo_title(item.get("title")) if item else None
                if not title or title.casefold() in used or title == target.asset.title:
                    skipped.append(TitleSkip(asset_id=target.asset.id, title=target.asset.title, reason="No usable, unique title came back; try again"))
                    continue
                used.add(title.casefold())
                suggestions.append(TitleSuggestion(
                    kind=target.kind, asset_id=target.asset.id, project_id=target.asset.source_project_id,
                    current_title=target.asset.title, suggested_title=title,
                    suggested_description=normalize_seo_description(item.get("description")) if item else "",
                    revision=target.revision,
                ))
        response.cost_kind = "actual" if all_actual and response.requests else "estimated"
        response.cost_usd = round(response.cost_usd, 6)
        return response

    # ---- apply ---------------------------------------------------------
    def apply(self, request: TitleApplyRequest) -> TitleApplyResponse:
        applied: list[TitleApplyResult] = []
        conflicts: list[TitleApplyResult] = []
        for item in request.items:
            result = TitleApplyResult(kind=item.kind, asset_id=item.asset_id, project_id=item.project_id, title=item.title)
            try:
                self._apply_one(item)
            except _Conflict as conflict:
                conflicts.append(result.model_copy(update={"reason": str(conflict)}))
                continue
            applied.append(result)
        return TitleApplyResponse(applied=applied, conflicts=conflicts)

    def _apply_one(self, item: TitleApplyItem) -> None:
        source: Literal["ai", "user"] = "user" if item.edited else "ai"
        if item.kind == "project":
            project = self.db.get_project(item.project_id or "")
            if not project:
                raise _Conflict("Project no longer exists")
            if project.name != item.current_title:
                raise _Conflict("Project name changed since the suggestion")
            title = " ".join(item.title.split())[:160]
            if not title:
                raise _Conflict("Title is blank")
            project.name, project.name_is_auto, project.updated_at = title, False, now_iso()
            self.db.save_project(project)
            return
        asset = self.db.get_asset(item.asset_id or "")
        if not asset:
            raise _Conflict("Library item no longer exists")
        if asset.title != item.current_title:
            raise _Conflict("Title changed since the suggestion")
        try:
            clean = YouTubeMetadataUpdate(revision=item.revision or 0, title=item.title, description=item.description)
        except ValueError as exc:
            raise _Conflict(_first_error(exc)) from None
        if item.kind == "clip":
            if asset.origin != "generated-clip":
                raise _Conflict("Not a generated clip")
            job, clip, _ = self._job_clip(asset)
            if not job or not clip:
                raise _Conflict("The linked clip is unavailable")
            if item.revision is None or clip.youtube_metadata_revision != item.revision:
                raise _Conflict("Title changed since the suggestion")
            try:
                _, saved_job, _ = self.db.update_generated_clip_metadata(asset.id, clean.title, clean.description, item.revision, title_source=source)
            except (ValueError, KeyError) as exc:
                raise _Conflict(str(exc)) from None
            self._save_job(saved_job, self.db.get_job_private(saved_job.id))
            return
        if asset.origin != "project-source":
            raise _Conflict("Only generated clips and imported sources are retitled")
        update: dict[str, Any] = {"title": clean.title, "title_source": source}
        if clean.description:
            update["description"] = clean.description
        self.db.save_asset(asset.model_copy(update=update))


def _channel(project: Project | None, private: dict[str, Any]) -> str:
    return str((project.source_creator if project else None) or private.get("youtube_creator") or "")[:120]


def _language(private: dict[str, Any]) -> str:
    transcript = private.get("transcript")
    language = transcript.get("language") if isinstance(transcript, dict) else None
    return str(language or private.get("transcription_language") or "the transcript language")[:40]


def _safe(exc: Exception) -> str:
    return " ".join(redact(provider_runtime_message(exc, "OpenRouter")).split())[:300] or "OpenRouter request failed"


def _first_error(exc: Exception) -> str:
    errors = getattr(exc, "errors", None)
    if callable(errors):
        try:
            return str(errors()[0].get("msg", "Invalid title"))[:200]
        except (IndexError, AttributeError, TypeError):
            pass
    return "Invalid title"
