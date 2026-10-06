# High-volume batches — issue and verification ledger

Branch: `feat/high-volume-batches-20261005233033`
Worktree: `/home/linuxpc/Git_projects/S6_CUT-high-volume-20261005233033`
Baseline: `origin/main` at `352782f`
Isolation: this worktree and later Compose run use a unique project name, data directory, and ports. The owner checkout and its `data/` are not used.

## Plan / file ownership

- Apply agent: production implementation in engine, web production files, and product docs.
- Test agent: engine/web tests and `tests/acceptance/high-volume-batches.spec.ts` only.
- Verify agent: independent read-only contract review, test runs, and media validation.
- Lead: coordination, issue repair/integration, isolated deployment, quality gate, and delivery.

## Acceptance criteria

1. Explicit opt-in High-volume count is an integer 1–500; Standard remains 1–30. API rejects invalid counts/mode combinations.
2. High-volume short/landscape Fast, Auto, and supported Smart plans are deterministic, source-/duration-bounded, 0.1-second distinct starts, may overlap, and never duplicate/pad.
3. Request is attempted up to 500. Under 1,800 seconds retain feasible requests (including 500); only if infeasible apply `min(requested, 300, actual valid windows)`. At/above 1,800 seconds explain genuine shortages. Smart uses transcript-aware validated candidates without Standard-only search/overlap caps.
4. Persist requested/effective/planned/successful counts, exact reduction reasons, durable target/window plan, and stable retry/recovery behavior. YouTube imports show pending duration analysis.
5. 500 clips can be selected/exported; manifests/credits refer only to published files. Standard/Music and publication/security invariants remain unchanged.
6. Tests cover limits, source boundaries, plan properties, persisted/recovery behavior, selection/export, and accessible UI. Distinguish mock UI from real render evidence.
7. Required checks: `npm run check` (or `npm run check:supported` if host dependencies are missing), `docker compose config`, affected Playwright tests on rebuilt isolated production gateway.
8. Real evidence, if feasible: authorized real YouTube import reused as one immutable source, then a 500-output FFmpeg job with inspected media/export/browser playback artifacts. Never report mocked/skipped/interrupted evidence as an end-to-end pass.

## Initial issue ledger

| ID | Finding | Severity | Status |
|---|---|---:|---|
| HV-1 | Standard UI count is limited to 30; clip-job API uses `le=30`. | High | Implementation added; awaiting independent and isolated acceptance verification |
| HV-2 | Standard project/selection models cap at 60 (selection must support 500). | High | Project count now allows 500; selection model now allows 500; awaiting API/export verification |
| HV-3 | Standard planners suppress overlap and candidate count depends on non-overlapping footage. | High | Separate Fast/landscape planner added; high-volume Smart landscape now routes through the transcript planner; focused tests pending |
| HV-4 | Dirty shared checkout contains a high-volume prototype plus unrelated Music edits in overlapping files; its below-1,800s policy always caps at 200 and cannot satisfy request. | High | Isolated; do not copy whole dirty files; current branch attempts requested count first |
| HV-5 | Smart candidate creation has an existing `min(30, requested*3)` pool ceiling; inappropriate for high-volume. | High | Independent review exposed a wrong `_timed_words` call and sub-tenth starts; fixed with FFprobe bounds and tenth-second-aligned starts, awaiting focused retest |
| HV-6 | Selection/export, Workspace visibility, and notices need auditing for 500/recovery/mobile support. | Medium | UI/API accept 500; 500 ZIP fixture now uses registered assets and valid MP4 media; mocked browser test awaits isolated gateway; genuine render pending |
| HV-7 | Host lacks FFmpeg/FFprobe and Python packages; Docker Compose is available. Use the supported container check and isolated real deployment. | Blocker | Investigating |
| HV-8 | Need real-media throughput and authorized YouTube source proof; this is much more expensive than planner/UI tests. | Blocker | Investigating |

## Iteration log

### 0 — isolation and baseline (2026-10-05 UTC)

- Read `DO-NOT-CHANGE/AGENTS.md`, `ARCHITECTURE.md`, `README.md`, `package.json`, and `playwright.config.ts`.
- Shared checkout had uncommitted Music and high-volume edits; left it untouched.
- Fetched `origin`; created this worktree from `origin/main` commit `352782f`.
- Baseline `docker compose config`: PASS.
- `npm run check:providers`: PASS.
- `npm run typecheck`: initially blocked because `node_modules` was absent; `npm ci` completed successfully in the isolated worktree.
- Host `ffmpeg`/`ffprobe` absent; Python 3.14 has no pip/engine dependencies. Container path required.
- Verified a real-source candidate: Blender's official YouTube upload `https://www.youtube.com/watch?v=eRsGyueVLvQ` is public, 14:48, uploaded by Blender; the official Sintel sharing page (`https://durian.blender.org/sharing/`) states CC BY 3.0 and provides attribution terms. This is suitable for authorized real-import testing if the app's normal download completes.
- Test agent ran a mocked Playwright case against `http://127.0.0.1:8080` (non-isolated/owner deployment port) before the feature gateway was built. It timed out waiting for High-volume; the retained screenshot at `test-artifacts/test-results/high-volume-batches-high-v-64da2-ts-all-mocked-completed-ids/test-failed-1.png` and trace at the same directory show the old deployed bundle, so no source/job was submitted. Root cause is the incorrect acceptance target, not a feature regression. Do not repeat on 8080; rerun only against the new isolated gateway.

