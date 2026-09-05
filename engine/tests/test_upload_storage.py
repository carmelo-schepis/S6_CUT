from __future__ import annotations

import asyncio
import errno
from io import BytesIO
from pathlib import Path

import pytest
from fastapi import HTTPException, UploadFile, status

from engine.app import _stream_upload


def test_stream_upload_reports_insufficient_storage(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    def no_space(*_: object, **__: object) -> None:
        raise OSError(errno.ENOSPC, "No space left on device")

    monkeypatch.setattr(Path, "mkdir", no_space)
    upload = UploadFile(file=BytesIO(b"video"), filename="source.mp4")

    with pytest.raises(HTTPException) as raised:
        asyncio.run(_stream_upload(upload, tmp_path / "job" / "source.mp4", 1024))

    assert raised.value.status_code == status.HTTP_507_INSUFFICIENT_STORAGE
    assert raised.value.detail == "Not enough free storage to upload this video. Free space and try again."
