from __future__ import annotations

import json
import os
import uuid
from pathlib import Path
from typing import Any

import httpx

from .database import Database
from .models import ProfileInput, ProviderProfile
from .security import SecretVault, mask_secret


FALLBACKS = {
    "planning": "Deterministic sentence and phrase planner",
    "captions": "Canonical timed transcript",
    "voice": "Local espeak-ng, then clearly labelled silent render",
    "media": "Personal Library, licensed/no-key source, then relevant text card",
}


class ProfileService:
    def __init__(self, db: Database, vault: SecretVault):
        self.db = db
        self.vault = vault

    @staticmethod
    def _decode(raw: bytes | None) -> dict[str, str]:
        if not raw:
            return {}
        try:
            value = json.loads(raw)
            return {str(key): str(item) for key, item in value.items() if item}
        except (json.JSONDecodeError, UnicodeDecodeError):
            return {}

    def secrets(self, profile_id: str) -> dict[str, str]:
        record = self.db.get_profile(profile_id)
        if not record:
            return {}
        profile, encrypted = record
        if profile.persistence == "session":
            return self._decode(self.vault.get_session(profile_id))
        return self._decode(self.vault.decrypt(encrypted))

    def selected_secrets(self) -> tuple[ProviderProfile | None, dict[str, str]]:
        profile = next((item for item in self.db.list_profiles() if item.selected), None)
        secrets = self.secrets(profile.id) if profile else {}
        secrets.setdefault("openrouterKey", os.getenv("OPENROUTER_API_KEY", ""))
        secrets.setdefault("elevenlabsKey", os.getenv("ELEVENLABS_API_KEY", ""))
        return profile, {key: value for key, value in secrets.items() if value}

    def save(self, value: ProfileInput, profile_id: str | None = None) -> ProviderProfile:
        profile_id = profile_id or str(uuid.uuid4())
        existing = self.db.get_profile(profile_id)
        previous = self.secrets(profile_id) if existing else {}
        secrets = {
            "openrouterKey": value.openrouter_key or previous.get("openrouterKey", ""),
            "elevenlabsKey": value.elevenlabs_key or previous.get("elevenlabsKey", ""),
        }
        profile = ProviderProfile(
            id=profile_id, name=value.name, model_id=value.model_id, voice_id=value.voice_id,
            selected=value.selected, persistence=value.persistence,
            openrouter_configured=bool(secrets["openrouterKey"]), elevenlabs_configured=bool(secrets["elevenlabsKey"]),
            openrouter_masked=mask_secret(secrets["openrouterKey"]), elevenlabs_masked=mask_secret(secrets["elevenlabsKey"]),
            status="configured" if any(secrets.values()) else "local only",
            capabilities=["structured planning"] if secrets["openrouterKey"] else [], fallbacks=FALLBACKS,
        )
        raw = json.dumps(secrets, separators=(",", ":")).encode()
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
            name=f"{profile.name} copy", model_id=profile.model_id, voice_id=profile.voice_id,
            openrouter_key=secrets.get("openrouterKey"), elevenlabs_key=secrets.get("elevenlabsKey"),
            persistence=profile.persistence, selected=False,
        ))

    async def test(self, profile_id: str) -> ProviderProfile:
        record = self.db.get_profile(profile_id)
        if not record:
            raise KeyError(profile_id)
        profile, _ = record
        secrets = self.secrets(profile_id)
        errors: list[str] = []
        async with httpx.AsyncClient(timeout=12, follow_redirects=False) as client:
            if key := secrets.get("openrouterKey"):
                response = await client.get("https://openrouter.ai/api/v1/models", headers={"Authorization": f"Bearer {key}"})
                if response.status_code >= 400:
                    errors.append(f"OpenRouter returned {response.status_code}")
            if key := secrets.get("elevenlabsKey"):
                response = await client.get("https://api.elevenlabs.io/v1/voices", headers={"xi-api-key": key})
                if response.status_code >= 400:
                    errors.append(f"ElevenLabs returned {response.status_code}")
        profile.status = "failed" if errors else ("connected" if secrets else "local only")
        profile.capabilities = [item for item, ready in (("structured planning", bool(secrets.get("openrouterKey"))), ("ElevenLabs narration", bool(secrets.get("elevenlabsKey")))) if ready]
        self.db.save_profile(profile)
        if errors:
            raise RuntimeError("; ".join(errors))
        return profile

    def delete(self, profile_id: str) -> None:
        self.vault.delete_session(profile_id)
        self.db.delete_profile(profile_id)

    def synthesize_elevenlabs(self, text: str, output: Path) -> bool:
        profile, secrets = self.selected_secrets()
        key = secrets.get("elevenlabsKey")
        voice = profile.voice_id if profile else None
        if not key or not voice:
            return False
        response = httpx.post(
            f"https://api.elevenlabs.io/v1/text-to-speech/{voice}",
            headers={"xi-api-key": key, "Accept": "audio/mpeg", "Content-Type": "application/json"},
            json={"text": text, "model_id": "eleven_multilingual_v2"}, timeout=90,
        )
        response.raise_for_status()
        output.write_bytes(response.content)
        return output.stat().st_size > 1000

    async def openrouter_json(self, messages: list[dict[str, str]], schema: dict[str, Any]) -> dict[str, Any] | None:
        profile, secrets = self.selected_secrets()
        key = secrets.get("openrouterKey")
        if not key or not profile:
            return None
        payload = {
            "model": profile.model_id,
            "messages": messages,
            "temperature": 0,
            "response_format": {"type": "json_schema", "json_schema": {"name": "s6_result", "strict": True, "schema": schema}},
        }
        async with httpx.AsyncClient(timeout=45) as client:
            for attempt in range(2):
                response = await client.post("https://openrouter.ai/api/v1/chat/completions", headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"}, json=payload)
                if response.status_code in {408, 429, 500, 502, 503, 504} and attempt == 0:
                    continue
                response.raise_for_status()
                content = response.json()["choices"][0]["message"]["content"]
                try:
                    return json.loads(content)
                except (TypeError, json.JSONDecodeError):
                    return None
        return None
