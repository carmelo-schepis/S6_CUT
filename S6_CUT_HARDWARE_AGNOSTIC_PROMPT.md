# S6_cut — CPU-first, hardware-agnostic implementation prompt

You are a senior Python, Docker, ffmpeg, and cross-platform video-processing engineer working directly in this repository.

Your task is to make **S6_cut fully usable without NVIDIA hardware or NVIDIA software**. The standard installation and standard Docker image must work on ordinary CPUs and must not download CUDA, cuDNN, TensorRT, NVIDIA container libraries, or NVIDIA-specific Python wheels.

GPU acceleration may remain available only as a clearly separated, optional installation path. It must never be required to install, start, transcribe, analyze, reframe, subtitle, render, or export a video.

Read `AGENTS.md`, all of `CLAUDE.md`, `README.md`, `.env.example`, `pyproject.toml`, every requirements/lock file, the Dockerfiles, Compose files, hardware-detection code, and relevant tests before editing anything.

## Non-negotiable outcome

After this work, a new user with no dedicated GPU must be able to run:

```bash
docker compose up --build
```

The default build must:

- Use a normal CPU Linux base image, not an `nvidia/cuda` image.
- Build and start without the NVIDIA Container Toolkit.
- Contain no CUDA, cuDNN, TensorRT, NCCL, or NVIDIA runtime packages.
- Avoid downloading NVIDIA CUDA component wheels through pip.
- Run transcription, scene detection, clip selection, reframing, subtitles, overlays, ffmpeg rendering, and ZIP export on CPU.
- Detect available CPU capabilities safely and select compatible settings automatically.
- Produce correct output even when processing is slower than on a GPU.

The application must also remain usable through a normal local Python installation on Windows, macOS, and Linux wherever the pinned dependencies support that operating system and architecture.

## Important distinction

“CPU-first” does not mean “disable AI features.” It means every required feature has a CPU implementation or a graceful CPU fallback.

The default experience must never show errors such as:

- CUDA not found
- No NVIDIA driver
- Torch was compiled with CUDA
- NVIDIA Container Toolkit missing
- No compatible GPU
- Failed to load a TensorRT/CUDA provider

Hardware acceleration is an optimization, not a prerequisite.

## Dependency audit

Audit the complete dependency graph, not only direct dependencies.

Pay particular attention to:

- `torch`
- `torchvision`
- `torchaudio`
- `ultralytics`
- Faster-Whisper / CTranslate2
- MediaPipe
- OpenCV
- ONNX Runtime
- ffmpeg
- Any package that transitively downloads `nvidia-*` wheels

Document which current dependency or installation command causes each NVIDIA/CUDA download.

Create an automated verification step that fails the CPU build if its installed Python distributions include packages matching names such as:

- `nvidia-*`
- CUDA-specific Torch wheels
- TensorRT bindings
- GPU-only ONNX Runtime

Also inspect the final Docker layers and base image so a passing pip check cannot hide NVIDIA libraries inherited from the image.

## Split CPU and GPU installations

Create two explicit dependency paths.

### Default CPU path

This is the supported default and the path used by:

```bash
docker compose up --build
```

Requirements:

- Install CPU-only Torch and TorchVision from the official CPU wheel source when they are still needed.
- Ensure installing Ultralytics afterward cannot replace CPU Torch with CUDA-enabled dependencies.
- Use CPU-compatible CTranslate2/Faster-Whisper.
- Use `opencv-python-headless` in containers unless the GUI package is genuinely required.
- Use CPU ffmpeg encoders such as `libx264` or another broadly available software encoder.
- Do not install NVENC-only ffmpeg builds.
- Lock versions reproducibly.
- Keep host-test dependencies separate from heavyweight runtime dependencies where practical.

### Optional GPU path

GPU support must live in separately named files and require an explicit command, for example:

```bash
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up --build
```

Requirements:

- It may use NVIDIA/CUDA dependencies because the user explicitly opted in.
- It must not modify or contaminate the default CPU lock file or image cache assumptions.
- The GPU Compose override may add device reservations and GPU environment settings; the base Compose file must not contain mandatory NVIDIA runtime configuration.
- Documentation must state that GPU mode is optional.

Never use a single requirements file whose resolver may choose NVIDIA wheels depending on the machine.

## Docker requirements

Refactor Docker packaging so the normal image is portable and reasonably sized.

The default Dockerfile must:

