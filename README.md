# S6_cut

S6_cut is a free, open-source, local-first video studio. Drop a long video or paste an authorised YouTube URL, choose Funny, Serious, Educational, or Hype, and receive independent vertical shorts with local word-timed captions.

There is no S6_cut account, credit system, watermark, artificial usage limit, or mandatory hosted application backend. The web gateway and private media engine run on hardware you control.

## Quick start (Docker)

The repository is currently **private**. Authenticated GitHub CLI users can install now using the commands below. Once the repository is made public, the standard anonymous one-liners will work from any device. The commands below pin both the bootstrap script and the installer checkout to the current default branch (`main`).

### Linux / macOS (bash)

**Private repo / authenticated (works now):**
```bash
gh api -H "Accept: application/vnd.github.raw+json" repos/carmelo-schepis/S6_CUT/contents/install.sh?ref=main | S6_BRANCH=main bash
```

**Public repo / anonymous (works after repository visibility is changed to public):**
```bash
curl -fsSL https://raw.githubusercontent.com/carmelo-schepis/S6_CUT/main/install.sh | S6_BRANCH=main bash
```

### Windows (PowerShell)

**Private repo / authenticated (works now):**
```powershell
$script = (gh api -H "Accept: application/vnd.github.raw+json" repos/carmelo-schepis/S6_CUT/contents/Install-S6_CUT.ps1?ref=main) -join "`n"
& ([scriptblock]::Create($script)) -Branch main
```

**Public repo / anonymous (works after repository visibility is changed to public):**
```powershell
$script = irm https://raw.githubusercontent.com/carmelo-schepis/S6_CUT/main/Install-S6_CUT.ps1
& ([scriptblock]::Create($script)) -Branch main
```

The installer checks for Git, Docker, and Docker Compose v2, clones S6_cut into `~/s6_cut` (or updates an existing installation in place), creates `.env` from the template on first run — and never overwrites your configuration — then builds, starts, and waits for the app to become ready. When it finishes you will see:

```text
✓ S6_cut is running

Frontend: http://localhost:8080
Backend:  http://localhost:8001
```

Open the **Frontend** URL in your browser. The engine's own port is bound to loopback and is never published to your network. That is not, however, an access control for the API: the web gateway proxies `/api/` — including the API docs at `/api/docs` — through to the engine, and S6_cut has no authentication. The API is therefore reachable from every interface the frontend is published on, which by default is all of them. Anyone who can reach the frontend can create, read and delete your projects and Library media. Set `S6_PORT` to bind it narrower — `S6_PORT=127.0.0.1:8080` restricts it to this machine, and `S6_PORT=<one-address>:8080` to a single interface — or keep it on a trusted network.

Requirements: Git, curl, Docker Engine with Compose v2, with 8 GB RAM recommended and enough storage for source media, the Whisper model, temporary renders, and outputs. The installer does not install Docker for you: on Linux, install Docker Engine; on macOS/Windows, install Docker Desktop.

- **Update** — re-run the same command. Your `.env`, projects, Library, media, outputs, models, and persistent Docker state are preserved.
- **Uninstall** (keeps your data) — run the one-command uninstaller:

  **Linux / macOS:**
  ```bash
  bash ~/s6_cut/uninstall.sh
  ```

  **Windows:**
  ```powershell
  & $HOME\s6_cut\uninstall.ps1
  ```

No-provider Auto jobs use Fast local cut and do not download Whisper. The first explicit Smart clips job downloads the configured Faster-Whisper model into the mounted data path.

### High-volume batches

Clip projects default to **Standard** (up to 30 outputs, using the existing planners). **High-volume** is an explicit Speech-mode option for 1–500 requested outputs and supports both vertical Shorts and landscape sources with Fast, Auto, or Smart processing. Its deterministic planners can overlap cuts but use distinct starts, real source/transcript timing, and duration-valid windows. AI hook text is optional and off by default. In Projects step 3, tick **AI hook text** to opt in to OpenRouter writing a short curiosity hook at the top of each Short; it works whether or not subtitles are burned. The choice is not persisted and starts unchecked every time Projects is mounted. Hook text is available only for eligible Smart, short-form, Standard Speech jobs with a connected OpenRouter provider, and appears read-only in the Workspace. It is unavailable in Fast, provider-less, Long form, High-volume, and Music jobs (Music keeps its manual Top text). If OpenRouter fails or returns unusable text, clips still render without hooks and the Workspace shows a warning. Smart high-volume planning stays local rather than sending large candidate sets to a provider. Music retains its existing non-overlapping planner and Standard limit.

The requested count is preserved. The effective target is confirmed against FFprobe and, for Smart, the available timed transcript. Under 30 minutes the engine attempts the full request; if valid windows are short, the effective target falls back to at most 300 and never exceeds the number of valid windows. At or above 30 minutes it supports up to 500 where valid. The Workspace shows requested, effective, planned, and successful counts plus the reason for any reduction; YouTube sources show that FFprobe confirmation is pending until download completes. Export selection supports up to 500 clips and manifests/credits describe only files actually included in the archive.

## Manual installation (Docker Compose)

Prefer to run the commands yourself, or want to pin a specific revision? Clone and start S6_cut manually:

```bash
git clone https://github.com/carmelo-schepis/S6_CUT.git
cd S6_CUT
cp .env.example .env
docker compose up -d --build
docker compose ps
```

Open <http://localhost:8080>. To stop without deleting state:

```bash
docker compose down
```

Only nginx publishes a port to your network. The FastAPI engine stays on the Compose network and additionally binds the host loopback at <http://localhost:8001> (API docs at `/api/docs`) for local debugging. Do not expose the raw engine HTTP port to the public internet; use an authenticated HTTPS reverse proxy or VPN for remote access.

## Local development

Requirements: Node.js 24+, Python 3.12, and FFmpeg/FFprobe. Install the exact dependencies, then start the Vite UI and FastAPI engine together:

```powershell
npm ci
python -m venv .venv
.venv\Scripts\python -m pip install -r engine\requirements-dev.lock
$env:S6_PYTHON = ".venv\Scripts\python.exe"
npm run dev
```

Open <http://127.0.0.1:5173>. Vite proxies same-origin `/api` requests to port 8001. On Windows, `START_S6_CUT.cmd` builds and starts the production Compose application.

### Installable PWA behavior

The production web UI is an installable Progressive Web App. When served through the same-origin gateway, the browser can install it as **S6_cut** using the browser's install control. Installation and service-worker caching require a secure context: HTTPS is required for network hostnames, while `localhost` and `127.0.0.1` are permitted loopback exceptions. The default `http://localhost:8080` setup therefore supports PWA behavior locally; a LAN hostname or IP needs an HTTPS reverse proxy or VPN deployment. The app shell is precached by `/sw.js`, and an already loaded shell can open cached routes while the browser is offline. Offline mode does not make the local engine or media operations available: `/api/` requests, uploads, downloads, exports, and video files are deliberately not cached, so reconnect to the local engine before creating or processing projects.

