"""Bounds tests for ZernioConfigRequest + PublishRequest.scheduled_for.

The Zernio config endpoint and publish schedule accept user-supplied strings
that land in data/config.json and the scheduler. These pin the size/shape
guards: unbounded api_key, oversized/odd accounts maps, and a giant
scheduled_for string are all rejected at the Pydantic boundary; normal
payloads pass.
"""
import pytest
from pydantic import ValidationError

from clippyme.api.schemas import PublishRequest, ZernioConfigRequest


def test_zernio_accepts_normal_config():
    req = ZernioConfigRequest(
        api_key="sk_live_abc123",
        accounts={"tiktok": "acc1", "youtube": "acc2", "instagram": None},
        timezone="Europe/Rome",
    )
    assert req.accounts["tiktok"] == "acc1"


def test_zernio_accepts_empty():
    req = ZernioConfigRequest()
    assert req.api_key is None


def test_zernio_rejects_oversized_api_key():
    with pytest.raises(ValidationError):
        ZernioConfigRequest(api_key="x" * 513)


def test_zernio_rejects_oversized_timezone():
    with pytest.raises(ValidationError):
        ZernioConfigRequest(timezone="z" * 65)


def test_zernio_rejects_too_many_accounts():
    with pytest.raises(ValidationError):
        ZernioConfigRequest(accounts={f"k{i}": "v" for i in range(17)})


def test_zernio_rejects_unknown_platform():
    with pytest.raises(ValidationError):
        ZernioConfigRequest(accounts={"myspace": "a"})


def test_zernio_rejects_oversized_account_id():
    with pytest.raises(ValidationError):
        ZernioConfigRequest(accounts={"tiktok": "a" * 257})


def test_zernio_rejects_nonstring_account_id():
    with pytest.raises(ValidationError):
        ZernioConfigRequest(accounts={"tiktok": {"nested": 1}})


def test_publish_accepts_normal_scheduled_for():
    req = PublishRequest(
        platforms=[{"platform": "tiktok", "accountId": "a"}],
        scheduled_for="2026-04-08T12:00:00",
    )
    assert req.scheduled_for.startswith("2026")


def test_publish_rejects_oversized_scheduled_for():
    with pytest.raises(ValidationError):
        PublishRequest(
            platforms=[{"platform": "tiktok", "accountId": "a"}],
            scheduled_for="9" * 65,
        )
