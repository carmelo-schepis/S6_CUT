from __future__ import annotations

from datetime import date

from engine.database import Database
from engine.library import LibraryRules, visual_concept
from engine.models import Asset


def asset(asset_id: str, title: str, policy: str, triggers: list[str], *, negative: list[str] | None = None, active_until: str | None = None) -> Asset:
    return Asset(id=asset_id, title=title, media_type="image/png", filename="asset.png", tags=[], triggers=triggers, negative_triggers=negative or [], policy=policy, active_until=active_until, licence="User supplied", content_hash=asset_id * 8)


def test_required_prefer_never_and_negative_rules_are_explainable(tmp_path) -> None:
    db = Database(tmp_path / "db.sqlite3")
    db.save_asset(asset("a", "Beatles poster", "prefer", ["The Beatles"]))
    db.save_asset(asset("b", "Blocked image", "never", ["Beatles"]))
    db.save_asset(asset("c", "Required campaign", "required", ["campaign"], negative=["competitor"]))
    rules = LibraryRules(db, tmp_path / "library")

    result = rules.explain("The Beatles changed popular music")
    assert result.selected and result.selected.id == "a"
    assert "The Beatles" in result.matched_triggers
    assert any(item["assetId"] == "b" and "Never" in item["reason"] for item in result.rejected)

    blocked = rules.explain("Our campaign compares a competitor")
    assert blocked.selected is None
    assert any(item["assetId"] == "c" and "Negative" in item["reason"] for item in blocked.rejected)


def test_expired_required_asset_is_excluded_before_ranking(tmp_path) -> None:
    db = Database(tmp_path / "db.sqlite3")
    db.save_asset(asset("d", "Old campaign", "required", ["launch"], active_until="2024-01-01"))
    result = LibraryRules(db, tmp_path / "library").explain("launch", on_date=date(2026, 8, 13))
    assert result.selected is None
    assert result.rejected[0]["reason"] == "Active date range has ended"


def test_visual_concept_skips_pronoun_contractions_for_named_entities() -> None:
    assert visual_concept("It's the natural progression, you know, GW, CIA.") == "CIA"
    assert visual_concept("The Beatles changed popular music.") == "The Beatles"
