# Deterministic Music reference-theme rendering evidence

`render-music-reference-fixture.py` calls the production `engine.media.write_music_ass` writer and renders through FFmpeg/libass in the isolated production engine image. It emits one PNG and ASS per new theme plus a separate standalone-serif diagnostic under an artifact directory. The samples contain the supplied lyric text:

- White sans: `i’ve / forgotten / about`
- Yellow sans: `do you think / that i’ve forgotten / about`
- White serif: `do you think / that i’ve forgotten / about`
- Standalone glyph diagnostic: `you was hardly talking / That’s when I knew that`

Example (after building the isolated engine image):

```sh
mkdir -p test-artifacts/music-reference-comparison
chmod 777 test-artifacts/music-reference-comparison
docker run --rm --network none -e PYTHONPATH=/workspace \
  -v "$PWD:/workspace:ro" \
  -v "$PWD/test-artifacts/music-reference-comparison:/out:rw" \
  -w /workspace --entrypoint python \
  s6-cut-engine:music-reference-lyrics-20261008 \
  scripts/qa/render-music-reference-fixture.py /out
```

These deterministic words/timestamps are **rendering evidence only—not Whisper or sung-vocal transcription evidence**. The standalone image is a separate glyph/outline comparison only; it does not add a fourth preset or assert that the standalone reference and phone-panel serif use the same typeface. Do not compare whole-frame pixels or unrelated footage backgrounds. For final reference comparison, use matched-scale crops of only the lyric/text regions; image output and reports live in ignored `test-artifacts/`.

A separate real-vocal acceptance remains opt-in and requires the authorized `Scarborough_Fair.ogg`, attribution/license, and cached local Whisper model; fixture transcripts are forbidden in that real-transcription journey.
