> Historical QA checklist: Script mode and AI Video described below have since been retired. These entries document past behavior, not supported current workflows.

# S6_CUT Autonomous Playwright Test Checklist

## Run: 2026-09-19/20 (live Docker Playwright sweep)

Evidence root: `test-artifacts/qa-sweep-20260919T235544Z/` (screenshots, logs, notes). Existing Compose services were healthy at startup and were not stopped. No project/data deletion or Git operations were performed. This run updates the status below as UI coverage proceeds; prior run evidence remains historical.

| Feature | Route/entry point | Status | Evidence | Notes |
|---|---|---|---|---|
| Deployment/health gate | `http://127.0.0.1:8080` | PASS (initial) | `logs/compose-ps.txt`, `logs/health.json` | web, engine and pot-provider healthy; 0 active/queued jobs at startup |
| Full live route sweep | All seven rail routes + Help | PASS (desktop; mobile shell captured) | `screenshots/`, `logs/live-sweep.json` | Projects, Library, Shorts Editor, AI Video local plan, Jobs, Settings, Workspace and Help exercised; no console/page/request failures |
| Shorts Editor deep pass | Shorts Editor with persisted completed clips | PASS | `screenshots/shorts-editor-selected.png`, `screenshots/shorts-editor-mobile.png` | Existing clip selected; preview, trim/aspect/subtitle controls and assistant surface verified without queueing a render |
| AI Video local planning status | AI Video → custom script | FIXED-VERIFIED | `screenshots/ai-video-local-plan-before-fix.png`, `screenshots/ai-video-local-plan-after-fix.png`, `logs/live-sweep.json` | QA-010: status text was constrained to a 20px grid column; scoped `.topic-video-form > .mode-note` to one full-width column; rebuilt web and reran original flow |
| Workspace completed output | Workspace → persisted complete YouTube project | PASS | `screenshots/workspace-desktop.png` | 11-step ledger, 9:16 preview, score/captions/asset/info tabs, clip board, export controls visually inspected |
| Safe non-destructive acceptance regression set | Playwright against rebuilt gateway | PARTIAL / HARNESS-INTERRUPTED | `logs/live-sweep.json`, Playwright terminal output, `test-artifacts/test-results/` | The 95-test batch advanced through test 68/95 without an assertion failure being reported, then the runner received SIGTERM from the test harness. The 27-test remainder (theme, alignment, Workspace design, ratio/progress and YouTube-credit fixture checks) passed 27/27. A split rerun was also harness-terminated after 19/53 without a reported assertion failure; no product defect is claimed from these interruptions. |

### Current run defect ledger

- **QA-010 — FIXED-VERIFIED.** Reproduction: AI Video → enter a clearly labeled local custom script → **Create / refresh plan**. Before fix, `Plan ready for review.` rendered one word per line in a 20px-wide first grid track; evidence `screenshots/ai-video-local-plan-before-fix.png`, geometry `logs/live-sweep.json` (`columns: 20px 1110px`, height 64px). Root cause: `.mode-note` is shared with icon + copy notes, but this Topic to Video status is a single direct text node. Fix: `web/src/styles.css` adds `.topic-video-form > .mode-note { grid-template-columns: minmax(0, 1fr); }`. Checks: lint/typecheck, frontend tests, build passed; affected web image rebuilt/recreated; original UI flow rerun and visually inspected in `screenshots/ai-video-local-plan-after-fix.png`; permanent regression `tests/acceptance/ai-video-layout.spec.ts` passed 1/1. No provider request or render was made.

### Current run checks / blockers

- `npm run lint` PASS; `npm run typecheck` PASS; `npm test -- --run` PASS (274 tests); `npm run build` PASS; `docker compose config` PASS.
- Host `python -m pytest engine/tests -q` and `npm run test:engine` are BLOCKED by this host environment: `/usr/bin/python3` is present but pytest is not installed and no project `.venv/bin/python` is available. The isolated project-defined `npm run check:supported` PASSed in a disposable temporary Compose dataset: **417 engine tests passed**, 2 upstream dependency deprecation warnings; isolated build also passed.
- `npm run lint`, `npm run typecheck`, `npm test -- --run` (**274 passed**), `npm run build`, and `docker compose config` PASS after the fix. The focused permanent regression `npx playwright test tests/acceptance/ai-video-layout.spec.ts` PASSed **1/1** after the test was made deterministic against the concurrent provider-status note.
- The broad safe live Playwright batch was harness-interrupted by SIGTERM rather than failing an assertion; its remainder passed 27/27. Destructive/provider/render-heavy specs remain intentionally unrun against shared data (see remaining gaps below).

