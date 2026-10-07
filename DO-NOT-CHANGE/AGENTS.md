# DO-NOT-CHANGE — S6_cut engine & UI invariants

This file is a guardrail for AI agents that modify the S6_cut codebase. **Read this
file before changing anything in `engine/`, `web/`, `docker/`, `compose.yaml`, or the
root scripts.** Everything below is a load-bearing contract. Breaking any of it
silently corrupts data, invalidates security, or breaks the deterministic engine —
often in ways that only appear later (lost Library assets, broken signed links,
duplicated clips, or a full startup crash).

The general rule: **make additive, backward-compatible changes. Never rewrite,
rename, reorder, or "simplify" an existing invariant. Never "fix" behaviour you do
not fully understand — first read the test suite (they encode the contracts).**

---

## 0. The single most important rule

The S6_cut engine is a **deterministic, local-first media engine** with an
**idempotent, transactionally-published Media Library**. The two hardest invariants:

1. **A completed clip and its Library asset are published in ONE SQLite transaction
   and are bidirectionally linked** — `clip.library_asset_id == asset.id` and
   `asset.source_clip_id == clip.id`. Never break or "simplify" this; the engine
   validates it and repair paths depend on it.
2. **All media is content-addressed and immutable.** Blobs live under
   `data/blobs/sha256/<2-prefix>/<sha256><suffix>`, are referenced through
   `media_blobs` + `media_blob_refs`, and are **never overwritten or deleted while a
   reference exists**. Library assets, project sources, and clip outputs are durable
   references, never files you modify in place.

If a proposed change touches either of these, stop and treat it as out of scope.

---

## 1. Data contract between engine and web (camelCase JSON)

`engine/models.py` `ApiModel` uses `alias_generator=to_camel` + `extra="forbid"`.
The web client parses every response with **zod schemas** in `web/src/types.ts`
using the camelCase field names. This contract is symmetric and exact:

- **Never rename/remove a field** that exists on `Project`, `Job`, `Clip`, `Asset`,
  `LibraryFolder`, `Health`, `ProviderProfile`, `ScoreBreakdown`, `ProvenanceRecord`,
  `Beat`, or `ProcessingStep` without changing **both** sides (engine model + zod
  schema) **and** every consumer.
- **Never add `extra="forbid"`-violating fields** to engine responses: if you add a
  field to a Pydantic model, the frontend zod schema must tolerate it (add the
  optional field) or the frontend `.parse()` will drop it silently — check both.
- Engine uses snake_case internally, camelCase over HTTP. Do not "fix" this naming
  asymmetry; it is the contract.
- `Clip.library_asset_id` is **engine-set only**, after the publication transaction
  commits. The UI must never display it from optimistic/derived state (see
  `workspace-view.tsx` comments).
- `Job` `steps` invariant: **at most one step may be `active`** and a terminal step
  (`complete|skipped|failed`) **must** have `completed_at`. `ProcessingStep` and
  `Job` validators enforce this — new step transitions must go through the helpers
  in `JobManager` (`start_step`/`complete_step`/`skip_step`/`fail_step`), never raw
  mutation.

## 2. Database layer (`engine/database.py`) — never touch these

### Migrations
- `schema_migrations` + `_migrate()`: **additive-only**. Never edit, delete, or
  reorder an existing migration block (`if version < N:`). Existing databases must
  keep working. If you need a schema change, append a new `if version < N+1:` block.
- The `projects`, `jobs`, `assets`, `profiles` tables store **whole-model JSON in a
  `payload` column** plus a few denormalized columns. The JSON payloads must always
  be parseable by the current models — do not write partial payloads.

### Unique identity indexes (idempotent publication depends on these)
- `assets_hash_idx` on `assets(content_hash)`.
- `assets_source_identity_idx` on `(origin, source_project_id) WHERE origin='project-source'`.
- `assets_output_identity_idx` on
  `(origin, source_project_id, source_job_id, source_clip_id) WHERE origin IN ('generated-clip','script-output')`.
- These make `register_blob_asset` / `publish_clip_output` / `backfill_missing_assets`
  idempotent. **Never drop, weaken, or add uniqueness to these** without a full
  migration plan and updated tests.
- `media_blob_refs` `ref_type` is constrained to `('asset','project-source','job-source','clip-output')`.
  New reference types require schema + all cleanup paths (delete_asset, delete_project)
  updated together.

### Methods that must never change behaviour
- `publish_clip_output` — the atomic publication transaction (blob upsert → asset
  upsert by stable identity → refs → clip update → job checkpoint → invariant
  validation). It runs in one `BEGIN IMMEDIATE` transaction.
- `register_blob_asset` — idempotent asset registration preserving **existing**
  metadata (title, tags, policy, folder…) when an asset already exists for a stable
  identity. New uploads must never clobber user-edited metadata.
- `backfill_missing_assets` / `repair_publications` (jobs.py) — startup repair.
  Must remain idempotent and never duplicate assets.
- `save_job` + `JobManager._save` — always keeps the linked `Project.state` in sync
  and writes a `state.json` next to the job directory. Keep this coupling.
