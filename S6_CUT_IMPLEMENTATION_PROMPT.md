# S6_cut — repository-specific implementation prompt

You are a senior full-stack engineer and video-processing architect working directly in this repository.

Your task is to evolve the existing application into **S6_cut**, a free, open-source, self-hosted desktop-style Progressive Web App that turns long videos into short-form clips and can also generate a complete video from a script.

Do not replace the existing application with a prototype. Inspect and extend the current architecture, preserve working functionality, and implement the work in tested phases.

## Read before changing anything

1. Read `AGENTS.md` and then all of `CLAUDE.md`. `CLAUDE.md` is the repository's authoritative architecture and coding guide.
2. Inspect `README.md`, `.env.example`, Docker files, backend tests, and frontend tests.
3. Treat `src/clippyme/` as the existing FastAPI/video engine and `dashboard/src/redesign/` as the production React frontend.
4. Preserve the thin-handler/domain-service structure, crash-safe atomic writes, job queue, resume/retry behavior, security gates, clip locks, and current compose order unless a migration explicitly requires a change.
5. Do not rename the Python package in the first pass. The internal `clippyme` name may remain for compatibility; change the user-facing product name to `S6_cut` separately.
6. Before implementation, write a concise gap analysis and phased plan. Then implement one phase at a time and run the relevant tests after every phase.

## Product outcome

S6_cut must support two primary workflows.

### Workflow A — long video to shorts

The user:

1. Drops a YouTube URL or uploads a video file.
2. Chooses a style: `funny`, `serious`, `educational`, or `hype`.
3. Starts the job and waits.
4. Reviews the generated clips and downloads individual clips or all clips as one ZIP.

The pipeline must:

- Download or ingest the source locally.
- Transcribe it, using local Whisper by default when no cloud transcription API is configured.
- Detect candidate clips with the configured LLM, or use the existing local TextTiling fallback when no LLM is available.
- Cut on word, sentence, and silence boundaries using the existing snapping logic.
- Reframe, subtitle, and render clips using the current pipeline.
- Burn word-by-word subtitles into the output.
- Allow the selected style to influence clip selection, hook copy, subtitle presentation, pacing, meme/visual selection, and other appropriate creative decisions.
- Produce a final downloadable ZIP containing all successful clips plus a small manifest describing each clip.

### Workflow B — script to original video

The user uploads or pastes a script and selects output options. The system must:

1. Validate and segment the script into timed narration beats.
2. Generate narration with ElevenLabs when configured.
3. If ElevenLabs is not configured or its request fails, continue without crashing. Provide a clearly defined fallback: local TTS when available, otherwise a silent/subtitle-only video with a visible non-fatal warning.
4. Generate or source a relevant image, GIF, or short visual approximately every 2–3 seconds. Timing should follow sentence/phrase boundaries rather than blindly cutting every fixed number of seconds.
5. Search the local asset library before requesting any web asset.
6. Prefer required/priority library assets when their labels match a beat; reject blocked assets and blocked labels.
7. Add subtitles aligned to the final narration or deterministic script timing.
8. Render the final video locally with ffmpeg, preserving attribution/source metadata for externally sourced assets.
9. Produce a usable video even when every optional external integration is missing.

## Core architecture change — provider abstraction

The current code is coupled to Gemini and currently blocks some job submissions when a Gemini key is absent, despite having an offline TextTiling fallback. Fix this.

Create a provider-neutral LLM layer used by viral-clip selection, JSON repair, subtitle/copy generation, asset-query generation, script storyboarding, and conversational clip editing.

Support:

- `LLM_PROVIDER=auto|openrouter|gemini|offline`
- `OPENROUTER_API_KEY`
- `OPENROUTER_MODEL`
- Existing Gemini settings for backward compatibility
- Per-job model override using an argv-safe provider/model slug

Provider resolution for `auto` must be:

1. OpenRouter when an OpenRouter key exists.
2. Gemini when a Gemini key exists.
3. Offline/local fallback when neither exists.

OpenRouter-only operation is a hard acceptance requirement. A user with only an OpenRouter API key must be able to run every LLM-dependent feature that has been implemented.

No API key may be mandatory for basic long-video processing. Remove the frontend and backend Gemini-key submission gates. Missing, invalid, rate-limited, or unavailable optional providers must produce a warning and a fallback, not fail the whole job, unless the user explicitly selected a strict “require this provider” option.

