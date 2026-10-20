from __future__ import annotations

import mimetypes
import os
import re
import shutil
import uuid
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from .database import Database, UNSORTED_FOLDER_ID
from .models import Asset, AssetOrigin, MatchExplanation


TOKEN_RE = re.compile(r"[\w'-]+", re.UNICODE)


def normalize(value: str) -> str:
    return " ".join(TOKEN_RE.findall(value.casefold()))


@dataclass(frozen=True)
class ResolvedVisual:
    label: str
    source: str
    confidence: float
    match_reason: str
    asset: Asset | None = None
    asset_path: Path | None = None


# DO-NOT-CHANGE: see DO-NOT-CHANGE/AGENTS.md
# deterministic matching (explain/resolve) and content-addressed blob store are contracts
class LibraryRules:
    def __init__(self, db: Database, library_root: Path):
        self.db = db
        self.library_root = library_root

    @property
    def data_root(self) -> Path:
        return self.library_root.parent

    # DO-NOT-CHANGE: content-addressed store — path is blobs/sha256/<prefix>/<digest><suffix>,
    # atomic temp+os.replace, hard-link preferred; blobs are immutable once published
    def _publish_blob(self, path: Path, digest: str) -> tuple[Path, str]:
        """Create one content-addressed durable blob, preferring a zero-copy hard link."""
        suffix = path.suffix.casefold() if path.suffix else ".bin"
        target = self.data_root / "blobs" / "sha256" / digest[:2] / f"{digest}{suffix}"
        relative = target.relative_to(self.data_root).as_posix()
        if target.is_file():
            return target, relative
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.partial")
        try:
            try:
                os.link(path, temporary)
            except OSError:
                with path.open("rb") as source, temporary.open("xb") as destination:
                    shutil.copyfileobj(source, destination, 1024 * 1024)
                    destination.flush()
                    os.fsync(destination.fileno())
            if target.exists():
                temporary.unlink(missing_ok=True)
            else:
                os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)
        return target, relative

    def register_file(
        self, path: Path, *, title: str, media_type: str, origin: AssetOrigin,
        folder_id: str, project_id: str | None = None, job_id: str | None = None,
        clip_id: str | None = None, metadata: dict[str, object] | None = None,
        content_hash: str | None = None, filename: str | None = None,
        tags: list[str] | None = None, triggers: list[str] | None = None,
        policy: str = "neutral", licence: str = "User supplied",
    ) -> Asset:
        from .media import sha256_file

        if not path.is_file() or ".partial" in path.name:
            raise ValueError("Only published media files can be registered")
        digest = content_hash or sha256_file(path)
        blob, relative = self._publish_blob(path, digest)
        values = metadata or {}
        asset = Asset(
            id=str(uuid.uuid4()), title=title[:200], media_type=media_type,
            filename=filename or path.name, content_hash=digest, blob_id=digest,
            origin=origin, folder_id=folder_id, source_project_id=project_id,
            source_job_id=job_id, source_clip_id=clip_id,
            duration_seconds=float(values["duration"]) if values.get("duration") is not None else None,
            width=int(values["width"]) if values.get("width") is not None else None,
            height=int(values["height"]) if values.get("height") is not None else None,
            tags=tags or [], triggers=triggers or [], policy=policy,
            licence=licence,
        )
        return self.db.register_blob_asset(asset, relative, blob.stat().st_size)

    def register_managed_video(
        self, path: Path, *, title: str, origin: AssetOrigin, project_id: str,
        job_id: str, metadata: dict[str, object], clip_id: str | None = None,
        folder_id: str = UNSORTED_FOLDER_ID, content_hash: str | None = None,
    ) -> Asset:
        """Register a validated video and its durable project/job/clip references."""
        return self.register_file(
            path, title=title, media_type=mimetypes.guess_type(path.name)[0] or "video/mp4",
            origin=origin, folder_id=folder_id, project_id=project_id, job_id=job_id,
            clip_id=clip_id, metadata=metadata, content_hash=content_hash,
            filename=path.name, policy="neutral", licence="Created or supplied by user",
        )

    # DO-NOT-CHANGE: deterministic scoring — exact×45, tags×12, title+20, policy
    # required+35/prefer+18; never/negative/date reject first; tie-break (-score, id)
    def explain(
        self, text: str, *, on_date: date | None = None, video_overlay: bool = False,
        exclude_project_id: str | None = None, exclude_job_id: str | None = None,
        exclude_blob_id: str | None = None,
    ) -> MatchExplanation:
        on_date = on_date or date.today()
        query = normalize(text)
        ranked: list[tuple[float, Asset, list[str], str]] = []
        rejected: list[dict[str, str]] = []
        for asset in self.db.list_assets():
            if video_overlay and (asset.origin != "manual-import" or not asset.video_overlay_eligible):
                rejected.append({"assetId": asset.id, "title": asset.title, "reason": "Automatic video overlays require explicit eligibility on a manually imported asset"})
                continue
            if video_overlay and exclude_project_id and asset.source_project_id == exclude_project_id:
                rejected.append({"assetId": asset.id, "title": asset.title, "reason": "Current project assets cannot be used as its own overlay"})
                continue
            if video_overlay and exclude_job_id and asset.source_job_id == exclude_job_id:
                rejected.append({"assetId": asset.id, "title": asset.title, "reason": "Current job assets cannot be used as its own overlay"})
                continue
            if video_overlay and exclude_blob_id and asset.blob_id == exclude_blob_id:
                rejected.append({"assetId": asset.id, "title": asset.title, "reason": "The source video cannot be reused as its own overlay"})
                continue
            if not asset.media_type.casefold().startswith(("image/", "video/")):
                rejected.append({"assetId": asset.id, "title": asset.title, "reason": "This asset has no visual media for an overlay"})
                continue
            if asset.policy == "never":
                rejected.append({"assetId": asset.id, "title": asset.title, "reason": "Never policy excludes it before ranking"})
                continue
            if asset.active_from and on_date < date.fromisoformat(asset.active_from):
                rejected.append({"assetId": asset.id, "title": asset.title, "reason": "Not active yet"})
                continue
            if asset.active_until and on_date > date.fromisoformat(asset.active_until):
                rejected.append({"assetId": asset.id, "title": asset.title, "reason": "Active date range has ended"})
                continue
            negatives = [item for item in asset.negative_triggers if normalize(item) in query]
            if negatives:
                rejected.append({"assetId": asset.id, "title": asset.title, "reason": f"Negative trigger matched: {negatives[0]}"})
                continue
            phrases = [*asset.triggers, *asset.aliases]
            exact = [phrase for phrase in phrases if normalize(phrase) and normalize(phrase) in query]
            tag_hits = [tag for tag in asset.tags if normalize(tag) in query.split()]
            title_hit = normalize(asset.title) in query and bool(normalize(asset.title))
            score = len(exact) * 45 + len(tag_hits) * 12 + (20 if title_hit else 0)
            if score > 0:
                score += {"required": 35, "prefer": 18, "neutral": 0}.get(asset.policy, 0)
            if asset.policy == "required" and not exact and not tag_hits and not title_hit:
                score = 34  # Required may reserve placement, but a content match remains stronger.
            if score <= 0:
                rejected.append({"assetId": asset.id, "title": asset.title, "reason": "No trigger, tag, alias, or title matched"})
                continue
            hits = [*exact, *tag_hits]
            if hits:
                match = f"matched {', '.join(hits)}"
            elif title_hit:
                match = f"matched title {asset.title!r}"
            else:
                match = "reserved placement under required policy"
            reason = f"{asset.policy.title()} policy; {match}"
            ranked.append((min(score, 100), asset, hits, reason))
        ranked.sort(key=lambda item: (-item[0], item[1].id))
        if not ranked:
            return MatchExplanation(query=text, selected=None, matched_triggers=[], score=0, reason="No eligible personal asset matched. Continue to enabled licensed sources, then a relevant text card.", rejected=rejected)
        score, asset, hits, reason = ranked[0]
        for _, alternative, _, _ in ranked[1:]:
            rejected.append({"assetId": alternative.id, "title": alternative.title, "reason": "Eligible, but ranked below the selected asset"})
        return MatchExplanation(query=text, selected=asset, matched_triggers=hits, score=score, reason=reason, rejected=rejected)

    def resolve(self, text: str) -> ResolvedVisual:
        explanation = self.explain(text)
        if explanation.selected:
            asset = explanation.selected
            relative = self.db.blob_relative_path(asset.blob_id)
            path = self.data_root / relative if relative else self.library_root / asset.id / asset.filename
            return ResolvedVisual(asset.title, "library", explanation.score / 100, explanation.reason, asset, path if path.exists() else None)
        concept = visual_concept(text)
        return ResolvedVisual(concept, "text-card", 0.55, "No eligible personal asset matched; used a relevant text description")

    def resolve_video_overlay(
        self, text: str, *, exclude_project_id: str | None = None,
        exclude_job_id: str | None = None, exclude_blob_id: str | None = None,
    ) -> ResolvedVisual:
        """Resolve only explicitly opted-in manual assets for video composition."""
        explanation = self.explain(
            text, video_overlay=True, exclude_project_id=exclude_project_id,
            exclude_job_id=exclude_job_id, exclude_blob_id=exclude_blob_id,
        )
        if not explanation.selected:
            return ResolvedVisual(visual_concept(text), "text-card", 0.0, explanation.reason)
        asset = explanation.selected
        relative = self.db.blob_relative_path(asset.blob_id)
        path = self.data_root / relative if relative else self.library_root / asset.id / asset.filename
        return ResolvedVisual(asset.title, "library", explanation.score / 100, explanation.reason, asset, path if path.is_file() else None)


def visual_concept(text: str) -> str:
    acronyms = re.findall(r"\b[A-Z]{3,}\b", text)
    if acronyms:
        return acronyms[0][:70]
    named = re.findall(r"\b(?:[A-Z][\w'’-]+)(?:\s+[A-Z][\w'’-]+){0,3}", text.strip())
    ignored = {"i", "i'm", "i’ve", "it's", "the", "this", "that", "here", "what", "when", "why", "how"}
    if named:
        candidate = next((item.strip(" .,!?\n") for item in named if item.strip(" .,!?\n").casefold() not in ignored), "")
        if candidate:
            return candidate[:70]
    tokens = [token for token in TOKEN_RE.findall(text) if len(token) > 4 and token.casefold() not in {"about", "there", "their", "would", "could", "which", "because"}]
    return " ".join(tokens[:4]).title()[:70] or "Key idea"
