"""The Hugging Face caches must live under the mounted data path.

Regression cover for an import that died with an opaque
``I/O error: Permission denied (os error 13)``: the Whisper download root was
already ``data/models``, but the Hub client and its Xet backend also wrote a
chunk cache and logs under ``HF_HOME``, which defaults to
``$HOME/.cache/huggingface``. Running the engine under a UID that is not the
image's own user leaves ``HOME=/``, so that default is unwritable and every
model download fails. Nothing may reintroduce a dependency on ``$HOME``.
"""
from __future__ import annotations

import dataclasses
import os
import tempfile
from pathlib import Path

import pytest

from engine.config import Settings


@pytest.fixture()
def isolated(monkeypatch: pytest.MonkeyPatch) -> Settings:
    for name in ("HF_HOME", "HF_XET_CACHE"):
        monkeypatch.delenv(name, raising=False)
    # An unwritable home is exactly the deployment shape that used to fail.
    monkeypatch.setenv("HOME", "/")
    root = Path(tempfile.mkdtemp(prefix="s6-cut-model-cache-"))
    return dataclasses.replace(Settings.from_env(), data_path=root)


def test_prepare_model_cache_pins_hugging_face_to_the_data_path(isolated: Settings) -> None:
    isolated.prepare_model_cache()
    models = isolated.data_path / "models"
    assert models.is_dir()
    assert os.environ["HF_HOME"] == str(models)
    assert os.environ["HF_XET_CACHE"] == str(models / "xet")
    # Never the container user's home, whatever HOME happens to be.
    assert not os.environ["HF_HOME"].startswith("/.cache")


def test_prepare_creates_the_cache_and_pins_it(isolated: Settings) -> None:
    isolated.prepare()
    assert os.environ["HF_HOME"] == str(isolated.data_path / "models")


def test_operator_supplied_cache_locations_win(isolated: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HF_HOME", "/mnt/models/hf")
    monkeypatch.setenv("HF_XET_CACHE", "/mnt/models/hf-xet")
    isolated.prepare_model_cache()
    assert os.environ["HF_HOME"] == "/mnt/models/hf"
    assert os.environ["HF_XET_CACHE"] == "/mnt/models/hf-xet"


def test_transcribe_pins_the_cache_before_importing_whisper() -> None:
    """The worker is a fresh process, so the pin has to happen inside transcribe.

    The Hub client resolves its cache locations at import time; pinning them
    only in ``prepare()`` would leave any caller that imports Faster-Whisper
    first writing to ``$HOME`` again.
    """
    import inspect

    from engine import media

    source = inspect.getsource(media.transcribe)
    pin = source.index("settings.prepare_model_cache()")
    whisper_import = source.index("from faster_whisper import WhisperModel")
    assert pin < whisper_import
