# Live acceptance runner: editing style library

Runner: `scripts/qa/editing-style-library-acceptance.mjs`
Spec: `tests/acceptance/editing-style-library-real.spec.ts`
Plan: `docs/plans/youtube-editing-style-library.md` (sections "Plain YouTube sources and isolated execution" and "Browser workflow")

**Status: required journeys passed separately; full runner did not pass in one unfiltered run.** UI and the real speech journey passed in run `20261030051247-4175627-20f3d2`. The real Music journey passed in the isolated Music-only run `20261030061002-48561-fa94fc`, including the explicit Warm filter over a clip that the automatic Music assignment had marked grayscale. The Music-only runner correctly reports `INCOMPLETE` because it was grep-filtered; an earlier full run passed UI and Speech but failed Music before the later selector and chroma-threshold fixes. Evidence stays under ignored `test-artifacts/editing-style-library/`. Do not interpret a filtered runner result as an overall `PASS`.

## What it does and does not do

- Starts a **new** Compose project named `s6-editstyle-<runId>`, with new loopback ports and a disposable absolute `S6_DATA_PATH` under the git-ignored `test-artifacts/editing-style-library/<runId>/data`. It never attaches to, restarts, reads or purges `s6-cut` (port 8080/8001) or its `data/`. It checks the engine container's project label, data mount and loopback-only port binding before any import.
- Runs on the child environment **allowlist** plus an empty `--env-file`, and forces `OPENROUTER_API_KEY=""`. Nothing from the repository `.env` or the caller's secrets reaches the stack. Projects are created with "Engine only".
- Imports **only the URLs you supply**, through the normal Projects UI. The runner and spec download nothing themselves, discover no references, and publish nothing. No `S6_TEST_TRANSCRIPT_JSON`, no mocked import or recognizer; the runner refuses to start if that variable is set.
- Limits: 60 minutes for the live campaign (hard-killed afterwards, then teardown), 30 minutes for build/start (`S6_EDITING_SETUP_TIMEOUT_MIN`), and at most **2 substitutions per mode**, used only after an external import failure, taken only from manifest entries you vetted.
- Tears down only its own project (`down --volumes --remove-orphans`), removes its built `<project>-engine|web` images and its data (`S6_EDITING_KEEP_DATA=1`, `S6_EDITING_KEEP_IMAGES=1` keep them).

## Required inputs (otherwise: `UNMET`, exit 3, nothing started)

| Variable | Meaning |
| --- | --- |
| `S6_EDITING_ACCEPTANCE=1` | Explicit authorization to build the isolated stack and import the URLs |
| `S6_EDITING_SPEECH_URL` | Plain public YouTube speech URL; must equal `speech.candidates[0].url` |
| `S6_EDITING_MUSIC_URL` | Plain public YouTube sung-vocal URL; must equal `music.candidates[0].url` |
| `S6_EDITING_MANIFEST` | Absolute path to the manifest below |

Optional: `S6_EDITING_ENGINE_IMAGE` + `S6_EDITING_WEB_IMAGE` (both, locally built, not the owner tags; uses `--no-build`), `S6_EDITING_WHISPER_MODEL`, `S6_EDITING_MUSIC_WHISPER_MODEL`, `S6_EDITING_VALIDATE_ONLY=1` (validate inputs and exit, no Docker), `S6_EDITING_INCLUDE_CAPTIONS_OFF_FILTER=1` (one extra import), `S6_EDITING_UNAVAILABLE_URL` (a URL **you** supply that is expected to be unavailable), `S6_EDITING_SKIP_RESTART=1`, and selection overrides `S6_EDITING_{SPEECH,MUSIC}_{STYLE,FILTER,HEADING,EMOJI,THEME,ANIMATION}` (UI labels). For diagnosis, `S6_EDITING_TEST_GREP` passes a Playwright `--grep` filter; a filtered run does not establish full acceptance.

## Source manifest (you create it; verify the interval by watching/listening first)

