# Shorts Editor

Shorts Editor is a native S6_cut workflow. Choose a Local file, authorised public
YouTube URL, or video already registered in Library, then set validated trim bounds
and an output aspect ratio. Local and YouTube sources are streamed into confined
staging before they become immutable project sources; Library sources remain
backward-compatible with the JSON endpoint. The form accepts a blank end to use the
source remainder. Jobs use the existing queue, pause/retry/stop controls,
atomic publication transaction, immutable content-addressed blobs, and
server-signed preview/download URLs.

The workflow currently supports 9:16, 16:9, 1:1, and 4:5 output, optional burned
captions through the ASS pipeline, a closed set of safe Original/Warm/Monochrome
looks, output mute and bounded 0–200% volume, and the existing subscribe animation.
These choices are snapshotted into each queued job; they never alter the immutable
source. Filter choices are enumerated server-side (no user-authored FFmpeg filter
strings are accepted).
Completed Shorts Editor outputs can be selected from the Clips panel or dragged into
the Editor; both paths resolve the clip's server-published Library asset and its
signed preview URL. Loaded short trims are relative to that generated video (from
zero through its duration), not to the original source timestamps. The Library
dropdown remains available for switching sources. Loading an output does not queue
another job or modify its immutable media. Generated video may already contain
burned-in captions, which cannot be removed by changing the later job's subtitle
setting.

It deliberately does not include social scheduling, Pexels downloading,
scraping-based TTS, a second media store, or a separate ShortsGenerator runtime.

All source media must be owned or authorised. YouTube acquisition is HTTPS-only,
public-host validated, and never bypasses DRM or access controls. Shorts jobs use
the existing queue and durable publication pipeline.

ShortsGenerator was used only as a behavioural reference; no source code or
assets were copied. See `THIRD_PARTY_NOTICES.md` and
`third_party_provenance.json` for the pinned upstream revision.
