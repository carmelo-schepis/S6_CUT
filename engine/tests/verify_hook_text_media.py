"""Read-only media verification for a completed hook-text job inside the engine container."""
from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from engine.app import db, manager, settings
from engine.jobs import _source_clip_visual_metadata, centered_partial_fill_eligible, job_content_format, youtube_creator_credit
from engine.media import caption_words_for_clip, probe, render_clip
from engine.security import confined
from engine.subscribe_animation import schedule_subscribe_animation


def normalized_ass_text(value: str):
    value = re.sub(r"\{[^}]*\}", "", value).replace(r"\N", " ")
    return " ".join(value.split()).casefold()


def raw_frame(path: Path, timestamp: float, crop: str):
    result = subprocess.run([
        settings.ffmpeg, "-hide_banner", "-loglevel", "error", "-ss", f"{timestamp:.3f}", "-i", str(path),
        "-frames:v", "1", "-vf", crop, "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
    ], check=True, capture_output=True)
    return result.stdout


def contrast_pixels(actual: bytes, control: bytes, minimum_luminance: float = 180):
    count = 0
    for offset in range(0, min(len(actual), len(control)), 3):
        red, green, blue = actual[offset:offset + 3]
        control_red, control_green, control_blue = control[offset:offset + 3]
        actual_luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue
        control_luminance = 0.2126 * control_red + 0.7152 * control_green + 0.0722 * control_blue
        if actual_luminance > minimum_luminance and control_luminance < 100:
            count += 1
    return count


