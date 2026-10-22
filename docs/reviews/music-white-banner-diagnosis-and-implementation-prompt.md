# Missing Music white banner: diagnosis and implementation prompt

Diagnosis date: 2026-10-22. Inspected local main and running Docker revision `3e2175e`.
The initial diagnosis changed no code or media. The follow-up implementation is on
`fix/music-white-banner-credit-timestamp-20261022`. It changes the renderer and
verification only; the main container and all published clips remain untouched.

## Confirmed diagnosis

The two most recent completed Music jobs contain 17 clips. All 17 have `white_banner` persisted and lack the full-width white strip in their actual published MP4 at 1 second:

- `7bc785a0-9abe-4d50-86e6-7a386616d2c6` — **i can't cope if i'm not reading** — 5 clips.
- `2cd6c90b-b0c5-41a8-b881-ddc8a2600be9` — **Cage The Elephant - Cigarette Daydreams (Official Video)** — 12 clips.

Both jobs have nonblank hook text, 1920×1080 source footage on a 1080×1920 output canvas, and Subscribe disabled. Their public and private presentation settings agree. The generated burn-in ASS includes the white rectangle at y=468–569 and black hook text centred at y=519. This rules out a lost format selection, insufficient headroom, or the Subscribe schedule as the explanation for these clips.

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

Evidence under ignored `.qa/banner-diagnosis-20261022/`:

- `affected-clips.json`: actual published-frame measurements for all 17 clips.
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
  `FONTCONFIG_FILE=/tmp/s6-english-fonts.conf`.
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
  `.qa/banner-fix-20261022/`; the initial published frame is under
  `.qa/banner-diagnosis-20261022/`. The attributed Playwright MP4, caption
  rerender output, ZIP, and inspected frame are under
  `.qa/s6-music-typo-check-1792656369482-3374886/`.

### Repairing the 17 existing clips

The isolated Playwright run exercised the supported caption rerender and
publication path after deleting the job's disposable files. It recovered source
media from the Library blob, reused the saved creator metadata and Music
presentation, published the rerender through the stable clip/asset identity, and
preserved the exact saved cue IDs, text, and times. The original and rerendered
MP4s both showed the banner. This is the verified repair path; no batch rerender
has been run against production data.

After the fix is deployed, repair each affected clip through the existing caption
review/rerender endpoint, one clip at a time:

1. Read the job and clip. Record `clip.captionRevision`, `clip.captionCues`,
   `clip.libraryAssetId`, `clip.blobId`, the saved hook/presentation/audio fields,
   and `clip.creatorCredit`. Confirm the source blob and any selected music-track
   asset still exist.
2. PUT the same saved cues to
   `/api/v1/jobs/{jobId}/clips/{clipId}/captions` with
   `{"revision": <captionRevision>, "cues": <captionCues>}`. This stores the
   exact existing caption edits and timing under a new revision.
3. POST
   `/api/v1/jobs/{jobId}/clips/{clipId}/captions/rerender?revision=<newRevision>`
   and wait for the caption rerender to complete. The worker reads the immutable
   source and saved Music settings/attribution and publishes a new
   content-addressed output. It reuses the stable clip and Library asset identity.
4. Verify the new MP4 at 1 second and, when the clip is long enough, after the
   credit fade at 12 and 20 seconds. Check the full-width strip, centred black
   text, audio, creator credit, and `libraryAssetId`; confirm the new blob hash
   differs for the affected clips. Keep the previous blob untouched.
5. Repeat for the other 16 clips only after the first repaired clip passes these
   checks. Rebuilding the container alone cannot alter already-rendered MP4s.

The 17 clips remain the two jobs listed above. They have not been rerendered or
modified. English defaults and transcription/planning behavior were not changed.

## Original implementation brief

Work in `/home/linuxpc/Git_projects/S6_CUT` and fix the missing Music white hook banner. Read `DO-NOT-CHANGE/AGENTS.md` before editing. Use the diagnosis above and reproduce the failure before changing production code.

Expected result: a Music clip created with nonblank Top text and `hook_text_format=white_banner` renders a solid white full-width strip with centred black text immediately above the fitted footage, while retaining the YouTube creator credit, selected lyric theme and animation, audio, and current timing rules.

1. Fix ASS timestamp serialization at the creator-credit event in `engine/media.py`. Emit its start through `_ass_time(0)` rather than the bare `0`. Audit other zero-start ASS events from the same writer for the same invalid syntax and make any necessary corrections consistently. Keep the numeric timings and current credit visibility/fade unchanged. Do not mask the failure by deleting attribution, disabling the banner, changing its geometry, or merely rearranging events.
2. Add a regression test that fails on current main using a real FFmpeg render with **both** `creator_credit` and the Music white banner. Cover the observed condensed-black/word-build and condensed-white/line-crossfade configurations, plus a no-credit control. Check both burn-in ASS and downloadable ASS handling where they differ. Generated ASS event start/end fields must use valid canonical timestamps, and the regression render must produce no `Bad timestamp` warning.
3. Assert actual rendered pixels at 1 second and after the credit has faded (12 seconds, and 20 seconds when duration permits): full-width opaque white strip, black centred text within its bounds, correct placement above the footage, and no strip covering the source. Verify attribution appears early and follows its existing fade schedule. Preserve plain-hook, blank/unchecked-hook, no-headroom fallback, and Subscribe collision behavior.
4. Extend the isolated Playwright typography workflow with a controlled source that actually reaches `youtube_creator_credit()` through saved source title/channel metadata. A plain file upload alone does not reproduce this failure. Prove attribution is present in the render inputs and output; inspect the generated MP4, test playback and seeking, check audio, and verify banner pixels in the downloaded video and ZIP output. Recheck the banner after the supported caption rerender workflow. Controlled transcription is acceptable for this rendering regression; label it as rendering evidence.
5. Run the repository's web lint, typecheck, tests and build, engine tests, and the relevant real FFmpeg/Playwright gates. Use the production container's FFmpeg/libass and bundled fonts for pixel verification. Report skipped checks explicitly. Inspect early, middle, and late frames yourself; a CSS sample or a successful HTTP response is insufficient proof.
6. Explain how to repair the 17 affected existing clips through the supported caption rerender/publication workflow after the fix is deployed. Reuse their saved source, exact caption edits and timing, hook text, presentation, audio choices, and attribution. Preserve Library linkage and immutable blob rules; never edit a published blob or ASS in place. Rebuilding a container alone cannot change an already-rendered MP4. Prepare and verify this repair path on isolated data before any production batch rerender.

Keep the English defaults and unrelated transcription/planning behavior unchanged. Deliver the focused patch, the regression tests, before/after video evidence, verification results, and the proposed existing-clip repair procedure.
