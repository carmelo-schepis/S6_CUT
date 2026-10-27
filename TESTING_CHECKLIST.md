> Historical QA checklist: Script mode and AI Video described below have since been retired. These entries document past behavior, not supported current workflows.

# S6_CUT Autonomous Playwright Test Checklist

## Run: 2026-09-19/20 (live Docker Playwright sweep)

Private historical artifacts contain the screenshots, logs and notes for this run. No destructive project or data operations were performed.

| Feature | Route/entry point | Status | Evidence | Notes |
|---|---|---|---|---|
| Deployment/health gate | Compose health checks | PASS (initial) | Private QA archive | web, engine and pot-provider healthy at startup |
| Full live route sweep | All seven rail routes + Help | PASS (desktop; mobile shell captured) | Private QA archive | Projects, Library, Shorts Editor, AI Video local plan, Jobs, Settings, Workspace and Help exercised; no console/page/request failures |
| Shorts Editor deep pass | Shorts Editor with persisted completed clips | PASS | Private QA archive | Existing clip selected; preview, trim/aspect/subtitle controls and assistant surface verified without queueing a render |
| AI Video local planning status | AI Video → custom script | FIXED-VERIFIED | Private QA archive | QA-010: status text was constrained to a 20px grid column; scoped `.topic-video-form > .mode-note` to one full-width column; rebuilt web and reran original flow |
| Workspace completed output | Workspace → persisted complete YouTube project | PASS | Private QA archive | 11-step ledger, 9:16 preview, score/captions/asset/info tabs, clip board, export controls visually inspected |
| Safe non-destructive acceptance regression set | Playwright against rebuilt gateway | PARTIAL / HARNESS-INTERRUPTED | Private QA archive | The 95-test batch advanced through test 68/95 without an assertion failure being reported, then the runner received SIGTERM from the test harness. The 27-test remainder (theme, alignment, Workspace design, ratio/progress and YouTube-credit fixture checks) passed 27/27. A split rerun was also harness-terminated after 19/53 without a reported assertion failure; no product defect is claimed from these interruptions. |

### Current run defect ledger

- **QA-010 — FIXED-VERIFIED.** Reproduction: AI Video → enter a clearly labeled local custom script → **Create / refresh plan**. Before the fix, `Plan ready for review.` rendered one word per line in a 20px-wide grid track. Geometry logs and screenshots are retained in the private QA archive. Root cause: `.mode-note` is shared with icon + copy notes, but this Topic to Video status is a single direct text node. Fix: `web/src/styles.css` adds `.topic-video-form > .mode-note { grid-template-columns: minmax(0, 1fr); }`. Lint, typecheck, frontend tests and build passed; the affected web image was rebuilt; the original flow was rerun and visually inspected. The permanent regression `tests/acceptance/ai-video-layout.spec.ts` passed 1/1. No provider request or render was made.

### Current run checks / blockers

- `npm run lint` PASS; `npm run typecheck` PASS; `npm test -- --run` PASS (274 tests); `npm run build` PASS; `docker compose config` PASS.
- Host `python -m pytest engine/tests -q` and `npm run test:engine` are BLOCKED by this host environment: `/usr/bin/python3` is present but pytest is not installed and no project `.venv/bin/python` is available. The isolated project-defined `npm run check:supported` PASSed in a disposable temporary Compose dataset: **417 engine tests passed**, 2 upstream dependency deprecation warnings; isolated build also passed.
- `npm run lint`, `npm run typecheck`, `npm test -- --run` (**274 passed**), `npm run build`, and `docker compose config` PASS after the fix. The focused permanent regression `npx playwright test tests/acceptance/ai-video-layout.spec.ts` PASSed **1/1** after the test was made deterministic against the concurrent provider-status note.
- The broad safe live Playwright batch was harness-interrupted by SIGTERM rather than failing an assertion; its remainder passed 27/27. Destructive/provider/render-heavy specs remain intentionally unrun against shared data (see remaining gaps below).

Run: 2026-09-12, using an existing local Docker deployment. No services were stopped. Historical evidence remains in a private archive.

## Run: 2026-09-17 (regression + video-shorts deep pass)

Context: the application images were rebuilt from an updated checkout before this run. Existing services were left running; historical screenshots remain private.

