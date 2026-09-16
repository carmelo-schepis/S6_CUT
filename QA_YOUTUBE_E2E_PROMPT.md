# S6_cut — Long-Running YouTube End-to-End Verify-and-Fix Prompt

**Target repository:** `/Users/dummy/Documents/S6_CUT` on the macOS host (`dummy@100.108.250.42`).
**How to use:** open a Claude Code session on that Mac with the working directory set to the repository, then paste everything below the line as the task. Expect a multi-hour run.

---

## 0. Mission

Drive the **entire S6_cut UI through Playwright against the real Docker deployment**, using six supplied YouTube sources, until every screen and every control is in a genuinely working state — and until every produced video is proven to contain **real moving picture and real audio**, not a frozen frame, a black screen, a placeholder text card, or a silent render that was never asked for.

This is a **verify → fix → re-verify** loop, not a test-writing exercise. A defect is not closed until the same Playwright check that caught it passes against a freshly rebuilt container.

### Non-negotiables

1. **Never fake a result.** No mocked renders, no fixture substituted for an output, no "should work" claims. Every PASS is backed by an artifact on disk.
2. **Never claim a pass you did not observe.** If something is blocked, write `BLOCKED` with the reason. A partial run reported honestly is worth more than a green report that is wrong. The previous run (`test-artifacts/QA_20260909T012725Z/REPORT.md`) is the tone to match.
3. **Never reset or delete existing data.** `S6_DATA_PATH` is the external volume `/Volumes/Carmelo HDD/S6_CUT-data` and holds the owner's real projects, Library, and blobs. Create new records with a unique run prefix; do not remove old ones. Do not run destructive Compose tests against this deployment.
4. **Respect `DO-NOT-CHANGE/AGENTS.md`.** The `/app/data` bind mount, engine port, and env defaults are contracts.
5. **Fix the product, not the test.** If a Playwright check fails because the app is wrong, change the app. Only change the check when the check itself encodes a wrong expectation — and say so explicitly in the report.
6. The six URLs are supplied by the repository owner as authorised test sources. Do not attempt to bypass DRM, age gates, paywalls, or access controls; if a URL is genuinely unavailable, record it as `BLOCKED` and continue with the rest.

---

## 1. Verified environment facts (checked 2026-09-11)

Do not rediscover these; confirm them and move on.

| Fact | Value |
| --- | --- |
| Host | macOS 15.7.9 (24G830), Apple silicon |
| Repo | `/Users/dummy/Documents/S6_CUT`, branch `fix/output-aspect-ratio`, HEAD `aad9837` |
| Pre-existing untracked | `.venv-python39-backup/` — leave it alone |
| `.env` | contains only `S6_DATA_PATH=/Volumes/Carmelo HDD/S6_CUT-data` |
| Node / npm | v22.23.2 / 10.9.8, at `/usr/local/bin` |
| Playwright browsers | already installed (`~/Library/Caches/ms-playwright`: chromium-1234, chromium-1243, chromium_headless_shell-1234, ffmpeg-1011) |
| Python venv | `.venv/bin/python` is 3.12.14 |
| Docker | Docker Desktop installed; **daemon was NOT running** — you must start it |
| **ffmpeg / ffprobe / yt-dlp / espeak-ng are NOT on the host** | they exist only inside the `engine` container — run them with `docker compose exec -T engine …` |

**A non-interactive shell does not load the user's PATH.** Begin every shell block with:

```bash
export PATH="$HOME/.npm-global/bin:/usr/local/bin:$PATH"
export DOCKER_HOST=unix://$HOME/.docker/run/docker.sock
cd /Users/dummy/Documents/S6_CUT
```

### Architecture you are testing

- `web` (nginx) publishes **http://127.0.0.1:8080** — the only LAN-facing port. All browser work goes here.
- `engine` (FastAPI) binds loopback **http://127.0.0.1:8001**, API docs at `/api/docs`. Use for corroboration only, never as a substitute for the UI.
- `pot-provider` (`brainicism/bgutil-ytdlp-pot-provider`) supplies YouTube PO tokens; `engine` will not start until it is healthy. **If YouTube imports fail, check this container first.**
- UI is React 19 + Vite, seven rail destinations: Projects, Library, Workspace, Shorts Editor, AI Video, Jobs, Settings, plus a Help dialog.
- **There are no `data-testid` attributes.** Select by `getByRole`, `getByLabel`, and the stable class names listed in §6.

