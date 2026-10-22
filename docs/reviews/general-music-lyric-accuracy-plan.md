# General Music lyric recognition: diagnosis and implementation plan

Date: 2026-10-22. Source inspected: main at `4cc1c06`.
Worktree: `/home/linuxpc/git_branches/S6_CUT-general-music-lyric-accuracy`.
Branch: `plan/general-music-lyric-accuracy-20261022`.

## Objective and boundaries

Improve automatic recognition of sung words across recordings, particularly quiet,
breathy, sustained and slowed vocals, while bounding CPU, memory and latency.
There must be no artist/title matching, built-in song lyrics, song-specific prompts,
word-replacement dictionaries, or requirement to provide reference lyrics at runtime.
Evaluation audio and human references are development data held outside Git.

This plan supersedes the earlier follow-up priority of making a local song catalog
or reference-lyrics import the main solution. Those are separate optional products.
Recognition, vocal activity, timestamp quality and resource use are the priorities.
Scraping, online identification and LLM lyric rewriting are outside this plan.

This change contains a plan and generic documentation cleanup only. It does not
change production decoding, download models, restart services or rewrite saved media.
No new acoustic benchmark was run during this diagnosis. The prior published-text
comparison is provisional evidence, not a measured general accuracy baseline.

## Confirmed findings

| Priority | Finding and code evidence | Effect / confidence |
| --- | --- | --- |
| P0 | The live container's `transcription_options(..., profile="music")` lacks the three-window/0.8 language options present in `engine/media.py:163`. | Confirmed deployment gap. Users of the live service still have the older language-detection behavior despite the main-branch fix. |
| P1 | `media.transcribe` uses one full-mix Faster-Whisper pass. The live settings are multilingual `small`, CPU/int8, beam 5, one job worker. | Confirmed architecture; quiet consonants and sustained singing remain an acoustic recognition challenge. A stronger model or different segmentation is a candidate, not a proven improvement. |
| P1 | `media.transcribe` retains word confidence but drops segment `avg_logprob`, `compression_ratio`, `no_speech_prob`, fallback `temperature` and detected-language probability. | Confirmed. The engine cannot explain or selectively revisit suspicious sections using the existing model's available signals. |
| P1 | `selection._timed_words` and `media.caption_words_for_clip` exclude non-finite, negative or zero-length timing records. | Confirmed display/selection loss. A read-only survey of three distinct saved Music transcripts found 79/827, 20/570 and 17/105 invalid timing records: 116/1,502 total (7.7%). This measures timing validity, not word correctness. These are old saved results, not results of the latest source. |
| P1 | `prepare_music_track` changes both pitch and tempo with `asetrate` before the song reaches ASR. Recognition and rendering share the transformed timeline. | Correct synchronization today, but transcribing artificially pitch-shifted vocals may hurt recognition. The accuracy effect requires comparison; changing the render sound is unnecessary. |
| P2 | Selected soundtracks are re-encoded to MP3, then decoded again into 16 kHz mono PCM for ASR. Preparation runs before transcript-cache lookup, including resumed jobs. | Confirmed extra encoding/decoding and I/O. Lossy re-encoding is an avoidable signal change, but is not established as the main cause of word errors. |
| P2 | Music disables speech VAD; ordinary Whisper windowing and default prompt carry-over still apply. There is no singing-aware vocal activity stage. | Keeping speech VAD off protects quiet singing. Long instrumental gaps and carried text are plausible causes of hallucinations/omissions. Simply enabling speech VAD may cut away singing. |
| P2 | `transcription.supervise` calls the heartbeat around each 0.1-second queue poll; the heartbeat in `jobs._transcribe_with_stages` invokes `_save` each time. `_save` reads/writes SQLite job/project state and replaces `state.json`. | Confirmed unnecessary checkpoint traffic, approximately ten saves/second plus progress events during idle decode. Actual latency savings have not been profiled. |
| P2 | Each production transcription uses a spawned child; the in-memory `_whisper_models` dictionary disappears when it exits. | Model weights reload for each uncached job. The spawn boundary is necessary for cancellation/native-runtime safety. Keep it; first reuse a model within a job's retry session. |
| P2 | Cache options include profile/model name/language/beam/word timing/conditioning, but not all inherited decoding defaults or a resolved model revision/runtime identity. | A library default or mutable local model path can change behavior without an adequate cache identity. Cache lookup also trusts stored payloads without timing-quality validation. |
| P2 | Initial Music rendering creates caption cues without running the review endpoint's QA. Existing generic QA has speech-like duration/reading rules. | Initial problems can remain invisible. Music needs its own warning policy; low confidence is a review signal rather than proof of an error. |

