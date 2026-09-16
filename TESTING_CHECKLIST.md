# S6_CUT Autonomous Playwright Test Checklist

Run: 2026-09-12, existing Docker deployment (`http://127.0.0.1:8080`), engine `127.0.0.1:8001`. Existing services were left running. Screenshots are under `test-artifacts/qa-sweep/`; prior owner QA evidence is under `test-artifacts/`.

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
