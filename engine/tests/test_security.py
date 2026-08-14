from __future__ import annotations

import json

import pytest

from engine.app import settings
from engine.media import synthesize_local
from engine.security import MediaSigner, SecretVault, confined, mask_secret, safe_filename, validate_youtube_url


def test_paths_and_filenames_are_confined(tmp_path) -> None:
    assert safe_filename("../../my clip?.mp4") == "my-clip-.mp4"
    with pytest.raises(ValueError):
        confined(tmp_path, "..", "outside.txt")


def test_url_import_rejects_unsupported_protocol_and_host() -> None:
    with pytest.raises(ValueError, match="public HTTPS YouTube"):
        validate_youtube_url("http://youtube.com/watch?v=one")
    with pytest.raises(ValueError, match="public HTTPS YouTube"):
        validate_youtube_url("https://127.0.0.1/video")


def test_local_tts_terminates_options_before_user_script(tmp_path, monkeypatch) -> None:
    captured: list[str] = []

    def fake_run(command, **_):
        captured.extend(command)
        output = command[command.index("-w") + 1]
        from pathlib import Path
        Path(output).write_bytes(b"0" * 1200)

    monkeypatch.setattr("engine.media.run", fake_run)
    synthesize_local("-f/app/data/secrets/instance.key", tmp_path / "voice.wav", settings)
    assert captured[-2] == "--"
    assert captured[-1] == "-f/app/data/secrets/instance.key"


def test_secrets_encrypt_mask_and_signed_links_expire(tmp_path, monkeypatch) -> None:
    vault = SecretVault(tmp_path / "instance.key")
    secret = b'{"openrouterKey":"sk-or-v1-example-secret"}'
    encrypted = vault.encrypt(secret)
    assert secret not in encrypted
    assert vault.decrypt(encrypted) == secret
    assert mask_secret("sk-or-v1-example-secret") == "••••cret"

    signer = MediaSigner(tmp_path / "signing.key", 60)
    expires, signature = signer.sign("jobs/one/clips/a.mp4")
    assert signer.verify("jobs/one/clips/a.mp4", expires, signature)
    assert not signer.verify("jobs/two/clips/a.mp4", expires, signature)
