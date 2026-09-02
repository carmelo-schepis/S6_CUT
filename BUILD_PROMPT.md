# S6_cut — Master Build Prompt

Use this prompt with a capable coding agent from the repository root:

`C:\Users\charl\Desktop\S6_cut\S6_cut`

---

## Prompt

You are the lead product engineer responsible for building **S6_cut** into a working, polished, self-hosted application. Work directly in:

`C:\Users\charl\Desktop\S6_cut\S6_cut`

Do not stop after producing a plan or a UI mock-up. Inspect the available material, make an implementation plan, then build, test, and document a credible end-to-end product. Work in coherent milestones and leave the repository runnable after each milestone. Preserve unrelated user work.

### 1. Product mission

S6_cut is a free, open-source, installable desktop-grade progressive web app that turns one long video into many vertical short-form videos:

1. **Drop** a local video or paste a supported YouTube URL.
2. **Pick a style:** Funny, Serious, Educational, or Hype.
3. **Create**, review results as they complete, then download selected clips or every clip as a ZIP.

It also has **Script mode**. A user pastes or uploads a script and S6_cut produces a new video with narration, word-timed subtitles, and a new relevant image, GIF, or other visual roughly every 2–3 seconds.

S6_cut is local-first and self-hosted:

- no account;
- no credits system;
- no S6_cut watermark;
- no artificial usage limits;
- no mandatory hosted application backend;
- source media, library files, transcripts, projects, and outputs stay on the user-controlled machine or NAS;
- internet access occurs only for a URL the user asks to import, a media source the user enables, or an optional API provider the user configures.

The preferred deployment is Docker Compose on **TrueNAS SCALE / Portainer**, while local development and ordinary Docker hosts must also work.

### 2. Authority and required reading

Before planning or editing, inspect the target repository and read these workspace documents in this order:

