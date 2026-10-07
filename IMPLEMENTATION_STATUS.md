# Implementation status

Updated: 2026-10-12

## Implemented and wired to the UI

- Script mode and AI Video topic planning are retired from the user interface and public creation/planning API. Legacy Script project/job payloads remain deserializable for history; completed output assets remain in the Library, while interrupted jobs fail closed and legacy render/retry/recovery is disabled.

- Branded React/TypeScript/Vite installable PWA using the supplied logo assets and canonical black/copper design tokens.
- Outline control layer: buttons, inputs, selects, counts and chips are a hairline plus a label at rest, with fill spent only on hover, active and pressed states, and one near-square `--radius-control` corner across the control layer. Status dots and the numbered step badges stay round; status colour stays chromatic.
- Projects create strip for local video and constrained YouTube URL, with Clip and Music / sung vocals workflows.
- Funny, Serious, Educational, and Hype deterministic score weights.
- FastAPI engine with SQLite WAL project/job/profile/Library records and an atomic per-job JSON checkpoint.
- Streamed, bounded upload; safe filename/path handling; FFprobe validation; duration limit; queue limit; creation rate limit.
- New no-provider Auto jobs resolve to Fast local cut: FFprobe-validated, deterministic non-overlapping windows, silent-video support, progressive FFmpeg crop/render, and no Whisper/provider calls.
- Explicit Smart clips use extracted 16 kHz mono audio, CPU-friendly Faster-Whisper defaults, real segment progress, cancellation checkpoints, versioned transcript cache, optional OpenRouter candidate ordering, and deterministic local fallback.
- Clip processing checklists record validated checkpoints, provider fallbacks, render counts, partial-output verification, retries, pause/cancel, and restart recovery. Legacy Script checklists remain deserializable; interrupted Script jobs fail closed.
- Independent FFmpeg renders with centre 9:16/1:1/16:9 crop, H.264/AAC, word-highlight captions, matched Library overlays, followed by FFprobe output validation and atomic publication.
- Progressive workspace through SSE with polling fallback, clip selection, score inspector, storyboard/Beat board, partial success, pause/resume, stop-and-keep, and scoped retry. The internal EDL remains authoritative while the redundant layered-timeline panel is no longer rendered.
- ZIP export with numbered successful media, `manifest.json`, `credits.json`, and warning/failure summary.
- Personal Media Library with persistent three-level business folders, Unsorted migration, combined search/type/origin/policy filters, signed previews, protected state, resilient refresh handling, and an exact-confirmation global purge that preserves application configuration.
- Validated uploads, YouTube sources, Fast/Smart clips, and retries publish idempotently into a shared content-addressed blob store with durable project/job/clip/Library references and neutral matching defaults. Historical Script output identity remains supported for existing assets.
- Provider profiles configure and test OpenRouter text planning. Hidden legacy speech metadata remains readable on existing profile records but cannot be set through the profile API or used by current workflows; retired ElevenLabs credentials are scrubbed while OpenRouter credentials are preserved.
- One-command `install.sh` installer and data-preserving `uninstall.sh` for Linux and macOS: prerequisite checks, clone/update into `~/s6_cut`, `.env` bootstrap, build/start, readiness wait, service status, and frontend/backend URL summary.
- nginx same-origin gateway, private engine service, signed media links, security headers, non-root images, one mounted data directory, Compose/TrueNAS/Portainer documentation, and Windows launcher.

## Verified evidence

> The evidence below largely records earlier revisions and dated live runs. Current retirement-branch checks are recorded first when completed; historical Script/AI Video evidence is not evidence of current functionality.