- Start from a standard multi-architecture Python/Debian image such as Python 3.11 slim, unless the repository audit finds a better compatible CPU base.
- Install only the system libraries actually required by ffmpeg, OpenCV, MediaPipe, fonts, and the application.
- Use a multi-stage build where it reduces the final image size without making dependency resolution fragile.
- Run as a non-root user where practical.
- Preserve persistent writable directories and their documented permissions.
- Include a health check.
- Avoid architecture-specific binaries unless selected safely for the current architecture.
- Never silently download a CUDA-enabled binary at container startup.

The default `docker-compose.yml` must:

- Have no `runtime: nvidia` requirement.
- Have no mandatory GPU device reservation.
- Have no NVIDIA-only environment variables.
- Start successfully in Docker Desktop, Portainer, and TrueNAS without GPU configuration.
- Remain suitable for CPU-only NAS hardware.

Keep `docker-compose.gpu.yml` as an optional override only.

## Runtime hardware selection

Centralize runtime hardware decisions in the existing hardware module instead of scattering checks throughout the pipeline.

Expose a small capability object containing at least:

- Selected execution device: CPU, CUDA, Apple Metal/MPS, or other supported accelerator
- CPU core count
- Available RAM when detectable
- Available ffmpeg encoders
- Torch availability and device support
- CTranslate2 supported compute types
- Selected transcription compute type
- Selected reframe detector
- Selected encoder

Default behavior must be conservative and portable:

- Device: CPU
- Faster-Whisper compute type: `int8` on CPU when supported, with a safe fallback
- Torch device: CPU
- ffmpeg encoder: `libx264`
- Reasonable worker/concurrency limits derived from CPU and RAM
- No assumption that AVX2, AVX-512, Apple Metal, Quick Sync, or another accelerator exists

Do not determine GPU support merely because a package imports. Verify that the device is genuinely usable. If probing an accelerator fails, log one warning, select CPU, and continue.

## CPU fallbacks by pipeline stage

Ensure each pipeline stage has a functional CPU route.

### Transcription

- Local Faster-Whisper must run on CPU.
- Select a CPU-suitable default model and `int8` compute mode.
- Allow the user to choose larger models while warning about expected RAM/time.
- If a cloud transcription provider is configured, it may be used, but it must not be required.
- A cloud failure must fall back to local CPU transcription.

### Scene detection

- PySceneDetect/OpenCV must run on CPU.
- Avoid GPU-only OpenCV builds and code paths.

### Reframing and subject detection

- YOLO inference must work with CPU-only Torch when enabled.
- Provide a lighter CPU profile using a small model and reduced sampling frequency.
- Preserve the existing MediaPipe/OpenCV fallback path.
- If YOLO or Torch is unavailable, do not fail the job. Use MediaPipe, saliency/center crop, or letterbox mode according to a documented fallback chain.
- Allow a “fast CPU” reframe mode that prioritizes reasonable output and completion time.

### Rendering

- Use software ffmpeg encoding by default.
- Probe encoders instead of assuming NVENC exists.
- Never pass CUDA/NVENC filters or encoders into the standard render path.
- If the user explicitly enables a hardware encoder and it fails, retry that render with the software encoder before failing the clip.

### LLM and asset features

- These features must not require a local GPU.
- OpenRouter or another configured API can perform LLM work remotely.
- The existing offline TextTiling fallback must remain CPU compatible.
- Image/GIF overlays, subtitles, and ZIP creation must use CPU-safe tools.

## Performance profiles

Add user-selectable processing profiles with safe defaults:

- `cpu_low`: low-memory systems and small NAS devices
- `cpu_balanced`: default for ordinary laptops/desktops
- `cpu_quality`: more analysis and larger local models, still no GPU
- `gpu`: visible only when an accelerator is detected or explicitly configured

Profiles may tune:

- Whisper model and compute type
- Detector model size
- Frame sampling interval
- Scene-analysis resolution
- Concurrent jobs
- Concurrent ffmpeg renders
- x264 preset and CRF
- Cache behavior

Profiles must affect speed and resource usage, not whether core features work.

Do not let the UI imply that CPU output is inferior or unsupported. Clearly communicate that GPU mode is optional and mainly improves processing speed.

## Cross-platform and architecture support

Support these environments as far as dependency availability permits:

- Windows 10/11 without NVIDIA hardware
- macOS on Apple Silicon and Intel
- Linux x86_64
- Linux ARM64 for compatible NAS/TrueNAS/Portainer systems

Where a dependency lacks an ARM64 wheel, implement one of the following rather than failing mysteriously:

1. Use a compatible alternative dependency.
2. Disable only that optional detector and use the documented CPU fallback.
3. Provide a clear build-time compatibility message with a usable reduced-feature path.

