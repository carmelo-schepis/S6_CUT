/**
 * Map backend log lines to a coarse pipeline step label for the UI spinner.
 *
 * The backend streams plain log lines (no numeric % and no structured step
 * field), so we infer the active phase from the log text. Checks are ordered
 * latest-phase-first because `logs` is the full accumulated transcript — once a
 * later phase's marker appears it must win over earlier ones.
 *
 * @param {string[]} logs
 * @returns {'processing' | 'analyzing' | 'transcribing' | 'downloading' | 'queued' | null}
 */
export function detectPipelineStep(logs) {
  if (!logs || logs.length === 0) return null;
  const joined = logs.join(' ');
  // Clip render loop — the backend prints "🎬 Processing Clip N". The whole-
  // video fallbacks ("Converting whole video", "processing entire video") also
  // land here: past detection, into the render phase.
  if (
    joined.includes('Processing Clip') ||
    joined.includes('Converting whole video') ||
    joined.includes('processing entire video')
  ) {
    return 'processing';
  }
  // Detection phase — Gemini scoring OR the no-AI TextTiling fallback (which
  // logs "Gemini unavailable — lexical TextTiling …").
  if (joined.includes('Analyzing with Gemini') || joined.includes('Gemini') || joined.includes('TextTiling')) {
    return 'analyzing';
  }
  if (joined.includes('Transcribing') || joined.includes('Faster-Whisper')) return 'transcribing';
  if (joined.includes('Downloading') || joined.includes('yt-dlp')) return 'downloading';
  if (joined.includes('queued') || joined.includes('started')) return 'queued';
  return null;
}

/**
 * Derive per-step meta overrides so the pipeline display reflects what actually
 * ran instead of static guesses. Pure: depends only on the streamed logs (for
 * transcription provider/model and the Gemini-vs-TextTiling branch) and the
 * submitted opts (for the reframe policy, which is chosen client-side and not
 * reliably echoed in the logs).
 *
 * Returns a partial map keyed by PIPE step id (`transcribe` / `detect` /
 * `reframe`); only keys we can resolve are present, so the caller falls back to
 * the static PIPE meta for the rest.
 *
 * NOTE: the substrings matched below are a soft contract with the backend's
 * log wording (clippyme/pipeline/main.py + deepgram_transcribe.py). If a log
 * line is rephrased there, the affected key simply drops back to the static
 * PIPE meta — wrong-but-stable degrades to generic, never to a crash.
 *
 * @param {string[]} logs
 * @param {{ reframeMode?: string, reframe?: boolean, mediaType?: string }} [opts]
 * @returns {{ download?: string, transcribe?: string, detect?: string, reframe?: string }}
 */
export function pipelineStepMeta(logs = [], opts = {}) {
  const joined = (logs || []).join(' ');
  const meta = {};

  // --- Download: a local upload is never fetched from a URL ----------------
  if (opts.mediaType === 'file') meta.download = 'local file';

  // --- Transcribe: the provider/model the backend actually used ------------
  // "🎙️  Transcribing with Deepgram [nova-3, lang=multi] …"
  // "🎙️  Transcribing with Faster-Whisper [large-v3] (CUDA mode)…"
  // Fallback FIRST: logs accumulate, so a Deepgram attempt that printed its own
  // "Transcribing with Deepgram" line and THEN failed must not win — the
  // Whisper fallback is the provider that actually produced the transcript.
  let m;
  if (joined.includes('falling back to Faster-Whisper')) {
    m = joined.match(/Transcribing with Faster-Whisper \[([^\]]+)\]/);
    meta.transcribe = m ? `whisper ${m[1].trim().toLowerCase()} (fallback)` : 'whisper (fallback)';
  } else if ((m = joined.match(/Transcribing with Deepgram \[([^,\]]+)/))) {
    meta.transcribe = `deepgram ${m[1].trim().toLowerCase()}`;
  } else if ((m = joined.match(/Transcribing with Faster-Whisper \[([^\]]+)\]/))) {
    meta.transcribe = `whisper ${m[1].trim().toLowerCase()}`;
  }

  // --- Detect moments: Gemini model, or the no-AI TextTiling fallback ------
  if (joined.includes('TextTiling')) {
    meta.detect = 'topic segments · no AI';
  } else if (
    (m = joined.match(/Gemini model override:\s*([\w.-]+)/)) ||
    (m = joined.match(/Initializing Gemini with model:\s*([\w.-]+)/))
  ) {
    meta.detect = m[1];
  }

  // --- Reframe: the user-chosen whole-clip policy (known client-side) ------
  // Legacy jobs only carry the boolean `opts.reframe`; map it as a fallback.
  const rm = opts.reframeMode || (opts.reframe === false ? 'disabled' : 'auto');
  meta.reframe =
    rm === 'object' ? 'object crop' : rm === 'disabled' ? '4:3 · bars' : 'face tracking';

  return meta;
}
