# Diagnostic: job progress stays in planning during FFmpeg render

Observed on revision `032c904f1b5b966eb754ecf9ca17c3f879422205` in fresh local Docker installations on an Intel Mac (macOS 15.7.9, Docker Desktop). The behavior repeated across real YouTube clips and local-engine jobs, including captioned and uncaptioned exports.

While FFmpeg was actively writing a clip's `.partial.mp4` file, the Jobs API kept reporting the job at `stage=plan` and `progress=28%`; the clip remained `queued`. Once FFmpeg finished, the job jumped to complete. The exported clips decoded and played, so this finding concerns live progress reporting rather than render output.

This makes an active render look stalled and prevents clients from distinguishing planning from rendering. The behavior was observed in multiple jobs in separate fresh datasets. No provider profile or API key was configured.

## Reproduce

1. Start a disposable stack from the tested revision with a unique Compose project name.
2. Import a real source and submit a Smart local clip job.
3. Poll `/api/v1/jobs/{job-id}` while running the read-only observer below.

```bash
python3 scripts/qa/reproduce-render-progress.py \
  --url http://127.0.0.1:64032 \
  --project s6-install-example \
  --job-id <job-uuid>
```

The observer exits `1` only after three samples show FFmpeg writing a `.partial.mp4` while the job is not publishing `stage=render` and clip state `rendering`. It exits `2` when the render ends before enough observations are collected. It does not change job state or remove containers.

## Expected and actual

- Expected during an active FFmpeg render: job stage `render` and clip state `rendering`, with render progress advancing.
- Actual during the observed jobs: stage `plan`, progress `28%`, clip state `queued`; after rendering, the job changed to complete.

No source changes or fixes are included in this diagnostic.
