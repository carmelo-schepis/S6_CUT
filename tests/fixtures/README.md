# Acceptance fixtures

`openrouter-fallback.mp4` is a synthetic, offline-generated fixture for the
OpenRouter Smart fallback acceptance test. It contains a simple generated video
and a single-channel spoken narration; it contains no personal or copyrighted
source material. The test uses the media only to exercise real local
transcription, rendering, and verification, and does not assert exact Whisper
wording.

The committed fixture is intentionally small (about 2.9 MiB), 13.375 seconds
long, and its reproducibility anchor is:

```
e2cc757cc3ac53da31656d7506578782b456c7b737061ddc632b0fb574d8ae30  openrouter-fallback.mp4
```

It was produced with offline speech synthesis and FFmpeg; the checksum above
must be updated if a regenerated fixture changes. Do not replace it with a
personal recording or a downloaded media file.