### Timing reality

Delivery encodes with `libx264 -preset slow -crf 18` and `S6_JOB_WORKERS=1`. Renders are slow and strictly serial. The previous QA run failed to finish its matrix for exactly this reason. Therefore:

- Keep requested clip counts low (1–3) and durations short unless the case under test needs otherwise.
- Queue work serially and wait on SSE/polling; never fire many jobs and hope.
- Checkpoint after every case so the run is resumable (§4).
- **Do not raise `S6_JOB_WORKERS` on this deployment** — it is a contract default and the box has limited RAM.

---

## 2. Bring-up

```bash
export PATH="$HOME/.npm-global/bin:/usr/local/bin:$PATH"
export DOCKER_HOST=unix://$HOME/.docker/run/docker.sock
cd /Users/dummy/Documents/S6_CUT

# 1. External data volume must be mounted before anything starts.
ls "/Volumes/Carmelo HDD/S6_CUT-data" || { echo "FATAL: data volume not mounted"; exit 1; }

# 2. Start Docker Desktop and wait for the daemon.
open -a Docker
until docker version --format '{{.Server.Version}}' >/dev/null 2>&1; do sleep 5; done

# 3. Build and start.
docker compose up -d --build
docker compose ps

# 4. Wait for health on both surfaces.
until curl -fsS http://127.0.0.1:8080/healthz >/dev/null; do sleep 5; done
curl -fsS http://127.0.0.1:8080/api/health | tee test-artifacts/"$RUN"/logs/gateway-health.json
curl -fsS http://127.0.0.1:8001/api/health | tee test-artifacts/"$RUN"/logs/engine-health.json
```

**Gate:** `/api/health` must report `status: ready` with `ffmpeg`, `ffprobe`, `whisper`, `ytdlp`, `localTts`, and `database` all true. If `ytdlp` is false, stop and fix that before touching the UI — every YouTube case depends on it.

Record image IDs, container start times, and `docker compose config` output into `logs/deployment.txt`.

### Pre-flight YouTube probe

Before spending render time, confirm each URL actually resolves through the engine's own yt-dlp, with the same client args the fix uses:

```bash
docker compose exec -T engine yt-dlp \
  --extractor-args "youtube:player_client=android,web" \
  --skip-download --print "%(id)s %(duration)s %(width)sx%(height)s %(title).60s" \
  "<URL>"
```

Write the result for all six into `logs/youtube-probe.txt`. Any URL that fails here is a **real defect in the YouTube import path** (or an unavailable video) — triage it with §8 before proceeding, because a broken import blocks half the matrix.

---

## 3. The six sources and their assignments

Each URL has a distinct role so the matrix covers every mode, style, aspect, and entry point without re-rendering the same thing six times. Run them **in this order**.

| # | URL | Entry point | Exact settings | What it proves |
| --- | --- | --- | --- | --- |
| 1 | `https://www.youtube.com/watch?v=8xEuFQz4E4A` | Projects → Clip mode → YouTube | Fast · Funny · Short form 9:16 · 3 clips · subtitles **ON** | Baseline import + deterministic cut + burned captions |
| 2 | `https://www.youtube.com/watch?v=KNVr5pHAygI` | Projects → Clip mode → YouTube | Smart · Serious · Short form 9:16 · 2 clips · subtitles **ON** | Local Whisper path, real segment progress, score inspector |
| 3 | `https://www.youtube.com/watch?v=Ju41cQSe7hY&pp=ugUEEgJlbg%3D%3D` | Projects → Clip mode → YouTube | Auto · Educational · **Long form 16:9** · 2 scenes · subtitles **ON** | Extra `&pp=` query param survives validation and yt-dlp; long-form landscape path |
| 4 | `https://www.youtube.com/watch?v=VTLnDqjfRZQ` | Projects → Clip mode → YouTube | Fast · Hype · Advanced aspect **1:1** · 2 clips · subtitles **OFF** | Non-default aspect; no-caption render must still be real video |
| 5 | `https://www.youtube.com/watch?v=ZvSEsBpuP3c&pp=ugUHEgVlbi1BVQ%3D%3D` | **Shorts Editor** → YouTube | trim start 10s, end 35s · aspect **4:5** · subtitles **ON** | Second entry point, trim honoured exactly, second `&pp=` variant |
| 6 | `https://www.youtube.com/watch?v=5K9QhkPww44` | Projects → Clip mode → YouTube | Smart · Funny · 9:16 · 2 clips · subtitles **ON** | Resilience: exercise Pause / Resume / Stop & keep / Retry import mid-run, then let it finish |

