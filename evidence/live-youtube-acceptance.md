# Live Smart Speech acceptance

- Test: `tests/acceptance/smart-speech-presentation-live.spec.ts` (Desktop Chromium), 1 passed in 7m12s.
- Input: public YouTube source `JnfBXjWm7hc`; detected creator `TED`; creator credit in the clip record and ZIP metadata: `Source: TED`.
- Pipeline: source validation, local Whisper transcription, local planning fallback (no OpenRouter provider connected), boundary verification, render, and output verification all completed. One 18.96-second clip was produced.
- Media: H.264/AAC output at 1080×1920; Playwright verified playback and seeking in the downloaded clip, workspace preview, Library preview, and Shorts Editor. ZIP integrity and its `credits.json` were verified; no subtitle sidecar files were included.
- Visual review: inspected early, midpoint, and near-end frames from the rendered MP4, plus the playing workspace preview and Shorts Editor preview. The captions are readable, bold, outlined, word-timed, and consistent with the supplied reference; the timed full-colour lightbulb emoji renders; the TED creator credit appears in the burned-in captions. No playback or rendering defect was observed.
- Captured locally under ignored `.run-artifacts/smart-captions-live-playwright/test-results/` during review. The downloaded test video/screenshots are temporary and are not committed.
