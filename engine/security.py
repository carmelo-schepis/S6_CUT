from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import os
import re
import socket
import time
import unicodedata
from pathlib import Path
from urllib.parse import urlparse

from cryptography.fernet import Fernet, InvalidToken


SAFE_FILENAME = re.compile(r"[^A-Za-z0-9._-]+")
ARCHIVE_INVALID = re.compile(r'[<>:"/\\|?*\x00-\x1f\x7f]')
YOUTUBE_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "music.youtube.com"}


# DO-NOT-CHANGE: see DO-NOT-CHANGE/AGENTS.md — HMAC payload format, key files, and
# confinement are security invariants; changing them breaks every existing signed URL


def safe_filename(name: str, fallback: str = "media") -> str:
    leaf = Path(name.replace("\\", "/")).name.strip(" .")
    cleaned = SAFE_FILENAME.sub("-", leaf)[:180].strip("-.")
    if not cleaned or cleaned.upper().split(".")[0] in {"CON", "PRN", "AUX", "NUL", "COM1", "LPT1"}:
        return fallback
    return cleaned


def safe_archive_title(name: str | None, fallback: str = "s6-cut-videos"):
    """Return a readable, cross-platform title safe for a ZIP name and root."""
    normalized = unicodedata.normalize("NFKC", name or "")
    normalized = ARCHIVE_INVALID.sub("-", normalized.replace("..", "-"))
    normalized = re.sub(r"\s+", " ", normalized).strip(" .")[:160].strip(" .")
    if not normalized or not any(character.isalnum() for character in normalized) or normalized.casefold() in {".", ".."}:
        return fallback
    if normalized.split(".", 1)[0].casefold() in {"con", "prn", "aux", "nul", "com1", "lpt1"}:
        return fallback
    return normalized


# DO-NOT-CHANGE: path traversal guard — every file-serving endpoint must use this
# and it must never be loosened
def confined(root: Path, *parts: str) -> Path:
    target = root.joinpath(*parts).resolve()
    if target != root.resolve() and root.resolve() not in target.parents:
        raise ValueError("Path escapes the configured data directory")
    return target


def validate_youtube_url(value: str) -> str:
    parsed = urlparse(value.strip())
    host = (parsed.hostname or "").lower().rstrip(".")
    if parsed.scheme != "https" or host not in YOUTUBE_HOSTS:
        raise ValueError("Only public HTTPS YouTube URLs are supported")
    if parsed.username or parsed.password or parsed.port not in (None, 443):
        raise ValueError("Credentials and custom ports are not allowed")
    try:
        for info in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM):
            address = ipaddress.ip_address(info[4][0])
            if address.is_private or address.is_loopback or address.is_link_local or address.is_reserved:
                raise ValueError("The URL resolved to a non-public address")
    except socket.gaierror as exc:
        raise ValueError("The YouTube host could not be resolved") from exc
    return value.strip()


class SecretVault:
    def __init__(self, key_path: Path):
        self.key_path = key_path
        self._session: dict[str, bytes] = {}
        self._fernet = Fernet(self._load_or_create_key())

    def _load_or_create_key(self) -> bytes:
        self.key_path.parent.mkdir(parents=True, exist_ok=True)
        if self.key_path.exists():
            key = self.key_path.read_bytes().strip()
            Fernet(key)
            return key
        key = Fernet.generate_key()
        temp = self.key_path.with_suffix(".tmp")
        temp.write_bytes(key)
        try:
            os.chmod(temp, 0o600)
        except OSError:
            pass
        os.replace(temp, self.key_path)
        return key

    def encrypt(self, value: bytes) -> bytes:
        return self._fernet.encrypt(value)

    def decrypt(self, value: bytes | None) -> bytes:
        if not value:
            return b""
        try:
            return self._fernet.decrypt(value)
        except InvalidToken as exc:
            raise ValueError("Saved provider secrets could not be decrypted") from exc

    def set_session(self, profile_id: str, value: bytes) -> None:
        self._session[profile_id] = value

    def get_session(self, profile_id: str) -> bytes | None:
        return self._session.get(profile_id)

    def delete_session(self, profile_id: str) -> None:
        self._session.pop(profile_id, None)


class MediaSigner:
    def __init__(self, key_path: Path, ttl_seconds: int):
        self.key_path = key_path
        self.ttl_seconds = ttl_seconds
        self.key = self._load_or_create()

    def _load_or_create(self) -> bytes:
        self.key_path.parent.mkdir(parents=True, exist_ok=True)
        if self.key_path.exists():
            key = self.key_path.read_bytes()
            if len(key) >= 32:
                return key
        key = os.urandom(48)
        temp = self.key_path.with_suffix(".tmp")
        temp.write_bytes(key)
        try:
            os.chmod(temp, 0o600)
        except OSError:
            pass
        os.replace(temp, self.key_path)
        return key

    # DO-NOT-CHANGE: signature payload is f"{relative}\n{expires}" — never change
    # the format, hash, or key handling or all existing signed links break
    def sign(self, relative_path: str) -> tuple[int, str]:
        expires = int(time.time()) + self.ttl_seconds
        payload = f"{relative_path}\n{expires}".encode()
        signature = base64.urlsafe_b64encode(hmac.new(self.key, payload, hashlib.sha256).digest()).decode().rstrip("=")
        return expires, signature

    def verify(self, relative_path: str, expires: int, signature: str) -> bool:
        if expires < int(time.time()) or expires > int(time.time()) + self.ttl_seconds + 60:
            return False
        expected_exp, expected = expires, self._signature(relative_path, expires)
        return expected_exp == expires and hmac.compare_digest(expected, signature)

    def _signature(self, relative_path: str, expires: int) -> str:
        payload = f"{relative_path}\n{expires}".encode()
        return base64.urlsafe_b64encode(hmac.new(self.key, payload, hashlib.sha256).digest()).decode().rstrip("=")


def redact(value: str) -> str:
    value = re.sub(r"(?i)(authorization|api[-_ ]?key|token)\s*[:=]\s*[^\s,;]+", r"\1=[redacted]", value)
    value = re.sub(r"sk-[A-Za-z0-9_-]{12,}", "[redacted-key]", value)
    return value[:1000]


def mask_secret(value: str | None) -> str | None:
    if not value:
        return None
    return f"••••{value[-4:]}"