def verify(job_id: str, clip_id: str | None = None):
    job = db.get_job(job_id)
    if not job:
        raise RuntimeError("the requested verification job is not present")
    private = db.get_job_private(job_id)
    if not job.hook_text_enabled or not job.clips:
        raise RuntimeError("the requested job is not an opted-in clip job")
    clip = next((item for item in job.clips if item.state == "complete" and item.hook_text and item.output_name and (clip_id is None or item.id == clip_id)), None)
    if not clip:
        raise RuntimeError("the requested job has no completed clip with hook text")
    hook = clip.hook_text
    output = confined(settings.data_path, "jobs", job.id, "clips", clip.output_name)
    if not output.is_file():
        raise RuntimeError("the completed clip file is unavailable for verification")
    transcript = private.get("transcript") if isinstance(private.get("transcript"), dict) else {}
    transcript_words = transcript.get("words") if isinstance(transcript.get("words"), list) else []
    clip_words = caption_words_for_clip(transcript_words, clip.start, clip.end)
    source_words = [
        {**word, "start": float(word["start"]) + clip.start, "end": float(word["end"]) + clip.start}
        for word in clip_words
    ]
    source_path = Path(str(private.get("source_path") or ""))
    if not source_path.is_file() and job.source_blob_id:
        relative = db.blob_relative_path(job.source_blob_id)
        source_path = confined(settings.data_path, *relative.split("/")) if relative else source_path
    if not source_path.is_file():
        raise RuntimeError("the immutable source media is unavailable for control rendering")

    burn_ass = output.with_name(f"{output.stem}.burn.ass")
    sidecars = {suffix: output.with_suffix(suffix) for suffix in (".ass", ".srt", ".vtt")}
    if not burn_ass.is_file():
        raise RuntimeError("the burn-in ASS track is unavailable")
    burn_text = burn_ass.read_text(encoding="utf-8")
    hook_event = next((line for line in burn_text.splitlines() if line.startswith("Dialogue: 5,")), None)
    if not hook_event or normalized_ass_text(hook) not in normalized_ass_text(hook_event):
        raise RuntimeError("the hook is missing from the burn-in ASS event")
    schedule = schedule_subscribe_animation(clip.duration, content_format=job_content_format(job, private),
                                           config=private.get("subscribe_animation"))
    expected_end = schedule[0][0] if schedule else clip.duration
    end_match = re.match(r"Dialogue: 5,([^,]+),([^,]+),Hook,", hook_event)
    if not end_match:
        raise RuntimeError("the hook burn-in event has no parseable timing")
    end_seconds = sum(float(part) * scale for part, scale in zip(end_match.group(2).split(":")[::-1], (1, 60, 3600)))
    if abs(end_seconds - expected_end) > 0.01:
        raise RuntimeError("the hook does not end at the Subscribe animation start")
    for sidecar in sidecars.values():
        if sidecar.is_file() and normalized_ass_text(hook) in normalized_ass_text(sidecar.read_text(encoding="utf-8")):
            raise RuntimeError(f"the hook leaked into downloadable caption sidecar {sidecar.suffix}")

    metadata = probe(output, settings)
    top_crop = "crop=iw:ih*0.30:0:0,scale=270:320"
    bottom_crop = "crop=iw:ih/4:0:ih*3/4,scale=270:160"
    with tempfile.TemporaryDirectory(prefix="s6-hook-media-verify-") as temporary:
        control = Path(temporary) / "without-hook.mp4"
        source_metadata = probe(source_path, settings)
        words_enabled = bool(private.get("burn_subtitles", job.burn_subtitles) or private.get("embed_subtitles", job.embed_subtitles))
        visual_text = " ".join(str(word.get("text", "")) for word in source_words)
        visual = manager.rules.resolve(visual_text)
        overlays, _ = _source_clip_visual_metadata(visual, clip.duration)
        render_kwargs = {
            "start": clip.start, "end": clip.end, "aspect": str(private.get("aspect_ratio") or "9:16"),
            "words": source_words if words_enabled else [], "visuals": [], "overlays": overlays,
            "settings": settings, "style": job.style, "has_audio": bool(source_metadata.get("audio")),
            "content_format": job_content_format(job, private),
            "centered_partial_fill": centered_partial_fill_eligible(job, private, source_metadata),
            "subscribe_animation": private.get("subscribe_animation"),
            "creator_credit": youtube_creator_credit(job, private),
            "embed_subtitles": bool(private.get("embed_subtitles", job.embed_subtitles)),
        }
        render_clip(source_path, control, **render_kwargs)
        active_actual = raw_frame(output, min(1.0, clip.duration * 0.1), top_crop)
        active_control = raw_frame(control, min(1.0, clip.duration * 0.1), top_crop)
        active_pixels = contrast_pixels(active_actual, active_control)
        if active_pixels < 20:
            raise RuntimeError(f"hook text is not visible in the top safe area ({active_pixels} differential white pixels)")
        caption_pixels = 0
        if words_enabled:
            no_captions = Path(temporary) / "without-captions.mp4"
            render_clip(source_path, no_captions, **{**render_kwargs, "words": [], "embed_subtitles": False})
            bottom_actual = raw_frame(output, min(1.0, clip.duration * 0.1), bottom_crop)
            bottom_control = raw_frame(no_captions, min(1.0, clip.duration * 0.1), bottom_crop)
            caption_pixels = contrast_pixels(bottom_actual, bottom_control, minimum_luminance=140)
            if caption_pixels < 20:
                raise RuntimeError("captions are not visibly rendered in the bottom band")
        animation_time = max(0.0, clip.duration - 3.0)
        animation_actual = raw_frame(output, animation_time, top_crop)
        animation_control = raw_frame(control, animation_time, top_crop)
        animation_pixels = contrast_pixels(animation_actual, animation_control)
        if animation_pixels > 20:
            raise RuntimeError(f"hook text remains visible during the Subscribe animation ({animation_pixels} differential pixels)")
    return {
        "jobId": job.id, "clipId": clip.id, "durationSeconds": metadata["duration"],
        "width": metadata["width"], "height": metadata["height"],
        "hookCharacterCount": len(hook), "hookEndSeconds": end_seconds,
        "subscribeStartSeconds": expected_end if schedule else None,
        "activeHookDifferentialWhitePixels": active_pixels,
        "animationHookDifferentialWhitePixels": animation_pixels,
        "bottomCaptionBrightPixels": caption_pixels,
        "sidecarsHookFree": True,
    }


if __name__ == "__main__":
    if len(sys.argv) not in {2, 3}:
        raise SystemExit("usage: verify_hook_text_media.py JOB_ID [CLIP_ID]")
    print(json.dumps(verify(sys.argv[1], sys.argv[2] if len(sys.argv) == 3 else None), sort_keys=True))
