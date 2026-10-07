from __future__ import annotations

import json
from pathlib import Path

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


def test_supplied_youtube_urls_are_canonicalized(monkeypatch) -> None:
    monkeypatch.setattr("engine.security.socket.getaddrinfo", lambda *_args, **_kwargs: [(None, None, None, None, ("142.250.70.206", 443))])
    fixture_path = Path(__file__).parents[2] / "tests" / "fixtures" / "youtube-live-sources.json"
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))

    for source in fixture["sources"]:
        assert validate_youtube_url(source["url"]) == f"https://www.youtube.com/watch?v={source['videoId']}"


@pytest.mark.parametrize("url", [
    "https://youtu.be/8xEuFQz4E4A?t=10",
    "https://www.youtube.com/shorts/8xEuFQz4E4A?feature=share",
    "https://m.youtube.com/watch?v=8xEuFQz4E4A&list=untrusted",
])
def test_supported_youtube_shapes_share_one_canonical_url(url, monkeypatch) -> None:
    monkeypatch.setattr("engine.security.socket.getaddrinfo", lambda *_args, **_kwargs: [(None, None, None, None, ("142.250.70.206", 443))])
    assert validate_youtube_url(url) == "https://www.youtube.com/watch?v=8xEuFQz4E4A"


@pytest.mark.parametrize("url", [
    "https://www.youtube.com/redirect?q=https://example.com/video.mp4",
    "https://www.youtube.com/watch",
    "https://www.youtube.com/watch?v=too-short",
    "https://www.youtube.com/watch?v=8xEuFQz4E4A&v=KNVr5pHAygI",
    "https://youtu.be/8xEuFQz4E4A/extra",
])
def test_youtube_urls_reject_redirects_and_ambiguous_video_ids(url, monkeypatch) -> None:
    monkeypatch.setattr("engine.security.socket.getaddrinfo", lambda *_args, **_kwargs: [(None, None, None, None, ("142.250.70.206", 443))])
    with pytest.raises(ValueError, match="YouTube video URL"):
        validate_youtube_url(url)


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


def test_signed_link_rejects_expiry_tampering_and_scope_changes(tmp_path, monkeypatch) -> None:
    now = 2_000_000_000
    monkeypatch.setattr("engine.security.time.time", lambda: now)
    signer = MediaSigner(tmp_path / "signing.key", 30)
    expires, signature = signer.sign("library-thumbnail:asset-a:blob-a:v1")

    assert signer.verify("library-thumbnail:asset-a:blob-a:v1", expires, signature)
    assert not signer.verify("library-thumbnail:asset-b:blob-a:v1", expires, signature)
    assert not signer.verify("library-thumbnail:asset-a:blob-b:v1", expires, signature)
    assert not signer.verify("library-thumbnail:asset-a:blob-a:v1", expires, signature[:-1] + ("A" if signature[-1] != "A" else "B"))
    assert not signer.verify("library-thumbnail:asset-a:blob-a:v1", now - 1, signature)
    assert not signer.verify("library-thumbnail:asset-a:blob-a:v1", now + 10_000, signature)


def test_confined_rejects_symlink_escape(tmp_path) -> None:
    root = tmp_path / "data"
    root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (root / "thumbnails").symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError, match="escapes"):
        confined(root, "thumbnails", "victim.jpg")


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
