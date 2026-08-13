# Implementation status

Updated: 2026-08-13

## Implemented and wired to the UI

- Branded React/TypeScript/Vite installable PWA using the supplied logo assets and canonical black/copper design tokens.
- Projects create strip for local video, constrained YouTube URL, and exact-source Script mode.
- Funny, Serious, Educational, and Hype deterministic score weights.
- FastAPI engine with SQLite WAL project/job/profile/Library records and an atomic per-job JSON checkpoint.
- Streamed, bounded upload; safe filename/path handling; FFprobe validation; duration limit; queue limit; creation rate limit.
- Local Faster-Whisper word transcription and content/model/schema cache.
- Sentence-aware bounded candidates, auditable score components, temporal overlap suppression, and complete-boundary preference.
- Independent FFmpeg renders with centre 9:16/1:1/16:9 crop, H.264/AAC, word-highlight captions, visual text cards or matched Library overlays, FFprobe output validation, and atomic publication.
- Progressive workspace through SSE with polling fallback, clip selection, score inspector, storyboard/Beat board, EDL lanes, partial success, pause/resume, stop-and-keep, and scoped retry.
- ZIP export with numbered successful media, `manifest.json`, `credits.json`, and warning/failure summary.
- Personal Media Library upload/dedup, Required/Prefer/Neutral/Never policy, active dates, negative triggers, deterministic explanation, and protected state.
- Script exact-span planning every roughly 2-3 seconds, optional ElevenLabs -> local espeak-ng -> silent narration fallback, word alignment, storyboard, captions, visual beats, and render.
- Provider profiles with configurable OpenRouter model, optional ElevenLabs voice, test/duplicate/delete, masked read API, session-only or Fernet-encrypted persistent secrets.
- nginx same-origin gateway, private engine service, signed media links, security headers, non-root images, one mounted data directory, Compose/TrueNAS/Portainer documentation, and Windows launcher.

## Verified evidence

- `npm run lint` - passed with zero warnings.
- `npm run typecheck` - passed under TypeScript strict mode.
- `npm test` - 7/7 frontend contract/integration tests passed.
- `python -m pytest engine/tests -q` - 15/15 engine unit/API/security tests passed. One Starlette environment deprecation warning is upstream and does not affect results.
- `npm run build` - Vite production build passed; 1,792 modules transformed.
- `npm install` and container `npm ci` audits - zero known vulnerabilities.
- Both multi-stage web and engine images built successfully, including FFmpeg, Faster-Whisper, yt-dlp, and espeak-ng in the private engine image.
- `docker compose config` passed. Only nginx publishes a host port; the engine remains private on the Compose network.
- `docker compose up -d` reached healthy state for both services. The production UI remains available at `http://127.0.0.1:8080`.
- Gateway health reported SQLite, FFmpeg, FFprobe, Whisper, yt-dlp, local TTS, and `/app/data` ready.
- Response headers verified CSP, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, and COOP.
- Script-mode smoke completed a vertical H.264 render with exact script spans, deterministic beats, captions, and provenance using the silent fallback when no narration provider was configured.
- Real supplied-media smoke completed a 20.60-second 1080x1920 H.264/AAC clip with 53 timed caption events after local Whisper transcription.
- Signed selected-export ZIP was downloaded and inspected: it contains the successful clip, `manifest.json`, and `credits.json` with project/job/style/score/provenance data.
- Completed jobs remained accessible after the production containers were recreated, exercising the mounted durable data path.
- Desktop and compact production screenshots were captured after asynchronous health/project data loaded and visually inspected for responsive layout and engine-ready state.

## Honest limitations / next bounded milestone

- Reframe is reliable centre crop with reversible source preservation; face/active-speaker trajectory analysis is not implemented yet.
- The EDL is versioned in the durable job/clip/beat contract, but interactive trim, caption correction, asset replacement, and persisted undo/redo controls are the next editor milestone.
- The Library resolver is fully local and deterministic. No live no-key web media adapter is enabled; unmatched content uses a visible relevant text card instead of rights-unknown or unrelated media.
- OpenRouter transport is implemented as a strict JSON boundary but deterministic local planning is currently the active production path; provider-enhanced candidate/beat validation can be added without changing core records.
- Local narration uses espeak-ng for dependable offline operation. Higher-quality local neural TTS is not bundled yet.
- Retention policy is reported/configured; only safe stale partial-file cleanup is automatic in this milestone. Operator-approved project/output cleanup needs a reference-aware UI.
- The UI shows the canonical EDL structure but the central viewer uses finished media when available rather than frame-accurate draft compositing before render.
- GPU acceleration is not required and is not configured by the default Compose file.
