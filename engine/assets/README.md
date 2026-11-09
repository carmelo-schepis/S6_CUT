# Bundled Subscribe animation

`subscribe-click.mov` is original S6_CUT artwork, authored as SVG paths and
encoded as a silent 1536×540, 30 fps, four-second QTRLE/ARGB video with straight
alpha. Its nominal button width is 1026 px. It has a rounded gradient face,
soft contact shadow, vector pointer, press/ripple response, and a warm neutral
Subscribed confirmation with a drawn checkmark and briefly moving bell.

`render_subscribe_animation.mjs` samples 120 explicit timestamps. It does not use
a browser animation clock, random values, external resources, or network fonts.
The first and last frames are fully transparent. Across all frames the nonzero
alpha bounds are x=245…1290 and y=78…423 (exclusive right/bottom: 1291,424).
At alpha >24 they are (255,80)…(1281,418). These fit the existing conservative
y=75…437 reservation, so renderer placement and music-banner spacing are retained.

Regenerate from the repository root:

```sh
npm ci
npx playwright install chromium
./engine/assets/generate_subscribe_animation.sh
```

Requires Node, the repository's Playwright installation, Chromium, and FFmpeg
with QTRLE support. `FFMPEG_BIN=/path/to/ffmpeg` accepts an executable path
(including a wrapper script), not a shell command. `TMPDIR` may select a writable
temporary directory with sufficient space for Chromium and PNG frames. On hosts
where Chromium cannot create a profile under `/tmp`, use a directory on disk:

```sh
mkdir -p "$HOME/.cache/s6-animation"
TMPDIR="$HOME/.cache/s6-animation" ./engine/assets/generate_subscribe_animation.sh
```

Intermediate frames and browser resources are cleaned up on success or failure.
The existing MOV is replaced only after encoding succeeds. Generation is a
development step; the application needs neither Node nor Chromium to composite it.
The renderer uses the same local MOV for every output and export packages the
finished video without adding the animation again. Existing outputs remain intact.

Typography uses the bundled Montserrat Bold font at
`engine/fonts/montserrat/Montserrat-Bold.ttf`, under the SIL Open Font License
beside it (`OFL.txt`). Only rasterized glyphs are included in the MOV. Shapes,
cursor, checkmark and bell are original paths; no downloaded artwork is used.