When a new application bundle is available, S6_cut shows **A new S6_cut version is ready**. Choose **Update app** to activate it; updates do not interrupt an active render automatically.

### Caption styles

Clip captions use the selected Funny, Serious, Educational, or Hype style. The engine renders these presets with the bundled Anton, Archivo Black, and Barlow display faces inside the engine image; it does not depend on a host machine having those fonts installed. Funny uses Archivo Black, Serious and Educational use Barlow, and Hype uses Anton. If a bundled face cannot be resolved at engine startup, the engine logs the requested and substituted font family instead of silently treating the fallback as the selected style. The font files and their SIL Open Font License notices are listed in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) and `third_party_provenance.json`.

Newly created Speech short-form jobs resolved to Smart use the reference-style Montserrat ExtraBold Italic captions and may add sparse, locally vendored Fluent 3D emoji images. Fast, Music, Long form, and historical jobs retain their prior presentations. For YouTube sources, the resolved video title and channel are kept with project attribution; eligible Shorts show a source credit. ASS downloads represent supported text styling; SRT/VTT cannot reproduce the raster emoji overlays. The exported MP4 and application preview use the same rendered captions, emoji, and eligible YouTube creator credit.

### Stopped YouTube imports

**Stop & keep** preserves a YouTube import as a recoverable Workspace even when it stops during download before producing a Library asset. The project remains visible in the Projects list and the Workspace offers **Retry import**. If a selected project temporarily leaves the recent Projects listing—for example, after its last Library asset is removed—the UI does not silently switch the Workspace to another project; it shows its own empty state and can resolve the project again when it returns.

## Configuration

Copy `.env.example` to `.env`. Important values:

