#!/bin/sh
# Builds a synthetic, fully-owned acceptance fixture for S6_cut content
# authenticity verification. Runs inside the S6_cut engine image, which carries
# ffmpeg 5.1 + espeak-ng + DejaVu fonts. No copyrighted or personal material is
# used: every frame and every sample is generated from lavfi sources and
# offline speech synthesis.
set -eu

W=/work
FONT=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf
MONO=/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf
SEC=19          # seconds per section
FPS=30
TOTAL=76        # 4 x 19

rm -rf "$W/parts"
mkdir -p "$W/parts"

# --- Section definitions -----------------------------------------------------
# label | background colour | accent colour | cue frequency | narration
# Narration deliberately avoids the tokens the deterministic planner treats as
# credit-roll markers (end, credit(s), cast, starring, directed, written,
# copyright, produced, fin) so real candidates are not rejected as title cards.
set_section() {
  case "$1" in
    1) LABEL="SECTION A - OPENING";     BG=0x123A6B; FG=0x6FA8FF; CUE=440
       SPEECH="Welcome to section A, the opening of this synthetic verification video. Here is why local video processing matters so much for privacy. This first step explains how the deterministic engine handles your media." ;;
    2) LABEL="SECTION B - EXPLANATION"; BG=0x14532D; FG=0x74E39B; CUE=554
       SPEECH="This is section B, the explanation. The engine reads timed words from local speech recognition. Because every step runs on your own machine, no audio ever leaves the building." ;;
    3) LABEL="SECTION C - EXAMPLE";     BG=0x6B1A1A; FG=0xFF9A8A; CUE=659
       SPEECH="Now section C shows a practical example. Imagine a long recording that needs several short vertical clips. The best method is a deterministic planner that always picks the same moments." ;;
    4) LABEL="SECTION D - CONCLUSION";  BG=0x3F1A6B; FG=0xC79AFF; CUE=880
       SPEECH="Section D is the conclusion of this verification video. We learned that local rendering keeps complete control of the media. That is the truth about private video tooling." ;;
  esac
}

# --- 1. Per-section video ----------------------------------------------------
# Continuous motion comes from four independent moving elements so that
# frame-to-frame difference is unambiguous everywhere in the timeline.
#
# The moving elements are composited with `overlay`, NOT `drawbox`: in drawbox
# the expression variable `t` is the border *thickness*, not the timestamp, so
# a `drawbox` whose x depends on `t` renders at a fixed position (and with
# t=fill it resolves to the fill sentinel). `overlay` and `drawtext` both
# expose `t` as presentation time, so motion and the burned-in clock agree.
for i in 1 2 3 4; do
  set_section "$i"
  ffmpeg -y -v error \
    -f lavfi -i "color=c=${BG}:s=1280x720:r=${FPS}:d=${SEC}" \
    -f lavfi -i "color=c=${FG}:s=150x592:r=${FPS}:d=${SEC}" \
    -f lavfi -i "color=c=${FG}:s=220x120:r=${FPS}:d=${SEC}" \
    -f lavfi -i "color=c=white:s=240x70:r=${FPS}:d=${SEC}" \
    -f lavfi -i "color=c=${FG}:s=1280x30:r=${FPS}:d=${SEC}" \
    -filter_complex "\
[0:v]drawbox=x=0:y=0:w=1280:h=96:color=${FG}@0.28:t=fill,\
drawtext=fontfile=${FONT}:text='${LABEL}':fontcolor=white:fontsize=58:x=(w-text_w)/2:y=22,\
drawtext=fontfile=${FONT}:text='S6 CUT SYNTHETIC TEST SOURCE':fontcolor=white@0.55:fontsize=30:x=(w-text_w)/2:y=560,\
drawtext=fontfile=${MONO}:text='%{eif\\:trunc(t*${FPS})\\:d\\:5}':fontcolor=white@0.9:fontsize=44:x=40:y=600[base];\
[base][1:v]overlay=x='(W-w)*(0.5+0.5*sin(2*PI*t/4))':y=96[o1];\
[o1][2:v]overlay=x='(W-w)*(0.5+0.5*sin(2*PI*t/5))':y=250[o2];\
[o2][3:v]overlay=x=520:y='170+380*(0.5+0.5*sin(2*PI*t/3.1))'[o3];\
[o3][4:v]overlay=x='-W+W*t/${SEC}':y=690[out]" \
    -map "[out]" -t ${SEC} \
    -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -an \
    "$W/parts/v${i}.mp4"

  # --- Per-section audio: boundary cue, then speech, then a short pause ------
  espeak-ng -v en-us -s 150 -p 45 -a 150 -w "$W/parts/speech${i}.wav" "$SPEECH"
  ffmpeg -y -v error -f lavfi -i "sine=frequency=${CUE}:duration=0.45:sample_rate=22050" \
    -af "volume=0.5,afade=t=out:st=0.35:d=0.1" -c:a pcm_s16le -ac 1 "$W/parts/cue${i}.wav"
  # Concatenate cue + speech, then pad/trim to exactly the section length so the
  # audio timeline stays locked to the video timeline.
  ffmpeg -y -v error -i "$W/parts/cue${i}.wav" -i "$W/parts/speech${i}.wav" \
    -filter_complex "[0:a]aresample=22050[a0];[1:a]aresample=22050[a1];[a0][a1]concat=n=2:v=0:a=1,apad,atrim=0:${SEC},asetpts=N/SR/TB[out]" \
    -map "[out]" -c:a pcm_s16le -ac 1 -ar 22050 "$W/parts/a${i}.wav"
done

# --- 2. Concatenate sections -------------------------------------------------
: > "$W/parts/vlist.txt"
: > "$W/parts/alist.txt"
for i in 1 2 3 4; do
  echo "file 'v${i}.mp4'" >> "$W/parts/vlist.txt"
  echo "file 'a${i}.wav'" >> "$W/parts/alist.txt"
done
ffmpeg -y -v error -f concat -safe 0 -i "$W/parts/vlist.txt" -c copy "$W/parts/video_all.mp4"
ffmpeg -y -v error -f concat -safe 0 -i "$W/parts/alist.txt" -c copy "$W/parts/audio_all.wav"

# --- 3. Final mux: burn the continuous global timestamp over the whole file --
# The timestamp is applied after concatenation so it counts monotonically
# across the entire source, which is what proves which source range an output
# clip was taken from.
ffmpeg -y -v error -i "$W/parts/video_all.mp4" -i "$W/parts/audio_all.wav" \
  -vf "\
drawbox=x=24:y=112:w=430:h=78:color=black@0.62:t=fill,\
drawtext=fontfile=${MONO}:text='T\\=%{pts\\:hms}':fontcolor=0xFFE08A:fontsize=54:x=40:y=124" \
  -map 0:v:0 -map 1:a:0 \
  -c:v libx264 -preset medium -crf 19 -pix_fmt yuv420p -r ${FPS} \
  -af "alimiter=limit=0.89,aresample=48000" -c:a aac -b:a 128k -ar 48000 -ac 1 \
  -t ${TOTAL} -movflags +faststart \
  "$W/s6cut-authenticity-source.mp4"

rm -rf "$W/parts"
echo "fixture built"