**Every URL must be typed into the UI field, not posted to the API.** The point is that the UI path works.

For case 6, deliberately interrupt: pause during download, resume, stop-and-keep, then Retry import, and confirm the partial `.part` is resumed rather than restarted (the job record persists `downloadProgress` byte counts — check them before and after).

---

## 4. Run ledger, artifacts, resumability

Create one run directory and use it for everything. Match the existing convention.

```bash
RUN="QA_$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p test-artifacts/"$RUN"/{logs,screenshots,outputs,media-validation,contact-sheets,browser-recordings,traces,ledger,fixes}
echo "$RUN" > test-artifacts/LATEST_RUN
```

| Path | Contents |
| --- | --- |
| `ledger/cases.json` | one row per case: `case_id`, `url`, `settings`, `project_id`, `job_id`, `clip_ids`, `state`, `attempts`, `outcome` — **written after every state change so the run resumes** |
| `ledger/defects.json` | one row per defect: `id`, `title`, `screen`, `repro_spec`, `evidence`, `root_cause`, `fix_commit`, `verify_run`, `status` |
| `coverage.csv` | every control in §6 with `PASS` / `FAIL` / `BLOCKED` / `NOT IMPLEMENTED` and evidence path |
| `render-matrix.csv` | same columns as the previous run's file — keep the format |
| `media-validation/<case>/` | ffprobe JSON, decode log, freeze/black/volume reports, extracted frames |
| `contact-sheets/<case>/contact.jpg` | frame grid for eyeballing |
| `outputs/` | the actual downloaded `.mp4` files |
| `screenshots/`, `traces/`, `browser-recordings/` | Playwright evidence |
| `REPORT.md` | the final honest report (§11) |

Use a unique prefix for every project name you create, e.g. `QA_<RUN>_<CASE_ID>`, so your records are distinguishable from the owner's and never collide.

Write Playwright specs into `tests/acceptance/` (they are picked up by `playwright.config.ts`, which already points `baseURL` at `http://127.0.0.1:8080` and allows `S6_ACCEPTANCE_URL` to override). One-off probes belong in `scripts/qa/`, matching the existing style there.

---

## 5. The content gate — "real video, not static"

**This is the most important section. A clip that plays but shows a frozen frame is a FAIL, and so is one that decodes cleanly but shows a placeholder card where source footage was expected.**

Every completed output must pass **all** of the following. Run the ffmpeg/ffprobe stages inside the engine container (host paths map `/Volumes/Carmelo HDD/S6_CUT-data/…` → `/app/data/…`).

### 5.1 Container and stream sanity

```bash
docker compose exec -T engine ffprobe -v error -show_streams -show_format -of json "/app/data/jobs/$JOB/clips/$FILE"
```
- video stream `h264`; audio `aac` **unless** the job explicitly warned it rendered silent
- `width`×`height` exactly matches the requested aspect (9:16 → 1080×1920, 1:1 → 1080×1080, 4:5 → 1080×1350, 16:9 → 1920×1080)
- `duration` within the requested min/max window (and for case 5, equal to the 25 s trim ±0.5 s)
- non-zero bitrate; `nb_frames` consistent with duration × fps

### 5.2 Full decode with no errors

```bash
docker compose exec -T engine ffmpeg -v error -i "$P" -f null - 2>&1 | tee decode.log
```
Any output = FAIL.

### 5.3 Freeze detection (the static check)

```bash
docker compose exec -T engine ffmpeg -hide_banner -i "$P" -vf "freezedetect=n=-60dB:d=2" -map 0:v -f null - 2>&1 | grep freezedetect
```
**FAIL if total frozen duration exceeds 25% of the clip, or if any single freeze span is longer than 3 s.**

### 5.4 Black / uniform-frame detection

```bash
docker compose exec -T engine ffmpeg -hide_banner -i "$P" -vf "blackdetect=d=0.5:pix_th=0.10" -an -f null - 2>&1 | grep blackdetect
```
**FAIL if black covers more than 15% of the clip.**

### 5.5 Frame-to-frame motion statistics

