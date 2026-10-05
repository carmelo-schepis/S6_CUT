# Bundled Subscribe animation

`subscribe-click.mov` is an original S6_CUT animation generated locally for this
project. It was authored as vector draw operations and encoded with FFmpeg's
QTRLE codec in ARGB, at 512×180 / 30 fps / four seconds. The surrounding pixels
are transparent. It contains a moving pointer, one click/spark, a brief
“SUBSCRIBED” state, then fades away. It has no sound and contains no third-party
artwork, fonts embedded in the file, or downloaded media. No attribution is
required. The renderer uses this checked-in file offline and composites it into
the video; it never packages or re-applies the animation during export.

The source artwork is generated with FFmpeg drawbox/drawtext filters using the
bundled system DejaVu Sans font family. `generate_subscribe_animation.sh`
recreates the checked-in file. The project does not rely on an external download
or a third-party animation licence.