- `npm run lint` - passed with zero warnings.
- `npm run typecheck` - passed under TypeScript strict mode.
- `npm test` - 221/221 frontend contract/component/integration tests passed.
- `python -m pytest engine/tests -q` - 269/269 engine unit/API/security/media/checklist/migration tests passed (265 baseline plus four added by the 2026-09-11 verification run). One Starlette environment deprecation warning is upstream and does not affect results.
- `npm run build` - Vite production build passed; 1,794 modules transformed.
- `npm install` and container `npm ci` audits - zero known vulnerabilities.
- Earlier production images were built with FFmpeg, Faster-Whisper, yt-dlp, deno, and espeak-ng. The retired application no longer installs or invokes espeak-ng; the QA-only synthetic media fixture builder remains separate.
- `docker compose config` passed. Only nginx publishes a LAN-facing host port; the engine additionally binds the host loopback (127.0.0.1:8001) for local API docs/debugging and stays otherwise private on the Compose network.
- `docker compose up -d` reached healthy state for both services. The production UI remains available at `http://127.0.0.1:8080`.
- Earlier gateway health checks verified SQLite, FFmpeg, FFprobe, Whisper, yt-dlp, and `/app/data`; local TTS readiness is no longer part of the current runtime.
- Response headers verified CSP, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, and COOP.
- Historical Script-mode smoke evidence describes the retired workflow and is not evidence that new Script jobs are accepted or rendered.
- Earlier OpenRouter migration smoke validated schema-constrained text, legacy encrypted profile/job metadata, and mocked Settings coverage. Legacy speech fields are retained on profile records for compatibility but are no longer exposed or used by current workflows. Redacted historical evidence is in `test-artifacts/openrouter-migration-20260908T081440Z/`.
- Real supplied-media Smart smoke completed a 20.60-second 1080x1920 H.264/AAC clip with 53 timed caption events after local Whisper transcription.
- Generated Fast-mode end-to-end smoke passed with both AAC and silent sources; each produced two validated 9:16 H.264 clips while instrumentation made any Whisper, OpenRouter, or semantic-selection call fail the test.
- Signed selected-export ZIP was downloaded and inspected: it contains the successful clip, `manifest.json`, and `credits.json` with project/job/style/score/provenance data.
- Completed jobs remained accessible after the production containers were recreated, exercising the mounted durable data path.
- Desktop and compact production screenshots were captured after asynchronous health/project data loaded and visually inspected for responsive layout and engine-ready state.
- **YouTube import fix verified**: `https://www.youtube.com/watch?v=FylHa4_neOA` successfully imports in both Fast and Smart modes. yt-dlp now uses `--extractor-args youtube:player_client=android,web` with format selector `bv*+ba/b` and includes a retry with broader client set (`android,web,web_music`) plus automatic cleanup of stale `.part`/`.ytdl` files on failure. Deno runtime installed in engine container for robust JavaScript player extraction.

### 2026-09-11 YouTube end-to-end verification run (`test-artifacts/QA_20260911T140416Z/`)

Six supplied YouTube sources were driven through the real UI against the live Docker deployment at the nginx gateway. Five produced outputs that passed a full content gate proving real moving picture and real audio taken from the imported source: container/stream sanity, clean full decode, freeze and black detection, frame-to-frame motion compared against the matching window of the source, eight distinct sampled frames, a source-versus-output frame match scored against a decoy frame from elsewhere in the same video, volume detection, and burned-caption verification.

- Fast 9:16 (3 clips), Auto long-form 16:9 (2 scenes), Fast 1:1 with subtitles off (2 clips), and a Shorts Editor 4:5 trim all passed every check. Measured output motion tracks the source window closely across all nine clips (for example 2.856 against 2.783); source-frame match scored 0.5-3.2 where the decoy scored 13-112; zero freeze and zero black in every clip but one (10.4%, within limits).
- Burned captions were proven pixel-side: on a 1920x1080 clip the caption strip differs from the source by 3.43-3.68 during cues and 0.02-0.05 between them.
- Signed media links expire after 900 s; an idle Workspace recovers automatically (403 followed by a re-signed 206 within 157 ms).
- Eleven product defects were found, fixed and re-verified against rebuilt containers; see the report's defect ledger. Four were high severity: long-form jobs crashed under Auto and Smart, Enter in the Shorts Editor assistant queued a real render, the Shorts Editor could not request a 4:5 output for a YouTube source, and Library previews rewound on any background revalidation.
- Smart mode over a source whose only speech is shorter than the requested minimum still emits that short cut; it now warns instead of reporting the duration range as satisfied.


## Honest limitations / next bounded milestone

- Reframe is reliable centre crop with reversible source preservation; face/active-speaker trajectory analysis is not implemented yet.
- The EDL is versioned in the durable job/clip/beat contract, but interactive trim, caption correction, asset replacement, and persisted undo/redo controls are the next editor milestone.
- The Library resolver is fully local and deterministic. No live no-key web media adapter is enabled; Clip mode always preserves the imported source footage.
- Smart clips may use the selected, tested OpenRouter profile to order validated local candidates. Provider failure is recorded in the checklist and falls back to deterministic local planning; OpenRouter never performs transcription.
- Script creation, narration generation, and AI Video topic planning are retired; no current Clip or Music workflow generates narration.
- Retention policy is reported/configured; only safe stale partial-file cleanup is automatic in this milestone. Operator-approved project/output cleanup needs a reference-aware UI.
- The UI shows the canonical EDL structure but the central viewer uses finished media when available rather than frame-accurate draft compositing before render.
- GPU acceleration is not required and is not configured by the default Compose file.
- The transcription stall guard (`S6_TRANSCRIPTION_STALL_SECONDS`, default 180 s) is measured from the last decoded segment. On a 34-minute source with the engine's four cores contended it fired before the first segment landed and failed the job cleanly; long sources on a loaded host may need a higher value.
- Long-form outputs deliberately carry no burned creator credit (`youtube_creator_credit` returns None for `content_format == "long"`, pinned by `test_credit_uses_persisted_creator_only_for_short_youtube_jobs`). Short-form outputs do carry it.