| Variable | Default | Purpose |
| --- | --- | --- |
| `S6_PORT` | `8080` | Published web/portal port — the URL you open in a browser and the only port reachable from your network |
| `S6_ENGINE_PORT` | `8001` | Engine API port, bound to the host loopback only (API docs and debugging) |
| `S6_DATA_PATH` | `./data` | Persistent database, jobs, uploads, Library, cache, models, exports, and instance secrets |
| `S6_WHISPER_MODEL` | `base` | CPU-friendly local Faster-Whisper model used only by explicit Smart clips |
| `S6_WHISPER_DEVICE` | `cpu` | Whisper device: `cpu`, `auto`, or `cuda` |
| `S6_WHISPER_COMPUTE_TYPE` | `int8` | Whisper compute type: `int8`, `int8_float16`, `float16`, `float32`, or `auto` |
| `S6_WHISPER_BEAM_SIZE` | `1` | Whisper beam size (1–8); lower beams decode faster on CPU |
| `S6_WHISPER_WORD_TIMESTAMPS` | `true` | Enable word-level timestamps required for caption rendering |
| `S6_JOB_WORKERS` | `1` | CPU/RAM-heavy concurrent jobs; start with one |
| `S6_MAX_QUEUED_JOBS` | `4` | Bounded pending queue |
| `S6_MAX_UPLOAD_BYTES` | `20000000000` | Streamed source-size ceiling |
| `S6_MAX_SOURCE_SECONDS` | `14400` | Four-hour duration ceiling |
| `S6_JOB_RETENTION_DAYS` | `30` | Operator retention target |
| `S6_MEDIA_URL_TTL_SECONDS` | `900` | Signed media/download-link lifetime |
| `S6_YTDLP_CONNECT_TIMEOUT` | `45` | YouTube connection/setup timeout in seconds |
| `S6_YTDLP_INACTIVITY_TIMEOUT` | `300` | No-byte inactivity period before a download fails; actively progressing large files are not cut off |

The OpenRouter profile can be configured in Settings. Persistent secrets are encrypted with a locally generated instance key and are never returned by read APIs. Headless deployments may set `OPENROUTER_API_KEY` in `.env` or Docker secrets orchestration. Protect `.env` like any other credential file.

### Whisper performance tuning

Smart-mode transcription runs locally with Faster-Whisper. The CPU-friendly defaults (`cpu` + `int8` + beam 1) keep memory low and decode fast; raise the model size or beam only when you need more accuracy and have CPU/RAM headroom:

- `S6_WHISPER_MODEL=base` or `small` is the sweet spot on 8 GB hosts; `medium`/`large-v3` need noticeably more RAM and time.
- On an NVIDIA GPU, set `S6_WHISPER_DEVICE=cuda` with `S6_WHISPER_COMPUTE_TYPE=float16` for the fastest decode.
- `S6_WHISPER_WORD_TIMESTAMPS=false` skips per-word alignment (faster) but disables word-timed captions; keep it `true` for captioned clips.

Whisper job stages report real, incrementally observed progress: each fraction is derived from an actual decoded segment boundary (`segment.end / duration`), never simulated, and stage labels show the text of the segment just decoded. YouTube imports likewise persist actual downloader byte counts, known totals, speed, ETA, and the last byte-progress timestamp in the job record. A retained partial can be retried with yt-dlp continuation; the import only cleans partial artifacts inside that job directory when it needs a fallback attempt. The engine checks the model cache on disk, so a pre-downloaded model (under `S6_DATA_PATH/models`) skips straight to transcription.

## Provider and fallback matrix

| Capability | Preferred | Missing or failing optional provider |
| --- | --- | --- |
| Fast clip cutting | Deterministic FFprobe windows and FFmpeg crop | No transcription, captions, model download, or API required |
| Smart transcription/timing | Local Faster-Whisper | Local Whisper supplies timing; an LLM never performs transcription |
| Smart clip selection | Optional OpenRouter ordering over validated local candidates | Deterministic local candidate planning |
| Visuals | Clip projects cut the imported source; a valid personal Library asset may be composited as an overlay | Clip mode never substitutes a text card for source footage |
| YouTube | Constrained local yt-dlp | Local upload remains available and the URL failure is scoped |

The application remains operational when OpenRouter is the only configured API. Clip mode also works with no API key. Script mode and AI Video have been retired; existing project records and completed outputs remain available for reading, download, export, and deletion. Optional provider failure becomes a visible warning and local fallback, not a corrupt project.

## Data, backup, restore, and removal

All server-side state is under `S6_DATA_PATH`:

```text
s6-cut.sqlite3      projects, jobs, business folders, blob references, Library metadata, caches
jobs/               project references, atomic journals, captions, clips
blobs/sha256/       shared content-addressed media used by projects and the Library
library/            legacy personal media retained in place during staged migration
models/             Faster-Whisper model cache
cache/              reusable analysis/media cache
exports/            ZIP bundles
secrets/            instance encryption and media-signing keys
temp/               bounded temporary work
```