```bash
docker compose exec -T engine ffprobe -f lavfi -i "movie=$P,signalstats" \
  -show_entries frame_tags=lavfi.signalstats.YAVG,lavfi.signalstats.YDIF -of csv
```
**FAIL if median `YDIF` across the clip is below 0.5** (essentially no luma change = static), **or** if `YAVG` standard deviation across sampled frames is under 1.0 (a flat card rather than a photographic frame).

### 5.6 Sampled frames must differ from each other

Extract at least 8 frames spread across the duration, hash them, and require **at least 6 distinct hashes**. Build the contact sheet from the same frames:

```bash
docker compose exec -T engine ffmpeg -i "$P" -vf "fps=8/$DUR,scale=320:-1,tile=4x2" -frames:v 1 "/app/data/qa-downloads/$RUN/$CASE-contact.jpg"
```

### 5.7 It must be the *source*, not a fallback card

A clip can be perfectly non-static and still be wrong — a rendered text card moves (captions animate) but contains none of the imported footage.

- Read the clip's `provenance` and the job `warnings` from `/api/v1/jobs/{id}`. If `visualLabel` / provenance indicates a text-card fallback for a **Clip-mode** job built from a YouTube source, that is a **defect**: Clip mode must cut the source, never substitute a card.
- Cross-check pictorially: extract a frame from the **imported source** at the midpoint of `clip.start`–`clip.end`, extract the corresponding output frame, and compare. They should be visibly the same scene (allowing for crop, scale, and burned captions). Use a downscaled greyscale mean-absolute-difference; a wildly different frame means the cut is not where the EDL says it is.

### 5.8 Audio is real

```bash
docker compose exec -T engine ffmpeg -i "$P" -af volumedetect -vn -f null - 2>&1 | grep -E "mean_volume|max_volume"
```
**FAIL if `mean_volume` is below −50 dB** unless the job explicitly warned that the source had no speech or that a silent render was chosen. Pure digital silence (`max_volume: -91.0 dB`) on a source that has audio is always a FAIL.

### 5.9 Captions are actually burned in

When subtitles were ON:
- `GET /api/v1/jobs/{job}/clips/{clip}/captions/srt` must return a non-empty cue list whose timings fall inside the clip.
- Sample three frames at cue midpoints and one frame in a gap between cues; the lower-third pixel variance must be measurably higher during cues than in the gap. If it is identical, captions were not burned in despite the toggle.

When subtitles were OFF (case 4), the reverse: no caption-shaped pixel activity, and the UI must not claim captions were burned.

### 5.10 The browser must render it — verified in Playwright

Disk validity is not enough; the served stream through nginx must play. In the Workspace with the clip selected:

```js
const result = await page.evaluate(async () => {
  const v = document.querySelector(".viewer-frame video");
  if (!v) return { error: "no video element" };
  v.muted = true;
  try { await v.play(); } catch (e) { return { error: "play rejected: " + e.message }; }
  const snap = () => {
    const c = document.createElement("canvas");
    c.width = 160; c.height = 90;
    c.getContext("2d").drawImage(v, 0, 0, 160, 90);
    return c.getContext("2d").getImageData(0, 0, 160, 90).data;
  };
  await new Promise(r => setTimeout(r, 1200));
  const t0 = v.currentTime, a = snap();
  await new Promise(r => setTimeout(r, 3000));
  const t1 = v.currentTime, b = snap();
  let diff = 0;
  for (let i = 0; i < a.length; i += 4) diff += Math.abs(a[i] - b[i]);
  return {
    readyState: v.readyState, w: v.videoWidth, h: v.videoHeight,
    advanced: t1 - t0, meanDiff: diff / (a.length / 4),
    err: v.error?.message || null,
  };
});
```

**Require:** `readyState >= 3`, `advanced >= 1.5`, `meanDiff >= 3.0`, `err === null`, and `w`/`h` matching the requested aspect. The media is same-origin through nginx, so the canvas is not tainted — if `getImageData` throws, that itself is a finding worth reporting.

Repeat the same check for the **Library** preview dialog and the **Shorts Editor** clip browser, so all three players are proven, not just one.

### 5.11 Signed-URL expiry

`S6_MEDIA_URL_TTL_SECONDS` is 900. A long QA session **will** cross that boundary. Deliberately leave a Workspace tab idle for >15 minutes, then press Play. Expected behaviour is a clean recovery (refreshed link or the visible "Retry preview" affordance), **not** a silent dead player. If the preview dies with no route back, that is a defect — file it.