The saved transcript survey contains eight words longer than eight seconds. Sustained
singing can legitimately do this; duration alone must not cause automatic deletion.
No lyrics, song names or artist names are hardcoded in `engine/`, `web/` or `scripts/`.
Specific recording references were in diagnostic documentation and evaluator examples;
the evaluator examples are now generic. Historical diagnostic reports remain evidence,
not runtime rules or training data.

## What the research supports

The pinned [Faster-Whisper 1.2.1 source](https://github.com/SYSTRAN/faster-whisper/blob/v1.2.1/faster_whisper/transcribe.py)
provides the diagnostic fields above and decoding controls. Its normal defaults
include previous-text conditioning and a temperature fallback sequence. Turning
conditioning off may reduce loops but lose context; changing both temperature and
conditioning at once prevents attributing the result. The previous combined local
experiment hallucinated text, so it is not a production recommendation.

A [2025 lyrics-transcription study](https://arxiv.org/html/2506.15514v1) found benefits
from vocal-activity boundaries derived from separated vocals and from retaining
longer sung context. Separation alone was not uniformly better. Its large-v2
results do not establish the best pipeline for this host or the small model.
A [2024 singing study](https://aclanthology.org/2024.nlp4musa-1.3/) also found that
singing style can matter more than accompaniment. Therefore evaluate segmentation
and vocal separation independently rather than assuming that clean vocals solve ASR.

[WhisperX](https://github.com/m-bain/whisperX) aligns supplied text to audio and
has language/dictionary limitations. It can be evaluated for timing after choosing
recognized words; it cannot establish that those words were sung correctly.

[CTranslate2's CPU guidance](https://opennmt.net/CTranslate2/performance.html)
favors int8 and avoiding oversubscribed worker/thread counts. This host has four
logical CPUs and about 11 GiB RAM; Compose budgets the engine four CPUs, 3 GiB RAM
and 4 GiB memory-plus-swap. The API, decoder and any preprocessing share that cap.
[Upstream CPU batching examples](https://github.com/SYSTRAN/faster-whisper#small-model-on-cpu)
show a memory/throughput trade-off, not a free speedup. Blindly increasing batch
size, workers, model size, or float precision is inappropriate here.

## Implementation sequence

### 0. Make the deployed baseline identifiable

- Add a non-sensitive build revision and effective Music profile/options version
  to health/diagnostic output. Mirror public additions in the frontend schema.
- Record the currently deployed build and config, wait for active work to finish,
  and roll out the already-merged engine and web language changes together from
  the main Compose project. Preserve the existing environment and data mount.
- Verify automatic detection beyond an instrumental intro and explicit language
  selection. Existing completed outputs stay unchanged; new jobs use the new cache.
- Acceptance: live and source revisions/options agree; deployment is reversible.

Files: `engine/app.py`, `engine/models.py`, `web/src/types.ts`, image build inputs,
existing deployment workflow. Do not expose host paths or environment secrets.

### 1. Add useful diagnostics and remove avoidable overhead

- Add optional private transcript diagnostics: effective decoding settings,
  language probability, segment quality fields, invalid-timing counts and reasons,
  audio/sample duration, stage elapsed time, runtime versions and model revision.
  Retain raw ASR words, including invalid timings, for diagnosis.
- Resolve the Music decoder's inherited defaults explicitly and include behavior
  changes, actual preprocessing and model identity in versioned Music cache keys.
  Read legacy payloads safely; mark unavailable diagnostics as unknown. Preserve
  Speech options/cache identity. Do not invalidate caches merely for a new UI label.
- Throttle only heartbeat persistence to roughly once per second. Poll cancellation
  promptly, retain truthful elapsed time, and force a final save at every stage,
  completion, error and cancellation. Preserve `_save`'s project/state-file coupling.
- Check transcript/prepared-audio identities before re-encoding. Reuse validated
  preprocessing artifacts on restart. Use derived job/cache files with atomic
  completion; never mutate content-addressed source blobs.
- Use explicit CPU thread/worker budgets and report cold model-load time separately.
  Keep spawned supervision; do not replace it with fork or share native state with
  the API process. Reuse a loaded model within one job's bounded refinement run.
- Acceptance: no text/timing changes from observability or persistence work; no
  checkpoint loss on restart; materially fewer heartbeat writes; cancellation
  remains responsive and cache hits avoid unnecessary audio preparation.

Files: `engine/media.py`, `engine/transcription.py`, `engine/jobs.py`,
`engine/config.py`, coordinated Compose/config documentation if settings are added.

### 2. Make the existing evaluator fit for comparing general improvements

- Use a private corpus with at least ten recordings spanning multiple singers:
  quiet/breathy, sustained slow singing, long intros, original and intentionally
  speed-shifted audio, live/repeated passages, clear vocals, another language, and
  an instrumental control. Include full recordings or enough contiguous context
  to exercise long-form behavior. Use authorized audio or appropriately licensed
  evaluation material; keep all recordings/reference text outside Git.
- Human references must match each performance, repetitions and truncation. Use
  anonymous IDs and separate development/held-out recordings; tune on development
  only. Never derive reference text from the model being evaluated.
- Split decoding from scoring. Save raw hypotheses/config privately so repeated
  scoring or normalization fixes do not rerun the expensive model.
- Run decoding through the same supervised production path. Fail if
  `S6_TEST_TRANSCRIPT_JSON` is set; require cached models/offline mode for an
  offline experiment, rather than silently allowing a model download.
- Report per-recording and aggregate S/D/I, WER, instrumental insertions, omission
  of annotated sung spans, onset/end error and timing-match coverage. Include CER
  where word splitting is unsuitable. Report ambiguity from repeated-word matching
  and unmatched words; timing MAE on exact matches alone can look deceptively good.
- Validate annotations before decoding. Persist their hashes and the normalizer
  version. Bound input size or replace quadratic Python edit tables with a bounded
  implementation for long recordings. Fix punctuation-only and apostrophe edge cases.
- Measure full pipeline wall time, CPU and peak aggregate container memory, not
  just the evaluator process RSS. Capture API/decoder/preprocessing coexistence.
- Acceptance: reproducible private hypotheses and complete reports on development
  and held-out recordings. No specific track is required or named in runtime code.

Files: `engine/music_lyric_eval.py`, private manifest/report tooling and documentation.

### 3. Compare recognition changes one at a time

Run the same corpus through this ordered matrix; promote only measured improvements:

1. Current small/int8/beam-5 baseline. For uncertain automatic language detection,
   compare a capped set of vocal-bearing windows distributed across the recording
   instead of relying only on its first 90 seconds; retain explicit language
   override and flag unresolved or mixed-language cases. Compare beam 3 for
   equivalent accuracy with less CPU, and small.en only when English is explicitly selected. Compare medium
   as an opt-in candidate under the total memory cap. A larger default is not assumed.
2. Produce recognition PCM directly from the original selected audio, avoiding
   the intermediate lossy MP3. Retain 16 kHz mono as the decoder contract. Test
   stereo cancellation and channel imbalance; use a better channel/stem only with
   evidence. Do not add blanket denoising, compression or aggressive high-pass filters.
3. For a known soundtrack speed adjustment, compare recognition at original pitch/
   tempo with recognition of the audible transformed track. Map timing by exact
   sample positions, speed, offset, trim and loop period. Never guess a source speed
   from a song title or try to undo an unknown already-slowed input. Preserve the
   rendered soundtrack's audible transformation. Cache each route separately.
4. Compare bounded singing-aware vocal activity segmentation against native
   long-form decoding. Preserve roughly 20-30 seconds of context where possible,
   pad boundaries and keep all offsets. Do not use short isolated-word crops.
   A vocal stem may supply boundaries while ASR still hears the original mix.
5. Compare a locally cached vocal separator plus ASR with the mix baseline. Pin
   implementation/model hashes and inspect maintenance/licence/dependency cost.
   [Demucs](https://github.com/facebookresearch/demucs) and the
   [research implementation](https://github.com/jaza-syed/mss-alt) have archived upstream repositories;
   do not add an unpinned Git dependency or assume research code is production-ready.
6. Separately compare previous-text conditioning, temperature fallback and
   hallucination-silence settings. Preserve real repeated choruses. Never apply
   a global no-repeat rule or discard a quiet phrase solely on no-speech probability.

Initial promotion targets (proposed, not achieved): at least 20% relative reduction
in held-out slow-vocal WER, improved median per-recording WER, no control recording
regressing by more than two percentage points, and no increase in instrumental
insertions or pathological repetition. Target aggregate peak memory at or below
2.5 GiB inside the 3 GiB engine budget, leaving operating headroom; the exact safety
margin must be confirmed with the API running. Target standard-path median and p95
latency no more than 1.5 times baseline. Slower wins may be offered separately with
measured latency. If no candidate meets these gates, keep the existing default.

Files: `engine/media.py`, `engine/transcription.py`, `engine/jobs.py`,
`engine/config.py`; isolate optional heavier preparation dependencies from the API.

### 4. Add bounded refinement only where the evidence supports it

- Mark questionable spans using combined segment diagnostics, invalid timing,
  instrumental hallucination signals, and vocal activity with missing text. Word
  confidence alone cannot identify omissions or guarantee a word is correct.
- Retry only those spans with a winning route from step 3, keeping phrase context
  and at most one refinement pass. Start with at most two windows of 30 seconds;
  account for padding/overlap and cap the total retried fraction for long songs.
- Preserve raw and candidate results. Use a selection policy evaluated on held-out
  data, not whichever candidate is longest or has the highest raw confidence from
  a different model. Keep the original or flag review when the choice is uncertain.
- Merge by audio interval and boundary alignment. Preserve actual repeated
  performances and exact time offsets. Cache retries by audio interval/config;
  restart does not retranscribe completed spans.
- Acceptance: fewer word errors on held-out recordings, bounded extra work, no
  duplicated boundary words, full cancellation/restart behavior. Unflagged passages
  and speech jobs retain their existing results.

Files: a focused Music refinement module plus `engine/transcription.py`,
`engine/jobs.py`, `engine/media.py` and cache identity helpers.

### 5. Repair timing and expose remaining uncertainty

- Preserve invalid-timing words in raw results; flag them before selection/rendering.
  Evaluate local acoustic alignment for affected phrases after wording is selected.
  Do not invent uniformly spaced timings or stretch a word across an instrumental.
- Distinguish aligned, unaligned and suspected-recognition-error states. Preserve
  raw ASR if alignment fails and make incomplete coverage visible. An acoustic
  aligner must be tested on sustained vowels, repeats, backing vocals and reverb.
- Populate initial Music caption review warnings using Music-specific criteria,
  including lost/unaligned words. Avoid applying speech reading-speed limits blindly.
- Keep manual corrections and revisions authoritative through retry, rerender and
  export. Mirror any public fields in engine models, Zod schemas and consumers.
- Acceptance: improved measured boundaries and word coverage without changing the
  recognized text to fit an aligner; invalid alignment is never silently presented
  as accurate. Sources, completed published blobs and Library links remain immutable.

Files: `engine/selection.py`, `engine/captions.py`, `engine/media.py`,
`engine/jobs.py`, `engine/models.py`, `web/src/types.ts`, caption review consumers.

## Validation and rollout gates for implementation

Use contract tests for option/cache isolation, invalid timing, repeated phrases,
known speed/trim/loop mappings, cancellation, worker death, restart, checkpoint
cadence, review revisions and SRT/VTT/export consistency. Synthetic tokens can
validate these contracts but cannot establish sung-audio accuracy. Use the private
real-audio corpus for every claimed recognition/timing improvement.

Run relevant focused engine tests for each implementation increment; run the
required engine/frontend gates before merging changes that affect those paths.
This planning-only change requires documentation/diff review, not a fresh media
benchmark or full application test suite. Keep one implementation increment per
isolated branch under `/home/linuxpc/git_branches` and merge only complete increments.

Deploy measured changes with saved revision/config and separate Music options/cache
versions. Roll back by selecting the previous profile/build; never rewrite existing
published media. Rollout, acoustic experiments and model downloads are future work,
not actions taken by this diagnosis.