```json
{
  "version": 1,
  "speech": { "candidates": [
    {
      "url": "https://www.youtube.com/watch?v=VIDEO_ID",
      "channel": "Exact channel name",
      "title": "Optional",
      "durationSeconds": 2093,
      "interval": { "startSeconds": 120, "endSeconds": 300 },
      "attribution": "Credit text you will retain",
      "reuseTerms": "Licence / permission covering the video AND audio",
      "preEffectFrames": ["/abs/path/optional-frame.png"],
      "verification": {
        "verifiedBy": "your name",
        "verifiedAt": "2026-10-30T10:00:00Z",
        "intervalVerifiedManually": true,
        "audibleSpeechOrSinging": true,
        "noBurnedSubtitles": true,
        "noBurnedHeadings": true,
        "noDecorativeEmoji": true,
        "notes": "free text"
      }
    }
  ] },
  "music": { "candidates": [ { "...same shape..." } ] }
}
```

- `candidates[0]` is the primary. Up to two further entries per mode are the only permitted substitutions; the runner never searches for replacements.
- The app picks its own clips and cannot be told a start time. The spec therefore **fails** if a selected clip falls outside `interval` (±0.25 s). Verify the span you list, and list a span that covers every clip the app might pick, or use a source that is plain throughout. A very long source (the 2,093 s Kennedy candidate in the plan) makes download and transcription expensive; prefer a shorter authorized source.
- The runner records URL, channel, duration, verified interval, attribution, reuse terms, the verification attestation, the selected clip, stage history and evidence hashes in `live-report.json` → `sources`.

## Run

```bash
export S6_EDITING_ACCEPTANCE=1
export S6_EDITING_SPEECH_URL='https://www.youtube.com/watch?v=...'
export S6_EDITING_MUSIC_URL='https://www.youtube.com/watch?v=...'
export S6_EDITING_MANIFEST=/abs/path/manifest.json
S6_EDITING_VALIDATE_ONLY=1 node scripts/qa/editing-style-library-acceptance.mjs   # inputs only
node scripts/qa/editing-style-library-acceptance.mjs                              # live run
```

Exit codes: `0` PASS, `1` FAIL, `2` BLOCKED (preflight), `3` UNMET inputs, `4` INCOMPLETE or BLOCKED_EXTERNAL (a required check could not run, or the source failed after the allowed substitutions), `5` TIMEOUT. Evidence is in `test-artifacts/editing-style-library/<runId>/`: `runner-report.json`, `live-report.json` (checks, substitutions, unmet list, browser errors), `evidence/` (request fields, downloaded MP4s, caption files, ZIP, sampled frames, screenshots), `playwright/`, `compose.log`.

## Journeys

1. **UI (no import):** four editorial intents; every one of the 12 subtitle cards selects and shows its "Style sample"; editorial intent unchanged; filter changes leave sample captions unchanged; keyboard Space/Enter; Play/Replay; reduced motion starts still; heading/emoji controls do not tick Hook text or write text; Fast gating; 390 px overflow check; Music hides regular controls, shows the nine original themes plus Karaoke focus / Soft glow / Lyric plate, and theme/animation/filter stay independent.
2. **Speech (real import, local Whisper):** a caption-free defaults **control** job, then a styled job (non-default subtitle style, filter, existing Hook text checkbox/input with a heading appearance, emoji mode) after staging and abandoning Music selections to prove no leakage. Checks: outgoing multipart fields, saved job equals request, Workspace "Editing style" summary after refresh, preview == download, FFprobe/decode/audio, caption downloads, decoded-pixel comparison against the control (filter shift, caption pixels at a cue vs a quiet moment, heading region), caption edit + rerender keeps the presentation, safe restart of the isolated engine only, ZIP manifest/credits/MP4 agreement. Caption edit/rerender uses the API because the current Workspace has no visible control; the report records the method.
3. **Music (real import):** new lyric theme + non-default animation + explicit filter, two clips, no replacement soundtrack; chroma of the source layer proves the filter overrides the automatic colour/grayscale assignment; audio, ASS, decoded frames, saved settings, Workspace summary.

## Known limits (reported as `unmet`, so the run is INCOMPLETE rather than PASS)

- Captions-off + filter journey and the unavailable-source probe run only when enabled/supplied.
- The latest Music-only runner was intentionally filtered; there is no unfiltered runner report with overall `PASS`, though UI and Speech passed together and Music passed in its own isolated run.
- Music has no caption-free control import. Provide `preEffectFrames` for manual comparison.
- Live coverage is one combination per mode; the full 12-style / 7-filter / 3-theme x 4-animation matrix belongs to deterministic render tests and is not claimed here.
- Fast and Long-form live journeys, high-volume batches and mobile viewer parsing are not covered by this runner.
- Selectors follow the labels in the current Projects UI (see the spec header). If the UI diverges, the affected check fails with a clear message.
