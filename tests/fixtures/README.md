# Acceptance fixtures

`openrouter-fallback.mp4` is a synthetic, offline-generated fixture for the
OpenRouter Smart fallback and Music-profile upload-path acceptance tests. It
contains a simple generated video and a single-channel spoken narration; it
contains no personal or copyrighted source material. It can exercise local
transcription and rendering, but it is **not** a Music-content validation
source and must never be used as a substitute for human-sung audio. Live Music
validation requires an authorized human-sung source, attribution/license
metadata, and the required cached model. The QA authenticity runner only runs
that live acceptance when explicitly opted in with `S6_RUN_LIVE_MUSIC=1` and a
user-provided `S6_MUSIC_SOURCE_VIDEO`.

The committed fixture is intentionally small (about 2.9 MiB), 13.375 seconds
long, and its reproducibility anchor is:

```
e2cc757cc3ac53da31656d7506578782b456c7b737061ddc632b0fb574d8ae30  openrouter-fallback.mp4
```

It was produced with offline speech synthesis and FFmpeg; the checksum above
must be updated if a regenerated fixture changes. Do not replace it with a
personal recording or a downloaded media file.
## Live YouTube acceptance fixture metadata

`youtube-live-sources.json` contains compact metadata for six public YouTube
URLs used by the opt-in live acceptance spec
`tests/acceptance/youtube-live.spec.ts`. It intentionally contains no downloaded
video, captions, thumbnails, or source media. The spec reads only the first
entry for each run, so it creates one project and one short in the target
deployment.

This test is destructive to the selected deployment: run it only against a
disposable, isolated data root. The required opt-in is explicit:

```bash
S6_RUN_LIVE_YOUTUBE=1 S6_ACCEPTANCE_ISOLATED=1 \
npx playwright test --config playwright.config.ts tests/acceptance/youtube-live.spec.ts
```

The test refuses to run without both variables. The URL validator canonicalizes
accepted direct YouTube video URLs to `https://www.youtube.com/watch?v=<11-character-id>`
before the normal download workflow receives them. Do not substitute a URL that
you do not own or have permission to process.
