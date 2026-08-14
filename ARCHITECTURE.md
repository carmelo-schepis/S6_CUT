# Architecture

## Runtime boundary

```text
Browser / installed PWA
        |
        | same-origin HTTP + SSE
        v
nginx web gateway :8080  (only published service)
        |
        | private Compose network
        v
FastAPI media engine :8001
        |-- SQLite WAL database
        |-- atomic job journal
        |-- FFprobe validation
        |-- Faster-Whisper timed words
        |-- deterministic selection / exact-span beat planner
        |-- Library rule engine
        |-- FFmpeg EDL-derived render
        `-- signed clips and ZIPs
                 |
                 v
           mounted /app/data
```

The browser owns interaction state. The engine is authoritative for projects, jobs, timed transcripts, Library metadata/rules, profiles, provenance, and produced artifacts. Every UI update is derived from a durable record; server-sent events accelerate updates and the workspace falls back to polling after disconnect.

## Durable job sequence

1. Stream an upload into a `.uploading` file with a hard byte limit, then atomically promote it.
2. Validate the source with FFprobe before creating processing work.
3. Create the project and immutable job settings snapshot in SQLite. Clip jobs record a resolved `processing_mode`: `auto` becomes `smart` only when the selected OpenRouter profile is configured and connected, otherwise `fast` (legacy jobs default to `smart`).
4. Before announcing each stage/result, save the SQLite job and atomically replace `jobs/<uuid>/state.json`.
5. Smart mode transcribes with visible Whisper model stages; fast mode skips transcription, providers, selection, Library resolution, and captions entirely — it probes, plans neutral windows with `plan_fast_windows`, and renders each cut independently with `render_fast_clip` (silent sources allowed).
6. Generate sentence-aware, duration-bounded, deterministic candidates and score components.
7. Resolve a personal Library asset first; otherwise use an explicit relevant text card.
8. Render each clip independently to a partial filename, probe its structure, then atomically publish.
9. Hash each validated source/output into `blobs/sha256`, using a same-filesystem hard link when possible and an atomic copy fallback otherwise. In one SQLite transaction, bind the blob, project/job/clip reference, idempotent Library asset, typed origin, and immutable business-folder snapshot. Temporary or failed files never cross this boundary.
10. Keep successful clips if another render fails; failed clips remain scoped and retryable. Recovery repeats publication safely using stable source/clip identities.
10. Build ZIP on disk with numbered media, manifest, credits, and warning/failure summary.

Fast cut switch: `switch-fast` reuses the saved source (no duplicate upload), cooperatively cancels the Smart job at its next checkpoint, and queues a new fast job against the same project.

Startup changes interrupted queued/active work to `recovered` and requeues it. Pausing is cooperative at safe checkpoints. “Stop and keep” is distinct from retry and preserves completed outputs.

## Composition model

The canonical job/clip/beat records are the first versioned EDL. FFmpeg consumes the same crop, subtitle timing, visual beat timing, provenance, and z-order displayed by the workspace:

1. centre/subject-safe source crop;
2. Library visual overlay where a valid matched file exists;
3. relevant text-card visual intention;
4. word-by-word ASS captions with current-word highlight;
5. source speech or generated narration.

The source file and Library sources are immutable. Manual editing can create later EDL versions without transcoding over originals. Business folders are metadata-only organizational containers, never filesystem or security boundaries. Physical blobs are eligible for retention cleanup only after their durable reference count reaches zero.

## Security model

S6_cut is single-user software for a trusted LAN or VPN. It is not a hostile multi-tenant service.

- nginx is the only published service; the engine has no host port.
- Uploads stream to confined UUID directories, with suffix, byte, duration, and FFprobe validation.
- URL import only accepts HTTPS YouTube hosts, rejects credentials/custom ports, resolves DNS, and rejects non-public addresses.
- Download paths are confined under jobs/exports and require expiring HMAC signatures.
- Provider keys are never present in profile responses. Persistent keys use Fernet encryption with a restrictive instance key; session keys remain process-memory-only.
- Logs/errors redact common authorization/key/token patterns and do not return host filesystem paths.
- Queue, worker, source duration, output count, provider timeout, and request creation rate are bounded.
- nginx sets CSP, frame, MIME, referrer, and permissions headers.

Administrators must provide authentication and TLS through an identity-aware reverse proxy or VPN for remote access.