---

## 6. Feature matrix — every screen, every control

Walk all of these. Each row goes into `coverage.csv` with evidence. At **1440×1000**, then repeat the shell-level and layout checks at **1024×768**, **768×1024**, and **390×844** (the existing responsive specs show the expected conventions).

### 6.1 Application shell
- Skip link is the first tab stop and moves focus to `#main-content`
- All seven rail buttons navigate; `aria-current="page"` tracks the active one
- Brand button returns to Projects
- Engine startup row `Connecting to the local engine…` appears then resolves exactly once
- Top-bar badge: `Local engine` / `Fallbacks active` / `Engine offline`
- Global alert + **Retry** appears when the engine is unreachable and clears when it returns (simulate with `docker compose stop engine` / `start engine` — this is safe, non-destructive)
- Page change scrolls to top
- PWA: `/manifest.webmanifest`, `/sw.js`, all four icons return 200; title matches `/S6_cut/i`
- Zero uncaught page errors; zero console errors other than the known benign COOP notice; zero HTTP ≥400 (record every one)

### 6.2 Projects
- `Clip mode` / `Script mode` segmented control, `aria-pressed` correct
- Source tabs `Local file` / `YouTube` (roles are `tab`)
- Drop zone: Browse button, Enter/Space activation, drag-enter styling, multi-file drop rejected with "Choose one video file at a time.", unsupported extension rejected with the MP4/MOV/WebM/MKV/M4V/AVI message
- YouTube field rejects `http://`, non-YouTube hosts, and malformed URLs with "Only public HTTPS YouTube URLs are supported."; accepts `youtube.com`, `m.youtube.com`, `youtu.be`, and URLs carrying extra query params
- Four style cards select exclusively
- `Short form · 9:16` / `Long form · 16:9`; switching to Long form forces aspect 16:9 and **disables** the Advanced aspect select
- Clip count −/+ clamps at 1 and 30; the Create button label tracks count and format ("Create 3 short clips", "Create 2 landscape clips", singular at 1)
- Processing mode Auto / Fast / Smart, and the hint text under it changes correctly for each — including the "Checking connected providers…" state before `/profiles` answers
- Burn-in subtitles checkbox
- Advanced controls: expands, aspect 9:16 / 1:1 / 16:9 / 4:5, min seconds (≥8), max seconds (>min; ≤180 for short form). Verify each error string fires.
- Project name (160 char max), Business folder select, **New folder** (`window.prompt` — handle the dialog), last-used folder persisted in `localStorage` under `s6-cut.recent-library-folder`
- Script mode: textarea, character counter, `.txt`/`.md` upload, rejection of other extensions, <10 char error, Narration select (auto / local / silent)
- Create is disabled when `health.ffmpeg === false`
- Recent projects: cards show style, count, format, age, `Authorised URL` vs `Local source`, live progress and status badge; **Refresh**; search box appears only above 12 projects and filters name + style; "Show all N projects" toggle; empty/no-match states and **Clear search**

### 6.3 Workspace
- Breadcrumb shows `Workspace / <project name>`
- Business folder select + the `window.confirm` about moving existing Library assets — test **both** answers and verify the asset placement each time
- Status badge and stage label track the job
- **Pause**, **Resume**, **Stop & keep**, **Retry failed**, **Retry import** appear only in their valid states and actually work (case 6)
- Job strip progress advances with real values; Smart stages must show genuine segment progress, not a simulated bar
- `ProcessChecklist` records real checkpoints; `WarningList` renders engine warnings
- Source panel: `Transcript`/`Script` and `Media` tabs, including **ArrowLeft/ArrowRight roving focus**; Media tab lists project assets with working inline players; Media error state offers Retry
- Clip board: tile per clip, zero-padded index, score ring, thumbnail `<video>`, `Retry preview` button when a thumb fails, Preview / Download / "Include in export" checkbox, "Saved to Library" badge, failed-clip **Retry clip**
- ⚠ **Board filters `All` / `Selected` / `Failed`** — confirm at runtime whether they filter anything (see §9.1)
- Viewer: `Toggle safe areas`, `Mute preview`/`Unmute preview`, transport `Previous frame`, Play/Pause, time readout counting up, and the `J K L` hint (see §9.2)
- Preview failure paths: `Retry preview`, `Retry playback`, `Play muted` — force them by temporarily renaming an output file on the data volume, then restore it
- Inspector tabs `score` / `captions` / `asset` / `info`; Score inspector shows all seven factors, the total, the explanation, and penalties
- **Download ZIP** with the selection count; the ZIP must contain the numbered media, `manifest.json`, and `credits.json`, and the credits must carry the YouTube creator attribution (there is an existing `youtube-creator-credit.spec.ts` — extend it, do not duplicate it)
- Stalled-Smart callout after 90 s of no progress: `Switch to fast local`, `Keep waiting`, `Stop & keep outputs`
- Empty state when no project is selected → `Choose a project`

