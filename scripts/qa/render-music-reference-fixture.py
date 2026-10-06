"""Render deterministic Music theme samples using the production ASS writer.

Run inside the production engine image; output is rendering evidence, not
Whisper/transcription evidence.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from engine.media import write_music_ass

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
phrases = {
    "reference_white_sans": ["i’ve", "forgotten", "about"],
    "reference_yellow_sans": ["do", "you", "think", "that", "i’ve", "forgotten", "about"],
    "reference_white_serif": ["do", "you", "think", "that", "i’ve", "forgotten", "about"],
}
for theme, tokens in phrases.items():
    words = [{"text": text, "start": 0.2 + index * 0.24, "end": 0.4 + index * 0.24} for index, text in enumerate(tokens)]
    ass_path = out / f"{theme}.ass"
    write_music_ass(ass_path, words, offset=0, duration=2.0, width=1080, height=1920, subtitle_theme=theme)
    frame_path = out / f"{theme}.png"
    sample_time = "0.5" if theme == "reference_white_sans" else "1.0"
    subprocess.run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
        "color=c=0x303030:s=1080x1920:r=30:d=2", "-ss", sample_time, "-vf", f"subtitles={ass_path}",
        "-frames:v", "1", str(frame_path),
    ], check=True)

# Standalone serif reference is a different two-line treatment. This diagnostic
# intentionally compares outlines only; it is not an additional preset or the
# phone-serif layout. It uses the selected phone-serif font and real libass.
standalone = out / "standalone-serif-diagnostic.ass"
standalone.write_text("""[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Caption,Bodoni Moda,125,&H00FFFFFF,&H00FFFFFF,&H99000000,&H00000000,0,0,0,0,90,100,0,0,1,1,0,5,0,0,0,1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
Dialogue: 10,0:00:00.00,0:00:02.00,Caption,,0,0,0,,{\\an5\\pos(540,1120)}you was hardly talking\\N{\\an5\\pos(540,1215)}That’s when I knew that
""", encoding="utf-8")
subprocess.run([
    "ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
    "color=c=0x303030:s=1080x1920:r=30:d=2", "-ss", "1.0", "-vf", f"subtitles={standalone}",
    "-frames:v", "1", str(out / "standalone-serif-diagnostic.png"),
], check=True)
