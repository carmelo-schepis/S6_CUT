from __future__ import annotations

import json
import os
import uuid
from typing import Any

import httpx

from .database import Database
from .models import OpenRouterModel, ProfileInput, ProviderProfile, now_iso
from .security import SecretVault, mask_secret


class ProviderError(RuntimeError):
    def __init__(self, category: str, message: str):
        super().__init__(message)
        self.category = category
        self.safe_message = message


MASKED_SECRET_MARKER = "••••"
LEGACY_SECRET_KEY = "elevenlabsKey"

FALLBACKS = {
    "planning": "Deterministic sentence and phrase planner",
    "captions": "Canonical timed transcript",
    "media": "Personal Library, licensed/no-key source, then relevant text card",
}

_TEST_FAILURE_MESSAGES = {
    "timeout": ("timeout_offline", "OpenRouter could not be reached"),
    "offline": ("timeout_offline", "OpenRouter could not be reached"),
    "401": ("invalid_credentials", "OpenRouter rejected the saved credentials"),
    "403": ("invalid_credentials", "OpenRouter rejected the saved credentials"),
    "408": ("timeout_offline", "OpenRouter could not be reached"),
    "429": ("rate_limited", "OpenRouter rate limit reached. Wait and retry."),
    "404": ("unavailable_model", "The selected OpenRouter model is unavailable. Choose another model in Settings."),
    "422": ("unavailable_model", "The selected OpenRouter model is unavailable. Choose another model in Settings."),
    "500": ("timeout_offline", "OpenRouter is temporarily unavailable"),
    "502": ("timeout_offline", "OpenRouter is temporarily unavailable"),
    "503": ("timeout_offline", "OpenRouter is temporarily unavailable"),
    "504": ("timeout_offline", "OpenRouter is temporarily unavailable"),
    "malformed": ("malformed_response", "OpenRouter returned a plan that could not be validated."),
}


def test_openrouter_failure() -> tuple[str, str] | None:
    """Return the explicit isolated-E2E provider failure, never in production."""
    if os.getenv("S6_TEST_MODE", "").strip() != "1":
        return None
    failure = os.getenv("S6_TEST_OPENROUTER_FAILURE", "").strip().casefold()
    return _TEST_FAILURE_MESSAGES.get(failure)


def provider_runtime_message(error: Exception, service: str) -> str:
    if isinstance(error, ProviderError):
        return error.safe_message
    if isinstance(error, httpx.HTTPStatusError):
        status_code = error.response.status_code
        if status_code in {401, 403}:
            return f"{service} credentials were rejected"
        if status_code == 429:
            return f"{service} is rate limited"
        if status_code in {404, 422}:
            return f"The configured {service} model or voice is unavailable"
        return f"{service} is temporarily unavailable"
    if isinstance(error, (httpx.TimeoutException, httpx.RequestError)):
        return f"{service} is offline or timed out"
    return f"{service} returned an unreadable response"


