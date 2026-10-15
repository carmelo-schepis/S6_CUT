from __future__ import annotations

import math

import pytest
from pydantic import ValidationError

from engine.models import ShortsJobInput
from engine.media import MediaError, _append_text_overlays, _shorts_grade_filter


@pytest.mark.parametrize("aspect", ["9:16", "16:9", "1:1", "4:5"])
def test_shorts_json_request_accepts_blank_end_and_camel_case_fields(aspect: str) -> None:
    value = ShortsJobInput.model_validate({"assetId": "asset-1", "start": 0, "aspectRatio": aspect})
    assert value.asset_id == "asset-1"
    assert value.end is None
    assert value.aspect_ratio == aspect
    assert value.model_dump(by_alias=True)["aspectRatio"] == aspect


@pytest.mark.parametrize("payload", [
    {"assetId": "asset-1", "start": 2, "end": 2},
    {"assetId": "asset-1", "start": 3, "end": 2},
    {"assetId": "asset-1", "start": 0, "aspectRatio": "3:2"},
    {"assetId": "asset-1", "start": 0, "unexpected": True},
])
def test_shorts_json_request_rejects_invalid_bounds_and_contract_fields(payload) -> None:
    with pytest.raises(ValidationError):
        ShortsJobInput.model_validate(payload)


@pytest.mark.parametrize("payload", [
    {"assetId": "asset-1", "start": -1},
    {"assetId": "asset-1", "start": math.nan},
    {"assetId": "asset-1", "start": 4, "end": 4},
    {"assetId": "asset-1", "start": 4, "end": math.inf},
    {"assetId": "", "start": 0},
])
def test_shorts_json_request_rejects_invalid_trim_values(payload) -> None:
    with pytest.raises(ValidationError):
        ShortsJobInput.model_validate(payload)


@pytest.mark.parametrize("preset", ["none", "warm", "cool", "black_white", "tint"])
def test_shorts_render_look_settings_validate(preset: str) -> None:
    value = ShortsJobInput.model_validate({
        "assetId": "asset-1", "start": 0, "filterPreset": preset,
        "filterIntensity": 0.65, "tintColor": "#a1B2c3", "tintOpacity": 42,
    })
    assert value.filter_preset == preset
    assert value.filter_intensity == 0.65
    assert value.tint_color == "#a1B2c3"
    assert value.tint_opacity == 42


@pytest.mark.parametrize("payload", [
    {"filterPreset": "sepia"},
    {"filterIntensity": -0.01},
    {"filterIntensity": 1.01},
    {"tintColor": "red"},
    {"tintOpacity": 101},
    {"textOverlays": [{"id": "x", "text": "bad", "x": 1.01}]},
    {"textOverlays": [{"id": "x", "text": "bad", "duration": 0}]},
])
def test_shorts_render_settings_reject_out_of_contract_values(payload) -> None:
    with pytest.raises(ValidationError):
        ShortsJobInput.model_validate({"assetId": "asset-1", "start": 0, **payload})


@pytest.mark.parametrize(("preset", "expected"), [
    ("warm", "colorbalance=rs=0.025:gs=0.007:bs=-0.015"),
    ("cool", "colorbalance=rs=-0.015:gs=0.005:bs=0.025"),
    ("black_white", "hue=s=0.500"),
    ("tint", "colorbalance=rm=0.1073:gm=0.0132:bm=-0.0533:pl=1"),
])
def test_shorts_look_filters_apply_selected_intensity(preset: str, expected: str) -> None:
    assert _shorts_grade_filter(preset, 0.5, "#d58a55", 20) == expected


def test_text_overlay_ass_escaping_position_timing_and_bounds(tmp_path) -> None:
    ass = tmp_path / "overlays.ass"
    ass.write_text("[Events]\n", encoding="utf-8")
    _append_text_overlays(ass, [{
        "text": "{hello} \\\\ world\nsecond line", "start": 0.5, "duration": 2,
        "x": 0.25, "y": 0.75, "size": 48, "color": "#12aBcD",
    }], duration=3, width=1080, height=1920)
    content = ass.read_text(encoding="utf-8")
    assert "Dialogue: 30,0:00:00.50,0:00:02.50,Caption" in content
    assert r"{\an5\pos(270,1440)\fs48\1c&HcDaB12&\bord2\shad1}" in content
    assert r"\{hello\}" in content
    assert r"\\ world\Nsecond line" in content


def test_text_overlay_ass_rejects_times_outside_trimmed_output(tmp_path) -> None:
    ass = tmp_path / "overlays.ass"
    ass.write_text("[Events]\n", encoding="utf-8")
    with pytest.raises(MediaError, match="fit inside the trimmed output"):
        _append_text_overlays(ass, [{"text": "Too late", "start": 2.5, "duration": 1}], duration=3, width=1080, height=1920)
