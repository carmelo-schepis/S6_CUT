# Music soundtrack verification

The optional song replaces the video's audio in Music mode. Lyrics use that
song's adjusted timeline. Short songs loop across the footage, and each clip
uses its position on that continuous timeline. Leaving the song blank uses the
video's original audio. Speed changes pitch and tempo together.

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

Four cases cover standard/faster uploaded songs, a slower YouTube Music URL, and
no optional song. Assertions cover persisted terminal steps, browser playback,
decoded audio amplitude and pitch, ZIP provenance, and caption editing after
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