- `remove_folder` — moves assets/child folders/projects to a destination and writes
  a `library_folder_redirects` row; the deleted folder is marked `deleted=1`,
  never hard-deleted. `resolve_folder_id` follows redirects on every read.
- `delete_asset` — refuses protected assets; returns whether the blob is now
  unreferenced so the caller may delete it. Never delete blobs inside `delete_asset`
  without the reference count check.
- `validate_clip_asset_relationship` — the bidirectional invariant checker. Tests
  depend on it.

## 3. Media & blob store (`engine/library.py`, `engine/media.py`)

- `LibraryRules._publish_blob(path, digest)` — content-addressed store: target path
  is `blobs/sha256/<digest[:2]>/<digest><suffix>`, written via temp file +
  `os.replace`, **preferring a zero-copy hard link**. Keep the digest-derived path
  scheme and the atomic publish.
- **Blob immutability**: once published, a blob's bytes and relative path are fixed.
  If source content changes, a **new** digest/blob is created. Never move, rename,
  or overwrite blob files, and never let `blob_id` drift from the digest.
- `MediaSigner` (`engine/security.py`): HMAC-SHA256 over `f"{relative}\n{expires}"`
  with `base64.urlsafe_b64encode(…).rstrip("=")`. **Never change the signed payload
  format, hash, or key file handling** — every existing signed URL would break, and
  the key file (`data/secrets/media-signing.key`) must be loaded once and reused.
- `confined(root, *parts)` — path traversal guard used by every file-serving
  endpoint. Never serve a file without it; never loosen it.
- `download_file` (app.py) only permits `jobs/` and `exports/` prefixes; the
  library preview endpoint uses a token `library-asset:{id}:{blob_id}`. The
  **frontend never constructs file paths or URLs** — it only uses server-provided
  `previewUrl` / `downloadUrl` / signed links. Keep it that way.
- Never expose absolute host paths, `/app/data` raw paths, or `data_path` on the
  wire (see `health.data_path` which returns a sanitized label).
- `validate_youtube_url` — SSRF protection: HTTPS-only, public-host resolution,
  blocks private/loopback/link-local/reserved addresses. Do not weaken.

## 4. Job processing pipeline (`engine/jobs.py`)

- `JobManager._process` outer guard: on unexpected failure it marks the job
  `failed`/`partial` **without touching already-published clips**. Never change this
  to roll back published clips.
- `_publish_output` — the staged publication protocol (resolve folder → hash &
  promote blob → atomic DB commit). Re-publication of the same stable identity must
  reuse existing asset/blob (idempotent), never duplicate.
- `_source` / `_register_source` — the source video is **registered as an immutable
  `project-source` Library asset** and `project.source_blob_id` is set. Sources are
  never destructively modified.
- `_switch_to_fast` — creates a **new job** reusing the same source; the old job is
  marked `cancelled_kept`. Do not reuse/overwrite the old job record.
- `_finish_render_steps` + job state machine:
  `queued → active → complete | failed | partial | cancelled_kept` (plus `paused`,
  `recovered`). Keep the transitions and the `stage`/`stage_label`/`progress` sync.
- Fast mode (`_process_clip_fast`) uses `plan_fast_windows` — **deterministic**
  window planning. Never make it random or stateful.
- `build_export` — ZIP with `manifest.json` + `credits.json`; keep the format.

## 5. Deterministic matching & Library rules (`engine/library.py`)

- `explain()` scoring is **deterministic and must stay so**: exact trigger/alias
  hits ×45, tag hits ×12, title hit +20, policy bonus `required` +35 / `prefer` +18;
  `required` reserves 34 when no content match; `never` policy, negative triggers,
  and date ranges reject before ranking; ties broken by `(-score, asset.id)`.
- `resolve()` is used inside the render pipeline to pick overlays and provenance.
  Never change scoring or rejection order without updating
  `engine/tests/test_library.py` and the selection tests.
- `normalize()` tokenization (`[\w'-]+`) is shared by matching; keep it stable.
- Policy values are exactly `required | prefer | neutral | never` (the UI label
  "Preferred" maps to `prefer`). Do not add/rename values without touching models,
  zod, `library-view.tsx`, `ImportPanel`, and the engine tests.

## 6. Render / caption pipeline (`engine/media.py`)

- `write_ass` — ASS subtitles: `PlayResX/PlayResY` **must match the final render
  canvas** (9:16=1080×1920, 1:1=1080×1080, 16:9=1920×1080), captions are
  bottom-centre `Alignment=2` with symmetric margins, word-by-word highlight uses
  `{\c&H0077D6FF&}`, wrapping happens at word boundaries via `_wrap_caption_words`,
  and `_ass_style_metrics` scales from the 9:16 reference (`_CAPTION_REFERENCE_*`).
  The subtitle tests (`engine/tests/test_subtitles.py`) encode these exact numbers.
- `render_clip` / `render_fast_clip` / `render_script` write to a
  `.partial.mp4` temp and `os.replace` on success; they validate output dimensions
  and audio before publishing. Keep the atomic output + validation.
- `transcribe` — Faster-Whisper with **word timestamps required** (captions depend
  on them). `S6_TEST_TRANSCRIPT_JSON` env var is the test fixture hook — keep it.
