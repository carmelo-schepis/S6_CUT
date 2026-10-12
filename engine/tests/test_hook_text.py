from engine.hook_text import HOOK_TEXT_MAX_LENGTH, HOOK_TEXT_SCHEMA, hook_text_prompt, hook_text_schema, normalize_hook_text
from engine.media import probe, render_clip, write_ass


def test_hook_prompt_contains_contract_and_clip_context():
    prompt = hook_text_prompt([{
        "index": 1, "style": "Serious", "duration": 24,
        "transcript_excerpt": "The answer was not what I expected.", "title": "A project",
    }])
    for phrase in ("stop the scroll", "pattern interrupt", "open a loop", "60–120", "22 words", "sentence case", "do not reveal", "transcript's language", "No hashtags", "untrusted quoted source data", "Discover", "different words"):
        assert phrase in prompt
    assert '"style": "Serious"' in prompt
    assert HOOK_TEXT_SCHEMA["properties"]["hooks"]["items"]["properties"]["text"]["maxLength"] == 150
    assert hook_text_schema(2)["properties"]["hooks"]["minItems"] == 2
    assert hook_text_schema(2)["properties"]["hooks"]["maxItems"] == 2
    assert HOOK_TEXT_MAX_LENGTH == 150


def test_normalize_hook_nfc_whitespace_controls_and_ass_characters():
    assert normalize_hook_text(' “Cafe\u0301  changes\\ {the}  answer?” ') == "Café changes the answer?"
    assert normalize_hook_text("The truth\x00 changes what we thought.") == "The truth changes what we thought."


def test_normalize_hook_rejects_invalid_lengths_and_urls_or_tags():
    assert normalize_hook_text("short") is None
    assert normalize_hook_text("x" * 151) is None
    assert normalize_hook_text("A" * 20) == "A" * 20
    assert normalize_hook_text("A" * 150) == "A" * 150
    assert normalize_hook_text("This hook includes #hashtag and more") is None
    assert normalize_hook_text("This hook mentions @someone today") is None
    assert normalize_hook_text("Visit https://example.com for context") is None
    assert normalize_hook_text("Visit example.com for context today") is None


def test_normalize_hook_rejects_emoji_and_non_latin_glyphs():
    assert normalize_hook_text("The quiet moment changes everything 🙂") is None
    assert normalize_hook_text("Что меняет этот неожиданный ответ?") is None


def test_hook_ass_style_wrap_layer_and_end_time(tmp_path):
    hook = "What if the answer everyone expects is not the answer that changes everything?"
    path = tmp_path / "hook.ass"
    write_ass(path, [], offset=0, duration=20, visuals=[], width=1080, height=1920,
              hook_text=hook, hook_end_time=15)
    ass = path.read_text(encoding="utf-8")
    assert "Style: Hook,Montserrat,72," in ass
    assert ",8,60,60,211,1" in ass
    assert "Dialogue: 5,0,0:00:15.00,Hook" in ass
    assert "Dialogue: 0,0,0:00:20.00,HookScrim" in ass
    assert "Dialogue: 10," not in ass
    hook_event = next(line for line in ass.splitlines() if ",Hook,," in line)
    body = hook_event.split(",,", 1)[-1]
    assert body.count(r"\N") <= 3
    assert "everyone" in body and "everything?" in body
    assert "Anton" not in ass


def test_hook_provider_timeout_is_warning_only_and_rendering_can_continue(monkeypatch, tmp_path):
    from dataclasses import replace
    from engine.app import settings as app_settings
    from engine.config import Settings
    from engine.database import Database
    from engine.jobs import JobManager
    from engine.library import LibraryRules
    from engine.models import Clip, Job, Project
    from engine.providers import ProfileService, ProviderError
    from engine.security import SecretVault

    runtime: Settings = replace(app_settings, data_path=tmp_path)
    db = Database(tmp_path / "hook-test.sqlite3")
    profiles = ProfileService(db, SecretVault(tmp_path / "secrets" / "key"))
    manager = JobManager(db, LibraryRules(db, tmp_path / "library"), profiles, runtime)
    project = Project(id="p-hook-timeout", name="Hook timeout", mode="clip", style="serious", state="active",
                      source_name="source.mp4", source_kind="youtube", requested_count=1)
    db.save_project(project)
    job = Job(id="j-hook-timeout", project_id=project.id, mode="clip", state="active", stage="planning",
              stage_label="Planning", progress=40, style="serious", processing_mode="smart", content_format="short",
              hook_text_enabled=True, clips=[Clip(id="c-hook-timeout", index=1, state="queued", start=0, end=30,
                                                  duration=30, opening_line="The original opening line.")],
              steps=manager._smart_steps(False, include_hook_text=True))
    private = {"hook_text": {"enabled": True, "status": "pending"}}
    db.save_job(job, private)

    async def fail_generation(*_args, **_kwargs):
        raise ProviderError("timeout_offline", "OpenRouter is offline or timed out")

    monkeypatch.setattr(profiles, "openrouter_json", fail_generation)
    manager._generate_hook_text(job, private, [{"text": "The transcript remains available", "start": 1, "end": 2}])

    assert job.clips[0].hook_text is None
    assert private["hook_text"]["status"] == "failed"
    assert next(step for step in job.steps if step.id == "hook_text").status == "failed"
    assert any("AI hook text unavailable" in warning for warning in job.warnings)
    assert "render" in {step.id for step in job.steps}, "the normal render stage remains queued after hook failure"
    assert not any("offline or timed out" in warning and "API key" in warning for warning in job.warnings)


