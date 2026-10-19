"""Run in an isolated engine container with cached models and --network none.

Pass a spoken WAV as argv[1]; S6_DATA_PATH must point at disposable verification data.
This exercises real Whisper/FFmpeg, while connected API responses are instrumented stubs.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys

# An existing-container execution can use this process-local network guard.
# Spawned transcription workers import this module and install the same guard.
if os.environ.get("S6_VERIFY_BLOCK_NETWORK") == "1":
    import socket
    def block_outbound(event, args):
        if event == "socket.connect" and args[0].family in {socket.AF_INET, socket.AF_INET6}:
            raise RuntimeError("Outbound networking disabled during local-engine verification")
    sys.addaudithook(block_outbound)

import numpy as np
from fastapi.testclient import TestClient

from engine import app as application
from engine.jobs import centered_partial_fill_eligible
from engine.media import caption_words_for_clip, probe, render_clip
from engine.models import OpenRouterModel
from engine.providers import ProviderError

def main():
    root = application.settings.data_path
    assert "/qa/" in str(root), "Use disposable verification data, never production storage"
    assert not os.environ.get("S6_TEST_TRANSCRIPT_JSON"), "This check must use real speech transcription"
    root.mkdir(parents=True, exist_ok=True)
    source = root.parent / "source.mp4"
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=15,eq=brightness=-0.6",
        "-stream_loop", "-1", "-i", sys.argv[1], "-t", "16",
        "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", str(source),
    ], check=True)
    client = TestClient(application.app)
    async def do_not_enqueue(_):
        return None
    application.manager.enqueue = do_not_enqueue
    results = []
    cases = [
        ("engine_only_connected", "engine_only", True, False),
        ("auto_disconnected", "auto", False, False),
        ("auto_connected", "auto", True, False),
        ("auto_provider_failure", "auto", True, True),
    ]
    first = None
    for name, policy, connected, fail in cases:
        calls = []
        application.profiles.smart_available = lambda: connected
        async def models():
            calls.append("models")
            if fail:
                raise ProviderError("timeout_offline", "Simulated unavailable provider")
            return [OpenRouterModel(
                id="google/gemini-2.5-flash-lite", name="Verification model", context_length=4096,
                pricing={"prompt": "0.0000001", "completion": "0.0000004"},
                supported_parameters=["response_format"],
            )]
        async def provider(messages, schema, **kwargs):
            props = schema.get("properties", {})
            calls.append("indexes" if "indexes" in props else "hooks" if "hooks" in props else "metadata")
            if fail:
                raise ProviderError("timeout_offline", "Simulated unavailable provider")
            if "indexes" in props:
                return {"indexes": [0]}
            if "hooks" in props:
                return {"hooks": [{"index": 1, "text": "This clip contains a locally timed spoken excerpt."}]}
            # The real call serializes input clip IDs in its user prompt.
            context = json.loads(messages[-1]["content"])
            payload = {"clips": [{"clip_id": item["clip_id"], "title": "A spoken excerpt with local word timing",
                                  "description": "A description of the supplied spoken excerpt."}
                                 for item in context["clips"]]}
            return (payload, {"prompt_tokens": 40, "completion_tokens": 40})
        application.profiles.openrouter_models = models
        application.profiles.openrouter_json = provider
        application.creation_times.clear()
        with source.open("rb") as upload:
            response = client.post("/api/v1/jobs/clip", data={
                "name": name, "execution_policy": policy, "processing_mode": "auto",
                "hook_text": "true", "youtube_metadata": "true", "burn_subtitles": "true",
                "count": "1", "min_duration": "8", "max_duration": "12", "aspect_ratio": "9:16",
            }, files={"file": ("spoken-fixture.mp4", upload, "video/mp4")})
        assert response.status_code == 202, response.text
        job_id = response.json()["job"]["id"]
        application.manager._process(job_id)
        job = application.db.get_job(job_id)
        private = application.db.get_job_private(job_id)
        assert job.state == "complete", (name, job.state, job.error, job.warnings)
        assert job.execution_policy == policy
        assert len(job.clips) == 1
        clip = job.clips[0]
        assert clip.state == "complete" and clip.hook_text
        words = private["transcript"]["words"]
        assert len(words) >= 10, (name, "Insufficient real speech transcription")
        output = root / "jobs" / job.id / "clips" / clip.output_name
        metadata = probe(output, application.settings)
        assert metadata["width"] == 1080 and metadata["height"] == 1920 and metadata["audio"]
        subtitles = output.with_suffix(".srt")
        assert subtitles.is_file() and "-->" in subtitles.read_text()
        assert output.with_name(output.stem + ".burn.ass").is_file()
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(output), "-f", "null", "-"],
                       check=True, capture_output=True)
        assert clip.library_asset_id and application.db.get_asset(clip.library_asset_id)
        if policy == "engine_only" or not connected:
            assert calls == [], (name, calls)
            assert private["hook_text"]["provider"] == "local"
        elif not fail:
            assert {"indexes", "hooks", "metadata"} <= set(calls), calls
        else:
            assert "indexes" in calls
            assert private["hook_text"]["provider"] == "local"
        results.append({"case": name, "job_id": job.id, "state": job.state, "transcribed_words": len(words),
                        "clip_duration": clip.duration, "hook_characters": len(clip.hook_text),
                        "provider_calls": calls, "metadata_status": clip.youtube_metadata_status,
                        "output": str(output), "warnings": job.warnings})
        if first is None:
            first = (job, private, output)
        print(json.dumps(results[-1]), flush=True)

    job, private, output = first
    clip = job.clips[0]
    control = root.parent / "control-no-text.mp4"
    render_clip(Path(private["source_path"]), control, start=clip.start, end=clip.end, aspect="9:16",
                words=[], visuals=[], overlays=[], settings=application.settings, has_audio=True,
                subtitles_enabled=False, content_format="short", style=job.style,
                centered_partial_fill=centered_partial_fill_eligible(job, private, probe(Path(private["source_path"]), application.settings)),
                presentation=private["presentation"]["caption"])
    def frame(path, t):
        raw = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", str(t), "-i", str(path),
                              "-frames:v", "1", "-vf", "scale=270:480", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                             check=True, capture_output=True).stdout
        return np.frombuffer(raw, dtype=np.uint8).reshape(480, 270, 3).mean(axis=2)
    clip_words = caption_words_for_clip(private["transcript"]["words"], clip.start, clip.end)
    samples = [min(clip.duration - 0.1, max(0.1, (word["start"] + word["end"]) / 2)) for word in clip_words[:5]]
    top_pixels = bottom_pixels = 0
    for t in samples:
        actual, blank = frame(output, t), frame(control, t)
        contrast = (actual > 150) & (blank < 100) & ((actual - blank) > 60)
        top_pixels = max(top_pixels, int(contrast[:160].sum()))
        bottom_pixels = max(bottom_pixels, int(contrast[310:].sum()))
    assert top_pixels >= 20, ("Hook text not visible", top_pixels)
    assert bottom_pixels >= 20, ("Burned captions not visible", bottom_pixels)
    report = {"network": ("Python outbound connections blocked; Hugging Face offline" if os.environ.get("S6_VERIFY_BLOCK_NETWORK") == "1" else "Docker --network none; cached models mounted read-only"),
              "real_whisper": True, "cases": results,
              "pixel_evidence": {"hook_pixels": top_pixels, "caption_pixels": bottom_pixels}}
    (root.parent / "report.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report["pixel_evidence"]), flush=True)



if __name__ == "__main__":
    main()