- `probe` enforces `settings.max_source_seconds`. `extract_audio_16k` produces the
  canonical 16 kHz mono WAV. Do not change formats without re-validating whisper
  ingestion and caption alignment.

## 7. Web frontend (`web/src/`)

- `web/src/types.ts` zod schemas **must mirror `engine/models.py` camelCase fields**.
  A parse failure on any view is a hard error — add fields on both sides together.
- `web/src/api.ts` — API paths (`/api/v1/...`), error surface (`ApiError`), and the
  `request()` wrapper are shared by every view. Changing a path breaks the client
  unless the engine route changes in lockstep.
- Signed media URLs come from the server (`previewUrl`, `downloadUrl`); the frontend
  never guesses paths. Keep `jobEventsUrl` (SSE) as-is; the Workspace relies on it.
- `web/src/library-sync.ts` — bounded revalidation + cross-tab signal
  (`emitLibraryChanged`, `createBoundedRevalidation`). Keep the debounce semantics;
  the Library/Workspace consistency depends on it.
- `App.tsx` routing / `WorkspaceView` polling + SSE update loop: keep the
  `prevClipStates` publication detection (it emits library-changed when a clip
  completes).
- `web/src/styles.css` design tokens (`--surface-*`, `--text*`, `--copper*`) are the
  design system; extend tokens, don't bypass them. Status colours carry meaning
  (see `StatusBadge`): complete/ready green, failed red, warning amber, copper =
  accent — don't collapse them.

## 8. Configuration & deployment

- `engine/config.py` env vars are consumed by `compose.yaml`, the Dockerfiles, and
  `scripts/dev.mjs`: `S6_DATA_PATH`, `S6_WHISPER_*`, `S6_JOB_*`, `S6_MAX_*`,
  `S6_MEDIA_URL_TTL_SECONDS`, `S6_FAST_GUARD_SECONDS`, `S6_FFMPEG_BIN`,
  `S6_FFPROBE_BIN`, `S6_YTDLP_BIN`, `S6_ALLOWED_ORIGINS`. The former
  `S6_LOCAL_TTS_BIN` variable is retired with Script/narration generation; do not
  reintroduce it as part of current runtime configuration. Changing a default or
  unit (bytes vs MB, seconds vs minutes) silently breaks docker deployments and
  the dev server.
- `compose.yaml` binds `./data` → `/app/data` and the web container proxies
  `/api/` → engine:8001. `docker/nginx.conf` carries the CSP and proxy timeouts.
  Never bypass the nginx proxy for media, and don't relax the CSP
  (`media-src`, `img-src`, `connect-src`).
- `web/vite.config.ts` dev proxy is `http://127.0.0.1:8001` — keep it pointing at the
  engine port used by `scripts/dev.mjs`.

## 9. Tests encode the contracts

`npm test`, `npm run typecheck`, `npm run lint`, `npm run build` and
`python -m pytest engine/tests -q` are the gate. The engine test suite
(`test_api.py`, `test_library.py`, `test_publication.py`, `test_atomic_publication.py`,
`test_security.py`, `test_subtitles.py`, `test_selection.py`, `test_fast_*.py`,
`test_whisper.py`, `test_steps.py`) asserts the invariants above — including that
preview URLs never leak host paths, tampered signatures return 403, publications are
idempotent, and the clip↔asset relationship holds. **If a change requires editing a
test to make it pass, that is a strong signal the change violates a contract** —
investigate before proceeding. FFmpeg/FFprobe-gated smoke tests skip cleanly when the
tools are absent; don't convert them into always-skip or always-run tests.

## 10. Explicit "do not" list (quick reference)

| Area | Never do |
|---|---|
| `engine/database.py` | Edit past migrations; drop unique identity indexes; hard-delete folders; delete blobs with live refs; skip the bidirectional invariant |
| `engine/models.py` | Rename camelCase fields; change `extra="forbid"`; relax validators (duration, step state, active-step exclusivity) |
| `engine/app.py` | Expose raw paths; remove HMAC checks on `/files`/preview; change 202/204/404/403 semantics; disable rate limiting on job creation |
| `engine/security.py` | Change the signed payload format, key handling, `confined()`, or YouTube SSRF checks |
| `engine/library.py` | Change deterministic scoring weights/order; weaken idempotent blob registration |
| `engine/jobs.py` | Roll back published clips on failure; mutate sources in place; reuse job records for "fast switch" |
| `engine/media.py` | Change ASS PlayRes/caption metrics constants; skip output validation; drop atomic `.partial` publish; make window planning non-deterministic |
| `web/src/types.ts` | Divergence from engine models (fields added/removed on one side only) |
| `web/src/api.ts` | Guessing media URLs client-side; renaming API paths alone |
| `web/src/styles.css` | Removing design tokens; making status colours monochrome |
| `docker/`, `compose.yaml`, `vite.config.ts` | Bypassing the proxy, relaxing CSP, changing data-path bindings or engine ports |

When in doubt: **make the smallest additive change, keep every existing test green,
and never trade away an invariant for "cleaner" code.**