### 1 — independent review and failure/repair (2026-10-05 UTC)

- Web quality checks: `npm run lint`, `npm run check:providers`, `npm run typecheck`, `npm test` (22 files / 281 tests), and `npm run build` all PASS.
- Independent Verify agent reproduced a High-volume Smart `TypeError` from calling `_timed_words` with an unsupported duration parameter. Lead repaired it by filtering `_timed_words` output against actual FFprobe duration, and then quantizing Smart starts down to supported tenth-second boundaries so actual (not just rounded) starts remain distinct.
- Engine regression tests exposed a recovery bug in `_process_clip_fast`: any persisted plan was rewritten so every clip shared the first clip's full-source trim. Repaired fast recovery to preserve and validate each stored source range; only explicit Shorts Editor trim metadata may rewrite its single clip. A recovery test now asserts exact persisted windows survive.
- Review found High-volume Smart landscape was routed through per-output fast transcription rather than one timed transcript. High-volume Smart landscape now uses the transcript-aware Smart pipeline; Standard long-form routing remains unchanged. Added API/checklist tests.
- The independent verifier also identified that the 500-ZIP fixture did not represent published MP4/Library pairs. Reworked it to generate a valid tiny MP4 with FFmpeg, register 500 content-addressed clip assets, and assert a 500-file ZIP whose manifest/credits correspond to those outputs.
- The first isolated engine run could not write `/app/data` because rootless Docker mapped the host-owned 0755 sandbox; changed only `.qa/isolation-run-20261005/data` to mode 0777. The next run exposed the Smart call and recovery issues above (15 failures). Later, an initial custom full-check adapter omitted the repo's top-level `/app/tests` fixture mount and produced one `FileNotFoundError` in `test_security` (523 other tests passed). Corrected the adapter to mount `tests/` read-only; this was harness configuration, not a product defect.
- Post-repair focused container run: `test_high_volume_batches.py`, `test_api.py`, and `test_checklist_shape.py` — **92 passed** (16.71s). Final `npm run check` with the corrected isolated container adapter: ESLint, provider-reference check, TypeScript, Vitest (**22 files / 281 tests**), engine pytest (**526 passed / 2 dependency deprecation warnings / 284.03s**), and production web build — all PASS. Log: `.qa/isolation-run-20261005/npm-check-repaired.log`.
- Independent Verify found Smart-planner repeated quality/score work; the planner now considers endpoints by target-duration proximity, quality-checks the nearest valid endpoint first, and scores only final temporal samples. A regression test asserts ordinary-window quality-check counts scale with unique tenth-second starts. Residual worst case can still require extra quality checks when endpoints are rejected; no ordinary-transcript blocker remained.
- A second independent review found that reducing a 301–499-window Smart short-source plan to 300 by slicing kept only early timeline candidates. Replaced prefix slicing with a shared temporal-quantile reducer and added a 400→300 coverage test; final full suite passed. `requested_count` is API/model validated to 1–500; effective target 0 is reserved for an actual no-window result.
- Independent reviewers found no remaining correctness blocker in code. Rebuilt the isolated production Compose gateway with `.qa/real-media-run/data` on UI port 31000 and engine port 31001; `/api/v1/health` reported `ready` with FFmpeg, FFprobe, yt-dlp, and database checks true. The corrected mock-only Playwright acceptance passed (**1/1 in 8.7s**) against `http://127.0.0.1:31000`; it asserted form submission at 500, Workspace persistence/reload, 500 clip controls, deselect/reselect, and mock ZIP requests containing exactly 499/500 IDs. Artifacts: `.qa/real-media-run/playwright/`. No actual job was submitted by this test.
- After repairing Playwright regex escaping and waiting for the mocked selection response before reading controlled checkbox state, reran final `npm run check` on the final source tree: ESLint, provider-reference check, TypeScript, Vitest (**22 files / 281 tests**), engine pytest (**526 passed / 2 existing deprecation warnings / 442.51s**), and production build — all PASS. Log: `.qa/real-media-run/npm-check-final.log`. Isolated `docker compose config` and `git diff --check` also PASS.
- Genuine authorized-import run started on the isolated gateway: MIT OpenCourseWare's official YouTube upload, *Lecture 1: Algorithmic Thinking, Peak Finding* (`https://www.youtube.com/watch?v=HtSuA80QTyo`, YouTube page identifies CC BY-NC-SA; private non-commercial QA only). Request: High-volume Speech/Fast, 500 vertical outputs, 8–10s each. HTTP 202 created one real YouTube project/job; FFprobe validated **3201.1s, 640×360, 29.97 fps / AV1**; planner retained **500 requested → 500 effective → 500 planned** across the source. The job is currently rendering sequentially; do not count its partial completion as a 500-output pass. API snapshots/poll log: `.qa/real-media-run/job-current.json`, `.qa/real-media-run/job-poll.log`.
- Genuine browser playback of the first completed output succeeded on the isolated production gateway: video element `readyState=4`, 1080×1920, duration 8.008s, no media error; playback advanced to 1.17s. Screenshot: `.qa/real-media-run/real-output-playback.png`. This proves one genuine output renders/plays, not all 500. Full 500 render completion, per-file FFprobe, full selected ZIP verification, and PR/merge remain pending.
