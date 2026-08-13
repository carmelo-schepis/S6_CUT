from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import threading
from pathlib import Path
from typing import Any, Iterable

from .config import Settings
from .security import confined, redact, safe_filename, validate_youtube_url


ALLOWED_VIDEO_SUFFIXES = {".mp4", ".mov", ".webm", ".mkv", ".m4v", ".avi"}
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
_whisper_lock = threading.Lock()
_whisper_models: dict[str, Any] = {}


class MediaError(RuntimeError):
    pass


def available(command: str) -> bool:
    return shutil.which(command) is not None or Path(command).is_file()


def run(command: list[str], *, cwd: Path | None = None, timeout: int = 3600) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(command, cwd=cwd, capture_output=True, text=True, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise MediaError(redact(str(exc))) from exc
    if result.returncode:
        detail = result.stderr.strip().splitlines()[-8:]
        raise MediaError(redact("\n".join(detail) or f"{Path(command[0]).name} failed"))
    return result


def sha256_file(path: Path, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


def probe(path: Path, settings: Settings) -> dict[str, Any]:
    result = run([settings.ffprobe, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)], timeout=120)
    try:
        payload = json.loads(result.stdout)
        streams = payload.get("streams", [])
        video = next((item for item in streams if item.get("codec_type") == "video"), None)
        audio = next((item for item in streams if item.get("codec_type") == "audio"), None)
        duration = float(payload.get("format", {}).get("duration") or (video or {}).get("duration") or 0)
    except (ValueError, TypeError, json.JSONDecodeError) as exc:
        raise MediaError("FFprobe returned malformed media metadata") from exc
    if not video or duration <= 0:
        raise MediaError("The source does not contain a readable video stream")
    if duration > settings.max_source_seconds:
        raise MediaError(f"Source duration exceeds the configured {settings.max_source_seconds}-second limit")
    return {"duration": duration, "width": int(video.get("width") or 0), "height": int(video.get("height") or 0), "video_codec": video.get("codec_name"), "audio": bool(audio), "audio_codec": audio.get("codec_name") if audio else None}


def probe_audio(path: Path, settings: Settings) -> dict[str, Any]:
    result = run([settings.ffprobe, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)], timeout=120)
    try:
        payload = json.loads(result.stdout)
        audio = next((item for item in payload.get("streams", []) if item.get("codec_type") == "audio"), None)
        duration = float(payload.get("format", {}).get("duration") or (audio or {}).get("duration") or 0)
    except (ValueError, TypeError, json.JSONDecodeError) as exc:
        raise MediaError("FFprobe returned malformed audio metadata") from exc
    if not audio or duration <= 0:
        raise MediaError("Narration does not contain a readable audio stream")
    return {"duration": duration, "audio_codec": audio.get("codec_name")}


def validate_video_upload(path: Path, original_name: str, settings: Settings) -> dict[str, Any]:
    if Path(original_name).suffix.casefold() not in ALLOWED_VIDEO_SUFFIXES:
        raise MediaError("Unsupported video type. Use MP4, MOV, WebM, MKV, M4V, or AVI.")
    return probe(path, settings)


def download_youtube(url: str, target_dir: Path, settings: Settings) -> Path:
    validate_youtube_url(url)
    target_dir.mkdir(parents=True, exist_ok=True)
    template = str(target_dir / "source-%(id)s.%(ext)s")
    result = run([
        settings.ytdlp, "--no-playlist", "--no-warnings", "--restrict-filenames",
        "--max-filesize", str(settings.max_upload_bytes),
        "--format", "bv*[height<=1080]+ba/b[height<=1080]",
        "--merge-output-format", "mp4", "--output", template,
        "--print", "after_move:filepath", url,
    ], timeout=3600)
    candidates = [Path(line.strip()) for line in result.stdout.splitlines() if line.strip()]
    if not candidates:
        candidates = list(target_dir.glob("source-*"))
    if not candidates:
        raise MediaError("YouTube import completed without a usable file")
    source = candidates[-1].resolve()
    if target_dir.resolve() not in source.parents or not source.is_file():
        raise MediaError("YouTube output escaped its job directory")
    probe(source, settings)
    return source


