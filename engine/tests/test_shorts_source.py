from __future__ import annotations

import math

import pytest
from pydantic import ValidationError

from engine.models import ShortsJobInput


def test_shorts_json_request_accepts_blank_end_and_camel_case_fields() -> None:
    value = ShortsJobInput.model_validate({"assetId": "asset-1", "start": 0, "aspectRatio": "4:5"})
    assert value.asset_id == "asset-1"
    assert value.end is None
    assert value.aspect_ratio == "4:5"


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