| Feature | Route/entry point | Status | Evidence | Notes / defect ID |
|---|---|---|---|---|
| PWA manifest/icons/service worker (new in this release) | App shell | PASS | `npx playwright test tests/acceptance/pwa.spec.ts` — 3/3 passed; served `sw.js`/`index.html` byte-diffed against source post-rebuild | Covers manifest validity, offline caching excludes API/media, user-controlled update prompt |
| YouTube import, Fast mode, no captions, 5 clips, real download+render to completion | Projects → Clip mode → YouTube | PASS | Private media evidence: H.264/AAC, 1080×1920, 60 seconds, full decode succeeded; job progress reflected render completion | Source URL and title are omitted from this historical checklist; media was not redistributed |
| YouTube import, Smart mode, captions ON, Serious style | Projects → Clip mode → YouTube | PASS | Private media evidence: captions, attribution and sidecar downloads were verified; engine surfaced a warning when only one valid complete moment was available | Source URL and title are omitted from this historical checklist; media was not redistributed |
| ZIP export/download | Workspace → Download ZIP | PASS | Private downloaded archive contained the expected clip media and export metadata | |
| Docker-served full acceptance workflow (`docker-app.spec.ts`) | Shorts Editor → AI Video → Settings → Jobs → Projects/YouTube stop-retry-stop | **FIXED-VERIFIED (2026-09-18)** | Private QA archive | **QA-007**, root cause and evidence in the resolution section below |
| Regression: git sync + Docker rebuild/recreate from current checkout | n/a | PASS | `HEAD`==`origin/main`==`5043a96`; both `engine` and `web` healthy after rebuild; served content byte-matches source | |
| Broad local (non-YouTube) acceptance regression, 16 spec files / 43 tests | tests/acceptance/*.spec.ts (excluding YouTube-network specs) | PASS (after 1 fix) | `npx playwright test <16 files>` — 37 passed, 2 skipped, 4 failed initially; 1 fixed+verified (QA-008), 3 are environment/host-permission issues, not app defects (see below) | |

## Additional findings, 2026-09-17

- **QA-008 — FIXED-VERIFIED.** `tests/acceptance/help.spec.ts` asserted the Help dialog contains exactly 8 `<img>` elements; it only ever renders 4 (`layoutReferences`). The 4 subtitle-style references render as `<video>` via `HelpVideoPreview` (since commit `db9dec1`, "Fix Help subtitle preview playback") and are already thoroughly covered by the dedicated `tests/acceptance/help-subtitle-previews.spec.ts` (readyState/dimensions/currentTime-advancing checks). The `img` count assertion was stale test code from before that change, not an app defect. Fix: changed the expected count from 8 to 4 in `tests/acceptance/help.spec.ts`. Verified: `npx playwright test tests/acceptance/help.spec.ts` — 2/2 passed; `npx tsc -p web/tsconfig.json --noEmit` clean. No app code touched.
- `tests/acceptance/bulk-export.spec.ts` requires its disposable data root to be writable by both the test runner and engine container. Run it against a dedicated isolated data root; do not change permissions on a live data directory to make the test pass.
- `tests/acceptance/library-project-sync-live.spec.ts` assumes a fresh, empty installation. Run it against a new disposable data root, never an existing user installation.
- Run-owned media and helper artifacts were removed after the test; private evidence is not committed.

## Defect ledger (2026-09-17 additions)

| ID | Status | Reproduction | Root cause / verification |
|---|---|---|---|
| QA-007 | **FIXED-VERIFIED (2026-09-18)** — root cause found; see the resolution section below | Run `npx playwright test tests/acceptance/docker-app.spec.ts` against the live app (single engine worker, `S6_JOB_WORKERS=1`). The spec queues a Shorts-Editor short, then 2 AI-Video script variants, then a YouTube clip job, then does Stop & keep → Retry import → Stop & keep on the YouTube job. In 2/2 runs, the **second** "Stop & keep" click landed on an unrelated job: run 1 stopped script job `1be168c6` (project "…Variant 1") instead of the retried YouTube job `a511760c`; run 2 failed one assertion earlier and stopped script job on project "…Variant 2" instead of the YouTube job. Engine logs confirm two `POST …/control/stop-keep` calls hit two different job ids each run, and the failure screenshot's breadcrumb literally shows the wrong project's Workspace ("Workspace / Browser acceptance local plan — Variant N") instead of "Workspace / YouTube import". | **Not yet root-caused with certainty** — investigated and ruled out: (a) pagination in `list_projects()` (no LIMIT, ordered by `updated_at DESC`, always returns all projects); (b) the per-job SSE stream (`/api/v1/jobs/{job_id}/events` is correctly scoped server-side, and `jobEventsUrl`/the `job` polling effect in `workspace-view.tsx` correctly closes over `currentJobId`); (c) backend `project.latest_job_id` cross-contamination (it's set once at creation and only ever updated to a *new* job for the *same* project during `switch-fast`). The remaining, unverified hypothesis is a stale-`refresh()` race in `web/src/App.tsx` around `onLibraryChanged`/`emitLibraryChanged` (fired from `workspace-view.tsx`'s clip-completion detection) landing after the YouTube project is selected but somehow bypassing the `refreshRevision` guard that commit `08ff539` ("Fix stale project refresh after creation") added for the narrower create-time race — this needs a maintainer with more budget to instrument `App.tsx`'s `refresh()`/`refreshRevision` and `workspace-view.tsx`'s `emitLibraryChanged` call with real logging under concurrent-job load, since a scaled-down repro script (same steps, tighter timing) did **not** reproduce it in 2 attempts, only the full multi-minute spec did. **Do not attempt a blind fix** — this touches the exact state-sync machinery the `08ff539` fix and `DO-NOT-CHANGE.md` §7 (App.tsx routing/SSE) flag as load-bearing; a wrong fix risks reintroducing the bug the prior commit fixed. User impact if real: while multiple jobs are in flight across different projects, a user actively working a Workspace can be silently shown a different project's Workspace and unknowingly click a control (e.g. Stop & keep) that acts on the wrong job. |

## QA-007 resolution (2026-09-18) — FIXED-VERIFIED

The earlier "ruled out pagination in `list_projects()`" note was wrong: that query has no `LIMIT`,
but it does **filter rows**. A project is returned only when its state is one of
`queued/active/paused/recovered/stalled` **or** it still owns a Library asset. `Stop & keep` puts
the project in `cancelled_kept`, which was not in that list — so an import stopped **before it
published any clip** matched neither branch and disappeared from `GET /api/v1/projects` entirely.

Chain of causation, each link verified with an isolated database fixture:

1. `Stop & keep` → `Project.state = "cancelled_kept"` (`save_job` keeps project state in sync).
2. With zero assets yet, `list_projects()` stops returning that project. A disposable fixture
   confirmed the API omitted stopped projects with no assets and exposed them after the fix.
3. `App.tsx` then found `selectedProjectId` missing from the returned list and reassigned the
   selection to `value[0]` — the head of `ORDER BY updated_at DESC`, i.e. whichever *other* project
   had most recently ticked, which under concurrent load is an actively-rendering job's project.
   That is why the breadcrumb showed "…— Variant N", and why it only reproduced with several jobs
   in flight (a lone project has nothing to fall back to).

Both layers were genuinely defective and both were fixed:

- `engine/database.py` `list_projects()` — added `cancelled_kept` to the "work can still continue
  from here" state list, alongside the `paused`/`stalled` entries already there. The Workspace
  offers **Retry import** for exactly this state, gated on the *download* phase — which is
  precisely when no asset exists — so the filter was hiding a stopped import from its own recovery
  control. A private screenshot confirmed the
  recovered project rendering the app's own banner, *"YouTube import stopped before the download
  began. Retry import to start it."*, with `Download ZIP 0` confirming the zero-asset case. That
  banner was unreachable before the fix.
- `web/src/App.tsx` — the shell now only *chooses* a project when nothing is selected; it never
  re-points an existing selection. Projects legitimately leave this listing by design (see
  `test_last_library_asset_hides_project_from_persisted_recent_listing`), so the shell must degrade
  to its own "No project selected" state rather than silently adopt an unrelated project's live job
  controls. The selection re-resolves by itself when the project returns.

Verification: `engine/tests` 361 passed; web unit suite 273 passed; `npm run typecheck` and
`npm run lint` clean; `docker-app.spec.ts` passed after rebuild (it had failed 2/2 before).
New regression tests — `test_stopped_but_kept_project_stays_visible_before_it_publishes_output`
(engine) and "never moves the open Workspace to another project when the selected one leaves the
listing" (`web/src/App.test.tsx`); the latter was confirmed to **fail** against the pre-fix
expression, so it genuinely guards the regression. An isolated live-UI check
confirmed the stopped import is listed again, opens to
`Workspace / YouTube import`, and stays on that project across repeated shell refresh cycles
(`stayed-on-same-project: true`), with no console errors and no horizontal overflow at 390px.

Note for whoever reads the Projects list next: this fix makes previously hidden stopped-but-kept
projects visible again. That is the intended correction, not a new bug.

## QA-009 (2026-09-18) — FIXED-VERIFIED — stale mobile navigation assertion

Found during the QA-007 regression pass, **pre-existing and unrelated to it**.
`startup-polling-a11y.spec.ts` › "no navigation label clips, including Workspace at 360px" failed
with `360px: Workspace label rendered / Received: undefined`.

Root cause is a contradiction between two commits: the assertion was written on **2026-09-05**
(`4fc01d3`), and on **2026-09-15** `b32eb73` ("Add Workspace processing spinner") added a
`@media (max-width: 600px)` block that deliberately drops the rail captions —
`.nav-item span { display: none; }` plus `.nav-item .nav-label { display: none; }`, while
re-showing `.nav-icon-wrap` as `inline-flex`. Its own comment states the intent: *"the caption is
dropped and the item becomes the icon alone; the button keeps its `aria-label`/`title`, so the
accessible name is unchanged."* The test's `.nav-item span` selector therefore collects seven
visible icon wrappers whose text is empty, finds no `"Workspace"` caption, and fails. The app is
behaving as designed; the ten-day-older assertion had silently gone stale.

Fix (test only, no app code): assert the accessible name at every width —
`.app-rail` `getByRole("button", { name: "Workspace" })` must be visible, which is exactly what the
caption drop trades on — and apply the caption assertion only where captions are actually rendered.
The clipping and horizontal-overflow assertions are unchanged, so the test still guards what it was
written to guard. Verified: `startup-polling-a11y.spec.ts` 12/12 passed.

Also noted: `control-style-and-commandbar.spec.ts:213` ("the folder picker, the job badge and the
actions share one optical axis") failed inside a six-spec batch but **passes in isolation** — a
cross-spec state-ordering artifact on a shared live instance, not a defect in the command bar.

| Feature | Route/entry point | Status | Evidence | Notes / defect ID |
|---|---|---|---|---|
| Application shell, skip link, primary navigation | Rail / main shell | PASS | Private QA archive | |
| Help dialog, focus and responsive readability | Help button | PASS | Acceptance `help.spec.ts`; archived historical QA evidence is excluded from this public repository | |
| Projects clip mode, local source, styles, counts, short/long format, processing mode | Projects | PASS | Private QA archive | Format, count, style, Auto/Fast/Smart and long-form controls exercised |
| Projects validation recovery when changing mode/source | Projects | FIXED-VERIFIED | Private QA archive | QA-004 and QA-006 verified; clip/source changes and script edits clear validation state |
| Projects YouTube URL validation and source path | Projects > YouTube | PASS | Broad acceptance `qa-feature-matrix.spec.ts`; Docker workflow covered URL stop/retry | The test import was left stopped and recoverable; no rerender was completed |
| Projects advanced controls and validation | Projects > Advanced controls | PASS | Broad acceptance `qa-feature-matrix.spec.ts`; live Advanced controls expanded and inspected | Count clamps, long-form aspect pinning, and duration errors covered |
| Projects script mode and local exact text | Projects > Script mode | PASS | Acceptance coverage; archived historical QA evidence is excluded from this public repository | Text-file picker pending |
| Workspace loading/SSE/polling and durable job state | Workspace | PASS | Acceptance coverage; completed jobs visible in live Jobs | |
| Workspace clip preview/playback | Workspace > Preview | PASS | Private QA archive | |
| Workspace selection, board filters, score inspector | Workspace | PASS | Existing `qa-dead-controls.spec.ts`; prior QA log | |
| Workspace caption/source/media tabs | Workspace | PASS | Archived historical QA evidence | |
| Workspace ZIP export and download | Workspace > Download ZIP | PASS | Fresh live Download ZIP button clicked without alert; prior ZIP inspection noted in IMPLEMENTATION_STATUS.md | |
| Shorts Editor local source, trim, ratios, subtitles | Editor | PASS | Private QA archive | Local upload, assistant proposal apply/reject/undo, ratio changes, and queue covered |
| Shorts Editor Library source | Editor > Library | PASS | Private QA archive | |
| Shorts Editor YouTube source and 4:5 output | Editor > YouTube | PASS | Acceptance coverage; `qa-shorts-youtube-options.spec.ts` | A new import was unnecessary because existing test data covered the workflow |
| Shorts Editor assistant and keyboard behavior | Editor assistant | PASS | Existing `qa-dead-controls.spec.ts`; prior QA log | |
| AI Video local script planning | AI Video | PASS | Private QA archive | Provider generation not run to avoid additional usage |
| AI Video topic/provider generation | AI Video | BLOCKED | Provider generation was not run because it may incur charges | |
| Jobs history, open, statuses, retry affordance | Jobs | PASS | Private browser evidence covered history, status and retry affordances | No existing jobs were paused or stopped |
| Library listing, filters, search, pagination | Library | PASS | Private browser evidence confirmed listing, filters, search and pagination | |
| Library preview and playback | Library > Preview | PASS | Acceptance coverage; signed media preview succeeded | |
| Library import/edit/protected/remove | Library | PASS | Private QA archive | Imported/edited/deleted only disposable test media; protected behavior covered by existing acceptance/unit evidence |
| Library business folders and keyboard tree | Library | PASS | Existing acceptance matrix and prior QA log | |
| Settings profile display, masked secrets, runtime capabilities | Settings | PASS | Private QA archive | Secrets masked; runtime all READY |
| Settings profile create/edit/test/duplicate/delete persistence | Settings | PASS | A disposable profile was created, duplicated and removed; the saved profile remained unchanged | No provider test call made |
| Responsive desktop/mobile shell and controls | All screens | PASS | Private QA archive | |
| PWA manifest/service worker/logo | App shell | PASS | Private QA archive | |
| Error/validation states and recovery | Projects/Editor/Jobs/AI Video | FIXED-VERIFIED | Private QA archive | QA-006: valid script input left stale validation alert; fixed and visually verified. Malformed URL, invalid trim, and empty AI topic recover with visible messages |
| Media output codec/dimensions/duration/audio/decode | Generated outputs | PASS | Private QA archive | Fresh persisted Script output played to end and decoded cleanly |
| YouTube source varieties and external failure handling | Projects/Editor YouTube | PASS (prior run) | Earlier source-variety checks covered successful and failed download handling; detailed evidence remains private | No additional media was downloaded for this checklist |

## Defect ledger

| ID | Status | Reproduction | Root cause / verification |
|---|---|---|---|
| QA-004 | FIXED-VERIFIED | Projects: select YouTube, submit `https://example.com/not-youtube`, switch to Script mode. The YouTube alert remained visible in the Script form; screenshot private QA artifacts. | Private QA archive |
| QA-005 | FIXED-VERIFIED | AI Video: leave Topic or keyword empty and click Create / refresh plan. Native required constraint showed generic browser bubble and did not render component validation; screenshot private QA evidence. | Private QA archive |
| QA-006 | FIXED-VERIFIED | Projects: switch to Script mode, submit empty form, enter valid script. The old `Add at least 10 characters of script.` alert remained beside valid text; screenshot private QA artifacts. | Private QA archive |

## Current run evidence (2026-09-12)

- The historical run used a local deployment and temporary Vite QA server; host and deployment details are omitted from this public checklist.
- Instrumented Playwright navigation across Projects, Library, Editor, AI Video, Jobs, and Settings reported zero console errors/warnings, page errors, failed requests, or non-2xx responses; detailed logs are retained privately.
- A completed Script job was opened from Projects; browser playback reached the 4.608-second end. The MP4/H.264/AAC output was 1080×1920 and 4.608 seconds; full decode succeeded.
- Frontend suite: 227/227. Engine suite: 271 passed, one upstream Starlette deprecation warning. `npm run build`, `docker compose config`, and `git diff --check` passed.
- Playwright UI regression set: 8/8 passed (`pwa`, Help, responsive layout, and creation/Library layout). Several saved clips were opened from the Library preview dialog, played, seeked and visually checked. Detailed screenshots and recordings remain in the private QA archive.
- Jobs UI review confirmed that failed-job details and the unavailable-render state were visible. No existing jobs or outputs were modified.
- Broad acceptance runs were stopped after worker contention affected queued disposable tests. No application exception or failed HTTP response was observed; this is not claimed as a product pass.

## Environment evidence

- Baseline health and job-state artifacts remain in the private local QA archive.
- Tool versions were recorded with the private QA evidence.
- Historical evidence from this run is retained privately outside the public repository; ignored local QA artifacts are not part of this checklist.
## Opt-in live YouTube acceptance test

The repository includes a deliberately skipped live test at
`tests/acceptance/youtube-live.spec.ts`. It exercises the normal UI import path
with the first metadata-only entry in `tests/fixtures/youtube-live-sources.json`,
then verifies that the produced output is playable, has the expected dimensions,
and contains changing decoded frames. It is not part of the default deterministic
suite and it creates project/media data.

Run it only against a disposable isolated deployment/data root, with Chromium
available and at least 3 GiB of free disk:

```bash
S6_RUN_LIVE_YOUTUBE=1 S6_ACCEPTANCE_ISOLATED=1 \
npx playwright test --config playwright.config.ts tests/acceptance/youtube-live.spec.ts
```

`S6_RUN_LIVE_YOUTUBE=1` enables the test; `S6_ACCEPTANCE_ISOLATED=1` confirms
that the target is disposable. The test fails before creating data when the
isolation confirmation is missing. The fixture stores only URL metadata; it does
not commit downloaded source media. Remove run-owned downloaded/generated video
artifacts after the run and retain only compact diagnostics.