Run: 2026-09-12, existing Docker deployment (`http://127.0.0.1:8080`), engine `127.0.0.1:8001`. Existing services were left running. Screenshots are under `test-artifacts/qa-sweep/`; prior owner QA evidence is under `test-artifacts/`.

## Run: 2026-09-17 (regression + video-shorts deep pass)

Context: `main` was fast-forwarded to `5043a96` ("Convert S6_cut into a production PWA") and `engine`/`web` were rebuilt/recreated from that checkout immediately before this run (previous containers were stale, predating the last 2 commits). Existing Docker services otherwise left running throughout; screenshots under `test-artifacts/qa-sweep-20260917/screenshots/`.

| Feature | Route/entry point | Status | Evidence | Notes / defect ID |
|---|---|---|---|---|
| PWA manifest/icons/service worker (new in this release) | App shell | PASS | `npx playwright test tests/acceptance/pwa.spec.ts` — 3/3 passed; served `sw.js`/`index.html` byte-diffed against source post-rebuild | Covers manifest validity, offline caching excludes API/media, user-controlled update prompt |
| YouTube import, Fast mode, no captions, 5 clips, real download+render to completion | Projects → Clip mode → YouTube | PASS | `test-artifacts/qa-sweep-20260917/screenshots/workspace-playing.png`; ffprobe of blob `9ff98824…mp4`: h264/aac, 1080×1920, exactly 60.000000s, clean `ffmpeg -f null -` decode (no errors); job progressed 40%→50.8%→61.6%→72.4%→100% over ~10 min matching real per-clip render time (not a fake bar) | Source: `youtube.com/watch?v=aqz-KE-bpKQ` (Big Buck Bunny, CC). All 5 clips 60.00s/1080×1920, evenly distributed windows, framing correct (subject in frame), "Source: Blender" creator credit shown |
| YouTube import, Smart mode, captions ON, Serious style | Projects → Clip mode → YouTube | PASS | `test-artifacts/qa-sweep-20260917/screenshots/caption-frame.png` (extracted frame with burned-in caption); caption text matches speech, legible, correct speaker label "Ziggy Q:", "Source: fogoticus" credit shown; ass/srt/vtt caption downloads present in job payload | Source: `youtube.com/watch?v=KNVr5pHAygI` (from `QA_YOUTUBE_E2E_PROMPT.md` matrix). Requested 2 clips; engine honestly found only 1 valid complete moment and surfaced a clear warning ("Found 1 valid clips instead of 2 … shortest 5.5s") instead of forcing a bad cut — correct, transparent behavior, not a defect |
| ZIP export/download | Workspace → Download ZIP | PASS | Real Playwright download event captured to `/tmp/workspace-export.zip` (161MB): contains all 5 clip MP4s + `manifest.json` + `credits.json` + `warning-summary.json`, matching the documented export contract | |
| Docker-served full acceptance workflow (`docker-app.spec.ts`) | Shorts Editor → AI Video → Settings → Jobs → Projects/YouTube stop-retry-stop | **FIXED-VERIFIED (2026-09-18)** | Failed 2/2 before the fix (`test-artifacts/test-results/docker-app-Docker-served-studio-acceptance-workflow/test-failed-1.png`; engine logs showed `stop-keep` landing on two different jobs). Passes after the fix + rebuild. Later repeat runs in the same session time out waiting on a single-worker queue backlog left by the earlier runs — a test-isolation artifact with a different signature (job stuck `Queued`, 0%), not this defect | **QA-007**, root cause and evidence in the resolution section below |
| Regression: git sync + Docker rebuild/recreate from current checkout | n/a | PASS | `HEAD`==`origin/main`==`5043a96`; both `engine` and `web` healthy after rebuild; served content byte-matches source | |
| Broad local (non-YouTube) acceptance regression, 16 spec files / 43 tests | tests/acceptance/*.spec.ts (excluding YouTube-network specs) | PASS (after 1 fix) | `npx playwright test <16 files>` — 37 passed, 2 skipped, 4 failed initially; 1 fixed+verified (QA-008), 3 are environment/host-permission issues, not app defects (see below) | |

## Additional findings, 2026-09-17

- **QA-008 — FIXED-VERIFIED.** `tests/acceptance/help.spec.ts` asserted the Help dialog contains exactly 8 `<img>` elements; it only ever renders 4 (`layoutReferences`). The 4 subtitle-style references render as `<video>` via `HelpVideoPreview` (since commit `db9dec1`, "Fix Help subtitle preview playback") and are already thoroughly covered by the dedicated `tests/acceptance/help-subtitle-previews.spec.ts` (readyState/dimensions/currentTime-advancing checks). The `img` count assertion was stale test code from before that change, not an app defect. Fix: changed the expected count from 8 to 4 in `tests/acceptance/help.spec.ts`. Verified: `npx playwright test tests/acceptance/help.spec.ts` — 2/2 passed; `npx tsc -p web/tsconfig.json --noEmit` clean. No app code touched.
- `tests/acceptance/bulk-export.spec.ts` fails with `EACCES: permission denied, mkdir '…/data/test-artifacts'` — **environment issue, not an app defect.** The bind-mounted `./data` directory is owned by uid 10001 (the containers run as `user: "10001:10001"` per `compose.yaml`), while Playwright runs as the host user (`linuxpc`, uid 1000) here, so it cannot create a temp subdirectory under the host's `data/`. Needs either running the acceptance suite as/with uid 10001, or a host-side `chmod`/`setfacl` on `data/` — an infrastructure/CI setup detail, out of scope for an application code fix.
- `tests/acceptance/library-project-sync-live.spec.ts` (both tests) fail because they assert a **completely empty** installation (`recent-project-count` == "0", "Build your private resolver" empty-state) — this instance has 12+ real projects and 190+ Library assets from ongoing use and prior QA runs. This is a pre-existing test-isolation requirement (these two tests need a fresh/empty data directory) unrelated to the current checkout's code; the same friction was already called out in the 2026-09-12 run notes. Not treated as an app defect.
- `data/test-artifacts` (created above) and the temporary QA helper scripts used to drive this run were removed; no permanent files were added to the repo other than this checklist and the `help.spec.ts` fix.

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

Chain of causation, each link verified against the live install:

1. `Stop & keep` → `Project.state = "cancelled_kept"` (`save_job` keeps project state in sync).
2. With zero assets yet, `list_projects()` stops returning that project. Verified directly against
   `data/s6-cut.sqlite3`: 6 rows in `cancelled_kept` with 0 assets were invisible to the API,
   including the literal `"YouTube import"` and `"Browser acceptance local plan — Variant 2"`
   projects from the failing runs. API returned 13 of 19 project rows before the fix, 19 after.
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
  control. Screenshot `test-artifacts/qa-007-fix/5-stopped-import-retry-available.png` shows the
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
expression, so it genuinely guards the regression. Live-UI check
(`test-artifacts/qa-007-fix/`): the stopped import is listed again, opens to
`Workspace / YouTube import`, and stays on that project across repeated shell refresh cycles
(`stayed-on-same-project: true`), with no console errors and no horizontal overflow at 390px.

Note for whoever reads the Projects list next: this fix makes previously hidden stopped-but-kept
projects visible again — 6 of them in this install. That is the intended correction, not a new bug.

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
| Application shell, skip link, primary navigation | Rail / main shell | PASS | `test-artifacts/live-initial.png`; live accessibility snapshot lists all 7 destinations | |
| Help dialog, focus and responsive readability | Help button | PASS | Prior `QA_AUTONOMOUS_TEST_LOG.md`; acceptance `help.spec.ts` | |
| Projects clip mode, local source, styles, counts, short/long format, processing mode | Projects | PASS | `test-artifacts/live-initial.png`; `test-artifacts/qa-sweep/screenshots/projects-stale-error-fixed.png`; broad acceptance suite | Format, count, style, Auto/Fast/Smart and long-form controls exercised |
| Projects validation recovery when changing mode/source | Projects | FIXED-VERIFIED | `test-artifacts/qa-sweep/screenshots/projects-stale-error.png` (repro), `projects-stale-error-fixed.png` (retest); current live script recovery `test-artifacts/current-run-projects-stale-script-error-fixed.png`; focused test 16/16 | QA-004 and QA-006 verified; clip/source changes and script edits clear validation state |
| Projects YouTube URL validation and source path | Projects > YouTube | PASS | Broad acceptance `qa-feature-matrix.spec.ts`; Docker workflow final covered live URL stop/retry | Authorized URL run left stopped and recoverable; no unapproved retry completion required |
| Projects advanced controls and validation | Projects > Advanced controls | PASS | Broad acceptance `qa-feature-matrix.spec.ts`; live Advanced controls expanded and inspected | Count clamps, long-form aspect pinning, and duration errors covered |
| Projects script mode and local exact text | Projects > Script mode | PASS | Prior `QA_AUTONOMOUS_TEST_LOG.md`; prior Workspace screenshot | Text-file picker pending |
| Workspace loading/SSE/polling and durable job state | Workspace | PASS | Prior QA log; completed jobs visible in live Jobs | |
| Workspace clip preview/playback | Workspace > Preview | PASS | `test-artifacts/qa-sweep/screenshots/workspace-fresh-complete.png`; live output player reached 0:04/0:04; existing `docker-app.spec.ts` | |
| Workspace selection, board filters, score inspector | Workspace | PASS | Existing `qa-dead-controls.spec.ts`; prior QA log | |
| Workspace caption/source/media tabs | Workspace | PASS | Prior QA log | |
| Workspace ZIP export and download | Workspace > Download ZIP | PASS | Fresh live Download ZIP button clicked without alert; prior ZIP inspection noted in IMPLEMENTATION_STATUS.md | |
| Shorts Editor local source, trim, ratios, subtitles | Editor | PASS | Docker workflow final `docker-app-final-2.log`; prior `qa-002-live-complete.png` | Local upload, assistant proposal apply/reject/undo, ratio changes, and queue covered |
| Shorts Editor Library source | Editor > Library | PASS | Prior QA log; `qa-002-live-complete.png` | |
| Shorts Editor YouTube source and 4:5 output | Editor > YouTube | PASS | Prior QA log; `qa-shorts-youtube-options.spec.ts` | New import blocked by already verified authorized set not needed |
| Shorts Editor assistant and keyboard behavior | Editor assistant | PASS | Existing `qa-dead-controls.spec.ts`; prior QA log | |
| AI Video local script planning | AI Video | PASS | `test-artifacts/qa-sweep/screenshots/ai-video-desktop.png`; prior QA log | Provider generation not run to avoid additional usage |
| AI Video topic/provider generation | AI Video | BLOCKED | Live UI warns provider request may incur charges; no unapproved paid request made | Credential present but explicit authorization for provider usage absent |
| Jobs history, open, statuses, retry affordance | Jobs | PASS | `test-artifacts/qa-sweep/screenshots/jobs-desktop.png`; live snapshot | Pause/stop not run against owner jobs |
| Library listing, filters, search, pagination | Library | PASS | `test-artifacts/qa-sweep/screenshots/library-desktop.png`; live snapshot shows 191 assets and Show 60 more | |
| Library preview and playback | Library > Preview | PASS | Prior QA log; live signed preview requests return 206 in server logs | |
| Library import/edit/protected/remove | Library | PASS | `test-artifacts/current-run-library-imported.png`, `current-run-library-edited.png`, `current-run-library-removed.png`; disposable asset count returned to zero | Imported/edited/deleted only disposable test media; protected behavior covered by existing acceptance/unit evidence |
| Library business folders and keyboard tree | Library | PASS | Existing acceptance matrix and prior QA log | |
| Settings profile display, masked secrets, runtime capabilities | Settings | PASS | `test-artifacts/qa-sweep/screenshots/settings-desktop.png`; live snapshot; stable acceptance retest | Secrets masked; runtime all READY |
| Settings profile create/edit/test/duplicate/delete persistence | Settings | PASS | `settings-after-disposable-profile.png`; duplicated existing profile through UI, confirmed 2 saved, deleted only disposable copy, confirmed 1 saved | Existing profile left active and unchanged; no provider test call made |
| Responsive desktop/mobile shell and controls | All screens | PASS | Stable Playwright retest `acceptance-retest.log`: 18/18 passed including 360px navigation, control target size, Workspace/Library containment, Help readability, startup states | |
| PWA manifest/service worker/logo | App shell | PASS | Stable Playwright retest `pwa.spec.ts` passed; live shell title/logo in `live-initial.png` | |
| Error/validation states and recovery | Projects/Editor/Jobs/AI Video | FIXED-VERIFIED | `test-artifacts/qa-sweep/screenshots/projects-stale-error-fixed.png`; `editor-validation.png`; `ai-video-empty-fixed.png`; current repro/fix `current-run-projects-stale-script-error.png` / `current-run-projects-stale-script-error-fixed.png`; frontend 227/227 | QA-006: valid script input left stale validation alert; fixed and visually verified. Malformed URL, invalid trim, and empty AI topic recover with visible messages |
| Media output codec/dimensions/duration/audio/decode | Generated outputs | PASS | `test-artifacts/qa-sweep/media/editor-4x5-ffprobe.json`; current `test-artifacts/current-run/script-output-ffprobe.json` and clean decode log; browser video metadata 1080×1920, 4.608 s | Fresh persisted Script output played to end and decoded cleanly |
| YouTube source varieties and external failure handling | Projects/Editor YouTube | PASS (prior authorized run) | `IMPLEMENTATION_STATUS.md` YouTube E2E report; pot-provider logs show all six IDs | Current run will rely on prior artifact to avoid repeated long paid/large imports |

## Defect ledger

| ID | Status | Reproduction | Root cause / verification |
|---|---|---|---|
| QA-004 | FIXED-VERIFIED | Projects: select YouTube, submit `https://example.com/not-youtube`, switch to Script mode. The YouTube alert remained visible in the Script form; screenshot `test-artifacts/qa-sweep/screenshots/projects-stale-error.png`. | `ProjectsView` did not clear `error` on mode/source changes. Clear state handlers added in `web/src/components/projects-view.tsx`; focused test passed 15/15, lint/typecheck passed, web image rebuilt, and live retest shows Script form with no alert in `projects-stale-error-fixed.png`. Existing user changes in the same component/test were preserved. |
| QA-005 | FIXED-VERIFIED | AI Video: leave Topic or keyword empty and click Create / refresh plan. Native required constraint showed generic browser bubble and did not render component validation; screenshot `ai-video-empty-no-alert.png`. | Removed redundant native `required` from `web/src/components/topic-to-video-view.tsx` so the existing visible validation runs. Topic/Projects focused tests passed 26/26, lint/typecheck passed, web image rebuilt, and live retest shows `Topic or keyword is required.` in `ai-video-empty-fixed.png`. |
| QA-006 | FIXED-VERIFIED | Projects: switch to Script mode, submit empty form, enter valid script. The old `Add at least 10 characters of script.` alert remained beside valid text; screenshot `test-artifacts/current-run-projects-stale-script-error.png`. | `ProjectsView` did not clear validation on script textarea or successful text-file changes. Added clear-on-edit/load behavior and regression coverage; focused test 16/16, live Vite retest has no alert beside valid text in `current-run-projects-stale-script-error-fixed.png`. |

## Current run evidence (2026-09-12)

- Existing Docker services were healthy and left running; local Vite QA server was started in background terminal `bt-1` on `127.0.0.1:5173`.
- Instrumented Playwright navigation across Projects, Library, Editor, AI Video, Jobs, and Settings reported zero console errors/warnings, page errors, failed requests, or non-2xx responses (`test-artifacts/current-run-instrumented-*.png`).
- A completed persisted Script job was opened from Projects; browser playback reached the 4.608-second end. `current-run/script-output-ffprobe.json` reports MP4/H.264/AAC, 1080x1920, 4.608 seconds, 188636 bytes; `script-output-decode.log` is empty.
- Frontend suite: 227/227. Engine suite: 271 passed, one upstream Starlette deprecation warning. `npm run build`, `docker compose config`, and `git diff --check` passed.
- Playwright UI regression set: 8/8 passed (`pwa`, Help, responsive layout, and creation/Library layout). Six visible Generated clips were opened in the Library preview dialog, played/seeked, and visually checked; evidence is `test-artifacts/current-run-generated-preview-1.png`, `current-run-generated-preview-2.png`, `current-run-youtube-cut02-seek8.png`, `current-run-youtube-cut01-seek8.png`, and `current-run-playwright-video-verification.json`.
- Jobs UI review found 15 failed historical jobs, all with zero outputs; a failed job opened in Workspace showed `Render unavailable` and `0 planned · 0 ready`. No failed video existed to delete.
- The broad/targeted acceptance runs were intentionally stopped after documenting worker-contention failures: the single pre-existing worker stayed busy rendering a five-clip YouTube job (durable progress advanced from clip 1 to clip 2 and `.partial.mp4` grew), while disposable acceptance jobs remained queued. No application exception or failed HTTP response was observed; this is not claimed as a product pass.

## Environment evidence

- Baseline health: `test-artifacts/qa-sweep/logs/health.json` reports all capabilities true and zero active/queued jobs. At current-run end, the pre-existing render remained active and two disposable acceptance jobs remained queued because they were blocked behind that render; they were not started or deleted.
- Tool versions: `test-artifacts/qa-sweep/logs/tool-versions.txt` (engine container).
- Pre-existing git changes preserved: `web/src/components/common.test.ts`, `common.tsx`, `projects-view.test.tsx`, `projects-view.tsx`, `shorts-editor-view.test.tsx`, `shorts-editor-view.tsx`, plus untracked `.venv-python39-backup/`, `QA_AUTONOMOUS_TEST_LOG.md`, `QA_YOUTUBE_E2E_PROMPT.md`.
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
