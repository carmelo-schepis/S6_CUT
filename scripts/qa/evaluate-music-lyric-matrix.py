#!/usr/bin/env python3
"""Run offline local Music ASR candidates across a private, human-annotated corpus.

The JSON manifest, candidate matrix, audio, references, and report must live
outside the Git checkout. The model cache may be an existing local cache in
ignored project data. Raw hypotheses are retained beside reports
so scoring changes do not need another expensive decode.
"""
from __future__ import annotations

import argparse
import json
import statistics
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any


REPO = Path(__file__).resolve().parents[2]


def outside_checkout(path: Path, label: str) -> Path:
    resolved = path.expanduser().resolve(strict=False)
    try:
        resolved.relative_to(REPO)
    except ValueError:
        return resolved
    raise ValueError(f"{label} must be outside the Git checkout to keep evaluation data private")


def read_json(path: Path) -> Any:
    return json.loads(path.expanduser().resolve(strict=True).read_text(encoding="utf-8"))


def evaluate(args: argparse.Namespace) -> dict[str, Any]:
    manifest_path = outside_checkout(args.manifest, "manifest")
    matrix_path = outside_checkout(args.candidates, "candidate matrix")
    output_dir = outside_checkout(args.output_dir, "output directory")
    tracks = read_json(manifest_path)
    candidates = read_json(matrix_path)
    if not isinstance(tracks, list) or not tracks or not isinstance(candidates, list) or not candidates:
        raise ValueError("manifest and candidates must be non-empty JSON lists")
    output_dir.mkdir(parents=True, exist_ok=True)

    reports: list[dict[str, Any]] = []
    used_ids: set[str] = set()
    for candidate in candidates:
        if not isinstance(candidate, dict) or not isinstance(candidate.get("id"), str):
            raise ValueError("each candidate requires a stable id")
        candidate_id = candidate["id"]
        if candidate_id in used_ids:
            raise ValueError(f"duplicate candidate id: {candidate_id}")
        used_ids.add(candidate_id)
        reports_for_candidate: list[dict[str, Any]] = []
        candidate_dir = output_dir / candidate_id
        candidate_dir.mkdir(parents=True, exist_ok=True)
        for track in tracks:
            if not isinstance(track, dict) or not isinstance(track.get("id"), str):
                raise ValueError("each track requires an anonymous id")
            track_id = track["id"]
            audio = outside_checkout(Path(str(track.get("audio", ""))), "audio")
            reference = outside_checkout(Path(str(track.get("reference", ""))), "reference")
            if not audio.is_file() or not reference.is_file():
                raise ValueError(f"audio/reference is missing for track {track_id}")
            stem = f"{track_id}-{candidate_id}"
            report_path = candidate_dir / f"{stem}.report.json"
            hypothesis_path = candidate_dir / f"{stem}.hypothesis.json"
            command = [
                sys.executable, "-m", "engine.music_lyric_eval",
                "--audio", str(audio), "--reference", str(reference),
                "--track-id", track_id, "--offline",
                "--save-hypothesis", str(hypothesis_path),
                "--report", str(report_path),
            ]
            if args.data_path:
                # Model caches are often already stored in the project's ignored
                # data directory. Evaluation media and outputs remain private,
                # while an existing local cache can be read in place.
                model_data = args.data_path.expanduser().resolve(strict=False)
                if not model_data.is_dir():
                    raise ValueError(f"model data path does not exist: {model_data}")
                command.extend(["--data-path", str(model_data)])
            for option, field in (
                ("--language", "language"),
                ("--model", "model"),
                ("--beam-size", "beam_size"),
                ("--speed", "speed"),
                ("--instrumental-spans", "instrumental_spans"),
                ("--timing-reference", "timing_reference"),
                ("--sung-spans", "sung_spans"),
            ):
                if field in track:
                    value = outside_checkout(Path(track[field]), field) if field.endswith("_spans") or field == "timing_reference" else track[field]
                    command.extend([option, str(value)])
                elif field in candidate:
                    command.extend([option, str(candidate[field])])
            if "condition_on_previous_text" in candidate:
                flag = "--condition-on-previous-text" if candidate["condition_on_previous_text"] else "--no-condition-on-previous-text"
                command.append(flag)

            completed = subprocess.run(command, cwd=REPO, capture_output=True, text=True)
            if completed.returncode:
                raise RuntimeError(
                    f"candidate {candidate_id}, track {track_id} failed ({completed.returncode}): "
                    f"{completed.stderr[-1500:]}"
                )
            report = read_json(report_path)
            reports_for_candidate.append(report)
        reference_words = sum(row["reference_word_count"] for row in reports_for_candidate)
        edit_errors = sum(row["substitutions"] + row["deletions"] + row["insertions"] for row in reports_for_candidate)
        per_track_wers = [float(row["word_error_rate"]) for row in reports_for_candidate]
        reports.append({
            "candidate_id": candidate_id,
            "candidate": candidate,
            "recordings": len(reports_for_candidate),
            "reference_words": reference_words,
            "edit_errors": edit_errors,
            "aggregate_wer": round(edit_errors / max(1, reference_words), 6),
            "median_recording_wer": round(statistics.median(per_track_wers), 6),
            "maximum_recording_wer": round(max(per_track_wers), 6),
            "instrumental_insertions": sum(
                int((row.get("instrumental_insertions") or {}).get("hypothesis_words_in_spans", 0))
                for row in reports_for_candidate
            ),
            "sung_span_omissions": sum(
                int((row.get("sung_span_omissions") or {}).get("omitted_words", 0))
                for row in reports_for_candidate
            ),
            "recording_reports": reports_for_candidate,
        })

    baseline = next((row for row in reports if row["candidate"].get("baseline") is True), None)
    if baseline:
        baseline_wer = baseline["aggregate_wer"]
        for row in reports:
            row["relative_wer_reduction_vs_baseline"] = (
                round((baseline_wer - row["aggregate_wer"]) / baseline_wer, 6) if baseline_wer else None
            )
            row["worst_recording_regression_vs_baseline"] = round(max(
                (candidate_report["word_error_rate"] - baseline_report["word_error_rate"])
                for candidate_report, baseline_report in zip(row["recording_reports"], baseline["recording_reports"])
            ), 6) if row is not baseline and len(row["recording_reports"]) == len(baseline["recording_reports"]) else 0.0

    return {"schema_version": 1, "manifest": manifest_path.name, "reports": reports}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--candidates", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--data-path", type=Path, help="existing local model cache")
    args = parser.parse_args()
    try:
        report = evaluate(args)
        target = args.output_dir.expanduser().resolve() / "matrix.report.json"
        target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(target)
        return 0
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as exc:
        parser.error(str(exc))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
