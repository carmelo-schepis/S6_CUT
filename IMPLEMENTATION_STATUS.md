# Implementation status

Updated: 2026-09-08

## Implemented and wired to the UI

- Branded React/TypeScript/Vite installable PWA using the supplied logo assets and canonical black/copper design tokens.
- Projects create strip for local video, constrained YouTube URL, and exact-source Script mode.
- Funny, Serious, Educational, and Hype deterministic score weights.
- FastAPI engine with SQLite WAL project/job/profile/Library records and an atomic per-job JSON checkpoint.
- Streamed, bounded upload; safe filename/path handling; FFprobe validation; duration limit; queue limit; creation rate limit.
- New no-provider Auto jobs resolve to Fast local cut: FFprobe-validated, deterministic non-overlapping windows, silent-video support, progressive FFmpeg crop/render, and no Whisper/provider calls.
- Explicit Smart clips use extracted 16 kHz mono audio, CPU-friendly Faster-Whisper defaults, real segment progress, cancellation checkpoints, versioned transcript cache, optional OpenRouter candidate ordering, and deterministic local fallback.
- Durable mode-specific processing checklists record real validated checkpoints, provider fallbacks, render counts, partial output verification, retries, pause/cancel, and restart recovery.
- Independent FFmpeg renders with centre 9:16/1:1/16:9 crop, H.264/AAC, word-highlight captions, visual text cards or matched Library overlays, FFprobe output validation, and atomic publication.
- Progressive workspace through SSE with polling fallback, clip selection, score inspector, storyboard/Beat board, partial success, pause/resume, stop-and-keep, and scoped retry. The internal EDL remains authoritative while the redundant layered-timeline panel is no longer rendered.
- ZIP export with numbered successful media, `manifest.json`, `credits.json`, and warning/failure summary.
- Personal Media Library with persistent three-level business folders, Unsorted migration, combined search/type/origin/policy filters, signed previews, protected state, and resilient refresh handling.
- Validated uploads, YouTube sources, Fast/Smart clips, Script outputs, and retries publish idempotently into a shared content-addressed blob store with durable project/job/clip/Library references and neutral matching defaults.
- Script exact-span planning every roughly 2-3 seconds, OpenRouter TTS -> local espeak-ng -> silent narration fallback, word alignment, storyboard, captions, visual beats, and render.
- Provider profiles with configurable OpenRouter model, optional OpenRouter speech model and voice, test/duplicate/delete, masked read API, session-only or Fernet-encrypted persistent secrets.
- One-command `install.sh` installer and data-preserving `uninstall.sh` for Linux and macOS: prerequisite checks, clone/update into `~/s6_cut`, `.env` bootstrap, build/start, readiness wait, service status, and frontend/backend URL summary.
- nginx same-origin gateway, private engine service, signed media links, security headers, non-root images, one mounted data directory, Compose/TrueNAS/Portainer documentation, and Windows launcher.

## Verified evidence

- `npm run lint` - passed with zero warnings.
- `npm run typecheck` - passed under TypeScript strict mode.
- `npm test` - 221/221 frontend contract/component/integration tests passed.
- `python -m pytest engine/tests -q` - 265/265 engine unit/API/security/media/checklist/migration tests passed. One Starlette environment deprecation warning is upstream and does not affect results.
- `npm run build` - Vite production build passed; 1,794 modules transformed.
- `npm install` and container `npm ci` audits - zero known vulnerabilities.
- The existing multi-stage web and engine images previously built successfully, including FFmpeg, Faster-Whisper, yt-dlp, deno, and espeak-ng. A final Docker rebuild was attempted after this migration but the host Docker daemon/storage timed out; no container result is claimed for this final revision.
- `docker compose config` passed. Only nginx publishes a LAN-facing host port; the engine additionally binds the host loopback (127.0.0.1:8001) for local API docs/debugging and stays otherwise private on the Compose network.
- `docker compose up -d` reached healthy state for both services. The production UI remains available at `http://127.0.0.1:8080`.
- Gateway health reported SQLite, FFmpeg, FFprobe, Whisper, yt-dlp, local TTS, and `/app/data` ready.
- Response headers verified CSP, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, and COOP.
- Script-mode smoke completed a vertical H.264 render with exact script spans, deterministic beats, captions, and provenance using the silent fallback when no narration provider was configured.
- OpenRouter-only migration smoke validated one schema-constrained text response, one real free OpenRouter MP3 TTS response using a discovered premade voice, migration of encrypted profile/job metadata, and mocked Settings Playwright coverage at desktop and mobile widths. Redacted evidence is in `test-artifacts/openrouter-migration-20260908T081440Z/`.
- Real supplied-media Smart smoke completed a 20.60-second 1080x1920 H.264/AAC clip with 53 timed caption events after local Whisper transcription.
- Generated Fast-mode end-to-end smoke passed with both AAC and silent sources; each produced two validated 9:16 H.264 clips while instrumentation made any Whisper, OpenRouter, or semantic-selection call fail the test.
- Signed selected-export ZIP was downloaded and inspected: it contains the successful clip, `manifest.json`, and `credits.json` with project/job/style/score/provenance data.
- Completed jobs remained accessible after the production containers were recreated, exercising the mounted durable data path.
- Desktop and compact production screenshots were captured after asynchronous health/project data loaded and visually inspected for responsive layout and engine-ready state.
- **YouTube import fix verified**: `https://www.youtube.com/watch?v=FylHa4_neOA` successfully imports in both Fast and Smart modes. yt-dlp now uses `--extractor-args youtube:player_client=android,web` with format selector `bv*+ba/b` and includes a retry with broader client set (`android,web,web_music`) plus automatic cleanup of stale `.part`/`.ytdl` files on failure. Deno runtime installed in engine container for robust JavaScript player extraction.

## Honest limitations / next bounded milestone

- Reframe is reliable centre crop with reversible source preservation; face/active-speaker trajectory analysis is not implemented yet.
- The EDL is versioned in the durable job/clip/beat contract, but interactive trim, caption correction, asset replacement, and persisted undo/redo controls are the next editor milestone.
- The Library resolver is fully local and deterministic. No live no-key web media adapter is enabled; unmatched content uses a visible relevant text card instead of rights-unknown or unrelated media.
- Smart clips may use the selected, tested OpenRouter profile to order validated local candidates. Provider failure is recorded in the checklist and falls back to deterministic local planning; OpenRouter never performs transcription.
- Local narration uses espeak-ng for dependable offline operation. Higher-quality local neural TTS is not bundled yet.
- Retention policy is reported/configured; only safe stale partial-file cleanup is automatic in this milestone. Operator-approved project/output cleanup needs a reference-aware UI.
- The UI shows the canonical EDL structure but the central viewer uses finished media when available rather than frame-accurate draft compositing before render.
- GPU acceleration is not required and is not configured by the default Compose file.
