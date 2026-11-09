#!/usr/bin/env sh
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(CDPATH= cd -- "$here/../.." && pwd)
node "$here/render_subscribe_animation.mjs" "$here/subscribe-click.mov" "${FFMPEG_BIN:-ffmpeg}" "$root"