def transcribe(path: Path, settings: Settings) -> dict[str, Any]:
    fixture = os.getenv("S6_TEST_TRANSCRIPT_JSON")
    if fixture:
        return json.loads(fixture)
    try:
        from faster_whisper import WhisperModel  # type: ignore
    except ImportError as exc:
        raise MediaError("Local Whisper is not installed in this engine runtime") from exc
    with _whisper_lock:
        model = _whisper_models.get(settings.whisper_model)
        if model is None:
            model = WhisperModel(settings.whisper_model, device="auto", compute_type="auto", download_root=str(settings.data_path / "models"))
            _whisper_models[settings.whisper_model] = model
    segments, info = model.transcribe(str(path), word_timestamps=True, vad_filter=True, beam_size=5)
    words: list[dict[str, Any]] = []
    segment_records: list[dict[str, Any]] = []
    for segment in segments:
        segment_records.append({"start": float(segment.start), "end": float(segment.end), "text": segment.text.strip()})
        for word in segment.words or []:
            text = str(word.word).strip()
            if text:
                words.append({"text": text, "start": float(word.start), "end": float(word.end), "confidence": float(word.probability or 0)})
    if not words:
        raise MediaError("No speech was detected. Automatic clips require a readable speech track; the source remains available for manual editing.")
    return {"language": getattr(info, "language", "unknown"), "words": words, "segments": segment_records}


def synthesize_local(text: str, output: Path, settings: Settings) -> Path:
    run([settings.local_tts, "-v", "en", "-s", "165", "-w", str(output), text], timeout=900)
    if not output.exists() or output.stat().st_size < 1000:
        raise MediaError("The local narration engine did not produce playable audio")
    return output


def dimensions(aspect: str) -> tuple[int, int]:
    return {"1:1": (1080, 1080), "16:9": (1920, 1080)}.get(aspect, (1080, 1920))


