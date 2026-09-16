from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import httpx


class OpenRouterTTSError(RuntimeError):
    def __init__(self, category: str, message: str):
        super().__init__(message)
        self.category = category
        self.safe_message = message


@dataclass(frozen=True)
class TTSResult:
    model: str
    voice: str
    request_id: str | None = None
    generation_id: str | None = None
    usage: str | None = None
    cost: str | None = None
    reused: bool = False


class OpenRouterTTS:
    """Dedicated OpenRouter speech client; text generation stays in providers.py."""

    endpoint = "https://openrouter.ai/api/v1/audio/speech"
    transient_statuses = {408, 429, 500, 502, 503, 504}
    max_audio_bytes = 50 * 1024 * 1024

    @staticmethod
    def _failure(status_code: int) -> tuple[str, str]:
        if status_code in {401, 403}:
            return "invalid_credentials", "OpenRouter rejected the saved credentials"
        if status_code == 402:
            return "insufficient_balance", "OpenRouter requires available balance for this speech request"
        if status_code in {400, 404, 422}:
            return "unsupported_model_or_voice", "The selected OpenRouter speech model or voice is unavailable"
        if status_code == 429:
            return "rate_limited", "OpenRouter is rate limited; try again later"
        if status_code in {408, 500, 502, 503, 504}:
            return "provider_service_failure", "OpenRouter speech service is temporarily unavailable"
        return "provider_service_failure", "OpenRouter returned an unexpected speech response"

    @staticmethod
    def _is_audio(content_type: str) -> bool:
        value = content_type.casefold().split(";", 1)[0].strip()
        return value.startswith("audio/") or value == "application/octet-stream"

    def synthesize(
        self,
        text: str,
        output: Path,
        *,
        key: str,
        model: str,
        voice: str,
        speed: float = 1.0,
        cancelled: Callable[[], bool] | None = None,
        validate: Callable[[Path], None] | None = None,
    ) -> TTSResult:
        if output.is_file() and output.stat().st_size > 0:
            if validate:
                validate(output)
            return TTSResult(model=model, voice=voice, reused=True)
        temporary = output.with_name(f"{output.name}.partial")
        temporary.unlink(missing_ok=True)
        output.parent.mkdir(parents=True, exist_ok=True)
        try:
            for attempt in range(2):
                if cancelled and cancelled():
                    raise OpenRouterTTSError("cancelled", "OpenRouter speech generation was cancelled")
                try:
                    with httpx.Client(timeout=httpx.Timeout(90.0, connect=15.0), follow_redirects=False) as client:
                        with client.stream(
                            "POST",
                            self.endpoint,
                            headers={"Authorization": f"Bearer {key}", "Accept": "audio/mpeg", "Content-Type": "application/json"},
                            json={"model": model, "input": text, "voice": voice, "response_format": "mp3", "speed": speed},
                        ) as response:
                            if response.status_code >= 400:
                                category, message = self._failure(response.status_code)
                                if response.status_code in self.transient_statuses and attempt == 0:
                                    time.sleep(0.25)
                                    continue
                                raise OpenRouterTTSError(category, message)
                            if not self._is_audio(response.headers.get("content-type", "")):
                                raise OpenRouterTTSError("malformed_response", "OpenRouter returned a non-audio speech response")
                            byte_count = 0
                            with temporary.open("wb") as stream:
                                for chunk in response.iter_bytes():
                                    if cancelled and cancelled():
                                        raise OpenRouterTTSError("cancelled", "OpenRouter speech generation was cancelled")
                                    if chunk:
                                        byte_count += len(chunk)
                                        if byte_count > self.max_audio_bytes:
                                            raise OpenRouterTTSError("malformed_response", "OpenRouter returned speech audio that is too large")
                                        stream.write(chunk)
                            if byte_count == 0:
                                raise OpenRouterTTSError("malformed_response", "OpenRouter returned empty speech audio")
                            osize = temporary.stat().st_size
                            if osize < 128:
                                raise OpenRouterTTSError("malformed_response", "OpenRouter returned unusable speech audio")
                            if validate:
                                validate(temporary)
                            temporary.replace(output)
                            return TTSResult(
                                model=model, voice=voice,
                                request_id=response.headers.get("x-request-id"),
                                generation_id=response.headers.get("x-generation-id"),
                                usage=response.headers.get("x-openrouter-usage"),
                                cost=response.headers.get("x-openrouter-cost"),
                            )
                except OpenRouterTTSError:
                    raise
                except (httpx.TimeoutException, httpx.RequestError) as exc:
                    if attempt == 0:
                        time.sleep(0.25)
                        continue
                    raise OpenRouterTTSError("timeout_offline", "OpenRouter speech generation timed out or could not be reached") from exc
            raise OpenRouterTTSError("provider_service_failure", "OpenRouter speech service is temporarily unavailable")
        finally:
            temporary.unlink(missing_ok=True)
