# Local music-lyric evaluation

`python -m engine.music_lyric_eval` runs the existing Music transcription profile
on local audio and compares it with a human-corrected reference. This is a
measurement tool; it does not change recognition in the application. Keep audio,
reference text and optional annotations outside Git. Its JSON report contains
content hashes, decoder diagnostics, word metrics, stage times and available
container memory measurements. The evaluator never needs a lyric service or
song catalog.

Run from the repository root using an environment with the engine dependencies
and a locally cached Faster-Whisper model:

```sh
python -m engine.music_lyric_eval \
  --audio /private/evaluation/recording.wav \
  --reference /private/evaluation/reference.txt \
  --track-id recording-001 \
  --data-path /path/to/local-data \
  --offline \
  --save-hypothesis /private/evaluation/recording-hypothesis.json \
  --instrumental-spans /private/evaluation/instrumentals.json \
  --timing-reference /private/evaluation/word-times.json \
  --report /private/evaluation/report.json
```

The annotations are optional. Instrumental and sung spans use JSON arrays of
`[start_seconds,end_seconds]` ranges. A recognized word in an instrumental range
counts as an insertion. `--sung-spans` requires `--timing-reference`; it measures
missed reference words in annotated vocal regions. The timing reference is a
JSON array with one word per record, for example
`[{"text":"example","start":12.3,"end":12.7}]`, and must align with the reference
text in order.

Timing MAE uses exact words matched by edit alignment. Repeated phrases and
missing words can make this correspondence ambiguous. References must match the
actual performance, including repetitions and truncation. A published lyric
page is a provisional comparison, not necessarily ground truth for a recording.

A saved hypothesis can be scored again with `--hypothesis
/private/evaluation/recording-hypothesis.json`; this avoids rerunning the model
when reviewing annotations or normalizer changes. The raw hypothesis includes
the production Music diagnostics and stays outside Git. `--offline` requires a
cached local model and disables Hugging Face downloads. The evaluator rejects
the synthetic transcript fixture and uses the same supervised decoder path and
direct 16 kHz PCM preparation as Music jobs. `--speed` applies the same bounded
pitch-and-tempo transformation as the audible soundtrack.

The report includes normalized WER and S/D/I counts, optional instrumental and
timing measurements, timing-match coverage, detected language, decoder options
and cache identity, audio/reference hashes, preprocessing/decoder time, process
RSS and the cgroup peak when available. Punctuation and case are ignored;
Unicode uses NFKC and curly apostrophes are canonicalized. Use non-sensitive
recording IDs. Alignment is bounded to one million dynamic-programming cells;
score shorter contiguous excerpts when a full recording exceeds that limit.

The cgroup memory figure reflects the containing cgroup's recorded peak, which
may include earlier work; use a fresh evaluation container for comparable memory
measurements. The evaluator itself does not establish that an ASR change is
better: use performance-matched human references, development/held-out splits,
and the gates in the [general implementation plan](general-music-lyric-accuracy-plan.md).