def _ass_time(seconds: float) -> str:
    value = max(0, seconds)
    hours = int(value // 3600)
    minutes = int((value % 3600) // 60)
    secs = value % 60
    return f"{hours}:{minutes:02d}:{secs:05.2f}"


def _ass_escape(value: str) -> str:
    return value.replace("\\", r"\\").replace("{", r"\{").replace("}", r"\}").replace("\n", r"\N")


def write_ass(path: Path, words: list[dict[str, Any]], *, offset: float, duration: float, visuals: Iterable[tuple[str, float, float]]) -> None:
    header = """[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Caption,Arial,72,&H00F1F2F4,&H0097D6FF,&H00000000,&H78000000,-1,0,0,0,100,100,0,0,1,5,2,2,80,80,250,1
Style: Visual,Arial,56,&H008FA8DD,&H000000FF,&H00110B0C,&HCC110B0C,-1,0,0,0,100,100,1,0,3,2,0,8,90,90,400,1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
"""
    events: list[str] = []
    local = [word for word in words if float(word["end"]) >= offset and float(word["start"]) <= offset + duration]
    for index, word in enumerate(local):
        group_start = index - index % 5
        group = local[group_start:group_start + 5]
        bits = []
        for item in group:
            text = _ass_escape(str(item["text"]))
            bits.append(r"{\c&H0077D6FF&}" + text + r"{\c&H00F1F2F4&}" if item is word else text)
        start = max(0, float(word["start"]) - offset)
        end = min(duration, max(start + .05, float(word["end"]) - offset))
        events.append(f"Dialogue: 10,{_ass_time(start)},{_ass_time(end)},Caption,,0,0,0,,{' '.join(bits)}")
    for label, start, end in visuals:
        events.append(f"Dialogue: 5,{_ass_time(start)},{_ass_time(end)},Visual,,0,0,0,,{_ass_escape(label)}")
    path.write_text(header + "\n".join(events) + "\n", encoding="utf-8")


def _overlay_inputs(command: list[str], overlays: list[tuple[Path, float, float]]) -> None:
    for path, _, _ in overlays:
        if path.suffix.casefold() in IMAGE_SUFFIXES:
            command.extend(["-loop", "1", "-framerate", "30", "-i", str(path)])
        else:
            command.extend(["-stream_loop", "-1", "-i", str(path)])


def _filters(width: int, height: int, overlays: list[tuple[Path, float, float]], asset_start_index: int, ass_name: str) -> tuple[str, str]:
    filters = [f"[0:v]scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height},setsar=1[base]"]
    current = "base"
    overlay_width, overlay_height = int(width * .86), int(height * .58)
    for number, (_, start, end) in enumerate(overlays):
        input_index = asset_start_index + number
        filters.append(f"[{input_index}:v]scale={overlay_width}:{overlay_height}:force_original_aspect_ratio=decrease,pad={overlay_width}:{overlay_height}:(ow-iw)/2:(oh-ih)/2:color=0x08080a,format=rgba[ov{number}]")
        output = f"layer{number}"
        filters.append(f"[{current}][ov{number}]overlay=(W-w)/2:(H-h)/2:enable='between(t,{start:.3f},{end:.3f})':eof_action=pass[{output}]")
        current = output
    filters.append(f"[{current}]subtitles={ass_name}[outv]")
    return ";".join(filters), "outv"


def render_clip(source: Path, output: Path, *, start: float, end: float, aspect: str, words: list[dict[str, Any]], visuals: list[tuple[str, float, float]], overlays: list[tuple[Path, float, float]], settings: Settings) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    ass = output.parent / f"{output.stem}.ass"
    duration = end - start
    write_ass(ass, words, offset=start, duration=duration, visuals=visuals)
    width, height = dimensions(aspect)
    temp = output.with_suffix(".partial.mp4")
    command = [settings.ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{start:.3f}", "-i", str(source), "-t", f"{duration:.3f}"]
    _overlay_inputs(command, overlays)
    filters, mapped = _filters(width, height, overlays, 1, ass.name)
    command.extend(["-filter_complex", filters, "-map", f"[{mapped}]", "-map", "0:a:0", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-movflags", "+faststart", "-shortest", str(temp)])
    run(command, cwd=output.parent, timeout=7200)
    metadata = probe(temp, settings)
    if metadata["width"] != width or metadata["height"] != height or not metadata["audio"]:
        raise MediaError("Rendered clip failed structural output validation")
    os.replace(temp, output)


def render_script(output: Path, *, duration: float, aspect: str, narration: Path | None, words: list[dict[str, Any]], visuals: list[tuple[str, float, float]], overlays: list[tuple[Path, float, float]], settings: Settings) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    ass = output.parent / f"{output.stem}.ass"
    write_ass(ass, words, offset=0, duration=duration, visuals=visuals)
    width, height = dimensions(aspect)
    temp = output.with_suffix(".partial.mp4")
    command = [settings.ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", f"color=c=0x08080a:s={width}x{height}:r=30:d={duration:.3f}"]
    audio_index: int | None = None
    if narration:
        audio_index = 1
        command.extend(["-i", str(narration)])
    asset_start = 2 if narration else 1
    _overlay_inputs(command, overlays)
    filters, mapped = _filters(width, height, overlays, asset_start, ass.name)
    command.extend(["-filter_complex", filters, "-map", f"[{mapped}]"])
    if audio_index is not None:
        command.extend(["-map", f"{audio_index}:a:0", "-c:a", "aac", "-b:a", "160k", "-ar", "48000"])
    else:
        command.append("-an")
    command.extend(["-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-t", f"{duration:.3f}", str(temp)])
    run(command, cwd=output.parent, timeout=7200)
    metadata = probe(temp, settings)
    if metadata["width"] != width or metadata["height"] != height or (narration and not metadata["audio"]):
        raise MediaError("Rendered script video failed structural output validation")
    os.replace(temp, output)
