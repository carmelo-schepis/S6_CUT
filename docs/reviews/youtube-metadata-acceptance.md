# YouTube metadata acceptance and review

## Scope and safety

- Metadata generation is an independent, opt-in OpenRouter feature for eligible Short-form Clip jobs. It runs on local timed transcript excerpts before clip publication; source title is secondary context. Prompts treat transcript/source text as untrusted data. It does not change rendered media, burned-in captions/hooks, Music Top text, or Fast mode.
- The per-profile metadata model defaults to `google/gemini-2.5-flash-lite`; Settings lists only models advertising structured output and at or below $0.10/M input and $0.40/M output. Requests disable reasoning, cap output tokens, use provider-side price ceilings, reserve a conservative per-job $0.05 budget, and cap provider requests at five per job. There is no automatic paid-model substitution.
- OpenRouter secrets use the existing encrypted profile vault. Metadata generation requires a selected, connected saved profile and uses the existing provider service/client.
- Provider failure retains playable output and deterministic clip titles. A transcript-derived description is used only when enough local excerpt exists; failure is surfaced as fallback/unavailable. Generation state, result cache, revision, model, usage and actual/estimated cost persist with the job.
- Workspace edits use revision checks. Generated Clip and Library Asset title/description updates are committed together. Library cards/details and selected-clip ZIP JSON manifest use the same saved metadata.

## Automated coverage

- `engine/tests/test_youtube_metadata.py`: metadata validation, stale revisions, linked Asset persistence, the existing Library 200/2,000-character edit contract, Fast-mode refusal, bounded provider parameters, paid-call limit, overlapping reservation preservation, and stale worker-checkpoint protection.
- `engine/tests/test_youtube_metadata_pipeline.py`: transcript time-range grounding, malformed/duplicate/missing/unknown IDs and repeated titles, deterministic fallback, two-item output-bounded batching with realistic IDs/descriptions, persistence/cache reuse, model price ceiling, output-token limit, and exhausted-budget behavior.
- Frontend component/API/type tests cover Settings model persistence, opt-in eligibility, editor behavior, Library presentation, and API contracts.
- `tests/acceptance/youtube-metadata-live.spec.ts` is deliberately non-mocked. It requires `S6_RUN_LIVE_YOUTUBE_METADATA=1`, `S6_ACCEPTANCE_ISOLATED=1`, an authorized public `S6_YOUTUBE_METADATA_URL`, and a selected/connected provider profile configured only in disposable review data. It exercises real provider generation, edits, reload, and export. Do not use the owner’s deployment/data for this test.

## Independent review follow-up

The independent acceptance review's source findings were checked against the current implementation (`b4b9ea8`): the metadata option starts unchecked and is disabled/reset for speech Fast mode; the YouTube inspector tab is rendered for Clip jobs; metadata edit requests require a revision; request/budget reservation is atomic under `BEGIN IMMEDIATE`; and the selected-clip ZIP manifest includes metadata title and description. The review's finding describes an earlier snapshot and does not apply to this revision. Live acceptance remains blocked as noted below.

## Provider evidence and review deployment

The OpenRouter Gemini 2.5 Flash Lite model page reports $0.10/M input and $0.40/M output. `OPENROUTER_API_KEY` is not available and the isolated review deployment has no configured provider profile, so no real credential test, provider request, or live generation has passed. The Playwright provider spec is therefore blocked/skipped, not a passing acceptance result. No secret is added to the repository or review deployment.

An isolated Docker review stack was running at the time of this review. Its private host binding, Compose project, network, and data path are omitted from this public record. Do not alter an existing review stack while cleaning up unrelated test stacks.

## Verification performed

- Frontend lint, typecheck, production build, and tests passed; latest frontend result was 325 tests passed. The retired-provider check, Python compile, and diff check also passed.
- Isolated Docker backend metadata/provider suites passed: 69 tests on the preceding revision; the metadata regression suite passed 11 tests on `b4b9ea8` (including failed-provider fallback persistence).
- `npm run check:supported`, started before `b4b9ea8`, passed its frontend gate but the full backend suite reported 656 passed and one failure: `engine/tests/test_steps.py::test_switch_fast_cancels_active_transcription_without_resurrecting_job`. The failure reproduced when run alone. The full suite has not been rerun on `b4b9ea8`; this is a failing/incomplete verification, not a pass.
- Greptile reviewed `b4b9ea8`: 25 files reviewed, 0 comments.
- `docker compose config`, the isolated review-stack health endpoints, and a browser UI smoke check passed.
- Live Playwright/provider verification remains blocked: credentials and an authorized source URL are unavailable. Skipped live coverage is not counted as a pass.
