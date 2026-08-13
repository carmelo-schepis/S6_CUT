from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from .database import Database
from .models import Asset, MatchExplanation


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


class LibraryRules:
    def __init__(self, db: Database, library_root: Path):
        self.db = db
        self.library_root = library_root

    def explain(self, text: str, *, on_date: date | None = None) -> MatchExplanation:
        on_date = on_date or date.today()
        query = normalize(text)
        ranked: list[tuple[float, Asset, list[str], str]] = []
        rejected: list[dict[str, str]] = []
        for asset in self.db.list_assets():
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
            reason = f"{asset.policy.title()} policy; " + (f"matched {', '.join(hits)}" if hits else "reserved eligible placement")
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
            path = self.library_root / asset.id / asset.filename
            return ResolvedVisual(asset.title, "library", explanation.score / 100, explanation.reason, asset, path if path.exists() else None)
        concept = visual_concept(text)
        return ResolvedVisual(concept, "text-card", 0.55, "No eligible local or enabled licensed result; used a relevant text card")


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
