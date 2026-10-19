# Local engine subtitles and hook text: diagnosis and implementation brief

Date: 2026-10-19. Inspected origin/main at 8a01de1. This document records the original diagnosis and implementation brief. The follow-up implementation is summarized at the end.

## Confirmed cause

1. `web/src/components/projects-view.tsx:179` treats Auto without a connected provider as Fast. Line 335 disables Burn in subtitles; submission at line 159 sends false. This exactly explains the supplied screenshot.
2. `engine/app.py:137` independently resolves Auto without a connected provider to Fast. `engine/jobs.py:2380` disables captions for Fast even if a client requests them. Removing the disabled checkbox alone cannot fix this.
3. Smart already supports local Faster-Whisper word timestamps and deterministic planning. `engine/media.py:750` performs local transcription; `engine/jobs.py:_plan_smart_candidates` uses local selection when use_openrouter is false. OpenRouter does not transcribe audio.
4. Hook text is currently cloud-only: projects-view.tsx:186 disables it without a provider, app.py:482 rejects it, and jobs.py:1635 calls OpenRouter. Provider failure currently renders without hooks, rather than generating local hooks.
5. There is no dedicated Engine only selection in the inspected Projects creation UI: it exposes Auto/Fast/Smart. Smart automatically enables OpenRouter planning when a connected profile exists. Thus selecting Smart is not a durable cloud opt-out.
6. `engine/providers.py:144` checks saved connected status and credentials, not a fresh reachability probe. Runtime failure must still fall back locally.
7. SEO title/description generation also calls providers independently of planning. An engine-only switch must govern these calls, including model-list requests; setting use_openrouter=false alone is insufficient.

## Host evidence and immediate workaround

Read-only checks on linuxpc: production /api/v1/health returned ready with Whisper, FFmpeg and FFprobe present. In s6-cut-engine-1, configured speech model base and music model small were both cached. This is not a missing-model diagnosis. No fresh transcription/render was run and the exact live frontend revision was not verified.

Current workaround: with no provider connected, explicitly select Smart and enable Burn in subtitles. This invokes the existing local transcription path. Hook text has no equivalent local workaround today. Smart with a connected provider can use that provider.

## Required behavior

Keep processing quality separate from execution location. Add an always-visible execution selector: Auto (API when connected; local fallback otherwise) and Engine only (local processing even with a connected API). Persist the choice on each job, expose it in job responses, and retain it through retries/restarts. A remembered UI preference may seed new jobs; it must not override existing job snapshots.

For normal caption/hook-enabled creation, use Smart regardless of whether a provider is connected. Keep Fast as an explicitly labelled no-transcription option. If a user enables captions/hooks while Fast is selected, clearly switch to Smart; never silently discard a checked feature. Do not rewrite existing Fast jobs or their caption-free semantics.

In Auto, use the API for supported text planning, hook and metadata tasks when connected, falling back locally on timeout, missing credentials or invalid output. Transcription and rendering remain local: the existing provider is a text service. Cloud speech transcription would be a separate feature.

Engine only must disable every job-scoped external AI request, including planning, hooks, metadata and model discovery. Do not disconnect or mutate shared provider profiles. Recheck the persisted policy at each call site, not only in the UI. Other concurrent jobs may legitimately use the provider.

For true offline use, use local uploads and installed models. YouTube source/song imports still require network. Expose model readiness and an explicit preparation/download action; require cached/local model loading during offline execution rather than allowing an implicit model download. Describe the distinction between local processing and offline source acquisition in the UI.

## Apply in four bounded prompts (suitable for Luna)

### Prompt 1: execution contract and routing

