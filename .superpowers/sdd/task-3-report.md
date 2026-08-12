# Task 3 report: Gemini exhaustion sentinel + `--monitor` flag

## Status
Done.

## Commit
b97118b — "feat(pipeline): --monitor disables fallbacks; flag Gemini exhaustion"
(branch: codex/monitor-clip-quality)

## Changes
- `src/clippyme/pipeline/run_ops.py`: added `should_use_fallback(monitor_mode: bool) -> bool`
  (`return not monitor_mode`), pure/host-tested.
- `tests/test_run_ops.py`: added `test_fallback_enabled_for_normal_jobs` and
  `test_fallback_disabled_in_monitor_mode`.
- `src/clippyme/pipeline/main.py`:
  - New `--monitor` CLI flag (store_true), added next to `--aspect`.
  - `get_viral_clips`: sets `get_viral_clips._last_gemini_exhausted = False` at
    the top of every call; the existing `try/except` around
    `generate_with_model_fallback` now checks `is_rate_limit_error(e)` and, if
    true, sets the sentinel `True` and prints the exhaustion message before
    returning `None` (existing generic error path/print preserved for all
    other exceptions).
  - The two fallback branches (~line 764) are now gated by
    `should_use_fallback(args.monitor)`: TextTiling only runs when fallback is
    enabled; when there are still no shorts, monitor mode writes
    `{'shorts': [], 'transcript': transcript, 'aspect': args.aspect}` (+
    `'gemini_exhausted': True` if the sentinel was set) atomically to
    `{video_title}_metadata.json` and exits that branch cleanly instead of
    rendering the whole-video fallback. Normal (non-monitor) jobs keep the
    original whole-video fallback behavior unchanged.
  - Added `should_use_fallback` to the existing `from clippyme.pipeline.run_ops
    import (...)` line inside `__main__`.

## Test summary
`pytest tests/test_run_ops.py -v` -> 5 passed (3 pre-existing + 2 new); `python -c
"import clippyme.pipeline.main"` -> clean import, no errors (ran in
clippyme-backend container).

## Concerns
None. Scope stayed within the three named files; no unrelated code touched.
