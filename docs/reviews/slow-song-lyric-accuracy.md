# Slow-song lyric accuracy: diagnosis and local-first plan

Date: 2026-10-22. Target: the tested music source, especially quiet/slow vocals.

## Finding and immediate fix

There are two separate problems: recognizing the words and aligning their timing.
Changing ASS styling or asking an LLM to rewrite captions cannot establish what
the singer actually sang.

An isolated test of a slow-vocal music source exposed a concrete recognition
failure:

- The first vocal starts around 32.6 seconds, after Whisper's usual first
  30-second language-detection window.
- The saved transcript reports `language="si"` (Sinhala), although the song is in
  English. Of 105 returned word records, 33 contain Sinhala characters. This is
  one confirmed failure, not a measurement of the user's estimated 10% error rate.
- Isolated language detection on 0–30 seconds picks Sinhala at probability
  0.368. Windows at 30–60 and 60–90 seconds pick English at 0.880 and 0.843.
- The API previously offered no way to select a lyrics language, although the
  worker, supervisor, and cache already supported a private `transcription_language`.
- A separate test source already reports English, so this language-detection fix addresses this
  failure mode but does not explain all transcription errors.

The immediate implementation makes Music consider up to three initial windows
with a language-detection confidence threshold of 0.8. Faster-Whisper can stop
early when a window exceeds that threshold; this is not a guarantee that all
three windows are examined. The default remains automatic and multilingual.
The Music form now also offers **Lyrics language → English**, which bypasses
guessing for the tested source songs. Omit `music_lyrics_language` for automatic detection;
the multipart API accepts the pinned tokenizer's supported language codes.

Detection options participate in the Music transcript cache identity, so a new
job cannot reuse the old intro-only transcript. Explicit language choices also
separate cache entries. Speech decoding and its cache identity are unchanged.
Model/beam defaults remain `small`/5, speech VAD stays off for Music, and word
timestamps stay on. Completed videos are not rewritten by changing the decoder;
create a new job or manually review/rerender their captions.

Deployment requires rebuilding both engine and web together, then verifying the deployed behavior with a new Music job. Use the documented deployment workflow and its configured data root. No database migration or new model download is
required for this fix.

## Real-audio evidence and limits

Source: private local audio derived from the tested music source. Its fingerprint and raw audio
are omitted from this public report.
Raw transcripts and screenshots are private, ignored local artifacts; they are not committed.

An isolated run of the **modified production `media.transcribe` function**, using
the production engine image with cached `small`, CPU/int8, beam 5 and automatic
language, selected **English** and returned 118 words in 11 segments. The run
took 51.39 seconds with peak process RSS 896,628 KiB (about 876 MiB). The container
had a 3 GiB limit, four CPU quota, read-only source/model mounts and **no network**.
Concurrent validation was running, so elapsed time is diagnostic, not a speed
benchmark. No transcription fixture or provider supplied the words.

This fixes the wrong-language reproduction. It does **not** establish a word-error
rate or perfect lyrics: no human-reviewed reference was available. There are
still nine zero-duration word records (previously 17), and residual word mistakes
and repeated phrases remain possible. Lower zero-duration counts alone do not
prove better timing. A human reference is required before claiming the reported
10% error rate has been reduced to a particular number.

An explicit-English experiment with `condition_on_previous_text=False` and
`temperature=0` invented a long spoken passage during the instrumental intro.
That combined tweak was rejected. It does not isolate which parameter caused
the regression, and neither setting is changed by this fix.

## Recommended next work, in order

### 1. Establish a small, honest accuracy benchmark

Use three to five authorized source recordings: the slow-vocal example, two
other slow studio tracks, a live performance and one slowed version. Keep full
songs or enough context to include instrumental gaps and repeated choruses.
Store media and reference lyrics outside Git; commit only fixture IDs, hashes,
evaluation code and aggregate metrics.

Have a listener correct the lyrics against each actual recording, preserving
repeats, ad-libs and omitted verses. A published studio lyric is not automatically
the ground truth for a live or shortened performance. Measure normalized word
error rate with separate substitution/deletion/insertion counts, invented words
in known instrumental spans, and manually marked word onsets/ends. Specify
punctuation/case normalization before comparing variants. Treat Whisper confidence
as a review signal, not a calibrated correctness score.

Acceptance: the slow-vocal language regression stays fixed; each variant reports
per-track results, maximum RSS and runtime, with no hidden substitutions of
synthetic speech or renderer-only fixtures for sung-audio evidence.

### 2. Add local reference lyrics and real word alignment

This is the strongest next step for users who want exact wording. Add optional
paste/upload of locally held TXT/LRC lyrics and a small reusable local song
catalog. Retain origin, content hash, recording/version and user confirmation.
Use selected lyrics as the text reference, then align the sung words to the
**actual audible timeline**. Keep reference-backed and raw ASR results available
for review. Do not silently replace the whole transcript based on a fuzzy title.

