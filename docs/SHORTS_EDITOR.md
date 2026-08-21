# Shorts Editor

Shorts Editor is a native S6_cut workflow. Select a video already registered in
Library, choose validated trim bounds and an output aspect ratio, then submit an
ordinary S6_cut clip job. Jobs use the existing queue, pause/retry/stop controls,
atomic publication transaction, immutable content-addressed blobs, and
server-signed preview/download URLs.

The workflow currently supports 9:16, 16:9, 1:1, and 4:5 output, optional script
captions through the ASS pipeline, configured/local/silent narration selection,
and authorised Library music with bounded volume. It deliberately does not
include social scheduling, Pexels downloading, scraping-based TTS, a second
media store, or a separate ShortsGenerator runtime.

All source media must be authorised and imported into S6_cut Library first.
ShortsGenerator was used only as a behavioural reference; no source code or
assets were copied. See `THIRD_PARTY_NOTICES.md` and
`third_party_provenance.json` for the pinned upstream revision.
