# Music soundtrack verification

Music mode lets the optional song replace the video's audio or play underneath
it. Song-only is the default; mixed mode keeps the original audio at normal
level and plays the song at 25% linear gain. Leaving the song blank keeps the
video's original audio. Lyrics use the song's adjusted timeline. Short songs
loop across the footage, and each clip uses its position on that timeline.
Speed changes pitch and tempo together.

## Additional defects repaired during verification

- Caption rerenders left the job queued or active and retained a completed
  `ready` step when queueing. They now reset the output steps, finish the job,
  preserve the previous output on failure, and reject conflicting edits.
- Caption queue failures now restore the previous terminal job state.
- Retention removed the original video needed by caption edits. Rerenders now
  recover the immutable source blob and the saved soundtrack asset.
- Short songs were rejected by planning before reaching the renderer's looping
  support. One speed-adjusted, looped audio timeline now feeds transcription and
  rendering, including late clip offsets and caption rerenders.
- Older transient soundtrack uploads are promoted to durable library assets.
  Missing previously saved songs produce an explicit error rather than a new
  download or a fallback to original audio.
- Import retry authorization is consumed when a worker starts so a subsequent
  stop wins. Audio decoding and timeline preparation support cancellation.
- Repeated unchanged download byte counts no longer reset stall detection.
- Soundtracks whose titles match lyrics are excluded from visual matching.
  Previously, a song titled `song` could be selected as an overlay and fail
  FFmpeg's video-stream mapping. Existing visual ranking stays unchanged.
- Audio-inspection timeouts now return an actionable error without exposing
  the private soundtrack path or command arguments.
- Font lookups no longer cache timeouts, failed commands or empty results.
  Health checks can recover after a transient fontconfig failure; successful
  lookups remain cached. Regression tests cover family and face lookups.

## Reproduce the real browser gate

```sh
npm run test:e2e:music-soundtrack
```

The runner builds current engine/web images, creates a unique Docker network and
data volume, generates valid silent and audible MP4s and a short MP3 with FFmpeg,
and launches Playwright against the real API and worker. Existing compatible
images can be reused with `S6_MUSIC_ENGINE_IMAGE` and `S6_MUSIC_WEB_IMAGE`; current
engine source and the freshly built frontend are mounted into them.

On a busy Linux host, set `S6_MUSIC_DATA_ROOT=/dev/shm` to place isolated job data
in a temporary RAM directory owned by the current user. The directory survives
engine container restarts and is deleted after the run. Output evidence stays
under `.qa`. This avoids storage stalls without changing production storage.
Set `S6_MUSIC_BROWSER_ROOT=/dev/shm` as well to record browser traces/video in RAM;
the runner copies the completed reports into `.qa` and removes the RAM folder.

Nine cases cover songs at all five supported speeds (four uploads and one
YouTube Music URL), no song, retained mode after song removal, original-audio
mixing, and mixing over silent video.
The mix case uses distinct 220 Hz source and 660 Hz song tones and checks both
frequencies and their relative level. Assertions also cover persisted terminal
steps, browser playback, decoded audio amplitude and pitch, ZIP provenance, and
caption editing after
deleting the transient job directory and restarting the engine. Rerendering must
keep the stable library asset identity while publishing a new video blob and
updated caption sidecars.

API responses, job execution, FFmpeg rendering, playback and exports are real.
Transcript timestamps and external yt-dlp transport are controlled fixtures to
keep this gate deterministic. This gate does not measure speech recognition
accuracy or guarantee future YouTube availability. A separate live YouTube check
on 2026-10-19 successfully downloaded and fully decoded a 230,550-byte MP3 using
the production downloader.

Evidence, including failed-run traces and output MP4s/ZIPs, remains in the
worktree's ignored `.qa/s6-music-check-*` directories. The runner removes its own
containers, network and data volume afterward.

## Integration checks

The local execution and iOS status changes from main were preserved. Creation
checks run on the desktop and Android workspace; iOS deliberately exposes a
read-only status view and is covered by the separate iOS status acceptance test.

- Full Docker engine suite before the final visual-eligibility fix: 822 passed.
- Combined host engine suite after the final fixes: 739 passed, 99 skipped for missing
  host media tools or optional runtime dependencies. An isolated fontconfig file
  points at vendored fonts; system font configuration was not changed.
- Combined frontend suite: 358 passed; lint, provider checks, typecheck and build
  passed. The existing large-bundle build warning remains.
- Desktop/Android form acceptance: 10 passed. iPhone status acceptance: 1 passed,
  2 inapplicable project cases skipped.
- Final real-browser soundtrack gate: 4 passed in 2.8 minutes against an isolated
  API, worker, database, FFmpeg and browser. It covered upload at 1× and 1.5×,
  YouTube Music at 0.75×, no-song original audio, playback, restart recovery,
  caption rerender, and ZIP export. Evidence is in
  `.qa/s6-music-check-1792380020327-1806340/playwright`.
- Original-audio mix gate on 2026-10-20: 9 passed in 3.4 minutes in isolated
  containers. It verified all five song speeds, both source/song tones and their
  25% level ratio, preserving source audio after song removal, the silent-video
  mix case, restart recovery, caption rerender, and ZIP composition metadata.
  Evidence is in `.qa/s6-music-check-1792444906330-879872/playwright`.
- An additional real API/worker/FFmpeg check on the integrated backend used
  silent footage, Engine only and a matching `song.mp3` title at 1.5×. All 12
  steps completed, nine caption cues were saved, and decoded audio measured
  989 Hz against the expected 990 Hz. Its database was isolated under `/tmp`.