Evaluate a local aligner such as WhisperX's alignment component against the
existing Faster-Whisper timing. This candidate has not been verified on this
source. Speech phoneme alignment must be tested on sustained vowels, reverb,
missing verses and repeats. Avoid introducing a speech VAD stage into Music that
cuts away singing. Reject or flag unaligned phrases; never spread all words
uniformly across a song, stretch a last word over an instrumental, or claim
line-level LRC timestamps are word timings.

Keep transcription/alignment in supervised child processes with real progress,
cancellation, bounded memory and deterministic cache keys incorporating lyric
hash, alignment model/version, language and audio identity. Current Music uses
the speed-adjusted soundtrack for both transcription and rendering; preserve
that shared timeline, including speed changes, trim offsets and source duration.

Acceptance: corrected reference words and acoustic timings survive restart,
retry, caption editing, rerender and export; invalid alignment remains visible;
tests cover chorus repetition and a shortened/live performance. Sources and
published blobs stay immutable. This stage needs end-to-end engine/model and
frontend schema changes wherever public fields are introduced.

### 3. Benchmark local acoustic improvements

Compare `small` with `medium` or another explicitly selected, cached local model
using the benchmark above. The host has about 12 GiB RAM and no exposed NVIDIA
GPU; production limits the engine to 3 GiB plus swap and four CPUs. A larger
model is not an acceptable default until measured with the parent API and
transcription worker together under that limit. Keep heavy models opt-in or use
a separately budgeted local worker.

Evaluate local vocal separation only as an optional preparation stage. Separation
can expose quiet singing but can also remove consonants and introduce artifacts.
Compare original-mix and isolated-vocal recognition, preserve duration/sample
alignment, and render the original audible mix. Do not concatenate conflicting
ASR results or let an LLM guess replacements. Consider bounded redecoding of
uncertain phrases only after per-track evaluation shows an improvement.

Acceptance: improve measured word errors without introducing instrumental
hallucinations or a regression on other tracks; document latency/memory and
fallback behavior. Keep the language fix even if an acoustic experiment fails.

### 4. Optional recognition and online lyric lookup

Use existing soundtrack title/artist metadata first: this test case already has the correct
title, so recognizing its identity is unnecessary. For known
local files, a local catalog can reuse confirmed lyrics and recording identities.
Chromaprint can generate fingerprints locally, but recognizing an unknown song
requires a matching database. A local catalog only recognizes what it contains;
it is not an offline equivalent of a universal music-recognition service.

If enabled explicitly, AcoustID can look up Chromaprint fingerprints online and
LRCLIB can retrieve lyrics using recording metadata. Prefer this documented API
to scraping lyric-page HTML. Cache the selected lyrics locally and preserve their
origin. Require confirmation of ambiguous artist/version matches, and fall back
to local ASR if lookup fails. Neither network service belongs in the default
processing path. Do not upload the full audio for fingerprint lookup.

AcoustID's service is designed for full recordings rather than short snippets;
its public service also has application-key and usage requirements. LRCLIB's
metadata lookup considers track duration, which can differ for slowed, live or
edited recordings. Retrieved text still requires alignment to the actual audio.
Network identification plus lyric lookup does not by itself solve timing.

## Validation

- Full engine suite: **885 passed** in 1,288.71 seconds using an isolated
  production-image container with FFmpeg/FFprobe, this branch mounted read-only,
  a temporary data directory, and no production data mount. All engine tests
  ran; none were skipped. Pytest 9.1.1 was installed only in the disposable test
  environment.
- Frontend: **438 tests passed** across 33 files; type checking, lint, production
  build and retired-provider reference check passed. The build reports its
  existing bundle-size advisory.
- Focused host regression run: **75 passed, 9 skipped**. The host has no FFmpeg;
  the separate production-image engine run supplies FFmpeg and FFprobe.
- Real browser: desktop (1440 px) and mobile (390 px) controls passed using the
  repository's installed Playwright Chromium. Automatic is the initial choice,
  English can be selected, the control fits mobile width, and switching to Clip
  hides it. No jobs were submitted and no page errors occurred. T3 preview was
  unavailable because its host browser libraries were missing.
- The offline real-audio production-function reproduction is described above;
  it uses no synthetic transcript fixture. These checks establish the language
  regression and integration behavior, not a measured song-wide word-error rate.

## Primary technical references

- [Pinned Faster-Whisper 1.2.1 implementation](https://github.com/SYSTRAN/faster-whisper/blob/v1.2.1/faster_whisper/transcribe.py): language sampling, early confidence exit and decoding controls.
- [WhisperX](https://github.com/m-bain/whisperX): local phoneme alignment candidate; its published speech results do not establish sung-lyric accuracy.
- [AcoustID web service](https://acoustid.org/webservice) and [FAQ](https://acoustid.org/faq): fingerprint lookup, keys, usage conditions and full-recording focus.
- [LRCLIB API](https://lrclib.net/docs): metadata lookup, lyric formats, client identification and rate-limit handling.
