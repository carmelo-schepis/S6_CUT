"""Deterministic caption normalization and QA shared by editing and rendering."""
from __future__ import annotations

import math
import re
from typing import Any

_MAX_TEXT = 160
_MAX_CUES = 500
_MAX_LINE = 42
_MAX_LINES = 2
_MIN_DURATION = 0.20
_MAX_DURATION = 12.0
_MAX_WPS = 20.0
_SAFE_MARGIN = 0.05
_CANVAS = {"9:16": (1080, 1920), "4:5": (1080, 1350), "1:1": (1080, 1080), "16:9": (1920, 1080)}
# Conservative deterministic layout-risk estimate, not visual confirmation.
_SAFE_INSET_FRACTION = .05


def caption_box(aspect: str, lines: int, longest_line: int) -> tuple[float, float, float, float] | None:
    """Estimate bottom-centred ASS caption bounds on the canonical canvas."""
    canvas = _CANVAS.get(aspect)
    if not canvas:
        return None
    width, height = canvas
    scale = height / 1920
    font = max(28, round(64 * scale))
    outline = max(2, round(4 * scale))
    margin_x, margin_v = round(72 * width / 1080), round(118 * height / 1920)
    box_width = min(width - 2 * margin_x, longest_line * font * .58 + 2 * outline + 16)
    box_height = max(1, lines) * font * 1.2 + 2 * outline + 16
    left = (width - box_width) / 2
    bottom = height - margin_v
    return left, bottom - box_height, left + box_width, bottom


def _rgba(value: str) -> tuple[float, float, float, float] | None:
    value = value.strip().lstrip("#")
    if len(value) not in (6, 8):
        return None
    try:
        channels = tuple(int(value[index:index + 2], 16) / 255 for index in range(0, len(value), 2))
    except ValueError:
        return None
    return (*channels[:3], channels[3] if len(channels) == 4 else 1.0)


def _luminance(rgb: tuple[float, float, float]) -> float:
    def linear(channel: float) -> float:
        return channel / 12.92 if channel <= .04045 else ((channel + .055) / 1.055) ** 2.4
    return .2126 * linear(rgb[0]) + .7152 * linear(rgb[1]) + .0722 * linear(rgb[2])


def contrast_ratio(foreground: str, background: str) -> float | None:
    fg, bg = _rgba(foreground), _rgba(background)
    if not fg or not bg:
        return None
    alpha = fg[3] + bg[3] * (1 - fg[3])
    if alpha <= 0:
        return None
    composite = tuple((fg[i] * fg[3] + bg[i] * bg[3] * (1 - fg[3])) / alpha for i in range(3))
    low, high = sorted((_luminance(composite), _luminance((bg[0], bg[1], bg[2]))))
    return (high + .05) / (low + .05)


def normalize_text(text: str) -> str:
    return re.sub(r"\s+", " ", text.replace("\r\n", "\n").replace("\r", "\n")).strip()


def qa_cues(cues: list[dict[str, Any]], duration: float, *, aspect: str = "9:16", foreground: str = "#FFFFFF", background: str = "#000000") -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    previous_end = 0.0
    for index, cue in enumerate(cues):
        cue_id = str(cue.get("id", index))
        start, end = cue.get("start"), cue.get("end")
        text = normalize_text(str(cue.get("text", "")))
        def add(code: str, severity: str, message: str) -> None:
            findings.append({"code": code, "severity": severity, "cueId": cue_id, "cueIndex": index, "message": message})
        if not text:
            add("empty_text", "error", "Caption text is empty.")
        if not isinstance(start, (int, float)) or not math.isfinite(start) or start < 0:
            add("invalid_start", "error", "Caption start must be finite and non-negative.")
        if not isinstance(end, (int, float)) or not math.isfinite(end) or end <= (start if isinstance(start, (int, float)) else 0):
            add("invalid_end", "error", "Caption end must be greater than start.")
        elif end > duration:
            add("end_beyond_duration", "error", "Caption end exceeds clip duration.")
        if isinstance(start, (int, float)) and start < previous_end:
            add("overlap", "error", "Caption cues must not overlap.")
        if isinstance(start, (int, float)) and isinstance(end, (int, float)) and end > start:
            span = end - start
            if span < _MIN_DURATION: add("too_short", "warning", "Caption cue is unusually short.")
            if span > _MAX_DURATION: add("too_long", "warning", "Caption cue is unusually long.")
            if len(text.split()) / span > _MAX_WPS: add("excessive_wps", "warning", "Caption reading speed is high.")
            previous_end = max(previous_end, end)
        confidence = cue.get("confidence")
        if confidence is None:
            add("missing_confidence", "warning", "Caption confidence is unavailable.")
        elif not isinstance(confidence, (int, float)) or not math.isfinite(confidence) or confidence < .65:
            add("low_confidence", "warning", "Caption confidence is low.")
        lines = text.split("\n")
        if any(len(line) > _MAX_LINE for line in lines): add("line_too_long", "warning", "Caption line is too long.")
        if len(lines) > _MAX_LINES: add("too_many_lines", "warning", "Caption has too many lines.")
        bounds = caption_box(aspect, len(lines), max((len(line) for line in lines), default=0))
        if bounds:
            inset_x, inset_y = _CANVAS[aspect][0] * _SAFE_INSET_FRACTION, _CANVAS[aspect][1] * _SAFE_INSET_FRACTION
            left, top, right, bottom = bounds
            if left < inset_x or top < inset_y or right > _CANVAS[aspect][0] - inset_x or bottom > _CANVAS[aspect][1] - inset_y:
                add("safe_area_violation", "warning", "Estimated caption bounds exceed the canonical safe area.")
        if len(text) > _MAX_TEXT: add("text_too_long", "error", "Caption text exceeds the maximum length.")
    if len(cues) > _MAX_CUES:
        findings.append({"code": "too_many_cues", "severity": "error", "message": "Caption cue count exceeds the maximum."})
    ratio = contrast_ratio(foreground, background)
    if ratio is None:
        findings.append({"code": "unknown_contrast", "severity": "warning", "message": "Caption contrast cannot be determined from the configured colors."})
    elif ratio < 4.5:
        findings.append({"code": "insufficient_contrast", "severity": "warning", "message": "Caption contrast is below the configured accessibility threshold."})
    if aspect not in {"9:16", "4:5", "1:1", "16:9"}:
        findings.append({"code": "unsafe_area_unknown", "severity": "warning", "message": "Caption safe area is unknown for this output aspect."})
    return findings


def normalize_and_validate(cues: list[dict[str, Any]], duration: float) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    normalized = [{**cue, "text": normalize_text(str(cue.get("text", "")))} for cue in cues]
    return normalized, qa_cues(normalized, duration)
