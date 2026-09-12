# Autonomous Playwright QA log

Started: 2026-09-12  
Environment: existing Docker Compose deployment at `http://127.0.0.1:8080` (engine loopback `127.0.0.1:8001`). The services predated this run and will not be stopped by this run. Health on startup: ready; SQLite, FFmpeg, FFprobe, Whisper, yt-dlp, local TTS all available.

Status legend: **untested**, **passing**, **failing**, **blocked**.

## Pass 1 — discovery and smoke

| Feature | Status | Evidence / notes |
|---|---|---|
| Application shell, navigation, skip link, Help | passing | Real desktop navigation traversed Projects, Library, Workspace, Editor, AI Video, Jobs, Settings. Help opened and closed as a modal with its guide content. |
| Projects: clip mode, local upload, URL validation, styles, formats, advanced settings, folders, search | in progress | Live desktop initial paint inspected; screenshot `test-artifacts/current-qa-desktop-projects.png`. Completed 4:5 Shorts job revealed project-card aspect reporting defect (QA-003). |
| Projects: script mode and text-file input | passing (text entry); upload pending | Explicit Silent render script was created through UI and completed in Workspace (`QA silent script regression`); text was preserved into four timed spans. `.txt/.md` picker not exercised because the available browser harness has no native file-chooser upload method. |
| Workspace: job status/SSE-polling, preview transport, clip selection/captions/export/download | passing | Inspected real completed 1:1 Shorts and 9:16 silent Script Workspaces; playback reached source end, progress checklists completed, captions/asset tabs worked, and Download ZIP was initiated through UI. Script ZIP passed `unzip -t` with its numbered MP4. |
| Shorts Editor: local, Library, YouTube sources; trimming, ratios, captions, assistant, output | in progress | Empty-source and trim validation, assistant aspect edit, Library preview, and Library-source 4:5/subtitled render exercised. The first render reached engine completion but remained visibly queued until reload (QA-002). |
| AI Video: local custom-script planning and render; provider-dependent planning | passing for local plan; blocked for provider generation | UI made a reviewable 1:1 custom-script plan locally (`Plan ready for review`) without selecting a model/calling OpenRouter. Provider generation not run to avoid unapproved paid-provider usage. |
| Jobs queue: filters, open, active controls | passing for history/open | Live Jobs view showed complete, failed/retry-import history and output counts; opened a completed job into Workspace. Pause/stop/retry not executed on an in-progress job to avoid disrupting jobs outside this disposable run. |
| Library: folders/filters/preview passing; destructive/edit/upload pending | Live Library showed folders, policy/type/origin controls and generated/source assets. A newly generated 4:5 clip preview rendered and played to its 4.333 s end at 1080×1350. No real assets were edited/deleted; native upload chooser unavailable in this browser harness. |
| Settings: runtime capabilities and OpenRouter profile lifecycle | untested | |
| Responsive/mobile layouts | untested | |
| PWA assets/service worker | untested | |

## Test sources

| Source | Intended coverage | Status |
|---|---|---|
| `test-video.mp4` (repository-provided disposable local fixture) | local upload/editor full output paths | pending |
| Public/authorised YouTube sources | short spoken, long spoken, another supported format | researching; no jobs submitted yet |

## Defect ledger

| ID | Status | Reproduction / evidence | Root cause / repair |
|---|---|---|---|
| QA-001 | fixed, UI verified | Open **Shorts Editor** against the existing real completed jobs. Several exact 60-second clips rendered as `0:60` (for example `QA_20260911T140416Z_C4`), which is invalid timecode. Screenshot: `test-artifacts/current-qa-shorts-editor.png`. After deployment, the same completed entries display `1:00`; screenshot `test-artifacts/qa-001-002-retest-shorts-editor.png`. | `formatDuration` calculated minutes before rounding the remaining seconds. It now rounds the total once, then divides/modulos it. Focused regression test added. |
| QA-002 | fixed, UI verified | In **Shorts Editor**, select Library → `Short — test-video`, set 4:5/subtitles and queue. The real engine completed job `5597584a-8fbe-4e94-afbb-a2a6d78b4d89`, but the open editor remained `queued` with zero dimensions after >45 seconds; navigating away/reloading showed complete 1080×1350 output. | `ShortsEditorView` fetched jobs only on mount and immediately after submission. It now uses the bounded single-flight poller: 2 s while work is unsettled, 15 s idle; focused component test proves queued → complete. Deployed UI retest queued a new 1:1 Library job and showed Queued → Rendering → Complete in place, without reload: `test-artifacts/qa-002-live-poll-retest.png`, `test-artifacts/qa-002-live-complete.png`. FFprobe: H.264/AAC, 1080×1080, 4.334 s. |
| QA-003 | fixed, UI verified | The real completed 4:5 Shorts job appeared as `1 short clip · 9:16` on its Projects card while the Editor confirmed 4:5 / 1080×1350. | Projects cards assumed every non-long clip was 9:16. They now derive displayed output aspect from the authoritative completed job's validated dimensions; focused regression test added. After deployment the card visibly reports `1 short clip · 4:5`; historical square completed cards report `1:1`. |

## Changes made by this QA run

- Added this progress record.
- Fixed timecode rollover in `web/src/components/common.tsx` and added focused coverage in `web/src/components/common.test.ts` (QA-001; deployed UI verified).
- Fixed stale Shorts Editor job state in `web/src/components/shorts-editor-view.tsx` and added coverage in `web/src/components/shorts-editor-view.test.tsx` (QA-002; deployed UI verified).
- Fixed completed-project output-aspect reporting in `web/src/components/projects-view.tsx` and added coverage in `web/src/components/projects-view.test.tsx` (QA-003; deployed UI verified).
