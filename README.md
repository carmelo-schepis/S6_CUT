# S6_cut

S6_cut is a free, open-source, local-first video studio. Drop a long video or paste an authorised YouTube URL, choose Funny, Serious, Educational, or Hype, and receive independent vertical shorts with local word-timed captions. Script mode turns exact pasted text into narration, semantic 2–3 second visual beats, a storyboard, and a composed video.

There is no S6_cut account, credit system, watermark, artificial usage limit, or mandatory hosted application backend. The web gateway and private media engine run on hardware you control.

## Quick start (Docker)

The repository is currently **private**. Authenticated GitHub CLI users can install now using the commands below. Once the repository is made public, the standard anonymous one-liners will work from any device.

### Linux / macOS (bash)

**Private repo / authenticated (works now):**
```bash
gh api -H "Accept: application/vnd.github.raw+json" repos/carmelo-schepis/S6_CUT/contents/install.sh | bash
```

**Public repo / anonymous (works after repository visibility is changed to public):**
```bash
curl -fsSL https://raw.githubusercontent.com/carmelo-schepis/S6_CUT/master/install.sh | bash
```

### Windows (PowerShell)

**Private repo / authenticated (works now):**
```powershell
gh api -H "Accept: application/vnd.github.raw+json" repos/carmelo-schepis/S6_CUT/contents/Install-S6_CUT.ps1 | Invoke-Expression
```

**Public repo / anonymous (works after repository visibility is changed to public):**
```powershell
irm https://raw.githubusercontent.com/carmelo-schepis/S6_CUT/master/Install-S6_CUT.ps1 | iex
```

The installer checks for Git, Docker, and Docker Compose v2, clones S6_cut into `~/s6_cut` (or updates an existing installation in place), creates `.env` from the template on first run — and never overwrites your configuration — then builds, starts, and waits for the app to become ready. When it finishes you will see:

```text
✓ S6_cut is running

Frontend: http://localhost:8080
Backend:  http://localhost:8001
```

Open the **Frontend** URL in your browser. The backend engine — including its API docs at `/api/docs` — listens on localhost only and is not exposed to your network.

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

Requirements: Node.js 24+, Python 3.12, FFmpeg/FFprobe, and espeak-ng. Install the exact dependencies, then start the Vite UI and FastAPI engine together:

```powershell
npm ci
python -m venv .venv
.venv\Scripts\python -m pip install -r engine\requirements-dev.lock
$env:S6_PYTHON = ".venv\Scripts\python.exe"
npm run dev
```

Open <http://127.0.0.1:5173>. Vite proxies same-origin `/api` requests to port 8001. On Windows, `START_S6_CUT.cmd` builds and starts the production Compose application.

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

Provider profiles can be configured in Settings. Persistent secrets are encrypted with a locally generated instance key and are never returned by read APIs. Headless deployments may set `OPENROUTER_API_KEY` and `ELEVENLABS_API_KEY` in `.env` or Docker secrets orchestration. Protect `.env` like any other credential file.

### Whisper performance tuning

Smart-mode transcription runs locally with Faster-Whisper. The CPU-friendly defaults (`cpu` + `int8` + beam 1) keep memory low and decode fast; raise the model size or beam only when you need more accuracy and have CPU/RAM headroom:

- `S6_WHISPER_MODEL=base` or `small` is the sweet spot on 8 GB hosts; `medium`/`large-v3` need noticeably more RAM and time.
- On an NVIDIA GPU, set `S6_WHISPER_DEVICE=cuda` with `S6_WHISPER_COMPUTE_TYPE=float16` for the fastest decode.
- `S6_WHISPER_WORD_TIMESTAMPS=false` skips per-word alignment (faster) but disables word-timed captions; keep it `true` for captioned clips.

Whisper job stages report real, incrementally observed progress: each fraction is derived from an actual decoded segment boundary (`segment.end / duration`), never simulated, and stage labels show the text of the segment just decoded. The engine checks the model cache on disk, so a pre-downloaded model (under `S6_DATA_PATH/models`) skips straight to transcription.

## Provider and fallback matrix

| Capability | Preferred | Missing or failing optional provider |
| --- | --- | --- |
| Fast clip cutting | Deterministic FFprobe windows and FFmpeg crop | No transcription, captions, model download, or API required |
| Smart transcription/timing | Local Faster-Whisper | Local Whisper supplies timing; an LLM never performs transcription |
| Smart clip selection | Optional OpenRouter ordering over validated local candidates | Deterministic local candidate planning |
| Script planning | Optional OpenRouter structured planning boundary | Deterministic exact-span phrase planner |
| Narration | Selected ElevenLabs voice | Local espeak-ng; then explicitly silent render |
| Visuals | Required/preferred personal Library | Relevant local text card; wrong media is not substituted |
| YouTube | Constrained local yt-dlp | Local upload remains available and the URL failure is scoped |

The application remains operational when OpenRouter is the only configured API. Clip mode also works with no API key. Optional provider failure becomes a visible warning and local fallback, not a corrupt project.

## Data, backup, restore, and removal

All server-side state is under `S6_DATA_PATH`:

```text
s6-cut.sqlite3      projects, jobs, business folders, blob references, Library metadata, caches
jobs/               project references, atomic journals, captions, narration, clips
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
- Business folders are organizational containers, not accounts or access-control boundaries; folder names never become filesystem paths.
- Back up and restore the entire `S6_DATA_PATH` together. The SQLite reference graph and `blobs/` content-addressed files are one backup unit. Existing `library/` files are migrated by reference without destructive startup moves.
- New managed media uses an atomic same-filesystem hard link into the shared blob store when supported, with an atomic copy fallback for filesystems that cannot hard-link. The schema is already separated into blobs and references so legacy media can be consolidated gradually without startup relocation.

## TrueNAS SCALE and Portainer

See [docs/TRUENAS_PORTAINER.md](docs/TRUENAS_PORTAINER.md) for dataset layout, Stack/Custom App configuration, update, backup, restore, and uninstall procedures.

## Quality checks

```bash
npm run lint
npm run typecheck
npm test
python -m pytest engine/tests -q
npm run build
docker compose config
```

See [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) for verified behavior, limitations, and exact evidence. See [ARCHITECTURE.md](ARCHITECTURE.md) for trust boundaries and durable processing. Third-party notices and the machine-readable provenance ledger are included.

## Responsible use

Only process content you own or are authorised to use. S6_cut does not bypass DRM, paywalls, authentication, or access controls. A code licence does not grant rights to downloaded media, models, fonts, voices, or brand assets. Exported ZIPs include provenance/credits and visible warning summaries when relevant.