Read this report and inspect current code before editing. Add a typed execution policy (auto/local) to frontend types and createClipJob, the clip API Form contract, Job persistence and durable private checkpoint state. Default legacy jobs compatibly so their prior behavior is retained. Resolve new Auto jobs to Smart when captions/hooks require transcription; do not use provider connectivity as local transcription capability. Centralize provider permission and guard all job planning/hook/metadata/model-list calls. Preserve music/high-volume/long-form rules unless explicitly changed. Add tests proving local mode never calls a provider even with connected credentials and after restart/retry. Run focused engine/API tests and frontend typecheck. Commit this stage.

### Prompt 2: local hooks and text fallback

Implement a deterministic transcript-grounded local hook generator in engine/hook_text.py. Select a concise, meaningful phrase/sentence from the clip transcript, normalize and validate it with existing rendering constraints, and record local provenance. Do not invent facts or promise language-model quality. Handle empty/too-short transcripts explicitly; render successfully with a visible explanation when no useful hook is possible. In Auto prefer valid provider output, but generate local replacements for failed/missing/invalid hooks. Remove provider-presence eligibility checks while retaining unrelated format restrictions. Reuse existing hook rendering and timed disappearance. Add local SEO title/description fallback for eligible jobs so the engine-only setting does not silently disable another enabled text feature. Include cache/provenance keys and retry behavior. Test provider timeout, malformed responses, partial results, silence and rendering sanitization. Commit this stage.

A bundled local LLM is optional future work, not required for initial local hooks; it needs separate model selection, installation, resource measurement and lifecycle design.

### Prompt 3: user controls and readiness

Add the always-visible Auto / Engine only selector to project creation. Keep captions and Hook text available without an API in eligible Smart jobs. Show whether hooks/planning will use local processing or API with fallback. Ensure checked options are sent faithfully and switching to/from Fast has explicit behavior. Show missing local model readiness separately from provider connectivity and implement preparation plus cached-only execution for offline operation. Update Help and README and remove stale provider-required copy. Test provider loading/disconnection, local override with connected API, checkbox submission, preference persistence and music/high-volume/long-form exclusions. Commit this stage.

### Prompt 4: verification and integration

Use isolated test data and ports, never production job storage. Run npm run check and applicable acceptance tests. Render a real short spoken fixture in (a) no-provider Auto, (b) Engine only with a configured provider whose calls fail the test if attempted, (c) connected Auto, and (d) Auto with provider failure. Verify actual burned caption and hook pixels, word timing, output audio/video validity and persisted execution/provenance after retry/restart. Test missing models and silent footage for honest outcomes. Keep explicit Fast tests asserting no Whisper calls. Record exact evidence and limitations. Fetch latest main, inspect concurrent changes, integrate and rerun affected checks before merging; do not overwrite other agents changes. Deployment/rebuild is separate from merge.

## Completion criteria

- Screenshot controls work without a provider for eligible spoken clips.
- Engine only remains available with an API connected and makes zero external AI calls.
- Auto uses connected API text features and falls back to local equivalents on failure.
- Captions use local word timing, with honest reporting for silence/missing models.
- Retries/restarts retain job execution policy; unrelated provider settings stay intact.
- Existing Fast, Music, high-volume, long-form and completed-job behavior remains compatible.


## Follow-up implementation (2026-10-19)

The diagnosis branch now carries an initial implementation: Auto uses local Smart transcription when no provider is connected; the Projects view exposes Auto with local fallback and Engine only; Engine only is snapshotted on the Job and blocks provider planning, hooks and metadata model lookup; hooks use transcript sentence selection locally when Engine only is selected, no provider is connected, planning fails, or hook generation fails; and enabled metadata gets a transcript-based local description in local execution. Provider-backed Auto still uses connected OpenRouter text features. Fast remains the explicit no-transcription mode.

Verification completed: Python syntax compilation and `npm run build` passed. Follow-up tests, real rendering, provider-call instrumentation and the corrections found during verification are recorded in [LOCAL_ENGINE_VERIFICATION.md](LOCAL_ENGINE_VERIFICATION.md). YouTube imports and YouTube song URLs require network access even when all AI generation is local.
