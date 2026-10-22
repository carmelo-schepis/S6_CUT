"""Local, private-reference evaluation for sung-word transcription."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import resource
import sys
import time
import unicodedata
from dataclasses import replace
from pathlib import Path
from typing import Any

from .config import Settings
from .media import transcribe


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def tokens(text: str) -> list[str]:
    text = unicodedata.normalize("NFKC", text).casefold()
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


def read_instrumental_spans(path: Path) -> list[tuple[float, float]]:
    spans = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(spans, list):
        raise ValueError("instrumental spans must be a JSON list of [start,end]")
    result = []
    for span in spans:
        if not isinstance(span, list) or len(span) != 2:
            raise ValueError("instrumental spans must be [start,end]")
        start, end = map(float, span)
        if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start:
            raise ValueError("invalid instrumental span")
        result.append((start, end))
    return result


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
    started = time.monotonic()
    transcript = transcribe(audio, settings, profile="music", language=args.language)
    elapsed = time.monotonic() - started

    words = transcript.get("words", [])
    hypothesis_tokens: list[str] = []
    hypothesis_word_indexes: list[int] = []
    for word_index, word in enumerate(words):
        word_tokens = tokens(str(word.get("text", "")))
        hypothesis_tokens.extend(word_tokens)
        hypothesis_word_indexes.extend([word_index] * len(word_tokens))
    counts, matches = align(reference_tokens, hypothesis_tokens)
    error_count = sum(counts.values())

    instrumental_result = None
    if args.instrumental_spans:
        spans = read_instrumental_spans(args.instrumental_spans.expanduser().resolve(strict=True))
        inserted_words = sum(
            any(start <= (float(word["start"]) + float(word["end"])) / 2 < end for start, end in spans)
            for word in words
        )
        instrumental_result = {
            "annotated_spans": len(spans),
            "hypothesis_words_in_spans": inserted_words,
        }

    timing_result = None
    timing_alignment_errors = None
    if args.timing_reference:
        timing_reference = read_timing_reference(args.timing_reference.expanduser().resolve(strict=True))
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
                "onset_mae_seconds": round(sum(onset_errors) / len(onset_errors), 4),
                "offset_mae_seconds": round(sum(offset_errors) / len(offset_errors), 4),
                "word_boundary_mae_seconds": round(
                    (sum(onset_errors) + sum(offset_errors)) / (2 * len(onset_errors)), 4
                ),
            }

    return {
        "schema_version": 1,
        "track_id": args.track_id,
        "audio_sha256": sha256(audio),
        "reference_sha256": sha256(reference_path),
        "language_detected": transcript.get("language", "unknown"),
        "reference_word_count": len(reference_tokens),
        "hypothesis_word_count": len(hypothesis_tokens),
        **counts,
        "word_error_rate": round(error_count / len(reference_tokens), 6),
        "instrumental_insertions": instrumental_result,
        "timing_reference_alignment_errors": timing_alignment_errors,
        "timing_error": timing_result,
        "transcription_runtime_seconds": round(elapsed, 3),
        "process_peak_rss_mib": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 2),
        "model": settings.music_whisper_model,
        "segment_count": len(transcript.get("segments", [])),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audio", type=Path, required=True, help="local audio/video file")
    parser.add_argument("--reference", type=Path, required=True, help="private UTF-8 human-corrected lyrics")
    parser.add_argument("--track-id", required=True, help="non-sensitive fixture ID")
    parser.add_argument("--data-path", type=Path, help="directory containing the cached local model")
    parser.add_argument("--language", help="optional language code; default uses local autodetection")
    parser.add_argument("--instrumental-spans", type=Path, help="private JSON [[start,end], ...]")
    parser.add_argument("--timing-reference", type=Path, help="private JSON [{text,start,end}, ...], one word per row")
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
