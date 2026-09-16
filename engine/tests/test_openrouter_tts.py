from __future__ import annotations

from pathlib import Path

import pytest

from engine.openrouter_tts import OpenRouterTTSError, OpenRouterTTS


class Response:
    def __init__(self, status_code: int, content_type: str = "audio/mpeg", chunks: list[bytes] | None = None, **headers: str):
        self.status_code = status_code
        self.headers = {"content-type": content_type, **headers}
        self.chunks = chunks or []
    def __enter__(self): return self
    def __exit__(self, *_): return None
    def iter_bytes(self): return iter(self.chunks)


def test_constructs_openrouter_speech_request_and_publishes_atomically(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    calls: list[dict[str, object]] = []
    response = Response(200, chunks=[b"ID3" + b"fake-mp3" * 40], **{"x-request-id": "request-redacted", "x-generation-id": "generation-redacted", "x-openrouter-cost": "0"})
    class Client:
        def __init__(self, **_: object): pass
        def __enter__(self): return self
        def __exit__(self, *_): return None
        def stream(self, method: str, url: str, **kwargs: object): calls.append({"method": method, "url": url, **kwargs}); return response
    monkeypatch.setattr("engine.openrouter_tts.httpx.Client", Client)
    output = tmp_path / "narration.mp3"
    result = OpenRouterTTS().synthesize("Short narration", output, key="fixture-key", model="free/speech", voice="alloy", speed=1.1)
    assert result.reused is False and result.request_id == "request-redacted" and result.cost == "0"
    assert output.read_bytes().startswith(b"ID3")
    assert not (tmp_path / "narration.mp3.partial").exists()
    assert calls[0]["method"] == "POST" and calls[0]["url"].endswith("/api/v1/audio/speech")
    assert calls[0]["headers"] == {"Authorization": "Bearer fixture-key", "Accept": "audio/mpeg", "Content-Type": "application/json"}
    assert calls[0]["json"] == {"model": "free/speech", "input": "Short narration", "voice": "alloy", "response_format": "mp3", "speed": 1.1}


def test_rejects_non_audio_and_empty_responses_without_partial_files(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    class Client:
        def __init__(self, **_: object): pass
        def __enter__(self): return self
        def __exit__(self, *_): return None
        def stream(self, *_: object, **__: object): return Response(200, content_type="application/json", chunks=[b'{"error":"no"}'])
    monkeypatch.setattr("engine.openrouter_tts.httpx.Client", Client)
    output = tmp_path / "audio.mp3"
    with pytest.raises(OpenRouterTTSError, match="non-audio"):
        OpenRouterTTS().synthesize("test", output, key="fixture", model="speech", voice="alloy")
    assert not output.exists() and not (tmp_path / "audio.mp3.partial").exists()


def test_retries_transient_failures_and_supports_cancellation(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    responses = [Response(503), Response(200, chunks=[b"ID3" + b"audio" * 50])]
    calls = 0
    class Client:
        def __init__(self, **_: object): pass
        def __enter__(self): return self
        def __exit__(self, *_): return None
        def stream(self, *_: object, **__: object):
            nonlocal calls
            response = responses[calls]; calls += 1
            return response
    monkeypatch.setattr("engine.openrouter_tts.httpx.Client", Client)
    output = tmp_path / "retry.mp3"
    result = OpenRouterTTS().synthesize("test", output, key="fixture", model="speech", voice="alloy")
    assert calls == 2 and output.exists() and not result.reused

    cancelled = tmp_path / "cancelled.mp3"
    with pytest.raises(OpenRouterTTSError, match="cancelled"):
        OpenRouterTTS().synthesize("test", cancelled, key="fixture", model="speech", voice="alloy", cancelled=lambda: True)
    assert not cancelled.exists() and not (tmp_path / "cancelled.mp3.partial").exists()


def test_reuses_existing_audio_without_request(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    called = False
    class Client:
        def __init__(self, **_: object): pass
        def __enter__(self): return self
        def __exit__(self, *_): return None
        def stream(self, *_: object, **__: object):
            nonlocal called
            called = True
            raise AssertionError("existing audio should be reused")
    monkeypatch.setattr("engine.openrouter_tts.httpx.Client", Client)
    output = tmp_path / "existing.mp3"; output.write_bytes(b"valid fixture audio")
    result = OpenRouterTTS().synthesize("test", output, key="fixture", model="speech", voice="alloy")
    assert result.reused and not called
