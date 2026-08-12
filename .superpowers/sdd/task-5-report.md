# Task 5 report: Consolidated folder, compose-on-completion, title filenames

**Status:** COMPLETE
**Commit:** `5727646` (branch `feat/monitor-consolidate-clips`)
**Tests:** `tests/domain/test_live_monitor.py` 92 passed; full host suite
`pytest -m "not integration"` 980 passed, 34 deselected; ruff (E9,F63,F7,F82) clean.

> Note: this file previously held an unrelated (frontend monitor-panel) report;
> it was the designated destination for THIS backend task, so it was overwritten.

## What changed (`src/clippyme/domain/live_monitor.py`)

- **`allocate_clip_filename(title_template, clip, existing, counter)`** — new pure,
  module-level helper (verbatim per brief). Module-level import
  `from clippyme.pipeline.run_ops import sanitize_windows_basename` (run_ops is
  stdlib-only, host-safe).
- **`__init__`** — `self._clip_dir = output_dir/"monitor_"+id.replace(":","_")`
  (derived, not persisted) and `self._name_counter = 0`.
- **`snapshot()`/`restore()`** — `name_counter` persisted (mirrors
  `pending_publish`/`publishing_enabled`); folder path derived, not persisted.
- **`_consolidate_clips(job_id, clips)`** — composes every good clip into
  `self._clip_dir`, title-named via the continuous counter, returns
  `[{"job_id","clip","composed_path"}]`; per-clip failures logged, not fatal.
- **`_await_and_publish`** — exhaustion handling (`gemini_exhausted`) PRESERVED;
  the direct publish loop replaced with consolidate-then-publish-consolidated.
- **`_compose_for_publish(job_id, clip, base_path=None)`** — `base_path=None`
  resolves the raw clip and composes, RAISING on failure (consolidation handles
  it per-clip); a passed `base_path` keeps the old fallback-on-failure behavior
  (used only by the drain-recompose path).
- **`_publish_one(entry)`** — signature changed from `(job_id, clip)` to
  `(entry)`. Uploads `entry["composed_path"]` directly (no re-compose), dedupes
  on the RAW clip path, queues the entry when paused; recomposes via
  `_compose_for_publish` only if a restored entry's `composed_path` vanished.
- **`_drain_pending`** — passes the whole entry to `_publish_one`.
- **`_delete_clip_artifacts` call site** — now passes `clip_path` for the
  upload_path arg (was `upload_path`). The consolidated composed file is the
  durable deliverable and is deliberately KEPT; the job-dir composed file is
  still cleaned via the existing `composed_clip_{idx}.mp4` target.
  `_delete_clip_artifacts` itself is unchanged.

## Existing-test signature adjustments (`tests/domain/test_live_monitor.py`)

`_publish_one` changed from `(job_id, clip)` to `(entry)`. Minimal updates:

- `_publishing_monitor` helper's `_no_compose` gained a `base_path=None` default.
- Six publish tests (`test_publish_one_retries_on_429_then_succeeds`,
  `_rolls_start_date_on_daily_limit`, `_non_429_fails_without_retry`,
  `test_successful_publish_deletes_clip_files_and_empty_dir`,
  `_keeps_dir_and_marks_metadata_when_clips_remain`,
  `test_deletion_failure_does_not_raise...`) now build
  `entry = {"job_id","clip","composed_path": <existing file>}` and call
  `_publish_one(entry)`.
- `test_paused_publish_queues_instead_of_publishing` — asserts the queued /
  snapshot / restored `_pending_publish` equals `[entry]` (now carries
  `composed_path`).
- `test_resume_drains_pending_in_order_with_spacing` and
  `test_restored_monitor_with_pending_and_enabled_drains_on_start` — pending
  entries now include `composed_path`.

Added the 3 new pure allocator tests verbatim from the brief.

## Concerns

- None blocking. The per-monitor folder (`monitor_<id>/`) is now a durable,
  growing library of composed clips, kept intentionally after publish. No
  retention/cleanup exists for it (out of scope); add one if disk growth matters.

## Review fixes (commit `604ed4f`)

Addressed all three review findings:

1. **IMPORTANT — `_drain_pending` lost entries on a raising recompose.** The
   per-entry `_publish_one(entry)` call is now wrapped in try/except: on
   exception (e.g. a restored entry whose `composed_path` vanished →
   `_compose_for_publish(base_path=None)` raises) it logs via `logger.exception`
   and re-appends the popped entry to `self._pending_publish` (then persists),
   so it retries rather than being lost. A single bad entry no longer aborts
   draining the rest — consistent with `_await_and_publish`'s guard.
2. **MINOR (atomicity) — `_consolidate_clips` copy is now atomic.**
   `shutil.copyfile(composed, dest+".tmp")` then `os.replace(dest+".tmp", dest)`,
   so a crash mid-copy never orphans a partial `.mp4` (which would also
   permanently reserve its title filename).
3. **MINOR (coverage) — new host test**
   `test_drain_recomposes_missing_composed_path_and_survives_failure`: queues a
   pending entry whose `composed_path` is missing plus a good sibling, spies
   `_compose_for_publish` (raises once, then succeeds), and asserts recompose is
   invoked, the sibling publishes, the failing entry is retried (not lost), and
   the queue fully drains.

Cosmetic "counter burned on compose failure" Minor left as-is per instruction.

### Re-run test output
- `tests/domain/test_live_monitor.py` — 93 passed.
- Full host suite `pytest -m "not integration" -q` — 981 passed, 34 deselected.
- ruff (E9,F63,F7,F82) — all checks passed.
