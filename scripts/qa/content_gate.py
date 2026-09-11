#!/usr/bin/env python3
"""The §5 content gate: proves a rendered clip contains real moving picture and
real audio taken from the imported source — not a frozen frame, a black screen,
a placeholder text card, or an unrequested silent render.

Every stage runs inside the engine container so the bytes examined are the same
bytes the engine wrote. Usage:

  python3 scripts/qa/content_gate.py <artifact-dir> <case-id> <job-id> \
      --aspect 9:16 --subtitles on [--duration-min 8 --duration-max 60]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import statistics
import subprocess
import sys
import urllib.request
from pathlib import Path

ENGINE = ["docker", "compose", "exec", "-T", "engine"]
GATEWAY = "http://127.0.0.1:8080"
ASPECT_DIMS = {"9:16": (1080, 1920), "1:1": (1080, 1080), "16:9": (1920, 1080), "4:5": (1080, 1350)}


def run(args: list[str], binary: bool = False) -> tuple[int, bytes | str, str]:
    proc = subprocess.run(ENGINE + args, capture_output=True)
    err = proc.stderr.decode("utf-8", "replace")
    return proc.returncode, (proc.stdout if binary else proc.stdout.decode("utf-8", "replace")), err


def layout_crops(src_w: int, src_h: int, dst_w: int, dst_h: int) -> tuple[str | None, str | None]:
    """Mirrors engine/media.py:_source_layout_filter so the frame comparison
    lines up with whichever layout the renderer actually used.

    Returns (source_crop, output_crop) as ffmpeg filters. Near-equal aspects are
    centre-cropped, so the SOURCE is cropped to the target shape. Materially
    different aspects get a blurred zoom-fill behind the whole source fitted in
    the middle, so the OUTPUT is cropped down to that fitted band instead.
    """
    if abs((src_w / src_h) / (dst_w / dst_h) - 1) <= 0.12:
        ratio = dst_w / dst_h
        return f"crop='min(iw,ih*{ratio})':'min(ih,iw/{ratio})'", None
    scale = min(dst_w / src_w, dst_h / src_h)
    fit_w, fit_h = round(src_w * scale), round(src_h * scale)
    return None, f"crop={fit_w}:{fit_h}:{(dst_w - fit_w) // 2}:{(dst_h - fit_h) // 2}"


def gray(path: str, timestamp: float, size: int = 16, crop: str | None = None) -> bytes | None:
    """One frame as raw 8-bit grayscale, straight out of the container."""
    chain = f"{crop + ',' if crop else ''}scale={size}:{size},format=gray"
    code, out, _ = run(["ffmpeg", "-v", "error", "-ss", f"{timestamp:.3f}", "-i", path,
                        "-frames:v", "1", "-vf", chain, "-f", "rawvideo", "-"], binary=True)
    return out if code == 0 and len(out) == size * size else None


def mad(a: bytes, b: bytes) -> float:
    return sum(abs(x - y) for x, y in zip(a, b)) / len(a)


def variance(data: bytes) -> float:
    return statistics.pvariance(list(data)) if len(data) > 1 else 0.0


def check(results: list, name: str, ok: bool, detail) -> bool:
    results.append({"check": name, "result": "PASS" if ok else "FAIL", "detail": detail})
    return ok


def skip(results: list, name: str, detail) -> None:
    """Records a check the engine itself declared inapplicable. It does not pass
    the gate silently — the reason is carried into the report."""
    results.append({"check": name, "result": "N/A", "detail": detail})


def clip_warnings(job: dict, index: int) -> list[str]:
    return [w for w in job.get("warnings", []) if re.match(rf"Clip {index}\b", w)]


def gate_clip(clip: dict, job: dict, args, out_dir: Path) -> dict:
    job_id = job["id"]
    name = clip.get("outputName") or f"{clip['index']:02d}-cut.mp4"
    path = f"/app/data/jobs/{job_id}/clips/{name}"
    results: list = []
    report = {"clip_id": clip["id"], "index": clip["index"], "path": path, "checks": results}

    # 5.1 container and stream sanity ---------------------------------------
    code, out, err = run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", path])
    if code != 0:
        check(results, "5.1 ffprobe", False, f"ffprobe failed: {err.strip()[:300]}")
        report["verdict"] = "FAIL"
        return report
    probe = json.loads(out)
    (out_dir / f"{clip['index']:02d}-ffprobe.json").write_text(json.dumps(probe, indent=2))
    video = next((s for s in probe["streams"] if s["codec_type"] == "video"), None)
    audio = next((s for s in probe["streams"] if s["codec_type"] == "audio"), None)
    duration = float(probe["format"].get("duration", 0))
    bitrate = int(probe["format"].get("bit_rate", 0) or 0)
    report["duration"] = duration
    report["dimensions"] = f"{video['width']}x{video['height']}" if video else None

    check(results, "5.1 video codec h264", bool(video) and video["codec_name"] == "h264",
          video["codec_name"] if video else "no video stream")
    silent_ok = any("silent" in w.lower() or "no speech" in w.lower() for w in job.get("warnings", []))
    check(results, "5.1 audio codec aac", bool(audio) and audio["codec_name"] == "aac",
          (audio["codec_name"] if audio else "no audio stream") + (" (job warned silent)" if silent_ok else ""))
    want = ASPECT_DIMS[args.aspect]
    check(results, f"5.1 dimensions == {args.aspect} {want[0]}x{want[1]}",
          bool(video) and (video["width"], video["height"]) == want, report["dimensions"])
    if args.duration_exact is not None:
        check(results, f"5.1 duration == {args.duration_exact}s ±0.5",
              abs(duration - args.duration_exact) <= 0.5, f"{duration:.3f}s")
    else:
        check(results, f"5.1 duration within [{args.duration_min}, {args.duration_max}]",
              args.duration_min - 0.5 <= duration <= args.duration_max + 0.5, f"{duration:.3f}s")
    check(results, "5.1 non-zero bitrate", bitrate > 0, bitrate)
    fps_parts = (video.get("avg_frame_rate") or "0/1").split("/") if video else ["0", "1"]
    fps = float(fps_parts[0]) / float(fps_parts[1]) if float(fps_parts[1]) else 0.0
    frames = int(video.get("nb_frames") or 0) if video else 0
    expected = duration * fps
    check(results, "5.1 nb_frames consistent with duration x fps",
          bool(expected) and abs(frames - expected) / expected < 0.10 if frames else False,
          f"nb_frames={frames} expected~{expected:.0f} fps={fps:.2f}")

    # Layout discovery: the renderer either centre-crops the source or fits the
    # whole of it inside a blurred zoom-fill. Later checks must look at the band
    # the picture actually occupies, not at the deliberately quiet fill.
    _, source_listing, _ = run(["sh", "-c", f"ls /app/data/jobs/{job_id}/source/"])
    source_name = source_listing.strip().splitlines()[0] if source_listing.strip() else None
    source_path = f"/app/data/jobs/{job_id}/source/{source_name}" if source_name else None
    src_w = src_h = 0
    src_dur = 0.0
    if source_path:
        code, sdims, _ = run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                              "-show_entries", "stream=width,height,duration", "-of", "json", source_path])
        if code == 0:
            sstream = json.loads(sdims)["streams"][0]
            src_w, src_h = int(sstream.get("width", 0)), int(sstream.get("height", 0))
            src_dur = float(sstream.get("duration") or 0)
    src_crop, out_crop = layout_crops(src_w, src_h, *ASPECT_DIMS[args.aspect]) if src_w and src_h else (None, None)
    report["layout"] = "centre-crop" if src_crop or not out_crop else "fitted-with-blurred-fill"
    report["content_band"] = out_crop

    # 5.2 full decode --------------------------------------------------------
    code, out, err = run(["ffmpeg", "-v", "error", "-i", path, "-f", "null", "-"])
    decode = (out + err).strip()
    (out_dir / f"{clip['index']:02d}-decode.log").write_text(decode or "(clean)")
    check(results, "5.2 full decode without errors", decode == "", decode[:300] or "clean")

    # 5.3 freeze detection ---------------------------------------------------
    _, out, err = run(["ffmpeg", "-hide_banner", "-i", path, "-vf", "freezedetect=n=-60dB:d=2",
                       "-map", "0:v", "-f", "null", "-"])
    freeze_log = "\n".join(l for l in (out + err).splitlines() if "freezedetect" in l)
    (out_dir / f"{clip['index']:02d}-freeze.log").write_text(freeze_log or "(none)")
    spans = [float(m) for m in re.findall(r"freeze_duration:\s*([0-9.]+)", freeze_log)]
    frozen = sum(spans)
    report["freeze_pct"] = round(100 * frozen / duration, 2) if duration else None
    report["freeze_longest"] = round(max(spans), 2) if spans else 0.0
    check(results, "5.3 frozen <= 25% of clip", duration and frozen / duration <= 0.25,
          f"{frozen:.2f}s of {duration:.2f}s = {report['freeze_pct']}%")
    check(results, "5.3 no freeze span > 3s", not spans or max(spans) <= 3.0,
          f"longest {report['freeze_longest']}s")

    # 5.4 black detection ----------------------------------------------------
    _, out, err = run(["ffmpeg", "-hide_banner", "-i", path, "-vf", "blackdetect=d=0.5:pix_th=0.10",
                       "-an", "-f", "null", "-"])
    black_log = "\n".join(l for l in (out + err).splitlines() if "blackdetect" in l)
    (out_dir / f"{clip['index']:02d}-black.log").write_text(black_log or "(none)")
    black = sum(float(m) for m in re.findall(r"black_duration:\s*([0-9.]+)", black_log))
    report["black_pct"] = round(100 * black / duration, 2) if duration else None
    check(results, "5.4 black <= 15% of clip", duration and black / duration <= 0.15,
          f"{black:.2f}s = {report['black_pct']}%")

    # 5.5 frame-to-frame motion statistics -----------------------------------
    # Measured inside the picture band: on a fitted layout roughly two thirds of
    # the canvas is an intentionally blurred, darkened fill, and including it
    # drags YDIF below the threshold even when the footage moves normally.
    movie = f"movie={path}" + (f",{out_crop}" if out_crop else "")
    _, out, _ = run(["ffprobe", "-f", "lavfi", "-i", f"{movie},signalstats",
                     "-show_entries", "frame_tags=lavfi.signalstats.YAVG,lavfi.signalstats.YDIF",
                     "-of", "csv"])
    yavg, ydif = [], []
    for line in out.splitlines():
        parts = line.strip().split(",")
        if len(parts) >= 3:
            try:
                yavg.append(float(parts[1]))
                ydif.append(float(parts[2]))
            except ValueError:
                continue
    (out_dir / f"{clip['index']:02d}-signalstats.csv").write_text(out)
    median_ydif = statistics.median(ydif) if ydif else 0.0
    stdev_yavg = statistics.pstdev(yavg) if len(yavg) > 1 else 0.0
    report["median_ydif"] = round(median_ydif, 3)
    report["stdev_yavg"] = round(stdev_yavg, 3)
    check(results, "5.5 median YDIF >= 0.5 (picture is moving)", median_ydif >= 0.5, report["median_ydif"])
    check(results, "5.5 YAVG stdev >= 1.0 (photographic, not a flat card)", stdev_yavg >= 1.0, report["stdev_yavg"])

    # 5.6 sampled frames differ ---------------------------------------------
    stamps = [duration * (i + 0.5) / 8 for i in range(8)]
    frames_gray = [gray(path, t, 32) for t in stamps]
    got = [f for f in frames_gray if f]
    digests = {hashlib.sha256(f).hexdigest() for f in got}
    report["distinct_frame_hashes"] = len(digests)
    check(results, "5.6 >= 6 distinct frames of 8 sampled", len(digests) >= 6,
          f"{len(digests)} distinct from {len(got)} extracted")

    sheet = f"/app/data/qa-downloads/{args.run}/{args.case}-{clip['index']:02d}-contact.jpg"
    run(["mkdir", "-p", f"/app/data/qa-downloads/{args.run}"])
    run(["ffmpeg", "-y", "-v", "error", "-i", path, "-vf",
         f"fps=8/{max(duration, 0.1):.3f},scale=320:-1,tile=4x2", "-frames:v", "1", sheet])
    report["contact_sheet"] = sheet

    # 5.7 the output is the source, not a fallback card ----------------------
    provenance = clip.get("provenance") or []
    visual = clip.get("visualLabel")
    card = any("card" in str(p.get("provider", "")).lower() or "card" in str(p.get("matchReason", "")).lower()
               for p in provenance)
    check(results, "5.7 clip mode did not substitute a text card",
          not (card and job.get("mode") == "clip"),
          f"visualLabel={visual!r} provenance={[p.get('provider') for p in provenance]}")

    if source_path:
        # The output's midpoint corresponds to this timecode in the source.
        mid_out = duration / 2
        mid_src = clip["start"] + mid_out
        b = gray(path, mid_out, 32, out_crop)
        a = gray(source_path, mid_src, 32, src_crop)
        # A decoy far from the cut calibrates what "a different scene" costs for
        # this particular video, so the verdict is not an absolute threshold
        # carried over from some other source.
        decoy_t = (mid_src + src_dur / 2) % src_dur if src_dur > 1 else 0.0
        d = gray(source_path, decoy_t, 32, src_crop)
        if a and b:
            diff = mad(a, b)
            decoy_diff = mad(d, b) if d else None
            report["source_vs_output_mad"] = round(diff, 2)
            report["decoy_mad"] = round(decoy_diff, 2) if decoy_diff is not None else None
            # Scaling, the blurred fill and burned captions keep this above zero;
            # the matched timecode must still be clearly closer than the decoy.
            ok = diff <= 30.0 and (decoy_diff is None or diff < decoy_diff * 0.7)
            check(results, "5.7 output frame matches the source at the same timecode", ok,
                  f"{report['layout']}: MAD {diff:.2f} at matched t={mid_src:.2f}s vs decoy "
                  f"{report['decoy_mad']} at t={decoy_t:.2f}s")
        else:
            check(results, "5.7 output frame matches the source at the same timecode", False,
                  "could not extract comparison frames")
    else:
        check(results, "5.7 source available for comparison", False, "no source file found")

    # 5.8 audio is real ------------------------------------------------------
    _, out, err = run(["ffmpeg", "-i", path, "-af", "volumedetect", "-vn", "-f", "null", "-"])
    vol_log = "\n".join(l for l in (out + err).splitlines() if "volumedetect" in l)
    (out_dir / f"{clip['index']:02d}-volume.log").write_text(vol_log or "(none)")
    mean_m = re.search(r"mean_volume:\s*(-?[0-9.]+) dB", vol_log)
    max_m = re.search(r"max_volume:\s*(-?[0-9.]+) dB", vol_log)
    mean_db = float(mean_m.group(1)) if mean_m else None
    max_db = float(max_m.group(1)) if max_m else None
    report["mean_volume_db"] = mean_db
    report["max_volume_db"] = max_db
    if silent_ok:
        check(results, "5.8 silent render was explicitly warned", True,
              f"mean={mean_db} max={max_db} dB; job warned about silence")
    else:
        check(results, "5.8 mean_volume > -50 dB", mean_db is not None and mean_db > -50.0,
              f"mean={mean_db} dB max={max_db} dB")
        check(results, "5.8 not digital silence", max_db is not None and max_db > -90.0, f"max={max_db} dB")

    # 5.9 captions ------------------------------------------------------------
    warned_no_captions = [w for w in clip_warnings(job, clip["index"])
                          if re.search(r"without captions|no speech", w, re.I)]
    if args.subtitles == "on" and warned_no_captions:
        # The engine said out loud that this cut carries no speech. That is a
        # truthful fallback, not a silently dropped caption track — but it is
        # surfaced here so the report never reads as if captions were verified.
        skip(results, "5.9 burned captions", f"engine warning: {warned_no_captions[0]}")
    elif args.subtitles == "on":
        cues = []
        try:
            with urllib.request.urlopen(f"{GATEWAY}/api/v1/jobs/{job_id}/clips/{clip['id']}/captions/srt", timeout=20) as r:
                srt = r.read().decode("utf-8", "replace")
            (out_dir / f"{clip['index']:02d}-captions.srt").write_text(srt)
            for m in re.finditer(r"(\d+):(\d+):(\d+),(\d+)\s*-->\s*(\d+):(\d+):(\d+),(\d+)", srt):
                g = [int(x) for x in m.groups()]
                cues.append((g[0] * 3600 + g[1] * 60 + g[2] + g[3] / 1000,
                             g[4] * 3600 + g[5] * 60 + g[6] + g[7] / 1000))
        except Exception as exc:  # noqa: BLE001 — the failure itself is the finding
            check(results, "5.9 caption SRT available", False, str(exc)[:200])
        check(results, "5.9 caption cue list is non-empty", bool(cues), f"{len(cues)} cues")
        if cues:
            inside = all(-0.5 <= s and e <= duration + 0.5 for s, e in cues)
            check(results, "5.9 cue timings fall inside the clip", inside,
                  f"first={cues[0]} last={cues[-1]} duration={duration:.2f}")
            lower = "crop=iw:ih/3:0:ih*2/3"
            during = [variance(f) for f in (gray(path, (s + e) / 2, 32, lower) for s, e in cues[:3]) if f]
            gaps = [(cues[i][1] + cues[i + 1][0]) / 2 for i in range(len(cues) - 1)
                    if cues[i + 1][0] - cues[i][1] > 0.3]
            gap_var = None
            if gaps:
                g = gray(path, gaps[len(gaps) // 2], 32, lower)
                gap_var = variance(g) if g else None
            report["caption_band_variance"] = {"during_cues": [round(v, 1) for v in during],
                                               "in_gap": round(gap_var, 1) if gap_var is not None else None}
            if during and gap_var is not None:
                check(results, "5.9 caption band is busier during cues than in a gap",
                      statistics.mean(during) > gap_var * 1.05,
                      f"during={[round(v, 1) for v in during]} gap={gap_var:.1f}")
            elif during:
                check(results, "5.9 caption band carries detail during cues",
                      statistics.mean(during) > 50, f"during={[round(v, 1) for v in during]}")
    else:
        burn = run(["sh", "-c", f"ls /app/data/jobs/{job_id}/clips/ | grep -c 'burn.ass' || true"])[1].strip()
        check(results, "5.9 no burned-caption artefacts requested", burn == "0",
              f"{burn} burn.ass files present with subtitles OFF")

    report["verdict"] = "FAIL" if any(r["result"] == "FAIL" for r in results) else "PASS"
    report["not_applicable"] = [r["check"] for r in results if r["result"] == "N/A"]
    return report


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("artifact_dir")
    p.add_argument("case")
    p.add_argument("job_id")
    p.add_argument("--run", required=True)
    p.add_argument("--aspect", required=True, choices=list(ASPECT_DIMS))
    p.add_argument("--subtitles", required=True, choices=["on", "off"])
    p.add_argument("--duration-min", type=float, default=8.0)
    p.add_argument("--duration-max", type=float, default=180.0)
    p.add_argument("--duration-exact", type=float, default=None)
    args = p.parse_args()

    with urllib.request.urlopen(f"{GATEWAY}/api/v1/jobs/{args.job_id}", timeout=30) as r:
        job = json.loads(r.read())

    out_dir = Path(args.artifact_dir) / "media-validation" / args.case
    out_dir.mkdir(parents=True, exist_ok=True)

    clips = [c for c in job.get("clips", []) if c.get("state") == "complete"]
    reports = [gate_clip(c, job, args, out_dir) for c in clips]
    summary = {
        "case": args.case, "job_id": args.job_id, "job_state": job.get("state"),
        "job_warnings": job.get("warnings", []),
        "clips_complete": len(clips), "clips_total": len(job.get("clips", [])),
        "verdict": "PASS" if reports and all(r["verdict"] == "PASS" for r in reports) else "FAIL",
        "clips": reports,
    }
    (out_dir / "gate.json").write_text(json.dumps(summary, indent=2))

    for rep in reports:
        print(f"--- clip {rep['index']} [{rep['verdict']}] {rep.get('dimensions')} {rep.get('duration', 0):.2f}s")
        for c in rep["checks"]:
            if c["result"] == "FAIL":
                print(f"      FAIL {c['check']}: {c['detail']}")
    print(json.dumps({k: v for k, v in summary.items() if k != "clips"}, indent=2))
    return 0 if summary["verdict"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
