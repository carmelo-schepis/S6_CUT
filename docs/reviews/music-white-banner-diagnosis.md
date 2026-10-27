# Missing Music white banner: diagnosis

Diagnosis date: 2026-10-22. Inspected the then-current application revision.
The initial diagnosis changed no code or media. The follow-up implementation is on
`fix/music-white-banner-credit-timestamp-20261022`. It changes the renderer and
verification only; the main container and all published clips remain untouched.

## Confirmed diagnosis

Historical completed Music jobs had clips with `white_banner` persisted but no full-width white strip in their actual published MP4 at 1 second.

The affected jobs had nonblank hook text, 1920×1080 source footage on a 1080×1920 output canvas, and Subscribe disabled. Their public and private presentation settings agree. The generated burn-in ASS includes the white rectangle at y=468–569 and black hook text centred at y=519. This rules out a lost format selection, insufficient headroom, or the Subscribe schedule as the explanation for these clips.

The creator-credit event in `engine/media.py:2473` uses a bare `0` for its start timestamp:

```python
events.append(f"Dialogue: 2,0,{_ass_time(credit_end)},Credit,,0,0,0,,{fade_tag}{_ass_escape(credit_text)}")
```

FFmpeg logs **Bad timestamp** when processing the affected burn-in ASS. In an isolated reproduction using that exact ASS file, changing only `Dialogue: 2,0,` to `Dialogue: 2,0:00:00.00,` removes the parser warning, makes the credit a correctly parsed event, and restores the white banner. No geometry, font, layers, theme, hook text, or lyric timing changed.

Measured on a black 1080×1920 diagnostic background with the actual affected ASS:

| ASS variant | Times sampled | White rows at banner edge | Mean RGB level across strip |
| --- | --- | --- | --- |
| Original | 1 s, 12 s, 20 s | 0 of 102 | 0.0 |
| Only credit start made canonical | 1 s, 12 s, 20 s | 102 of 102 | 237.74 (includes black hook glyphs) |

This establishes a timestamp-serialization/parser failure involving the creator credit. The internal FFmpeg/libass failure mechanism was not separately instrumented; do not describe this as a proven alpha, layering, or rectangle-geometry bug.

Evidence is retained in private ignored QA artifacts:

- `affected-clips.json`: published-frame measurements for the affected clips.
- `actual-frame.png`: an affected frame with black hook text and no white strip.
- `minimal-repro.json`: original versus single-timestamp-change pixel measurements.
- `ffmpeg-parser-log.txt`: original warning and corrected credit-event parsing.

## Why validation missed it

Before this fix, `engine/tests/test_music_motion_render.py` supplied banner/theme/animation inputs but its render helper did not supply `creator_credit`. The pixel test therefore exercised a banner without the problematic event. `tests/acceptance/music-typography-real.spec.ts` uploaded `silent.mp4`, so that journey did not exercise YouTube source attribution. The English-default acceptance tests did not enable a hook banner. Playback checks establish that an MP4 works, but do not establish that every requested visual element was rendered. The isolated typography journey now uses a controlled YouTube source and verifies attribution.

## Implemented fix and verification

All zero-start ASS events emitted by `write_ass` now serialize their start through
`_ass_time(0)`, including creator credit, the plain Music Top-text fallback, and
the two speech-hook events. This keeps the creator-credit end (`min(duration,
9s)`) and its existing 8-second hold plus fade unchanged. The regression suite
checks canonical start/end fields in burn-in and downloadable ASS; the credit is
present in burn-in only.

The source change is in `engine/media.py`. Regression coverage is in
`engine/tests/test_music_motion_render.py`, the ASS contract tests, and the
isolated Playwright journey. The Playwright journey now submits a controlled
YouTube source through the normal UI import path. Its local yt-dlp adapter saves
the source title and channel, and assertions check the resulting project, private
job metadata, clip attribution, rendered video, playback and seeking, song audio,
the downloaded MP4, ZIP MP4, and a caption rerender that reuses the exact saved
caption cues.

Verification completed:

- `npm run lint`, `npm run typecheck`, `npm test` (446 passed), and `npm run build`
  passed. Vite prints its existing large-chunk advisory.
- `npm run test:engine` passed: 879 passed, 151 skipped. Host FFmpeg is absent, so
  FFmpeg-gated cases skip in that host run. The font mapping was supplied with
  `FONTCONFIG_FILE=/path/to/isolated-fontconfig.conf`.
- The new real-FFmpeg renderer regression was run separately in the disposable
  production engine image with its bundled fonts and FFmpeg 5.1.9: both cases
  passed (condensed-black/word-build and condensed-white/line-crossfade), with
  credit and no-credit control renders. It checked banner pixels at 1, 12, and 20
  seconds, credit visibility/fade, untouched footage, canonical ASS timestamps,
  and no `Bad timestamp` warning.
- The related Music motion, subtitle, hook, and presentation tests passed in the
  same production engine image: 104 passed, including the existing plain/blank
  hook, no-headroom, and Subscribe-collision behavior.
- The isolated Playwright gate passed in Desktop Chromium. It used controlled
  transcription as rendering evidence, not as proof of singing recognition.
  The test project skips iOS/Android read-only runs; those were not run here.
- The pre-fix source ASS produced `Bad timestamp`. Changing only the credit start
  in a copy removed the warning and restored all 102 white banner rows at 1, 12,
  and 20 seconds. Before/after videos and frames are under
  an ignored local QA artifact directory; the initial published frame is under
  an ignored local QA artifact directory. The attributed Playwright MP4, caption
  rerender output, ZIP, and inspected frame are under
  an ignored local QA artifact directory.

### Repairing the affected clips

The isolated Playwright run verified the caption rerender and publication flow
against disposable data. The affected historical clips have not been rerendered,
and no bulk operation was performed against production data. Any future repair
should use the application's validated rerender flow, inspect each result, and
preserve previous immutable blobs. The detailed operator runbook is retained
outside the public repository.

English defaults and transcription/planning behavior were not changed.
