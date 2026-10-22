# Local music-lyric evaluation

`python -m engine.music_lyric_eval` runs the existing Music transcription profile
on local audio and compares it with a human-corrected reference. This is a
measurement tool; it does not change recognition in the application. Keep audio,
reference text and optional annotations outside Git. Its JSON report contains
content hashes and aggregate metrics.

Run from the repository root using an environment with the engine dependencies
and a locally cached Faster-Whisper model:

```sh
python -m engine.music_lyric_eval \
  --audio /private/evaluation/recording.wav \
  --reference /private/evaluation/reference.txt \
  --track-id recording-001 \
  --data-path /path/to/local-data \
  --instrumental-spans /private/evaluation/instrumentals.json \
  --timing-reference /private/evaluation/word-times.json \
  --report /private/evaluation/report.json
```

The last two input annotations are optional. Instrumental spans use a JSON array
of `[start_seconds,end_seconds]` ranges. A recognized word whose midpoint falls
in a range is counted as an instrumental insertion. The timing reference is a
JSON array with one word per record, for example
`[{"text":"example","start":12.3,"end":12.7}]`.

Timing MAE uses exact words matched by edit alignment. Repeated phrases and
missing words can make this correspondence ambiguous. References must match the
actual performance, including repetitions and truncation. A published lyric
page is a provisional comparison, not necessarily ground truth for a recording.

The report includes normalized WER and S/D/I counts, optional instrumental and
timing measurements, detected language, audio/reference hashes, decoder runtime
and process peak RSS. Punctuation and case are ignored; Unicode uses NFKC and
curly apostrophes are canonicalized. Use non-sensitive recording IDs.

Current limits: this command calls the decoder directly, does not enforce cached
models/offline execution, and measures its own process rather than the API and
all processing stages together. It must not be run with the synthetic-transcript
fixture environment enabled. The [general implementation plan](general-music-lyric-accuracy-plan.md)
addresses these limits before using its reports as production promotion gates.
