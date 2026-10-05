#!/usr/bin/env sh
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ffmpeg_bin=${FFMPEG_BIN:-ffmpeg}
"$ffmpeg_bin" -hide_banner -loglevel error -y \
  -f lavfi -i 'color=c=black@0.0:s=1536x540:r=30:d=4,format=rgba' \
  -vf "drawbox=x=255:y=75:w=1026:h=252:color=0xE53935@0.96:t=fill:enable='between(t,0.30,3.35)',drawbox=x=255:y=75:w=1026:h=252:color=0x555555@0.96:t=fill:enable='between(t,1.15,3.35)',drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='SUBSCRIBE':fontcolor=white:fontsize=90:x=390:y=153:enable='between(t,0.30,1.14)',drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='SUBSCRIBED':fontcolor=white:fontsize=78:x=393:y=159:enable='between(t,1.15,3.35)',drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='➤':fontcolor=white:bordercolor=black:borderw=6:fontsize=120:x='1200-318*min(1,max(0,(t-0.35)/0.72))':y='378-201*min(1,max(0,(t-0.35)/0.72))':enable='between(t,0.35,1.10)',drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='✦':fontcolor=white:fontsize=84:x=942:y=78:enable='between(t,1.08,1.32)',geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(between(T,0.30,3.35)*between(X,255,1280)*between(Y,75,324),245,alpha(X,Y))',fade=t=out:st=3.35:d=0.55:alpha=1" \
  -an -c:v qtrle -pix_fmt argb "$here/subscribe-click.mov"
