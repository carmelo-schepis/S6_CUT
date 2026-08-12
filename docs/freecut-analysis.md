# FreeCut analysis

Source: [walterlow/freecut](https://github.com/walterlow/freecut) — a browser-based, client-side multi-track video editor (a Premiere/CapCut-style timeline NLE that runs entirely in the browser).

Evaluated against ClippyMe to decide what (if anything) is worth porting. Verdict up front: **FreeCut is a human-driven browser NLE built on WebGPU + WebCodecs + Mediabunny — a different product, a different language, and the opposite execution model from ClippyMe (a headless server-side AI viral-shorts generator). Nothing is port-worthy.** The few capabilities that overlap (Whisper transcription, scene-cut detection, subtitle formatting) ClippyMe already does, in a mature/native form that is equal or better; the one genuinely pure-math, language-agnostic module (a chi-squared histogram scene-cut detector) is a hand-rolled reimplementation of exactly what ClippyMe already gets from PySceneDetect's `ContentDetector`.

## What FreeCut is

| Aspect | FreeCut |
|---|---|
| Goal | Interactive multi-track timeline editing in the browser (human drags/trims/splits/keyframes clips) |
| Runtime | **TypeScript + React 19 + Vite**, Chromium-only (Chrome 113+) — **100% browser**, no Node/Python backend for the editing itself |
| Engine | **WebGPU** compositing/effects/transitions/masks + **WebCodecs** decode/encode + **Mediabunny** demux/mux (MP4/WebM/MOV/MKV, HTTP-Range streaming). **No ffmpeg, no ffmpeg.wasm, no native code.** |
| Storage | File System Access API + OPFS (projects/media/thumbnails/waveforms/captions on disk); IndexedDB only as a `FileSystemHandle` registry |
| State / routing | Zustand stores + TanStack Router |
| Editing model | Human-driven: timeline edit, keyframes, transitions, effects placed by hand. AI features (Whisper, scene detection, captioning, MusicGen, Kokoro TTS) are **user-invoked assists**, not an automated pipeline |
| Automation | A `headless/` layer drives the **same browser engine** via Playwright (Node orchestrates a headless Chrome) — automation by remote-controlling a browser, **not** native headless processing |

FreeCut is the same archetype as `webcut` and `openreel-video`: a **real-time, GPU-accelerated, human-in-the-loop browser editor**. ClippyMe is the opposite end of the spectrum — a **headless, automated, server-side ffmpeg/OpenCV/YOLO/MediaPipe pipeline** that turns a long URL into finished 9:16 clips with zero manual editing. Browser WebGPU/WebCodecs/Mediabunny code has no analogue in (and cannot be ported to) a Python ffmpeg pipeline.

## AI / analysis feature checklist (vs ClippyMe core)

| Capability | FreeCut | ClippyMe | Verdict |
|---|---|---|---|
| Audio transcription | **yes** — browser Whisper via transformers.js (`src/features/media-library/transcription/`) | Deepgram Nova-3 cloud + faster-whisper fallback, URL-hash cached, audio-only FLAC extraction | **ClippyMe** (cloud Nova-3 + multilingual code-switch + caching is a superset) |
| AI/LLM viral moment detection | **no** | Gemini 5-axis viral rubric over full transcript | **ClippyMe-only** (FreeCut's core gap) |
| Face / object tracking | **no** | YOLOv8 + MediaPipe FaceMesh, active-speaker MAR | **ClippyMe-only** |
| Auto reframe 16:9→9:16 | **no** (README + tree confirm none) | the entire `reframe.py` / `reframe_ops.py` stack | **ClippyMe-only** |
| Scene detection | **yes** — chi-squared histogram / WebGPU optical-flow / optional VLM verify (`src/infrastructure/analysis/`) | PySceneDetect `ContentDetector` | **ClippyMe** (mature lib; see below) |
| Silence / filler smart-cut | **no** | `smartcut.py` two-stage auto-editor v3 + manual `drop_ranges` | **ClippyMe-only** |
| Beat / tempo detection | **no** | none (out of scope — see `openreel-video-analysis.md`) | n/a |
| Auto subtitle generation | **yes** — Whisper → caption items + formatting (`captioning/scene-caption-format.ts`) | `subtitles.py` semantic line-split + ASS karaoke (6 presets, EN/IT/ES/FR/DE) | **ClippyMe** (far more capable) |

The whole AI/CV pipeline ClippyMe is built around — viral detection, reframing, smart-cut, cover selection, social publishing — FreeCut has none of. The fit is wrong-direction (again): FreeCut is the manual editor a user reaches for *after* an automated tool like ClippyMe hands them clips.

## The closest call — chi-squared histogram scene-cut — and why it stays unported

`src/infrastructure/analysis/histogram-scene-detection.ts` (~165 LOC) is the one clean, dependency-light, language-agnostic module FreeCut has: 160×90 downsample → per-channel 32-bin RGB histograms (normalized) → **chi-squared distance** between consecutive frames → cut when distance ≥ 0.3. It is a tidy pure-TS shot-boundary detector.

It stays unported because **ClippyMe already runs the mature, maintained version of this exact algorithm.** `scene_detection.py:detect_scenes` uses PySceneDetect's `ContentDetector` — content-aware cut detection on per-frame colour/luma histogram deltas (HSV), the same algorithm family as FreeCut's chi-squared RGB histogram, but battle-tested, threshold-tuned, frame-accurate, and already wired into the pipeline (`main.py` → per-scene reframe strategy). Porting a hand-rolled TS reimplementation of a library ClippyMe already depends on would be a strict regression — more code, less robust, and it would have to be rewritten from TypeScript into Python besides. The transferable *idea* (histogram-delta shot boundaries) is the same idea PySceneDetect already gives us; there is nothing to take.

FreeCut's other scene paths (WebGPU optical-flow compute shaders, local-VLM verify) are browser/GPU-locked and not portable.

## Why the rest doesn't port

- **WebGPU compositor / transition / effect shaders** (`gpu-compositor/`, `gpu-transitions/`) — WGSL shader math against `GPUDevice` in a live browser compositor. ClippyMe emits one continuous clip per moment (no multi-clip cut to transition across), and ffmpeg already ships `xfade`/`eq`/`gblur`/`hue` for the rare case a transition or filter were ever wanted. **The better source is ffmpeg's native filter set, not a shader port** — and even those stay unwired for lack of a use case.
- **WebCodecs + Mediabunny export pipeline** (`export-render.worker.ts`) — the opposite architecture from ClippyMe's native-ffmpeg subprocess backend. Porting it would be a regression; ClippyMe already does slice/transcode/mux/audio-extract natively and faster.
- **Keyframe easing / interpolation** (`features/keyframes/utils/`: cubic-Bézier solver, lerp, eased interpolation) — these are *display tweens* for UI keyframe animation, not signal smoothers for a camera path. ClippyMe's `reframe_ops.py` smoother suite (savgol / Kalman RTS / 1€ filter / damped-spring + asymmetric zoom easing) already matches or exceeds them for the only thing ClippyMe smooths, and ClippyMe has no keyframe-animation product to consume display eases.
- **SoundTouch time-stretch** (`audio/time-stretch.ts`, WSOLA) — ClippyMe has no time-stretch feature and no product use for one; ffmpeg `atempo`/`rubberband` would be the native source if it ever did.
- **OPFS / File System Access storage, Zustand stores, timeline px↔frame math, every React view** — interactive-browser-editor concerns with no headless analogue.

## Bottom line

FreeCut and ClippyMe share a domain (video) but not a product, a language, or an execution model — FreeCut is "edit it yourself in the browser on WebGPU", ClippyMe is "generate it automatically on a server with ffmpeg + AI". Every overlapping capability (transcription, scene detection, subtitle formatting) ClippyMe already does in a more mature or more capable form; the genuinely pure-math piece (chi-squared histogram scene-cut) is a hand-rolled reimplementation of the PySceneDetect `ContentDetector` ClippyMe already depends on; and everything else is WebGPU/WebCodecs/OPFS code that cannot port into a Python/ffmpeg stack. **No code change is warranted; the net-positive deliverable is this recorded decision** (same pattern as `docs/webcut-analysis.md`, `docs/openreel-video-analysis.md`, and `docs/videolingo-analysis.md`).