### 6.4 Shorts Editor
- Source picker: Local file / YouTube / **Library** (the third tab only exists here)
- Trim `Start seconds` / `End seconds` inputs and the `Trim start` range stay in sync
- Validation: negative start, end ≤ start
- `Aspect ratio` select, `Subtitles` checkbox, project name, `Change source`
- Preview transport: play/pause, `Preview position` scrub
- ⚠ `Preview volume` and `Expand preview` buttons (see §9.3)
- `Queue short` submits; `Unsaved edits` → `All changes saved`; `Undo` restores the previous state; the "Discard unsaved Shorts Editor changes?" confirm fires when switching clips while dirty
- Clip browser: `Filter clips` select (all/queued/rendering/complete/failed) actually filters; "Show N more of M" paging; per-row `Retry failed clip` and `Stop clip and keep completed outputs`
- AI editing assistant: duration ("make it 20 seconds"), start/end, aspect ("use 1:1"), subtitles ("add captions"); proposal intent ("propose …") must **not** apply until `Apply proposal`, and `Reject` must discard; unsupported requests ("centre the speaker") must return the honest refusal
- ⚠ Pressing **Enter** in the assistant input (see §9.4)

### 6.5 AI Video (Topic to Video)
- Provider status row: `Checking connected providers…` → connected/not configured
- With no provider: `Configure OpenRouter` button routes to Settings; the custom-script path still plans locally
- With a provider: model picker populates, `Refresh models`, the charge warning names the chosen model, and the models-error state offers Retry
- Brief fields; Target seconds 10–180; Aspect select; Variants clamped 1–3
- `Create / refresh plan` → plan review panel shows title, hook, narration, beat count, estimated duration, hashtags
- Changing provider or model after planning must show "Create a new plan for the selected model" and disable Generate
- `Generate reviewed video(s)` queues exactly `variants` script jobs, named `<title> — Variant N`
- **If no OpenRouter key is available for this run**, cover the entire custom-script (local planning) path fully and mark the provider-backed rows `BLOCKED`, not `PASS`.

### 6.6 Jobs
- Card per job, CLIP/SCRIPT tag, stage label, state badge, style, age, "N outputs ready"
- Download facts (phase, transferred, speed) during a YouTube import
- Progress bar for non-settled jobs only; grouped warnings with the "+N more" suffix
- `Open` navigates to that project's Workspace
- `Pause` / `Resume` / `Retry failed clips` / `Retry import` appear in the right states and work
- `Refresh`; "Show all N jobs" beyond 20
- Poll cadence tightens while work runs and relaxes when idle

### 6.7 Settings
- `New profile` / `Add profile` opens the form; auto-opens when no profile exists
- Fields: name, secret storage (encrypted / session), OpenRouter key with show/hide toggle, text model, TTS model (datalist + `Refresh speech models`), TTS voice datalist, TTS speed 0.25–4
- `Save and test connection` runs a real test; connection results show per-service status, message, and last-checked time
- `Use profile`, `Test`, `Edit`, `Duplicate`, `Delete` (with confirm)
- **Saved secrets are never returned** — assert the key field is empty on reopen and that `GET /api/v1/profiles` contains only the mask
- Runtime capabilities list matches `/api/health`; `Refresh` re-reads it
- Network boundary card shows the real `dataPath`
- `Use local cutting without API` / `Continue with local cutting` returns to Projects
- The existing `openrouter-settings-mocked.spec.ts` covers the mocked path — extend rather than replace