def test_real_render_shows_hook_then_clears_it_before_subscribe_and_keeps_captions_bottom(tmp_path):
    import shutil
    import subprocess
    import pytest
    from engine.config import Settings

    settings = Settings.from_env()
    if not shutil.which(settings.ffmpeg) or not shutil.which(settings.ffprobe):
        pytest.skip("real hook-frame verification requires FFmpeg and FFprobe")
    source = tmp_path / "hook-source.mp4"
    subprocess.run([
        settings.ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "color=c=0x303030:size=640x360:rate=12:duration=12",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=12",
        "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", str(source),
    ], check=True, capture_output=True)
    words = [{"text": "Captions stay anchored at the bottom", "start": 0.2, "end": 2.0}]
    animation = {"enabled": True, "version": 1, "short_form_lead_seconds": 5}
    common = dict(start=0, end=12, aspect="9:16", words=words, visuals=[], overlays=[], settings=settings,
                  style="serious", centered_partial_fill=True, subscribe_animation=animation)
    with_hook, control = tmp_path / "with-hook.mp4", tmp_path / "without-hook.mp4"
    hook = "The quiet clue changes the ending more than you think."
    render_clip(source, with_hook, **common, hook_text=hook)
    render_clip(source, control, **common)

    def count_bright(path, timestamp, crop, threshold=205):
        frame = subprocess.run([
            settings.ffmpeg, "-hide_banner", "-loglevel", "error", "-ss", str(timestamp), "-i", str(path),
            "-frames:v", "1", "-vf", crop, "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
        ], check=True, capture_output=True).stdout
        return sum(1 for offset in range(0, len(frame), 3)
                   if frame[offset] > threshold and frame[offset + 1] > threshold and frame[offset + 2] > threshold)

    top = "crop=iw:ih/3:0:0,scale=270:320"
    bottom = "crop=iw:ih/4:0:ih*3/4,scale=270:160"
    active_hook = count_bright(with_hook, 1, top)
    active_control = count_bright(control, 1, top)
    assert active_hook > active_control + 20, "hook burn-in should add white text in the reserved top band"
    after_hook = count_bright(with_hook, 8, top)
    after_control = count_bright(control, 8, top)
    assert after_hook <= after_control + 10, "hook must be absent while the ending Subscribe animation is playing"
    assert count_bright(with_hook, 1, bottom, threshold=100) > 20, "caption text should remain visible in the bottom caption band"
    assert probe(with_hook, settings)["duration"] == pytest.approx(12, abs=0.2)
    assert hook not in with_hook.with_suffix(".srt").read_text(encoding="utf-8")


def test_rendered_hook_is_only_in_burn_ass_and_stops_for_subscribe(monkeypatch, tmp_path):
    from types import SimpleNamespace
    import engine.media as media

    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    output = tmp_path / "clip.mp4"
    metadata = {"width": 1080, "height": 1920, "rotation": 0, "sample_aspect_ratio": 1.0, "audio": True, "duration": 20}
    monkeypatch.setattr(media, "probe", lambda *_args, **_kwargs: metadata)
    monkeypatch.setattr(media, "_credit_alignment", lambda *_args, **_kwargs: 3)

    def fake_run(command, **_kwargs):
        from pathlib import Path
        Path(command[-1]).write_bytes(b"rendered")

    monkeypatch.setattr(media, "run", fake_run)
    words = [{"text": "Captions", "start": 0, "end": 1}]
    hook = "The quiet clue changes the ending more than you think."
    render_clip(source, output, start=0, end=20, aspect="9:16", words=words, visuals=[], overlays=[],
                settings=SimpleNamespace(ffmpeg="ffmpeg"), hook_text=hook, creator_credit="Source: Creator",
                subscribe_animation={"enabled": True, "version": 1, "short_form_lead_seconds": 5})
    burn_ass = output.with_name("clip.burn.ass").read_text(encoding="utf-8")
    caption_ass = output.with_suffix(".ass").read_text(encoding="utf-8")
    import re
    hook_event = next(line for line in burn_ass.splitlines() if line.startswith("Dialogue: 5,"))
    hook_body = re.sub(r"\{[^}]*\}", "", hook_event.split(",,0,0,0,,", 1)[1]).replace(r"\N", " ")
    assert " ".join(hook_body.split()) == hook
    assert hook not in caption_ass
    assert hook not in output.with_suffix(".srt").read_text(encoding="utf-8")
    assert "Dialogue: 5,0,0:00:15.00,Hook" in burn_ass
    credit_event = next(line for line in burn_ass.splitlines() if line.startswith("Dialogue: 2,"))
    assert credit_event.startswith("Dialogue: 2,0,0:00:11.00,Credit,")
    assert r"{\fad(0,1000)}" in credit_event
    assert ",Caption," in burn_ass and ",Caption," in caption_ass
    caption_events = [line for line in caption_ass.splitlines() if line.startswith("Dialogue:")]
    assert not any(",Hook," in line or ",Credit," in line for line in caption_events)
    assert hook not in output.with_suffix(".vtt").read_text(encoding="utf-8")