Keep secrets in the existing persisted local configuration mechanism. Never write secrets to job metadata, logs, journals, ZIP manifests, or frontend error messages. Mask them in configuration responses.

## Tagged local asset library

Add a first-class Asset Library stored under a configurable persistent data path, mounted through Docker.

Each asset needs metadata such as:

- Stable ID
- Original filename and safe stored filename
- Media type: image, animated GIF, short video, poster, logo, ad, product, meme, background, or other
- User labels/tags
- Description
- Include policy: `auto`, `prefer`, `required`, or `blocked`
- Optional campaign/brand name
- Optional start/end validity dates
- Optional minimum/maximum display duration
- Optional source/attribution/license fields
- Created/updated timestamps

Implement safe backend endpoints and a frontend Library view to upload, preview, edit labels, filter, and delete assets. Validate media by content, not extension alone. Enforce size limits, safe filenames, path confinement, atomic metadata writes, and trusted-origin/API-token protections.

During video creation, build a deterministic asset-selection service:

1. Convert each timed transcript/script beat into normalized concepts and search terms.
2. Exclude blocked assets first.
3. Insert required assets whose rules match.
4. Rank preferred/automatic local assets by label relevance.
5. Only use a web source when the local library has no suitable result.
6. Avoid repeating the same asset too frequently.
7. Save the selection decision, timing, source, and reason in job metadata so the result is reproducible and editable.

Ads and posters must be deliberate overlays or scene inserts, not random meme matches. Give them frequency caps and safe-area controls.

## Contextual images and GIFs

For spoken references such as “the Beatles,” create timed overlay cues from the word-level transcript. The cue system must:

- Group words into semantic phrases.
- Ask the configured LLM for concise visual entities/search terms, with an offline keyword fallback.
- Search the local library first.
- Use pluggable web providers rather than brittle scraping.
- Store source URL, creator, license/attribution, query, local cache path, and retrieval time.
- Cache downloaded assets locally.
- Validate MIME type, dimensions, duration, byte size, redirect target, and SSRF safety before ffmpeg sees the file.
- Support still images, animated GIFs, and short videos.
- Provide per-project and global controls for enabling web assets, safe-search level, maximum overlays, minimum confidence, and attribution behavior.
- Allow the user to remove or replace an automatically chosen overlay before final export.

Do not claim that arbitrary web images are free to reuse. Make provider/license metadata visible and prefer sources whose API exposes reusable-license information.

## Subtitles

Retain the existing word-level timing and ASS subtitle rendering. LLMs may improve punctuation, line breaking, emphasis, translation, or style, but must never invent timing. Timing must remain derived from ASR or deterministic script narration timing.

If the LLM is missing, subtitles must still render using the transcript. If transcription cloud APIs are missing, use local Whisper. A cloud failure must fall back locally and continue.

## PWA and local/self-hosted operation

Make the React dashboard installable as a PWA:

- Add a web app manifest, appropriate icons, theme colors, install metadata, and a service worker.
- Cache the application shell and static assets, not private API responses, videos, secrets, job status, or large generated media.
- Show a clear offline/backend-unavailable state.
- Preserve normal browser operation on localhost and LAN deployments.

“Everything runs locally” means media processing and storage run on the user's machine or self-hosted server. Be explicit in the UI when an optional configured API sends transcript/script text or audio to an external provider.

## TrueNAS and Portainer deployment

Keep Docker Compose as the primary deployment path and make it easy to deploy as a Portainer stack or TrueNAS custom app.

Required deployment characteristics:

- One clearly documented compose command for CPU-only operation.
- Optional GPU override without making GPU mandatory.
- Persistent volumes for config, uploads, output, cache, fonts, logo, asset library, and project/job metadata.
- Configurable published port, with a sensible default.
- Health checks for backend and frontend.
- Restart policy suitable for a home server.
- Non-root runtime where practical, or clearly documented UID/GID/PUID/PGID mapping.
- Correct reverse-proxy and trusted-proxy documentation.
- No hard-coded host paths.
- A `.env.example` that documents every new variable.
- A TrueNAS/Portainer deployment guide with volume mapping, permissions, updates, backups, and restore instructions.

Do not add a hosted account system, credit system, watermark, artificial usage limits, or required cloud backend.

## Frontend changes

Keep the current React structure and reusable controls. Add or adapt views for:

- Home/Create with three obvious steps: Drop, Pick a style, Wait/download.
- Source mode: URL, video upload, or script.
- Style selector: funny, serious, educational, hype.
- Script settings: voice provider/voice, aspect, target duration, visual pace, subtitles, local/web assets.
- Profiles/Settings dashboard for OpenRouter, Gemini, ElevenLabs, Deepgram, local/offline choices, and model selection.
- Asset Library.
- Processing view that distinguishes fatal errors from non-fatal provider fallbacks.
- Results storyboard showing clip/video, subtitles, and timed asset overlays.
- Download all as ZIP.

Use `S6_cut` in user-facing copy. Keep internal compatibility names until a dedicated safe rename migration.

## Backend/job model

Extend the existing job system rather than adding a second unrelated runner.

Introduce explicit job modes such as `shorts` and `script_video`. Persist mode, style, provider decisions, warnings, selected assets, and resumable phase checkpoints. New phases must participate in the existing runtime-state, retry, cancellation, pause/resume, cleanup, and QA mechanisms.

Classify failures:

- Fatal: invalid source, corrupt media, no disk space, unsafe path, irrecoverable ffmpeg failure.
- Non-fatal: missing optional key, provider 401/402/429/5xx, no web match, TTS unavailable, individual asset download failure.

Non-fatal failures must be included in structured job warnings and visible in the UI while allowing usable output to complete.

## Suggested delivery phases

Implement in this order:

1. **Baseline and safety:** run tests, document current behavior, remove mandatory Gemini submission gates, add structured warnings, verify truly keyless long-video processing.
2. **OpenRouter abstraction:** provider-neutral LLM interface, settings UI, config validation/masking, model handling, tests, OpenRouter-only end-to-end path.
3. **Product shell:** S6_cut branding, style selector, simplified three-step Create flow, ZIP-all endpoint, PWA manifest/service worker.
4. **Asset Library:** storage model, safe CRUD API, frontend library, persistent Docker volume, relevance ranking tests.
5. **Timed visual overlays:** cue schema, local matching, web-provider interface/cache/safety, ffmpeg composition, editable storyboard.
6. **Script-to-video:** script ingestion, beat planning, optional ElevenLabs TTS, fallback behavior, subtitle timing, scene assembly, final render.
7. **Deployment hardening:** Portainer/TrueNAS compose/docs, health checks, permissions, backup/restore, CPU/GPU verification.
8. **QA and polish:** integration fixtures, cancellation/resume, provider outage cases, large files, ZIP verification, PWA audit, documentation.

Do not attempt all phases in one unreviewable commit. Keep each phase independently runnable and tested.

## Testing requirements

Add focused tests for at least:

- A process job starts with no API headers or cloud keys.
- OpenRouter-only configuration selects clips successfully using a mocked response.
- OpenRouter/Gemini/ElevenLabs/Deepgram failures fall back without failing the job.
- Provider secrets are masked and absent from logs/journals/metadata.
- Provider/model IDs cannot inject CLI arguments.
- Asset upload type/size/path validation.
- Library ranking honors blocked, required, preferred, and automatic policies.
- SSRF and redirect protection for web assets.
- Script segmentation and deterministic 2–3 second visual pacing.
- TTS-present and TTS-absent script jobs.
- Subtitle timing survives LLM punctuation/line-break enhancement.
- ZIP contains every completed clip and a valid manifest.
- PWA service worker never caches API/config/video routes.
- Docker volumes survive container recreation.
- Existing backend and frontend tests remain green.

Run the commands documented in `CLAUDE.md`, including backend host tests, ruff checks, frontend tests/lint/build, and Docker integration tests where the environment supports them.

## Definition of done

The work is complete only when:

- A user can process a YouTube link or local video with no cloud APIs configured.
- A user can configure only OpenRouter and use LLM-dependent features.
- Missing ElevenLabs or any other optional API never causes an otherwise viable job to fail.
- The user can select funny, serious, educational, or hype and that style reaches the backend pipeline as structured data.
- The user can create a narrated or fallback script-based video with changing visuals and burned subtitles.
- The asset library influences visual selection and honors include/exclude rules.
- The user can download all generated shorts as a ZIP.
- The dashboard is installable as a PWA.
- The stack deploys persistently through Docker Compose and has clear TrueNAS/Portainer instructions.
- Security, crash recovery, cancellation, tests, and existing video quality features have not regressed.

At the end of each phase, report: files changed, architectural decisions, fallbacks implemented, tests run and results, known limitations, and the exact next phase.