### 6.8 Library
- `Import asset` panel: file, title, business folder, tags, trigger phrases, policy, licence → asset appears in the grid
- Folder tree: `New business folder`, add subfolder, Rename, Move (including the "Destination folder not found." error), Archive/Restore, Remove (assets relocate to Unsorted, **nothing is deleted**)
- Tree keyboard navigation: ArrowUp/ArrowDown/Home/End across `role="treeitem"`
- `Show archived` toggle
- Policy filters required / prefer / neutral / never with live counts
- `Search media`, `Media type`, `Asset origin` filters; combined filtering; "No media matches these filters" → `Clear filters`
- Bulk select → `Move selected assets`
- Asset card: `Preview <title>` opens the video dialog (Escape closes, focus returns to the opener — `tests/library-keyboard-preview.spec.ts` already covers this; run it), `Select <title> for Rule Inspector`
- Rule Inspector: title, policy, triggers, tags, brands, people (comma splitting), min spacing, max uses, licence, protected checkbox; blur-save actually persists
- `Remove Library record` is disabled while protected; enabled otherwise, with confirm
- "Show 60 more of N" paging
- Cross-view sync: completing a clip in Workspace must make it appear in Library without a manual reload

### 6.9 Help
- `Open S6 Cut Help` from the rail; all six section links scroll to their sections
- Every `/help/*.png` reference resolves 200 and renders with non-zero dimensions
- Escape closes; backdrop click closes; Tab is trapped inside the dialog; focus returns to the launcher
- Body scroll is locked while open and restored after

---

## 7. Order of work

1. Bring-up + health gate + YouTube probe (§2)
2. Static pass over every screen at all four viewports — no jobs yet. Catch layout, wiring, and dead-control defects cheaply first. (§6)
3. Triage and fix everything found in step 2 using the loop in §8, because a broken control will corrupt the render matrix.
4. Case 1 → full content gate (§5) → fix → re-verify.
5. Cases 2–6 in order, each with the full content gate.
6. Cross-cutting: signed-URL expiry, SSE drop + polling fallback (`docker compose stop engine` for 30 s mid-job, then start — progress must survive), container restart with a completed job still accessible.
7. Full regression gate (§10).
8. Report (§11).

---

## 8. The defect loop — mandatory for every issue

For each defect, in order, no skipping:

1. **Reproduce in Playwright.** Write a named, minimal spec in `tests/acceptance/` that fails for the right reason. Save trace, video, and screenshot. If it cannot be reproduced through the browser, say so and reclassify it as a source-audit finding.
2. **Capture evidence before touching code**: screenshot, trace, console errors, failing network calls, relevant `docker compose logs engine --since 10m`, and the job JSON.
3. **Find the root cause.** Read the component and the engine route. Do not pattern-match a symptom fix.
4. **Fix minimally**, in the style of the surrounding code. This codebase comments *why*, not *what* — match that. Keep the fix scoped to the defect.
5. **Re-run the repro spec.** It must now pass.
6. **Re-run the neighbours**: the component's own vitest file, plus any acceptance spec touching that screen.
7. **Rebuild and re-verify through the real gateway** — `docker compose up -d --build`, then re-run the spec against `http://127.0.0.1:8080`. A fix verified only against `npm run dev` does not count.
8. **If it still fails, go back to step 3.** Loop until resolved. If three full loops do not resolve it, write up exactly what was tried, what the evidence shows, and what the next hypothesis is — then move on and mark it `OPEN`.
9. Append to `ledger/defects.json` and commit with a focused message.

Commit style: one commit per defect, imperative subject, body explaining the root cause. End every commit message with:

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

Do not push, and do not open a PR, unless the owner asks.

---

## 9. Known suspicions from static audit — confirm at runtime first

These were found by reading the source on 2026-09-11. **They are hypotheses, not confirmed defects.** Reproduce each in the browser before changing anything; if a suspicion turns out to be fine, record it as verified-OK.

**9.1 Workspace board filters look inert.** `web/src/components/workspace-view.tsx:541` renders `All` / `Selected` / `Failed` as three buttons with no `onClick` and a hard-coded `active` class on `All`. If they do nothing, either wire them to filter the clip board or remove them — a control that cannot be actuated is worse than no control.

**9.2 Workspace `J K L` hint may have no keyboard handler.** `workspace-view.tsx:521` displays the shortcut legend, but no `keydown` binding for J/K/L was found in the component. Also note the transport offers `Previous frame` with no matching *next* frame control. Confirm both.

