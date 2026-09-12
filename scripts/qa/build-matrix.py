#!/usr/bin/env python3
"""Rebuilds render-matrix.csv from the per-case gate.json files."""
import csv, json, pathlib, sys
A = pathlib.Path(sys.argv[1])
rows = []
for case in ("C1", "C2", "C3", "C4", "C5", "C6"):
    gate = A / "media-validation" / case / "gate.json"
    if not gate.exists():
        continue
    data = json.loads(gate.read_text())
    for c in data["clips"]:
        caption = c.get("caption_strip_vs_source_mad") or c.get("caption_strip_bright_ratio")
        rows.append({
            "case": case, "job_id": data["job_id"], "clip_index": c["index"], "verdict": c["verdict"],
            "dimensions": c.get("dimensions"), "duration_s": round(c.get("duration", 0), 2),
            "layout": c.get("layout"),
            "freeze_pct": c.get("freeze_pct"), "freeze_longest_s": c.get("freeze_longest"),
            "black_pct": c.get("black_pct"),
            "median_ydif": c.get("median_ydif"), "source_median_ydif": c.get("source_median_ydif"),
            "stdev_yavg": c.get("stdev_yavg"), "distinct_frames_of_8": c.get("distinct_frame_hashes"),
            "source_match_mad": c.get("source_vs_output_mad"), "decoy_mad": c.get("decoy_mad"),
            "mean_volume_db": c.get("mean_volume_db"), "max_volume_db": c.get("max_volume_db"),
            "caption_band": json.dumps(caption) if caption else "",
            "not_applicable": ";".join(c.get("not_applicable") or []),
            "failed_checks": ";".join(x["check"] for x in c["checks"] if x["result"] == "FAIL"),
        })
with (A / "render-matrix.csv").open("w", newline="") as fh:
    writer = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
    writer.writeheader()
    writer.writerows(rows)
print(f"{len(rows)} clip rows; PASS={sum(1 for r in rows if r['verdict']=='PASS')}")
for r in rows:
    print(f"  {r['case']} clip{r['clip_index']} {r['verdict']:<5} {r['dimensions']:>9} {r['duration_s']:>6}s {r['failed_checks'][:50]}")