class ProfileService:
    def __init__(self, db: Database, vault: SecretVault):
        self.db = db
        self.vault = vault
        self._migrate_legacy_secrets()

    @staticmethod
    def _decode(raw: bytes | None) -> dict[str, str]:
        if not raw:
            return {}
        try:
            value = json.loads(raw)
            return {str(key): str(item) for key, item in value.items() if item}
        except (json.JSONDecodeError, UnicodeDecodeError, TypeError, AttributeError):
            return {}

    @staticmethod
    def _credential(value: str | None, previous: str = "") -> str:
        """Normalize a newly entered secret without accepting a masked value."""
        if not ProfileService._has_new_credential(value):
            return previous.strip()
        return value.strip()

    @staticmethod
    def _has_new_credential(value: str | None) -> bool:
        return bool(value and value.strip() and MASKED_SECRET_MARKER not in value.strip())

    def _read_secret(self, profile_id: str, profile_persistence: str, encrypted: bytes | None) -> dict[str, str]:
        raw = self.vault.get_session(profile_id) if profile_persistence == "session" else self.vault.decrypt(encrypted)
        secrets = self._decode(raw)
        if LEGACY_SECRET_KEY in secrets:
            # An old installation may still contain the retired provider key. Drop
            # it on first read and re-encrypt only the supported OpenRouter secret.
            secrets.pop(LEGACY_SECRET_KEY, None)
            cleaned = json.dumps(secrets, separators=(",", ":")).encode()
            if profile_persistence == "session":
                self.vault.set_session(profile_id, cleaned)
            else:
                self.db.replace_profile_secret(profile_id, self.vault.encrypt(cleaned))
        return secrets

    def _migrate_legacy_secrets(self) -> None:
        for profile in self.db.list_profiles():
            record = self.db.get_profile(profile.id)
            if record:
                self._read_secret(profile.id, profile.persistence, record[1])

    def secrets(self, profile_id: str) -> dict[str, str]:
        record = self.db.get_profile(profile_id)
        if not record:
            return {}
        profile, encrypted = record
        return self._read_secret(profile_id, profile.persistence, encrypted)

    def selected_secrets(self, *, include_environment: bool = True) -> tuple[ProviderProfile | None, dict[str, str]]:
        profile = next((item for item in self.db.list_profiles() if item.selected), None)
        secrets = self.secrets(profile.id) if profile else {}
        if include_environment:
            secrets.setdefault("openrouterKey", os.getenv("OPENROUTER_API_KEY", ""))
        return profile, {key: value for key, value in secrets.items() if value}

    def smart_available(self) -> bool:
        """True only when the selected OpenRouter profile is configured and connected."""
        for profile in self.db.list_profiles():
            if not profile.selected or not profile.openrouter_configured or profile.text_status != "connected":
                continue
            if self.secrets(profile.id).get("openrouterKey"):
                return True
        return False

    def save(self, value: ProfileInput, profile_id: str | None = None) -> ProviderProfile:
        profile_id = profile_id or str(uuid.uuid4())
        existing = self.db.get_profile(profile_id)
        previous = self.secrets(profile_id) if existing else {}
        key = self._credential(value.openrouter_key, previous.get("openrouterKey", ""))
        previous_profile = existing[0] if existing else None
        text_unchanged = bool(previous_profile and not self._has_new_credential(value.openrouter_key) and value.text_model_id == previous_profile.text_model_id)
        profile = ProviderProfile(
            id=profile_id, name=value.name, text_model_id=value.text_model_id, selected=value.selected, persistence=value.persistence,
            openrouter_configured=bool(key), openrouter_masked=mask_secret(key),
            text_status=previous_profile.text_status if text_unchanged else ("configured" if key else "not_configured"),
            text_message=previous_profile.text_message if text_unchanged else ("Ready to test" if key else "Optional; deterministic local planning remains available"),
            text_last_checked_at=previous_profile.text_last_checked_at if text_unchanged else None,
            status="configured" if key else "local only",
            capabilities=["OpenRouter text generation"] if key else [],
            fallbacks=FALLBACKS,
        )
        raw = json.dumps({"openrouterKey": key}, separators=(",", ":")).encode()
        if value.persistence == "session":
            self.vault.set_session(profile_id, raw)
            self.db.save_profile(profile, b"")
        else:
            self.vault.delete_session(profile_id)
            self.db.save_profile(profile, self.vault.encrypt(raw))
        return profile

    def duplicate(self, profile_id: str) -> ProviderProfile:
        record = self.db.get_profile(profile_id)
        if not record:
            raise KeyError(profile_id)
        profile, _ = record
        secrets = self.secrets(profile_id)
        return self.save(ProfileInput(
            name=f"{profile.name} copy", text_model_id=profile.text_model_id, openrouter_key=secrets.get("openrouterKey"),
            persistence=profile.persistence, selected=False,
        ))

    @staticmethod
    def _http_failure(status_code: int, service: str) -> tuple[str, str]:
        if status_code in {401, 403}:
            return "invalid_credentials", f"{service} rejected the saved credentials"
        if status_code == 402:
            return "insufficient_balance", f"{service} requires available balance for this request"
        if status_code == 429:
            return "rate_limited", f"{service} is rate limited; try again later"
        if status_code in {404, 422}:
            return "unavailable", f"The configured {service} model is unavailable"
        if status_code in {408, 500, 502, 503, 504}:
            return "provider_service_failure", f"{service} is temporarily unavailable"
        return "provider_service_failure", f"{service} returned an unexpected response"

    @staticmethod
    def _model_from_entry(entry: object) -> OpenRouterModel | None:
        if not isinstance(entry, dict):
            return None
        model_id = entry.get("id")
        if not isinstance(model_id, str) or not model_id.strip():
            return None
        name = entry.get("name")
        context = entry.get("context_length")
        architecture = entry.get("architecture") if isinstance(entry.get("architecture"), dict) else {}
        raw_modalities = architecture.get("output_modalities", entry.get("output_modalities", []))
        modalities = [item.strip() for item in raw_modalities if isinstance(item, str) and item.strip()] if isinstance(raw_modalities, list) else []
        pricing = entry.get("pricing") if isinstance(entry.get("pricing"), dict) else {}
        prices = [pricing.get(name) for name in ("prompt", "completion", "input", "output") if pricing.get(name) is not None]
        free = model_id.endswith(":free") or bool(prices) and all(str(price) in {"0", "0.0", "0.00"} for price in prices)
        return OpenRouterModel(
            id=model_id, name=name.strip() if isinstance(name, str) and name.strip() else model_id,
            context_length=context if isinstance(context, int) and not isinstance(context, bool) and context > 0 else None,
            output_modalities=modalities, free=free,
        )

    async def openrouter_models(self, output_modalities: str | None = None) -> list[OpenRouterModel]:
        profile, secrets = self.selected_secrets(include_environment=False)
        if not profile or not profile.openrouter_configured or profile.text_status != "connected":
            raise ProviderError("not_configured", "OpenRouter is not configured. Test the selected profile in Settings.")
        key = secrets.get("openrouterKey")
        if not key:
            raise ProviderError("not_configured", "OpenRouter is not configured. Test the selected profile in Settings.")
        params = {"output_modalities": output_modalities} if output_modalities else None
        try:
            async with httpx.AsyncClient(timeout=12, follow_redirects=False) as client:
                response = await client.get("https://openrouter.ai/api/v1/models", params=params, headers={"Authorization": f"Bearer {key}"})
        except (httpx.TimeoutException, httpx.RequestError) as exc:
            raise ProviderError("timeout_offline", "OpenRouter is offline or timed out. Try again later.") from exc
        if response.status_code >= 400:
            category, message = self._http_failure(response.status_code, "OpenRouter")
            raise ProviderError(category, message)
        try:
            payload = response.json()
            entries = payload.get("data") if isinstance(payload, dict) else None
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            raise ProviderError("malformed_response", "OpenRouter returned an unreadable model list.") from exc
        if not isinstance(entries, list):
            raise ProviderError("malformed_response", "OpenRouter returned an unreadable model list.")
        models = {model.id: model for entry in entries if (model := self._model_from_entry(entry)) is not None}
        if output_modalities and any(model.output_modalities for model in models.values()):
            models = {key: model for key, model in models.items() if output_modalities in model.output_modalities}
        return [models[model_id] for model_id in sorted(models)]

    async def test(self, profile_id: str) -> ProviderProfile:
        record = self.db.get_profile(profile_id)
        if not record:
            raise KeyError(profile_id)
        profile, _ = record
        secrets = self.secrets(profile_id)
        key = secrets.get("openrouterKey")
        profile.text_status = "not_configured" if not key else "configured"
        profile.text_message = "Optional; deterministic local planning remains available" if not key else "Ready to test"
        profile.text_last_checked_at = None
        if key:
            async with httpx.AsyncClient(timeout=12, follow_redirects=False) as client:
                try:
                    profile.text_status = "connected"
                    self.db.save_profile(profile)
                    models = await self.openrouter_models()
                    profile.text_last_checked_at = now_iso()
                    if not any(item.id == profile.text_model_id for item in models):
                        profile.text_status, profile.text_message = "unavailable", "The configured OpenRouter text model is unavailable"
                    else:
                        response = await client.post(
                            "https://openrouter.ai/api/v1/chat/completions",
                            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                            json={"model": profile.text_model_id, "messages": [{"role": "user", "content": "Return exactly the JSON object {\"ok\":true}."}], "temperature": 0, "response_format": {"type": "json_object"}},
                        )
                        if response.status_code >= 400:
                            profile.text_status, profile.text_message = self._http_failure(response.status_code, "OpenRouter")
                        else:
                            try:
                                valid = json.loads(response.json()["choices"][0]["message"]["content"]).get("ok") is True
                            except (KeyError, IndexError, TypeError, ValueError, json.JSONDecodeError):
                                valid = False
                            profile.text_status, profile.text_message = ("connected", "Connected; text generation succeeded") if valid else ("malformed_response", "OpenRouter returned an unreadable text-generation response")
                except ProviderError as exc:
                    profile.text_status, profile.text_message = exc.category, exc.safe_message
                except (httpx.TimeoutException, httpx.RequestError):
                    profile.text_status, profile.text_message = "timeout_offline", "OpenRouter is offline or timed out; local planning remains available"
        profile.status = "connected" if profile.text_status == "connected" else ("configured" if key else "local only")
        profile.capabilities = ["OpenRouter text generation"] if profile.text_status == "connected" else []
        self.db.save_profile(profile)
        return profile

    async def openrouter_json(self, messages: list[dict[str, str]], schema: dict[str, Any], *, require_saved_profile: bool = False, model_id: str | None = None) -> dict[str, Any] | None:
        profile, secrets = self.selected_secrets(include_environment=not require_saved_profile)
        if require_saved_profile and (not profile or profile.text_status != "connected"):
            return None
        key = secrets.get("openrouterKey")
        if not key or not profile:
            return None
        if failure := test_openrouter_failure():
            category, message = failure
            raise ProviderError(category, message)
        if model_id:
            models = await self.openrouter_models()
            if not any(model.id == model_id for model in models):
                raise ProviderError("unavailable", "The selected OpenRouter text model is no longer available. Choose another model in Settings.")
        payload = {"model": model_id or profile.text_model_id, "messages": messages, "temperature": 0, "response_format": {"type": "json_schema", "json_schema": {"name": "s6_result", "strict": True, "schema": schema}}}
        async with httpx.AsyncClient(timeout=45, follow_redirects=False) as client:
            for attempt in range(2):
                try:
                    response = await client.post("https://openrouter.ai/api/v1/chat/completions", headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"}, json=payload)
                except (httpx.TimeoutException, httpx.RequestError) as exc:
                    if attempt == 0:
                        continue
                    raise ProviderError("timeout_offline", "OpenRouter could not be reached") from exc
                if response.status_code in {401, 403}:
                    raise ProviderError("invalid_credentials", "OpenRouter rejected the saved credentials. Test the profile in Settings.")
                if response.status_code == 429:
                    raise ProviderError("rate_limited", "OpenRouter rate limit reached. Wait and retry.")
                if response.status_code in {404, 422}:
                    raise ProviderError("unavailable", "The selected OpenRouter text model is unavailable. Choose another model in Settings.")
                if response.status_code in {408, 500, 502, 503, 504}:
                    if attempt == 0:
                        continue
                    raise ProviderError("timeout_offline", "OpenRouter is temporarily unavailable. Try again later.")
                if response.status_code >= 400:
                    raise ProviderError("provider_service_failure", "OpenRouter request was rejected")
                try:
                    content = response.json()["choices"][0]["message"]["content"]
                    result = json.loads(content)
                except (KeyError, IndexError, TypeError, ValueError, json.JSONDecodeError) as exc:
                    raise ProviderError("malformed_response", "OpenRouter returned a plan that could not be validated.") from exc
                if not isinstance(result, dict):
                    raise ProviderError("malformed_response", "OpenRouter returned a plan that could not be validated.")
                return result
        raise ProviderError("timeout_offline", "OpenRouter could not be reached")

    def delete(self, profile_id: str) -> None:
        self.vault.delete_session(profile_id)
        self.db.delete_profile(profile_id)