Back up or snapshot the complete data directory while the stack is stopped, or use a filesystem-consistent snapshot. Restore by placing the directory at the configured path before starting the same or newer application version. Preserve `secrets/`; otherwise saved provider profiles and existing signed-link identity cannot be recovered.

- Uninstall but keep data: run `uninstall.sh` (or `docker compose down --rmi local` for the manual flow), leaving `S6_DATA_PATH` untouched. `uninstall.sh --purge --yes` additionally deletes the installation directory and everything in it — including your data; use it only when you are sure.
- Remove data: stop the stack, confirm the exact configured absolute data path, and remove that dataset/directory separately. Compose never declares a named volume that silently deletes the host dataset.
- Deleting one project never deletes a Library source as a side effect. Removing a Library record likewise leaves project and clip references usable.
- To empty the Library from the UI, open **Settings → Library data**, choose **Delete all Library content**, and type `DELETE ALL CONTENT`. This permanently removes Library media—including archived and protected items—and cascades linked projects and generated media, while preserving provider profiles, secrets, settings, the database, and business-folder records. The action is unavailable while a job is queued or processing.
- Business folders are organizational containers, not accounts or access-control boundaries; folder names never become filesystem paths.
- Back up and restore the entire `S6_DATA_PATH` together. The SQLite reference graph and `blobs/` content-addressed files are one backup unit. Existing `library/` files are migrated by reference without destructive startup moves.
- New managed media uses an atomic same-filesystem hard link into the shared blob store when supported, with an atomic copy fallback for filesystems that cannot hard-link. The schema is already separated into blobs and references so legacy media can be consolidated gradually without startup relocation.

## TrueNAS SCALE and Portainer

See [docs/TRUENAS_PORTAINER.md](docs/TRUENAS_PORTAINER.md) for dataset layout, Stack/Custom App configuration, update, backup, restore, and uninstall procedures.

## Local delivery quality

Final renders use one shared local delivery profile: H.264 (`libx264`), `slow`
preset, CRF 18, `yuv420p`, `+faststart`, and AAC at 192 kbps/48 kHz. Stereo
sources remain stereo. This increases render time and
file size compared with disposable fast encodes, but avoids unnecessary quality
loss and keeps outputs broadly browser-compatible.

Portrait, square, and 4:5 renders preserve the complete source frame when a
centre crop would discard substantial detail. The full-frame foreground is fitted
with Lanczos scaling over an undarkened, blurred, aspect-cover background.
Sources close to the target aspect use a simpler high-quality fit/crop. A 1080×1920
file made from a 360p source is still only 360p detail enlarged to a delivery
canvas; ordinary scaling cannot recreate missing detail. 1080p or better sources
are recommended. All processing remains free and local; no AI upscaler or cloud
restoration service is used.

## Quality checks

```bash
npm run lint
npm run typecheck
npm test
python -m pytest engine/tests -q
npm run build
docker compose config
```

The combined frontend and engine quality gate also checks that retired providers do not return to customer-facing source, then runs the checks above that are available through npm:

```bash
npm run check
npm run check:providers
```

When host FFmpeg/FFprobe are unavailable, the reproducible provisioned check
runs the same frontend checks and the complete engine suite inside a freshly
built engine image, with isolated temporary data:

```bash
npm run check:supported
```

The isolated real-browser OpenRouter fallback check builds a temporary Compose
stack, configures an in-memory provider failure seam, runs local Whisper and
FFmpeg, and removes its test dataset afterward:

```bash
npm run test:e2e:openrouter-fallback
```

Playwright retains a trace on failure; set `S6_ACCEPTANCE_TRACE=on` when a
successful run also needs a trace artifact. The seam requires both
`S6_TEST_MODE=1` and the harness-provided failure name,
is disabled by default, and is never used by normal provider requests.

The live AI hook YouTube acceptance is opt-in (`S6_RUN_LIVE_AI_HOOK_TEXT=1`)
and runs against a separately provisioned isolated stack with a connected
OpenRouter profile. Set `S6_AI_HOOK_TEXT_ENGINE_CONTAINER` to that stack's
engine container ID; successful jobs use it for read-only FFmpeg control renders
and pixel checks inside the engine container. The live tests are Desktop
Chromium-only, skip by default, and never print provider credentials.

See [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) for verified behavior, limitations, and exact evidence. See [ARCHITECTURE.md](ARCHITECTURE.md) for trust boundaries and durable processing. Third-party notices and the machine-readable provenance ledger are included.

## Responsible use

Only process content you own or are authorised to use. S6_cut does not bypass DRM, paywalls, authentication, or access controls. A code licence does not grant rights to downloaded media, models, fonts, voices, or brand assets. Exported ZIPs include provenance/credits and visible warning summaries when relevant.