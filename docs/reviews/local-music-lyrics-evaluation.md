# Local music-lyric evaluation

`python -m engine.music_lyric_eval` runs the existing Music transcription profile
on a local audio file and compares it with a human-corrected reference. It needs
no network service or lyric site. Keep the audio, reference, and optional
annotations outside Git; the JSON report contains content hashes and aggregate
metrics only.

Example (run from the repository root, with the local Faster-Whisper model cache
available):

```sh
.venv/bin/python -m engine.music_lyric_eval \
  --audio /path/to/authorized-cas-recording.wav \
  --reference /private/path/cas-bubblegum-reviewed.txt \
  --track-id cas-bubblegum-v1 \
  --data-path /home/linuxpc/Git_projects/S6_CUT/data \
  --instrumental-spans /private/path/cas-bubblegum-instrumentals.json \
  --timing-reference /private/path/cas-bubblegum-word-times.json \
  --report /private/path/cas-bubblegum-report.json
```

`--instrumental-spans` is a JSON array of `[start_seconds,end_seconds]` ranges.
Words whose midpoint lands in an annotated range are counted as likely
instrumental insertions. `--timing-reference` is a JSON array with one word per
record, for example `[{"text":"example","start":12.3,"end":12.7}]`. Timing
MAE is computed only for exact words matched by the reference/hypothesis edit
alignment. Mark each recording/version against its actual performance; studio
lyrics alone are not ground truth for a live or shortened performance.

The report includes normalized word-error rate and substitution/deletion/
insertion counts, annotated instrumental insertions, optional word-boundary
MAE, detected language, audio/reference SHA-256, transcription runtime, and
process peak RSS. Punctuation and case are ignored; Unicode text is normalized
with NFKC. It does not print or write either lyric text. Supply a stable,
non-sensitive fixture ID via `--track-id`; do not put lyric text in IDs.

There is no human-reviewed Bubblegum reference in the saved jobs, so this
command cannot currently produce a meaningful accuracy score for that recording.
The previous transcript and audio can be evaluated once an authorized listener
has corrected a private reference against that same recording.
