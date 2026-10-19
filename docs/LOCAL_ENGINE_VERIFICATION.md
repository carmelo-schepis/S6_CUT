# Local engine verification — 2026-10-19

Verified on linuxpc in the isolated S6_CUT-local-engine-subtitles worktree.

## Results

- npm run check passed: lint, retired-provider checks, TypeScript, 358 frontend tests, 721 backend tests and the production build. The host skipped 96 tests requiring media tools or other optional runtime dependencies.
- Four Chromium browser checks passed, covering 1440px and 390px widths with a provider connected and disconnected. Captions and hooks remained enabled, Engine only was submitted in the multipart request, and the page had no horizontal overflow or JavaScript errors.
- Real Faster-Whisper transcription and FFmpeg rendering completed for Engine only with a configured API, disconnected Auto, connected Auto and Auto with provider failure. Each produced a complete 1080x1920 clip with audio, timed subtitle sidecars, hook text, a linked Library asset and a successful complete decode.
- The first job performed real transcription in a fresh temporary data directory: 10 timed words and an 8.64-second clip. Later jobs reused the validated transcript cache.
- Engine only and disconnected Auto recorded zero provider calls. Connected Auto exercised candidate selection, model lookup, metadata and hook generation. The failure case exercised provider errors and completed with local planning, metadata and hooks.
- Comparing the Engine only output against a matching control render with text disabled found 509 bright hook pixels and 396 caption pixels. This verifies text in the actual rendered frames, beyond checking subtitle files.

## Corrections made during verification

The Workspace metadata action now honors Engine only. Either the public job snapshot or its private checkpoint can veto cloud use. Switching to Fast preserves that policy.

Metadata availability is snapshotted separately from provider planning, preserving the existing independently supported metadata path. Auto mode now uses the same resolver in the API and its helper.

Interrupted hook generation recovers locally without replaying an ambiguous paid request. Partial provider results retain valid hooks, accurately count local replacements and show an accurate fallback warning.

Regression coverage includes both durable policy copies, restart loading, API submissions, the explicit Workspace metadata action, interrupted and partial hooks, unsuitable transcripts and browser submission at desktop and phone widths.

## Verification setup and limits

The host font check used an isolated fontconfig file pointing at the repository's vendored fonts; no system font configuration changed. The engine image also resolved the required Montserrat ExtraBold Italic face.

The real render harness is scripts/qa/local-engine-verification.py. Docker cleanup delayed new container creation, so the successful run used a separate /tmp/qa/s6-local-engine-verification directory inside the existing engine container, with the current branch source copied into that directory. The test process had Python outbound connections blocked, Hugging Face offline mode enabled and cached models available. It did not use the live service's database or change service configuration. A 600-second transcription initialization timeout was used to accommodate concurrent host load.

Connected-provider responses and failures were instrumented stubs; no live API credentials or paid calls were used. Local hooks select transcript text rather than using a bundled local language model. Cached models are required for offline transcription, and YouTube source/song acquisition requires network access.

Evidence remains under .qa/local-engine-verification in the verification worktree: report.json, browser screenshots and reports, and the saved Engine only output. The code corrections were merged locally; this verification did not push or deploy them.