**9.3 Shorts Editor has two dead icon buttons.** `shorts-editor-view.tsx:196` renders `Preview volume` and `Expand preview` with no handlers. Either implement them (mute toggle; fullscreen on the preview element) or remove them.

**9.4 Enter in the Shorts Editor assistant probably queues a render.** The whole panel is wrapped in `<form onSubmit={submit}>` at `shorts-editor-view.tsx:185`, and the assistant composer input at line 201 sits inside it with its send button as `type="button"`. Pressing Enter in the chat box would therefore submit the outer form and **queue a short** instead of sending the message. Confirm, and if so fix it (handle Enter on the input, or take the composer out of the form).

**9.5 Workspace inspector tabs show raw lowercase keys.** `workspace-view.tsx:526` renders the literal strings `score`, `captions`, `asset`, `info`. Cosmetic, but visible — check against the rest of the UI's sentence-case convention.

**9.6 Signed media links expire mid-session.** `S6_MEDIA_URL_TTL_SECONDS=900` while renders take many minutes. Verify the expiry path recovers (§5.11).

**9.7 Long-form 16:9 aspect is force-set but Advanced still shows a select.** Confirm the disabled state holds and that the submitted `aspectRatio` is genuinely `16:9` regardless of what the select last displayed.

**9.8 YouTube import robustness.** The documented fix uses `--extractor-args youtube:player_client=android,web` with a broader retry set and stale `.part`/`.ytdl` cleanup, backed by the `pot-provider` container. Two of the six URLs carry `&pp=` parameters — confirm they flow through validation, storage, and yt-dlp unmangled.

---

## 10. Regression gate before the report

All of these must run, and their real output must be recorded — including failures.

```bash
npm run lint
npm run typecheck
npm test -- --run                      # vitest; previous run hit a 120s tool timeout — give it a longer ceiling
.venv/bin/python -m pytest engine/tests -q
npm run build
docker compose config
npx playwright test --config playwright.config.ts
```

Baselines to beat, from `IMPLEMENTATION_STATUS.md`: 221/221 frontend tests, 265/265 engine tests, lint clean, typecheck clean under strict mode. **Any regression below those numbers blocks the report.**

Then update `IMPLEMENTATION_STATUS.md` — both the verified-evidence list and the honest-limitations list — to reflect what this run actually established. Do not inflate it.

---

## 11. Report

Write `test-artifacts/$RUN/REPORT.md` with:

1. **Executive result** — one honest paragraph. Full pass, or partial with the exact reason.
2. **Deployment evidence** — revision, branch, compose project, image IDs, health JSON, data mount.
3. **Counts** — coverage rows by outcome; cases attempted/completed; defects found/fixed/open.
4. **Per-case results** — for each of the six URLs: settings, job and clip IDs, outcome, and the §5 gate results with the actual numbers (freeze %, black %, median YDIF, mean volume dB, browser `advanced` and `meanDiff`). Numbers, not adjectives.
5. **Defects** — for each: symptom, repro spec path, evidence paths, root cause, fix (file:line + commit), verification evidence, final status.
6. **Still broken / open** — anything unresolved after three loops, with the next hypothesis.
7. **Blocked / not covered** — and why. Be specific; "ran out of time on Smart 16:9" is a fine entry.
8. **Rerun instructions** — the exact commands to resume from the ledger.

Also refresh `coverage.csv`, `render-matrix.csv`, `ledger/*.json`, and `test-artifacts/LATEST_RUN`.

---

## 12. Stop conditions

**Stop and ask the owner** before:
- anything that would delete or overwrite existing projects, Library records, blobs, or the SQLite database
- changing `compose.yaml`, the `/app/data` mount, engine ports, or anything under `DO-NOT-CHANGE/`
- spending money on a paid OpenRouter model (free models and the local paths are fine)
- pushing commits or opening a pull request
- any change to the delivery encode profile (H.264 slow/CRF 18/AAC 192k) — it is a deliberate quality decision, not a performance bug

**Keep going without asking** for: writing tests, fixing UI and engine defects, restarting containers, rebuilding images, creating new QA projects, and stopping/starting services for fault-injection tests.

**Done means:** every row in `coverage.csv` is `PASS` or has a written, justified `BLOCKED`/`OPEN`; all six URLs produced outputs that passed the full §5 content gate (or are documented as genuinely blocked); the regression gate is green at or above baseline; and `REPORT.md` tells the truth about all of it.
