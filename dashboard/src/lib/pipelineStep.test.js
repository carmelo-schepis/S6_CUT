// Pure-logic tests for the pipeline-step inference. Run with the built-in Node
// test runner — `npm test` (no new dependency; the repo is otherwise pytest).
// These functions parse the backend's streamed log lines, so they rot silently
// when that wording drifts; this guards the parse contract.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { detectPipelineStep, pipelineStepMeta } from './pipelineStep.js';

test('detectPipelineStep maps log markers to the active phase', () => {
  assert.equal(detectPipelineStep(['📥 Downloading video from YouTube...']), 'downloading');
  assert.equal(
    detectPipelineStep(['📥 Downloading...', '🎙️  Transcribing with Deepgram [nova-3, lang=multi]']),
    'transcribing',
  );
  assert.equal(detectPipelineStep(['🎙️  Transcribing with Faster-Whisper [large-v3] (CPU mode)...']), 'transcribing');
  assert.equal(
    detectPipelineStep(['🎙️  Transcribing with Deepgram [nova-3]', '🤖  Analyzing with Gemini...']),
    'analyzing',
  );
  assert.equal(detectPipelineStep(['🧩 Gemini unavailable — lexical TextTiling found 4 topic clips.']), 'analyzing');
  assert.equal(detectPipelineStep(['🤖  Analyzing with Gemini...', '🎬 Processing Clip 1: 10s - 40s']), 'processing');
  assert.equal(detectPipelineStep(['⏩ Skipping analysis, processing entire video...']), 'processing');
  assert.equal(detectPipelineStep(['🔥 Found 7 viral clips!', '🎬 Processing Clip 1']), 'processing');
});

test('detectPipelineStep ignores the removed dead markers and empties', () => {
  assert.equal(detectPipelineStep(['Step 4: foo']), null); // backend never prints "Step N:"
  assert.equal(detectPipelineStep([]), null);
  assert.equal(detectPipelineStep(null), null);
});

test('pipelineStepMeta.download reflects a local upload vs a URL fetch', () => {
  assert.equal(pipelineStepMeta([], { mediaType: 'file' }).download, 'local file');
  assert.equal(pipelineStepMeta([], { mediaType: 'url' }).download, undefined); // keeps static "fetch source"
  assert.equal(pipelineStepMeta([], {}).download, undefined);
});

test('pipelineStepMeta.transcribe reflects the provider/model that actually ran', () => {
  assert.equal(
    pipelineStepMeta(['🎙️  Transcribing with Deepgram [nova-3, lang=multi] (1.2 MB)'], {}).transcribe,
    'deepgram nova-3',
  );
  assert.equal(
    pipelineStepMeta(['🎙️  Transcribing with Faster-Whisper [large-v3] (CUDA mode)...'], {}).transcribe,
    'whisper large-v3',
  );
  // Fallback must win even though a Deepgram line was logged first (logs accumulate).
  assert.equal(
    pipelineStepMeta(
      [
        '🎙️  Transcribing with Deepgram [nova-3, lang=multi]',
        '⚠️  Deepgram transcription failed (401); falling back to Faster-Whisper.',
        '🎙️  Transcribing with Faster-Whisper [medium] (CPU mode)...',
      ],
      {},
    ).transcribe,
    'whisper medium (fallback)',
  );
  // Fallback announced but Whisper hasn't printed its model line yet.
  assert.equal(
    pipelineStepMeta(['⚠️  Deepgram transcription failed (401); falling back to Faster-Whisper.'], {}).transcribe,
    'whisper (fallback)',
  );
  // No transcribe marker yet → key absent, caller keeps the static PIPE meta.
  assert.equal(pipelineStepMeta(['📥 Downloading...'], {}).transcribe, undefined);
});

test('pipelineStepMeta.detect reflects the Gemini model or the no-AI fallback', () => {
  assert.equal(
    pipelineStepMeta(['🤖  Initializing Gemini with model: gemini-3.5-flash'], {}).detect,
    'gemini-3.5-flash',
  );
  assert.equal(pipelineStepMeta(['🤖  Gemini model override: gemini-2.5-pro'], {}).detect, 'gemini-2.5-pro');
  assert.equal(
    pipelineStepMeta(['🧩 Gemini unavailable — lexical TextTiling found 4 topic clips.'], {}).detect,
    'topic segments · no AI',
  );
});

test('pipelineStepMeta.reframe reflects the user-chosen mode (incl. legacy boolean)', () => {
  assert.equal(pipelineStepMeta([], { reframeMode: 'auto' }).reframe, 'face tracking');
  assert.equal(pipelineStepMeta([], { reframeMode: 'object' }).reframe, 'object crop');
  assert.equal(pipelineStepMeta([], { reframeMode: 'disabled' }).reframe, '4:3 · bars');
  assert.equal(pipelineStepMeta([], { reframe: false }).reframe, '4:3 · bars'); // legacy back-compat
  assert.equal(pipelineStepMeta([], {}).reframe, 'face tracking'); // default
});