1. `..\Full overview (frontend and backend)\S6_cut-FINAL-FULL-OVERVIEW.md`
2. `..\Full overview (frontend and backend)\S6_cut-DESIGN-MEDIUM-OVERVIEW.md`
3. `..\Full overview (frontend and backend)\S6_cut-COLOUR-PALETTE.md`
4. `..\Schedule\README.md` and the day files relevant to the current milestone
5. `..\Resources or copy and take parts from\S6_CUT_RESOURCE_INTEGRATION_INDEX.md`
6. Each relevant `S6_CUT_TAKEAWAYS.md` inside the resource projects
7. The supplied assets in `LOGO\`

Resolve conflicts using this order:

1. this master prompt and the user’s latest instructions;
2. the final full overview;
3. the design and colour documents;
4. the schedule;
5. resource takeaways;
6. upstream reference implementations.

The self-hosted browser + private media-engine architecture in this prompt overrides older browser-only/hosted-service notes. Do not modify the reference repositories. Study them and port only well-understood, licence-compatible behavior into S6_cut.

### 3. Required runtime architecture

Build one repository containing:

- a React + TypeScript + Vite installable PWA;
- a private Python FastAPI media engine;
- FFmpeg and FFprobe for media validation, composition, and encoding;
- faster-whisper or an equivalent verified local Whisper implementation for word timestamps;
- yt-dlp for user-authorized YouTube imports;
- a persistent SQLite database for projects, jobs, provider profiles, library metadata, rules, and provenance;
- a mounted filesystem for uploads, source cache, library assets, models, temporary work, completed clips, and ZIP exports;
- nginx serving the frontend and reverse-proxying same-origin `/api` and job events to the private engine;
- Dockerfiles and a production `compose.yaml` suitable for Docker, Portainer stacks, and TrueNAS SCALE Custom Apps.

Only the web gateway publishes a host port. The engine stays on the private Compose network. Use server-sent events or WebSockets for live job progress, with reconnect and polling fallback. Long-running jobs must be durable and recoverable after browser, container, or host restart.

For local development, provide one documented command for the frontend and engine, plus a simple Windows launcher if practical. Do not require Electron or Tauri for the MVP: the installed PWA is the desktop app.

### 4. Provider and fallback rules

**The application must work when OpenRouter is the only configured API.** ElevenLabs and all media-provider keys are optional. Missing, invalid, rate-limited, or offline optional providers must never crash an entire project.

Implement typed provider interfaces and capability checks. The required degradation behavior is:

| Capability | Preferred path | No optional provider/key |
| --- | --- | --- |
| Transcription | local Whisper | local Whisper; never require an LLM |
| Clip segmentation | deterministic TextTiling + boundaries + scoring, optionally improved by OpenRouter | deterministic local result |
| Caption wording | OpenRouter may clean punctuation and choose phrase groupings | use the timed transcript directly |
| Caption timing | Whisper/TTS alignment | Whisper/TTS alignment; never invent timestamps with an LLM |
| Script analysis | OpenRouter structured output | deterministic sentence/phrase beat planner |
| Script narration | ElevenLabs if selected | use a documented local TTS engine; if local TTS is unavailable, offer a clearly labelled no-narration render rather than failing |
| Image/GIF selection | personal library, then enabled no-key/licensed web sources, then optional keyed sources | library, no-key source, curated fallback, or text card |
| Generated images | optional configured provider | skip generation and continue |
| YouTube ingest | local yt-dlp in the engine | local file upload remains available; report URL-specific failures clearly |

OpenRouter is the single general-purpose LLM integration. In **Settings → Profiles**, let the user:

- add, edit, test, duplicate, select, and delete named profiles;
- enter an OpenRouter API key and configurable model ID;
- optionally enter an ElevenLabs key and voice ID;
- configure enabled web media sources and any source-specific keys;
- see masked secrets, connection health, capabilities, and the exact fallback for every service;
- choose session-only or encrypted persistent storage where supported.

Never return a saved secret to the browser after it is stored. Persist secrets encrypted at rest using a locally generated instance key kept in the mounted data directory with restrictive permissions. Support environment/file-based secrets for headless TrueNAS deployments. Explain that remote access requires HTTPS/VPN because the app has no built-in multi-user authentication.

For OpenRouter calls:

- keep the model configurable rather than hard-coding a fashionable model;
- request schema-constrained JSON where the chosen model supports it;
- validate every response with a strict server-side schema;
- use bounded retries, timeouts, cancellation, and useful error categories;
- keep raw provider output only in an opt-in local diagnostic log with secret redaction;
- cache stable analysis by content hash + prompt/schema/model version;
- never let malformed output enter project state;
- fall back to deterministic local logic after bounded failure.

### 5. Clip mode requirements

Accept drag-and-drop/local selection for common video formats and a supported YouTube URL. Validate inputs with FFprobe. Constrain paths, filenames, protocols, download size, duration, queues, and redirects. Do not bypass DRM or access controls. The UI and documentation must tell users to process content they own or are authorized to use.

The clip pipeline is:

1. ingest and fingerprint the source;
2. extract speech-focused audio;
3. transcribe locally with word timestamps and detected language;
4. split long transcripts into overlapping sentence-aware chunks;
5. generate more candidates than requested;
6. score candidates with an auditable breakdown;
7. snap cuts to word and sentence boundaries, then nudge toward nearby quiet audio when safe;
8. remove invalid, overlapping, and semantically duplicate candidates;
9. create a vertical reframe plan;
10. render each clip independently with word-by-word captions and timed visual overlays;
11. probe and atomically publish each completed clip;
12. package selected/all successful clips into a ZIP with a manifest and credits/provenance file.

Style presets must change real selection and editing behavior:

- **Funny:** laughter, surprise, punchlines, reactions, faster overlays, higher tolerance for short setup/punchline arcs.
- **Serious:** complete thoughts, claims and evidence, restrained motion, fewer visual interruptions.
- **Educational:** coherent explanations, practical value, definitions and steps, clear diagrams/images, calmer captions.
- **Hype:** immediate hooks, emotional peaks, strong claims, faster pacing and energetic but readable captions.

Candidate scoring should expose hook, coherence, ending quality, emotional/energy signal, practical value, visual potential, completeness, penalties, and any optional LLM contribution. The same transcript and settings must produce deterministic local scores.

Do not cut mid-word or casually cut mid-sentence. Respect user min/max duration while prioritizing complete thoughts. One failed candidate, image, GIF, or encode must not fail the batch. Completed clips appear progressively and each failed clip has its own retry action.

For reframing, begin with reliable center/face/subject-aware 9:16 cropping and a smoothed trajectory. Avoid constant camera drift. Preserve the immutable source so crop choices remain reversible. Expose 9:16 by default and support 1:1 and 16:9 where practical.

### 6. Word subtitles and automatic visual triggers

Store a canonical timed-word transcript. An LLM may improve punctuation, spelling, phrase grouping, emphasis, entity recognition, and search plans, but it must not be the source of timing.

Burn in accessible, high-contrast word-by-word subtitles. Highlight the currently spoken word. Keep caption blocks inside mobile safe areas, allow preset editing, and ensure preview and export use the same style/timing model.

Automatically derive visual beats from words and meaning. Example: when the spoken text mentions “the Beatles,” the planner should create a Beatles entity beat and the resolver should attempt a relevant licensed/library image timed to that phrase. Do not simply keyword-match every noun. Prefer named entities, concrete concepts, punchlines, emotional reactions, comparisons, and user library triggers.

The media resolver order is:

1. required/pinned personal-library rule;
2. exact personal-library semantic/tag match;
3. preferred personal-library match;
4. cached previously approved media;
5. exact-entity no-key/licensed source;
6. enabled keyed image/GIF source;
7. progressively relaxed but still relevant query;
8. optional generated image;
9. curated local fallback or branded text card.

Use documented APIs or permitted feeds, not brittle web scraping. Preserve provider, creator, original URL, licence, attribution text, query, match reason, download timestamp, and content hash. Cache downloaded media locally. Enforce safe-search and reject unsupported, corrupt, oversized, or rights-unknown results when the selected policy requires known licensing. Wrong media is worse than a tasteful text card.

Every overlay must have a duration, layer, placement, crop/fit mode, entrance/exit behavior, source/provenance, and confidence. Animated GIF/video timing must render consistently. Avoid covering faces or captions. Apply restrained deterministic motion presets instead of random effects.

### 7. Script mode requirements

Accept pasted text and `.txt`/`.md` uploads. Preserve the exact source script and split it into independently editable paragraphs.

The script pipeline is:

1. validate and normalize the script without silently rewriting it;
2. create narration using the chosen ElevenLabs voice or the local TTS fallback;
3. cache voice per paragraph using text + voice/settings hashes;
4. align narration to words and sentences;
5. plan semantic visual beats targeting a new visual roughly every 2–3 seconds, allowing natural phrase boundaries;
6. resolve personal-library and web assets progressively;
7. assemble a storyboard with editable beats;
8. render narration, captions, images/GIFs/video, transitions, optional user music, and ducking;
9. publish a preview and final MP4 with credits/provenance.

If ElevenLabs is missing, do not display a fatal error. Use local TTS. If neither narration path is operational, explain that the output will be silent and allow the user to continue or add their own voice track. If OpenRouter is missing or fails, use deterministic sentence/phrase beats and straightforward search queries.

Provide a storyboard/Beat board where the user can see the chosen asset, intended concept/entity, source, confidence, rule state, and progress. Allow replace, upload, personal-only, web-only, retry same query, relaxed query, pin, and never-use actions without restarting the whole project.

### 8. Personal Media Library

Build a persistent library for images, animated GIFs, short videos, logos, posters, ads, products, brand assets, and reusable audio.

For each asset support:

- human title and description;
- media type and technical metadata;
- free-form tags;
- people, brands, products, topics, campaigns, and trigger phrases;
- aliases and negative triggers;
- policy: Required, Prefer, Neutral, or Never;
- eligible styles/modes/projects;
- active date range;
- minimum spacing and maximum uses per project;
- preferred duration, placement, fit mode, and layer;
- a protected/pinned state for advertisements and posters;
- attribution/licence/provenance metadata;
- perceptual/content hashes for deduplication.

The rule engine must be deterministic and run before external search. A required asset should reserve a valid placement subject to safety and spacing constraints, but remain visibly overridable by the user. A Never asset is excluded before ranking. Preserve matched triggers, rules, score, rejected alternatives, and overrides in the workspace data.

Store library files in the mounted data directory so a TrueNAS dataset can be snapshotted and backed up. Never delete source library files as a side effect of deleting one project; use explicit reference tracking and confirmation.

### 9. UI and visual direction

Use the supplied files in `LOGO\` for the app icon, in-app brand mark, PWA icons, and legal/about view. Do not redesign the logo.

Follow the canonical design documents. The app should feel like a calm professional editor that has already done the first edit:

- black and near-black workspace;
- sparse copper highlights derived from the logo;
- no neon SaaS gradients, glassmorphism, oversized hero copy, or marketing-page dashboard;
- desktop-first editing density with a usable review/export experience on smaller screens;
- persistent navigation for Projects, Library, Workspace, Jobs, and Settings;
- a clear create strip: source/script → style → Create;
- progressive result cards that can be opened before the whole job finishes;
- central viewer, Clip/Beat board, selection-driven Inspector, and collapsible layered timeline;
- visible local/offline/provider/fallback state;
- full keyboard support, visible focus, reduced motion, ARIA/live status, and status meaning beyond colour.

The new-user path must remain short:

`Add source → Pick style → Create → Review → Download ZIP`

Advanced controls must not become a mandatory setup wizard.

### 10. Project, job, and composition model

Use versioned typed schemas for Project, Source, Transcript, TimedWord, AudioEvent, ClipCandidate, Clip, Beat, Asset, AssetRule, QueryAttempt, ProviderProfile, EDL, RenderJob, Warning, and ProvenanceRecord.

Keep provider-specific responses outside core records. Use immutable job settings snapshots. Persist a durable checkpoint before reporting progress to the UI. Job states must include queued, active, paused where feasible, partial, failed, recovered, cancelled/kept, and complete.

Represent all automatic and manual edits in a versioned edit decision list/scene graph. Preview and export must consume the same EDL so crop, captions, assets, timing, z-order, and visibility agree. Suggested layer order:

- markers;
- B-roll;
- reframe/source video;
- required campaign media;
- ordinary visual overlays;
- titles/hooks;
- captions;
- SFX;
- music;
- speech.

Applying edits creates a new reversible EDL version. Bulk style changes must not overwrite manual trims, transcript corrections, hand-picked assets, or required placements.

### 11. API and operational behavior

Design a small versioned same-origin API for:

- health/readiness and runtime capabilities;
- local upload and URL import;
- projects, jobs, clips, previews, and ZIP export;
- job events and cancellation/retry;
- library assets, metadata, rules, search, and match explanations;
- provider profiles, masked status, model/voice discovery where supported, and connection tests;
- storage/retention diagnostics and safe cleanup.

Use streamed uploads/downloads and do not load large media fully into RAM. Bound worker count, queued jobs, source size, duration, output count, provider concurrency, and retention. Use temporary files plus atomic rename. Validate all generated media with FFprobe before publication. Sanitize downloadable filenames and prevent traversal/SSRF. Redact keys, authorization headers, signed URLs, and sensitive filesystem paths from logs/errors.

ZIP export must stream or build on disk, remain cancellable, exclude failed clips without hiding that fact, and include:

- numbered media files;
- `manifest.json` with project and render settings;
- `credits.txt` or `credits.json` with asset sources/licences;
- a failure/warning summary when relevant.

### 12. Docker, TrueNAS, and Portainer delivery

Deliver:

- locked frontend and backend dependencies;
- multi-stage production Dockerfiles;
- `compose.yaml` with web and private engine services;
- `.env.example` with safe defaults;
- configurable `S6_PORT` and absolute `S6_DATA_PATH`;
- health checks, restart policies, resource-aware worker defaults, and a model-download start period;
- non-root runtime where feasible;
- one persistent `/app/data` mount containing database, jobs, library, cache, models, exports, and instance secrets;
- documentation for Docker Compose, Portainer Stack, and TrueNAS SCALE Custom App installation, update, backup, restore, and uninstall-with/without-data;
- no host-path assumptions baked into containers;
- no requirement for a GPU, with optional documented GPU acceleration if detected.

The default deployment is for a trusted LAN. Document how to place it behind an authenticated HTTPS reverse proxy or VPN for remote use. Do not claim the raw port is safe for public internet exposure.

### 13. Licensing and source-reuse rules

S6_cut must remain open source. Before copying code, inspect and record the exact upstream repository, revision, file, and licence. Maintain `THIRD_PARTY_NOTICES.md` and a machine-readable attribution/provenance ledger.

Resource posture:

- **AI-Youtube-Shorts-Generator:** reference-only until its upstream licence and revision are verified; reimplement behavior rather than copying.
- **ClippyMe:** MIT; useful for TextTiling, boundary cleanup, reframing, job recovery, and tests; preserve notices for copied/substantial portions.
- **ReelsGenerator:** MIT; study script, TTS, caption, pacing, and media-cache behavior; prefer clean TypeScript/Python adaptation.
- **ViralMint:** AGPLv3; direct reuse requires an AGPL-compatible project/package and preserved notices. Otherwise use clean-room behavioral reimplementation.
- **VUZA:** MIT code, but downloaded/scraped media rights are separate; take resolver ideas, not Pinterest scraping.
- **yt-dlp:** preserve its required notices and keep it a constrained, user-authorized ingest component.

Do not assume a code licence also licenses downloaded media, fonts, models, voices, or logos. Do not add Pinterest scraping or arbitrary browser automation as a default source. Include a clear legal/about page and export provenance.

### 14. Build order

The target worktree may initially show a large set of pre-existing deletions from an older implementation. Treat those deletions as user-owned work: do not restore, stage, discard, or commit them automatically. Inspect the prior `HEAD` read-only with commands such as `git show HEAD:<path>` when it helps determine whether a proven component should be deliberately reintroduced.

Also inspect whether `..\S6_cut draft` contains reusable, compatible implementation, but do not copy it blindly and do not edit it. Reuse only code that passes the same licence, architecture, and quality review as every other source.

Then deliver these vertical milestones:

1. **Foundation:** monorepo/repository structure, typed contracts, branded PWA shell, FastAPI engine, SQLite/mounted storage, health, Docker Compose, tests.
2. **First real clip:** local upload → FFprobe → local Whisper → deterministic candidate → vertical FFmpeg render → captions → downloadable MP4.
3. **Batch product:** style-aware ranking, sentence/silence boundaries, multiple independent clips, progressive results, recovery, selection, ZIP.
4. **URL ingest and profiles:** constrained YouTube import, OpenRouter profile/settings/health, optional LLM enhancement, full fallback tests.
5. **Library and resolver:** asset ingest, labels/rules, Tier-0 matching, no-key licensed source, provenance, automatic timed overlays.
6. **Script mode:** script → local/ElevenLabs voice → forced alignment → 2–3 second beat plan → storyboard → composed video.
7. **Editor polish:** shared preview/export EDL, replacements, transcript/caption edits, basic trim/reframe, keyboard/accessibility/responsive behavior.
8. **Appliance quality:** TrueNAS/Portainer docs, backup/restore, retention, restart recovery, security hardening, real-media release test.

At every milestone, integrate a working path into the actual UI. Do not build an invisible collection of disconnected backend utilities and do not fill the UI with fake buttons or mocked completion states.

### 15. Mandatory test matrix

Add automated unit, contract, integration, and end-to-end coverage. At minimum prove:

1. With no API keys, a local speech video produces at least one valid captioned short.
2. With **only an OpenRouter key**, Clip mode and Script mode continue without ElevenLabs or keyed media sources.
3. With OpenRouter unavailable/malformed/rate-limited, deterministic fallback completes the job with a visible warning.
4. With ElevenLabs absent or failing, local TTS is used; if deliberately disabled, the user can produce a silent script video.
5. A transcript candidate is snapped to valid word/sentence boundaries and does not exceed source duration.
6. One failed clip or corrupt GIF does not discard successful clips.
7. “Beatles” or another fixed named-entity fixture produces a timed entity visual request and either a relevant library/web result or a declared text-card fallback—never an unrelated silent substitution.
8. Required/Prefer/Never library policies, spacing, date, and maximum-use rules behave deterministically and explain their decisions.
9. Preview and export agree on subtitle words/timing, overlay timing, crop, and z-order for a deterministic fixture.
10. ZIP contains successful clips, manifest, credits, and warnings.
11. Saved jobs and completed clips survive an engine restart; interrupted safe work is recovered or honestly marked retryable.
12. Secrets are masked, never returned by read APIs, absent from logs, and preserved across restart only when the user chose persistent storage.
13. Traversal, SSRF, unsupported protocol, oversized upload, queue saturation, invalid media, and expired signed-download tests fail safely.
14. The production PWA installs and runs through the same-origin gateway.
15. `docker compose config`, production image builds, and health checks pass.
16. A real supplied test video produces a structurally valid 1080x1920 H.264/AAC sample verified by FFprobe.

Use the supplied test media under `..\Test video\` and/or `..\oracle-e2e-short-01.mp4` only for local validation; do not commit unnecessary duplicate media.

### 16. Definition of done

The MVP is not done until a fresh operator can:

- follow the README on an ordinary Docker host or TrueNAS/Portainer;
- open the installable PWA without creating an account;
- add a local file or supported YouTube link;
- choose Funny, Serious, Educational, or Hype;
- receive coherent, non-overlapping, word-captioned vertical clips progressively;
- see relevant timed library/web overlays with provenance and understandable fallbacks;
- download one clip or all successful clips as a ZIP;
- paste/upload a script and produce a unique storyboard/video with 2–3 second visual beats;
- complete both workflows with only OpenRouter configured, and complete the local Clip workflow with no API keys;
- restart the app without corrupting completed work;
- back up all server-side state from one mounted data directory.

### 17. Working method and reporting

Start by reporting:

1. what currently exists in the target repo;
2. which reference pieces are safe and useful;
3. the exact first vertical slice;
4. the files you will create/change;
5. the commands and evidence that will prove it works.

Ask only questions that materially change security, data ownership, licensing, or user-facing behavior. Make reasonable implementation choices for ordinary details. Then implement; do not wait for approval for safe, in-scope local edits and tests.

Keep an `IMPLEMENTATION_STATUS.md` with completed behavior, verified commands/evidence, known limitations, and the next milestone. Never describe a mock, stub, or future control as working. Run focused tests after each change and broader checks before handoff. For UI work, capture screenshots at desktop and compact widths. For media work, save one small smoke-test artifact and its FFprobe evidence outside version control.

At the end of each milestone, report the user-visible outcome first, then test/build evidence, fallbacks verified, files changed, remaining risks, and the next bounded milestone.

---

This prompt deliberately prioritizes a real self-hosted vertical slice over a wide mock interface. The first release should do the core job reliably; deeper editing features can grow from the shared EDL and durable job model without breaking that path.
