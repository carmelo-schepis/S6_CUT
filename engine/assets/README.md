# Bundled Subscribe animation

`subscribe-click.mov` is an original S6_CUT animation generated locally for this
project. It was authored as vector draw operations and encoded with FFmpeg's
QTRLE codec in ARGB, at 1536×540 / 30 fps / four seconds. The surrounding pixels
are transparent; the visible button spans 1026 px (66.8% of the canvas width).
It contains a moving pointer, one click/spark, a brief “SUBSCRIBED” state, then
fades away. It has no sound and contains no third-party artwork, fonts embedded
in the file, or downloaded media. No attribution is required. The renderer
sizes from the visible-button width, keeps the transparent source aspect ratio,
and composites the asset offline; it never packages or re-applies the animation
during export.

The source artwork is generated with FFmpeg drawbox/drawtext filters using the
bundled system DejaVu Sans font family. `generate_subscribe_animation.sh`
recreates the checked-in file. The project does not rely on an external download
or a third-party animation licence.