Do not advertise an architecture as supported until its image builds and a smoke test completes.

## Settings and diagnostics UI

Add a Hardware/Performance section in Settings showing:

- Detected device
- Selected profile
- Transcription model and compute type
- Reframe detector/fallback
- ffmpeg encoder
- CPU/RAM summary
- Whether optional GPU acceleration is available

The UI must say that no dedicated GPU is required.

Add a copyable diagnostics report that contains versions and capability results but never secrets, private file paths, transcripts, or API keys.

## Configuration

Introduce clearly documented variables only where useful, such as:

- `S6CUT_PERFORMANCE_PROFILE=cpu_balanced`
- `S6CUT_DEVICE=auto|cpu|cuda|mps`
- `S6CUT_FFMPEG_ENCODER=auto|libx264|...`
- `S6CUT_WHISPER_MODEL=...`
- `S6CUT_WHISPER_COMPUTE_TYPE=auto|int8|float32|...`
- `S6CUT_MAX_CONCURRENT_JOBS=...`

Names may follow the repository's existing configuration prefix if consistency requires it. Keep `.env.example`, README tables, Compose files, and runtime defaults synchronized.

`auto` must always resolve to a safe CPU option when no verified accelerator exists.

## Testing requirements

Add automated tests for at least:

- Hardware detection on a machine where CUDA is unavailable.
- Torch imports but `torch.cuda.is_available()` is false.
- Accelerator probing raises an exception and CPU is selected.
- Faster-Whisper receives CPU and an appropriate CPU compute type.
- Reframe falls back when YOLO/Torch is absent.
- ffmpeg falls back to `libx264` when a requested hardware encoder is missing or fails.
- CPU concurrency limits remain positive and bounded on low-core/low-memory systems.
- Default Compose config contains no mandatory NVIDIA runtime/device reservation.
- Default Docker image contains no installed `nvidia-*`, CUDA, cuDNN, TensorRT, or NCCL packages/libraries.
- Default requirements resolve without downloading NVIDIA packages.
- CPU-only end-to-end smoke test processes a small fixture and produces a playable clip with audio and subtitles.
- Existing backend and frontend tests remain green.

Create a CI job that builds the standard CPU image with no GPU runner, starts the stack, waits for health checks, submits a small fixture, and verifies output with ffprobe.

## Documentation requirements

Update the README and deployment documentation with:

- “No GPU required” near the main install command.
- Approximate CPU processing expectations stated as examples, not promises.
- RAM/disk recommendations for low, balanced, and quality profiles.
- Standard CPU Docker instructions first.
- Optional GPU instructions in a separate section.
- Portainer and TrueNAS steps that do not mention NVIDIA unless the user chooses the optional GPU section.
- Troubleshooting for unsupported CPU instructions, RAM exhaustion, slow transcription, and missing ffmpeg encoders.

Never tell CPU-only users to install CUDA as a troubleshooting step.

## Suggested implementation order

1. Audit and document every current NVIDIA/CUDA dependency and assumption.
2. Add tests that prove the current default path is not CPU-clean.
3. Split and lock CPU versus optional GPU dependencies.
4. Replace the default Docker base and Compose configuration with CPU-only versions.
5. Centralize capability detection and CPU-safe runtime defaults.
6. Add per-stage CPU fallbacks and software-encoder retry behavior.
7. Add performance profiles and Settings diagnostics.
8. Add CPU-only end-to-end CI and final-image dependency inspection.
9. Update TrueNAS, Portainer, local-install, and troubleshooting documentation.

Keep each step independently reviewable. Do not combine this with unrelated UI redesign or product features.

## Definition of done

This task is complete only when:

- The normal dependency installation downloads no NVIDIA/CUDA packages.
- The normal Docker image contains no NVIDIA/CUDA runtime.
- `docker compose up --build` works on a CPU-only machine without NVIDIA tooling.
- A CPU-only end-to-end job produces playable, correctly subtitled output.
- Transcription, reframing, and encoding each have tested CPU paths.
- Missing optional ML dependencies trigger usable fallbacks rather than job failure.
- GPU support, if retained, requires a separate explicit opt-in command.
- TrueNAS and Portainer CPU deployment instructions work without GPU configuration.
- Existing functionality, security, resumability, cancellation, and tests have not regressed.

At completion, report the dependency audit, files changed, final CPU image size, proof that no NVIDIA packages are installed, CPU smoke-test results, remaining optional GPU files, and any platform-specific limitations.
