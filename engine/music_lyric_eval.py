"""Local, private-reference evaluation for sung-word transcription."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import resource
import sys
import time
import unicodedata
from dataclasses import replace
from pathlib import Path
from typing import Any
from collections import Counter

from .config import Settings
from .media import (
    extract_music_audio_16k, is_whisper_model_cached, probe_audio,
    transcription_cache_identity,
)
from .transcription import supervise


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def tokens(text: str) -> list[str]:
    text = unicodedata.normalize("NFKC", text)
    text = text.translate(str.maketrans({"’": "'", "‘": "'", "ʼ": "'"})).casefold()
    result: list[str] = []
    current: list[str] = []
    for char in text:
        if char.isalnum() or (char == "'" and current):
            current.append(char)
        elif current:
            result.append("".join(current))
            current = []
    if current:
        result.append("".join(current))
    return result


def align(ref: list[str], hyp: list[str]) -> tuple[dict[str, int], list[tuple[int, int]]]:
    """Return edit counts and exact-match index pairs from a Levenshtein alignment."""
    rows, columns = len(ref) + 1, len(hyp) + 1
    if rows * columns > 1_000_000:
        raise ValueError("alignment is too large for the bounded evaluator; score shorter contiguous excerpts")
    costs = [[0] * columns for _ in range(rows)]
    back = [[""] * columns for _ in range(rows)]
    for i in range(1, rows):
        costs[i][0], back[i][0] = i, "D"
    for j in range(1, columns):
        costs[0][j], back[0][j] = j, "I"

    for i in range(1, rows):
        for j in range(1, columns):
            same = ref[i - 1] == hyp[j - 1]
            choices = (
                (costs[i - 1][j - 1] + (0 if same else 1), "M" if same else "S"),
                (costs[i - 1][j] + 1, "D"),
                (costs[i][j - 1] + 1, "I"),
            )
            costs[i][j], back[i][j] = min(choices, key=lambda choice: choice[0])

    counts = {"substitutions": 0, "deletions": 0, "insertions": 0}
    matches: list[tuple[int, int]] = []
    i, j = len(ref), len(hyp)
    while i or j:
        operation = back[i][j]
        if operation == "M":
            matches.append((i - 1, j - 1))
            i -= 1
            j -= 1
        elif operation == "S":
            counts["substitutions"] += 1
            i -= 1
            j -= 1
        elif operation == "D":
            counts["deletions"] += 1
            i -= 1
        elif operation == "I":
            counts["insertions"] += 1
            j -= 1
        else:
            raise ValueError("could not align words")
    matches.reverse()
    return counts, matches


def character_error_rate(reference: str, hypothesis: str) -> float | None:
    left, right = "".join(tokens(reference)), "".join(tokens(hypothesis))
    if not left:
        return None
    if (len(left) + 1) * (len(right) + 1) > 20_000_000:
        return None
    if len(left) < len(right):
        left, right = right, left
    previous = list(range(len(right) + 1))
    for row, left_char in enumerate(left, 1):
        current = [row]
        for column, right_char in enumerate(right, 1):
            current.append(min(
                current[-1] + 1,
                previous[column] + 1,
                previous[column - 1] + (left_char != right_char),
            ))
        previous = current
    return round(previous[-1] / len("".join(tokens(reference))), 6)


def read_timing_reference(path: Path) -> list[dict[str, Any]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError("timing reference must be a JSON list")
    result = []
    for row in data:
        if not isinstance(row, dict) or not all(key in row for key in ("text", "start", "end")):
            raise ValueError("timing rows need text, start, and end")
        start, end = float(row["start"]), float(row["end"])
        word = tokens(str(row["text"]))
        if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end < start or len(word) != 1:
            raise ValueError("each timing row needs one word and valid start/end")
        result.append({"text": word[0], "start": start, "end": end})
    return result


def read_time_spans(path: Path) -> list[tuple[float, float]]:
    spans = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(spans, list):
        raise ValueError("time spans must be a JSON list of [start,end]")
    result = []
    for span in spans:
        if not isinstance(span, list) or len(span) != 2:
            raise ValueError("time spans must be [start,end]")
        start, end = map(float, span)
        if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start:
            raise ValueError("invalid time span")
        result.append((start, end))
    return result


def cgroup_peak_memory_mib() -> float | None:
    for candidate in (Path("/sys/fs/cgroup/memory.peak"), Path("/sys/fs/cgroup/memory/memory.max_usage_in_bytes")):
        try:
            value = candidate.read_text(encoding="ascii").strip()
            if value != "max":
                return round(int(value) / (1024 * 1024), 2)
        except (OSError, ValueError):
            continue
    return None


def evaluate(args: argparse.Namespace) -> dict[str, Any]:
    audio = args.audio.expanduser().resolve(strict=True)
    reference_path = args.reference.expanduser().resolve(strict=True)
    if not audio.is_file() or not reference_path.is_file():
        raise ValueError("audio and reference must be files")
    reference_tokens = tokens(reference_path.read_text(encoding="utf-8"))
    if not reference_tokens:
        raise ValueError("reference contains no words")
    settings = Settings.from_env()
    if args.data_path:
        settings = replace(settings, data_path=args.data_path.expanduser().resolve())
    if getattr(args, "model", None):
        settings = replace(settings, music_whisper_model=args.model.strip())
    beam_size = getattr(args, "beam_size", None)
    if beam_size is not None and not 1 <= int(beam_size) <= 8:
        raise ValueError("--beam-size must be between 1 and 8")
    condition_on_previous_text = getattr(args, "condition_on_previous_text", None)
    audio_metadata = probe_audio(audio, settings)
    audio_duration = float(audio_metadata["duration"])
    instrumental_spans = read_time_spans(args.instrumental_spans.expanduser().resolve(strict=True)) if args.instrumental_spans else None
    timing_reference = read_timing_reference(args.timing_reference.expanduser().resolve(strict=True)) if args.timing_reference else None
    sung_spans = read_time_spans(args.sung_spans.expanduser().resolve(strict=True)) if args.sung_spans else None
    if timing_reference is not None and [row["text"] for row in timing_reference] != reference_tokens:
        raise ValueError("timing reference words must exactly match normalized reference text in order")
    if sung_spans is not None and timing_reference is None:
        raise ValueError("--sung-spans requires --timing-reference with one timed word per reference token")
    for label, spans in (("instrumental", instrumental_spans), ("sung", sung_spans)):
        if spans and any(end > audio_duration for _, end in spans):
            raise ValueError(f"{label} span exceeds audio duration")
    if timing_reference and any(row["end"] > audio_duration for row in timing_reference):
        raise ValueError("timing reference exceeds audio duration")
    if os.getenv("S6_TEST_TRANSCRIPT_JSON"):
        raise ValueError("unset S6_TEST_TRANSCRIPT_JSON; the evaluator must use real local transcription")
    if args.offline and not args.hypothesis:
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        if not is_whisper_model_cached(settings, profile="music"):
            raise ValueError("selected Music model is not cached; offline evaluation will not download models")

    preprocessing_seconds = 0.0
    decode_seconds = 0.0
    transcript = None
    if args.hypothesis:
        transcript = json.loads(args.hypothesis.expanduser().resolve(strict=True).read_text(encoding="utf-8"))
        if not isinstance(transcript, dict) or not isinstance(transcript.get("words"), list):
            raise ValueError("saved hypothesis must be a transcript JSON object containing words")
    else:
        speed = round(min(1.5, max(0.75, float(args.speed))), 3)
        audio_digest = sha256(audio)
        eval_data = args.data_path.expanduser().resolve() if args.data_path else settings.data_path
        recognition_audio = eval_data / "music-lyric-eval" / f"{audio_digest}-{speed:.3f}.wav"
        preprocess_started = time.monotonic()
        extract_music_audio_16k(audio, settings, output=recognition_audio, speed=speed, duration=float(audio_metadata["duration"]))
        preprocessing_seconds = time.monotonic() - preprocess_started
        decode_started = time.monotonic()
        transcript = supervise(
            recognition_audio, settings, profile="music", language=args.language,
            source_seconds=float(audio_metadata["duration"]), beam_size=beam_size,
            condition_on_previous_text=condition_on_previous_text,
        )
        decode_seconds = time.monotonic() - decode_started
        if args.save_hypothesis:
            destination = args.save_hypothesis.expanduser().resolve()
            destination.parent.mkdir(parents=True, exist_ok=True)
            temporary = destination.with_suffix(destination.suffix + ".partial")
            temporary.write_text(json.dumps(transcript, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            temporary.replace(destination)

    words = transcript.get("words", [])
    hypothesis_tokens: list[str] = []
    hypothesis_word_indexes: list[int] = []
    for word_index, word in enumerate(words):
        word_tokens = tokens(str(word.get("text", "")))
        hypothesis_tokens.extend(word_tokens)
        hypothesis_word_indexes.extend([word_index] * len(word_tokens))
    counts, matches = align(reference_tokens, hypothesis_tokens)
    error_count = sum(counts.values())
    matched_reference_indexes = {reference_index for reference_index, _ in matches}

    instrumental_result = None
    if instrumental_spans is not None:
        inserted_words = sum(
            any(start <= (float(word["start"]) + float(word["end"])) / 2 < end for start, end in instrumental_spans)
            for word in words
        )
        instrumental_result = {
            "annotated_spans": len(instrumental_spans),
            "hypothesis_words_in_spans": inserted_words,
        }

    timing_result = None
    timing_alignment_errors = None
    sung_omission_result = None
    if timing_reference is not None:
        timing_counts, timing_matches = align(
            [row["text"] for row in timing_reference], hypothesis_tokens
        )
        timing_alignment_errors = sum(timing_counts.values())
        onset_errors = [
            abs(float(timing_reference[ref_index]["start"]) - float(words[hypothesis_word_indexes[hyp_index]]["start"]))
            for ref_index, hyp_index in timing_matches
        ]
        offset_errors = [
            abs(float(timing_reference[ref_index]["end"]) - float(words[hypothesis_word_indexes[hyp_index]]["end"]))
            for ref_index, hyp_index in timing_matches
        ]
        if onset_errors:
            timing_result = {
                "matched_words": len(onset_errors),
                "reference_coverage": round(len(onset_errors) / max(1, len(timing_reference)), 6),
                "repeated_reference_tokens": sum(1 for count in Counter(row["text"] for row in timing_reference).values() if count > 1),
                "onset_mae_seconds": round(sum(onset_errors) / len(onset_errors), 4),
                "offset_mae_seconds": round(sum(offset_errors) / len(offset_errors), 4),
                "word_boundary_mae_seconds": round(
                    (sum(onset_errors) + sum(offset_errors)) / (2 * len(onset_errors)), 4
                ),
            }

    if sung_spans is not None:
        sung_indexes = {
            index for index, row in enumerate(timing_reference)
            if any(start <= (row["start"] + row["end"]) / 2 < end for start, end in sung_spans)
        }
        matched_sung = sung_indexes & matched_reference_indexes
        sung_omission_result = {
            "annotated_sung_reference_words": len(sung_indexes),
            "matched_words": len(matched_sung),
            "omitted_words": len(sung_indexes - matched_sung),
            "omission_rate": round(len(sung_indexes - matched_sung) / max(1, len(sung_indexes)), 6),
        }

    return {
        "schema_version": 2,
        "normalizer_version": "nfkc-casefold-apostrophe-v1",
        "track_id": args.track_id,
        "audio_sha256": sha256(audio),
        "reference_sha256": sha256(reference_path),
        "language_detected": transcript.get("language", "unknown"),
        "reference_word_count": len(reference_tokens),
        "hypothesis_word_count": len(hypothesis_tokens),
        **counts,
        "word_error_rate": round(error_count / len(reference_tokens), 6),
        "character_error_rate": character_error_rate(
            reference_path.read_text(encoding="utf-8"),
            " ".join(str(word.get("text", "")) for word in words),
        ),
        "instrumental_insertions": instrumental_result,
        "sung_span_omissions": sung_omission_result,
        "timing_reference_alignment_errors": timing_alignment_errors,
        "timing_error": timing_result,
        "transcription_runtime_seconds": round(preprocessing_seconds + decode_seconds, 3),
        "preprocessing_runtime_seconds": round(preprocessing_seconds, 3),
        "decoder_supervision_runtime_seconds": round(decode_seconds, 3),
        "process_peak_rss_mib": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 2),
        "cgroup_peak_memory_mib": cgroup_peak_memory_mib(),
        "model": settings.music_whisper_model,
        "decoder_cache_identity": transcription_cache_identity(
            settings, profile="music", language=args.language, beam_size=beam_size,
            condition_on_previous_text=condition_on_previous_text,
        ),
        "decoder_options": {
            "beam_size": beam_size or settings.music_whisper_beam_size,
            "condition_on_previous_text": True if condition_on_previous_text is None else condition_on_previous_text,
        },
        "music_speed": round(min(1.5, max(0.75, float(args.speed))), 3),
        "transcript_diagnostics": transcript.get("diagnostics"),
        "segment_count": len(transcript.get("segments", [])),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audio", type=Path, required=True, help="local audio/video file")
    parser.add_argument("--hypothesis", type=Path, help="score a saved raw transcript JSON without rerunning ASR")
    parser.add_argument("--save-hypothesis", type=Path, help="save the raw transcript JSON for repeat scoring")
    parser.add_argument("--offline", action="store_true", help="require the selected model to be cached and forbid Hub downloads")
    parser.add_argument("--speed", type=float, default=1.0, help="audible soundtrack speed used to prepare recognition audio")
    parser.add_argument("--reference", type=Path, required=True, help="private UTF-8 human-corrected lyrics")
    parser.add_argument("--track-id", required=True, help="non-sensitive fixture ID")
    parser.add_argument("--data-path", type=Path, help="directory containing the cached local model")
    parser.add_argument("--language", help="optional language code; default uses local autodetection")
    parser.add_argument("--model", help="local model name/path candidate; with --offline it must already be cached")
    parser.add_argument("--beam-size", type=int, help="Music decoding beam candidate (1..8)")
    conditioning = parser.add_mutually_exclusive_group()
    conditioning.add_argument("--condition-on-previous-text", dest="condition_on_previous_text", action="store_true", help="retain cross-window text context")
    conditioning.add_argument("--no-condition-on-previous-text", dest="condition_on_previous_text", action="store_false", help="disable cross-window text context")
    parser.set_defaults(condition_on_previous_text=None)
    parser.add_argument("--instrumental-spans", type=Path, help="private JSON [[start,end], ...]")
    parser.add_argument("--timing-reference", type=Path, help="private JSON [{text,start,end}, ...], one word per row")
    parser.add_argument("--sung-spans", type=Path, help="private JSON [[start,end], ...] for annotated sung-vocal regions; requires timing reference")
    parser.add_argument("--report", type=Path, help="write aggregate-only JSON here; otherwise print")
    args = parser.parse_args(argv)
    try:
        output = json.dumps(evaluate(args), ensure_ascii=False, indent=2) + "\n"
        if args.report:
            destination = args.report.expanduser().resolve()
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(output, encoding="utf-8")
        else:
            sys.stdout.write(output)
        return 0
    except (OSError, ValueError, RuntimeError) as exc:
        parser.error(str(exc))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
