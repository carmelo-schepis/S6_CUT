#!/usr/bin/env node
/**
 * Run the real-upload Music acceptance against an already-running isolated gateway,
 * then inspect source and rendered outputs from within its engine container.
 * This harness does not build, deploy, or seed a deployment. Its Playwright spec
 * intentionally submits one real job through the UI; the existing deployment's
 * worker processes it.
 *
 * Required opt-in: S6_MUSIC_SOURCE_VIDEO, S6_MUSIC_COMPOSE_PROJECT,
 * S6_MUSIC_ENGINE_SERVICE, S6_MUSIC_CONTAINER_SOURCE_PATH and
 * S6_MUSIC_CONTAINER_OUTPUT_DIR (the base jobs directory inside the container;
 * outputs are under <base>/<persisted-job-id>/clips/<outputName>). The source
 * and outputs must be visible inside the selected engine container. Supply authorized human-sung media with capacity
 * for one requested 8-20 second clip; shortfalls are reported, never relaxed.
 * S6_TEST_TRANSCRIPT_JSON is forbidden.
 */
import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const fixture = process.env.S6_MUSIC_SOURCE_VIDEO;
const musicProfile = process.env.S6_MUSIC_TEST_PROFILE;
const composeProject = process.env.S6_MUSIC_COMPOSE_PROJECT;
const engineService = process.env.S6_MUSIC_ENGINE_SERVICE;
const containerSourcePath = process.env.S6_MUSIC_CONTAINER_SOURCE_PATH;
const containerOutputDir = process.env.S6_MUSIC_CONTAINER_OUTPUT_DIR;
const acceptanceUrl = process.env.S6_ACCEPTANCE_URL;
if (musicProfile !== undefined && musicProfile !== "music") throw new Error("Canonical Music acceptance allows only S6_MUSIC_TEST_PROFILE=music or unset.");
if (!fixture) throw new Error("Opt-in required: set S6_MUSIC_SOURCE_VIDEO to authorized human-sung media.");
if ("S6_TEST_TRANSCRIPT_JSON" in process.env) throw new Error("Live Music acceptance forbids S6_TEST_TRANSCRIPT_JSON.");
if (!acceptanceUrl || new URL(acceptanceUrl).port === "8080") throw new Error("Set explicit S6_ACCEPTANCE_URL; any :8080 gateway is forbidden.");
if (!composeProject || !/^s6-cut-music-repair-[a-z0-9][a-z0-9_-]*$/i.test(composeProject) || !engineService || !containerSourcePath || !containerOutputDir) {
  throw new Error("Set a unique s6-cut-music-repair-* S6_MUSIC_COMPOSE_PROJECT, S6_MUSIC_ENGINE_SERVICE, S6_MUSIC_CONTAINER_SOURCE_PATH, and S6_MUSIC_CONTAINER_OUTPUT_DIR for isolated container verification.");
}
const fixturePath = resolve(fixture);
const sourceStat = await stat(fixturePath);
if (!sourceStat.isFile() || sourceStat.size === 0) throw new Error("S6_MUSIC_SOURCE_VIDEO must be a non-empty video file.");

function isWithin(parent, child) {
  const pathFromParent = relative(parent, child);
  return pathFromParent === "" || (pathFromParent !== ".." && !pathFromParent.startsWith(`..${sep}`) && !isAbsolute(pathFromParent));
}
async function rejectSymlinkPath(parent, child) {
  let current = parent;
  for (const segment of relative(parent, child).split(sep).filter(Boolean)) {
    current = join(current, segment);
    const existing = await lstat(current).catch(() => null);
    if (existing?.isSymbolicLink()) throw new Error("Music acceptance artifacts cannot use symlink paths");
  }
}

const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-${randomBytes(3).toString("hex")}`;
const rootReal = await realpath(root);
const qaBase = resolve(root, ".qa");
const existingQaBase = await lstat(qaBase).catch(() => null);
if (existingQaBase?.isSymbolicLink()) throw new Error("Music acceptance artifacts cannot use symlink paths");
await mkdir(qaBase, { recursive: true });
const qaBaseReal = await realpath(qaBase);
if (!isWithin(rootReal, qaBaseReal)) throw new Error("Music acceptance artifacts must remain inside the isolated worktree");
const artifactRoot = resolve(qaBase, "music-repair-20260605");
await rejectSymlinkPath(qaBase, artifactRoot);
await mkdir(artifactRoot, { recursive: true });
const artifactRootReal = await realpath(artifactRoot);
if (!isWithin(rootReal, artifactRootReal)) throw new Error("Music acceptance artifacts must remain inside the isolated worktree");
const requestedArtifacts = resolve(root, process.env.S6_PLAYWRIGHT_ARTIFACTS || join(".qa", "music-repair-20260605", "runs", runId));
if (requestedArtifacts === artifactRoot || !isWithin(artifactRoot, requestedArtifacts)) throw new Error("S6_PLAYWRIGHT_ARTIFACTS must be a unique path under .qa/music-repair-20260605");
await rejectSymlinkPath(artifactRoot, requestedArtifacts);
const requestedParent = dirname(requestedArtifacts);
await mkdir(requestedParent, { recursive: true });
if (!isWithin(artifactRootReal, await realpath(requestedParent))) throw new Error("Music acceptance artifacts must remain inside .qa/music-repair-20260605");
const existingArtifacts = await lstat(requestedArtifacts).catch(() => null);
if (existingArtifacts) throw new Error("S6_PLAYWRIGHT_ARTIFACTS must name a new, unique directory");
await mkdir(requestedArtifacts);
const artifacts = await realpath(requestedArtifacts);
if (!isWithin(artifactRootReal, artifacts)) throw new Error("Music acceptance artifacts must remain inside .qa/music-repair-20260605");
const environment = { ...process.env, S6_PLAYWRIGHT_ARTIFACTS: artifacts };
const screenshotPath = join(artifacts, "screenshots");
await rejectSymlinkPath(artifacts, screenshotPath);
await mkdir(screenshotPath, { recursive: true });
if (!isWithin(artifacts, await realpath(screenshotPath))) throw new Error("Music acceptance screenshots must remain inside .qa/music-repair-20260605");
const reportPath = join(artifacts, "music-live.json");
const report = {
  createdAt: new Date().toISOString(),
  fixture: { bytes: sourceStat.size },
  deployment: { project: composeProject, service: engineService, containerId: null, imageId: null, image: null },
  mediaVerification: null,
  sourceFixtureHashMatchesContainer: null,
  mediaVerificationFailure: null,
  runtimeTranscript: null,
  runtimeTranscriptFailure: null,
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

function run(command, args, includeStderr = false) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error("Isolated media verification command failed");
  return includeStderr ? `${result.stdout}\n${result.stderr}` : result.stdout;
}
function compose(args, includeStderr = false) {
  const envFile = process.env.S6_MUSIC_COMPOSE_ENV_FILE;
  return run("docker", ["compose", "--project-directory", root, "-f", resolve(root, "compose.yaml"), ...(envFile ? ["--env-file", resolve(root, envFile)] : []), "-p", composeProject, ...args], includeStderr);
}
function inEngine(command, ...args) {
  return compose(["exec", "-T", engineService, command, ...args]);
}
function inEngineWithStderr(command, ...args) {
  return compose(["exec", "-T", engineService, command, ...args], true);
}
function parseRate(rate) {
  const [numerator, denominator] = String(rate || "").split("/").map(Number);
  return denominator ? numerator / denominator : numerator;
}
function verifySourceHash(containerPath, hostPath) {
  const hostHash = createHash("sha256").update(readFileSync(hostPath)).digest("hex");
  const script = "import hashlib,sys; print(hashlib.sha256(open(sys.argv[1], 'rb').read()).hexdigest())";
  const containerHash = inEngine("python", "-c", script, containerPath).trim();
  if (!/^[a-f0-9]{64}$/.test(containerHash)) throw new Error("Container source hash unavailable");
  return { matches: hostHash === containerHash, hostHash };
}
function probe(containerPath) {
  const output = inEngine("ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type,duration,avg_frame_rate", "-of", "json", containerPath);
  return JSON.parse(output);
}
function mediaSummary(probed) {
  const duration = Number(probed.format?.duration);
  const video = probed.streams?.find((stream) => stream.codec_type === "video");
  const audio = probed.streams?.find((stream) => stream.codec_type === "audio");
  return { duration, hasVideo: Boolean(video), hasAudio: Boolean(audio), frameRate: parseRate(video?.avg_frame_rate) };
}
function volumeSummary(containerPath) {
  const output = inEngineWithStderr("ffmpeg", "-hide_banner", "-i", containerPath, "-map", "0:a:0", "-vn", "-af", "volumedetect", "-f", "null", "-");
  const mean = output.match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i)?.[1];
  const maximum = output.match(/max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i)?.[1];
  if (mean === undefined || maximum === undefined) throw new Error("Audio level summary unavailable");
  return { meanVolumeDb: Number(mean), maxVolumeDb: Number(maximum) };
}

let preflightHostHash;
try {
  const requestedGateway = new URL(acceptanceUrl);
  if (requestedGateway.protocol !== "http:" || requestedGateway.hostname !== "127.0.0.1" || requestedGateway.pathname !== "/" || requestedGateway.search || requestedGateway.hash || requestedGateway.username || requestedGateway.password) {
    throw new Error("S6_ACCEPTANCE_URL must be the root of the selected loopback-only HTTP gateway");
  }
  const publishedGateways = compose(["port", "web", "8080"]).trim().split(/\r?\n/).filter(Boolean);
  if (publishedGateways.length !== 1) throw new Error("Expected exactly one published web gateway for the selected Compose project");
  const publishedGateway = new URL(`http://${publishedGateways[0]}`);
  if (publishedGateway.hostname !== "127.0.0.1" || publishedGateway.port !== requestedGateway.port) {
    throw new Error("S6_ACCEPTANCE_URL does not match the selected Compose project's loopback web gateway");
  }
  const containers = compose(["ps", "-q", engineService]).trim().split(/\r?\n/).filter(Boolean);
  if (containers.length !== 1) throw new Error("Expected exactly one isolated engine container");
  report.deployment.containerId = containers[0];
  report.deployment.image = JSON.parse(run("docker", ["inspect", "--format", "{{json .Config.Image}}", containers[0]]).trim());
  report.deployment.imageId = JSON.parse(run("docker", ["inspect", "--format", "{{json .Image}}", containers[0]]).trim());
  const sourceHashCheck = verifySourceHash(containerSourcePath, fixturePath);
  report.sourceFixtureHashMatchesContainer = sourceHashCheck.matches;
  preflightHostHash = sourceHashCheck.hostHash;
  if (!report.sourceFixtureHashMatchesContainer) throw new Error("Host and container source fixtures differ");
} catch (error) {
  report.sourceFixtureHashMatchesContainer = false;
  report.mediaVerificationFailure = { errorClass: error instanceof Error ? error.name : "UnknownError", step: "isolated host/container fixture hash preflight" };
  report.finishedAt = new Date().toISOString();
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  throw new Error("Isolated Music acceptance preflight failed");
}
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

console.log(`Live Music Playwright acceptance; artifacts: ${artifacts}`);
console.log(`Gateway: ${acceptanceUrl}`);
const result = spawnSync("npx", ["playwright", "test", "--config", "playwright.config.ts", "tests/acceptance/music-source-live.spec.ts"], {
  cwd: root, env: environment, stdio: "inherit",
});
if (result.error) throw result.error;
let exitCode = result.status ?? 1;
try {
  const containers = compose(["ps", "-q", engineService]).trim().split(/\r?\n/).filter(Boolean);
  if (containers.length !== 1 || containers[0] !== report.deployment.containerId) throw new Error("Isolated engine container changed during acceptance");
  const acceptance = JSON.parse(await readFile(reportPath, "utf8"));
  if (acceptance.fixture?.sha256 !== preflightHostHash) throw new Error("Uploaded fixture differs from the preflight source");
  report.mediaVerification = { source: mediaSummary(probe(containerSourcePath)), outputs: [] };
  report.mediaVerification.source.volumedetect = volumeSummary(containerSourcePath);
  const successfulClips = acceptance.clips ?? [];
  let outputFiles = [];
  if (acceptance.job?.id) {
    const diagnostic = String.raw`import json, sys
from engine.config import Settings
from engine.database import Database
from engine import media
job_id = sys.argv[1]
settings = Settings.from_env()
db = Database(settings.data_path / "s6-cut.sqlite3")
job = db.get_job(job_id)
private = db.get_job_private(job_id)
transcript = private.get("transcript") if isinstance(private, dict) else None
if not isinstance(job, dict) and job is not None:
    job = job.model_dump()
profile = str((job or {}).get("source_profile") or "speech")
language_hint = private.get("transcription_language")
options = media.transcription_options(settings, profile=profile, language=language_hint, word_timestamps=True)
cache_key = private.get("transcript_cache_key")
expected = media.transcription_cache_key(str(private.get("source_hash") or ""), settings, profile=profile, language=language_hint, word_timestamps=True)
transcript = transcript if isinstance(transcript, dict) else {}
words = transcript.get("words") if isinstance(transcript.get("words"), list) else []
segments = transcript.get("segments") if isinstance(transcript.get("segments"), list) else []
times = []
for row in [*words, *segments]:
    if isinstance(row, dict):
        for key in ("start", "end"):
            value = row.get(key)
            if isinstance(value, (int, float)):
                times.append(float(value))
summary = {"available": bool(transcript), "sourceProfile": profile, "audioConditioning": options["audio_conditioning"], "effectiveModel": options["model"], "device": options["device"], "computeType": options["compute_type"], "beamSize": options["beam_size"], "vadFilter": options["vad_filter"], "wordTimestamps": options["word_timestamps"], "language": {"mode": "hint" if language_hint else "Auto", "hint": language_hint, "detected": transcript.get("language")}, "cacheIdentity": {"stored": cache_key, "matchesCurrentOptions": cache_key == expected}, "wordCount": len(words), "segmentCount": len(segments), "transcriptTimestampExtentSeconds": {"start": min(times) if times else None, "end": max(times) if times else None}}
summary["outputFiles"] = [clip.get("output_name") for clip in ((job or {}).get("clips") or []) if isinstance(clip, dict) and isinstance(clip.get("output_name"), str)]
print(json.dumps(summary, separators=(",", ":")))`;
    try {
      const runtimeDiagnostics = JSON.parse(inEngine("python", "-c", diagnostic, acceptance.job.id));
      outputFiles = runtimeDiagnostics.outputFiles;
      delete runtimeDiagnostics.outputFiles;
      report.runtimeTranscript = runtimeDiagnostics;
    } catch (error) {
      report.runtimeTranscriptFailure = { errorClass: error instanceof Error ? error.name : "UnknownError" };
    }
  }
  for (const [clipPosition, clip] of successfulClips.entries()) {
    const outputName = outputFiles[clipPosition];
    if (typeof outputName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(outputName) || outputName === "." || outputName === "..") throw new Error("Output filename unavailable or unsafe");
    if (!acceptance.job?.id || !/^[A-Za-z0-9_-]+$/.test(acceptance.job.id)) throw new Error("Persisted job id unavailable or unsafe");
    const outputPath = `${containerOutputDir.replace(/\/$/, "")}/${acceptance.job.id}/clips/${outputName}`;
    const output = mediaSummary(probe(outputPath));
    const audioLevels = volumeSummary(outputPath);
    // Allow one source frame for timestamp rounding; assume 24 fps if probe lacks a rate.
    const frameTolerance = report.mediaVerification.source.frameRate > 0 ? 1 / report.mediaVerification.source.frameRate : 1 / 24;
    const withinSource = Number(clip.end) <= report.mediaVerification.source.duration + frameTolerance;
    const nonSilent = Number.isFinite(audioLevels.meanVolumeDb) && Number.isFinite(audioLevels.maxVolumeDb) && audioLevels.maxVolumeDb > -60;
    const tolerance = output.frameRate > 0 ? 1 / output.frameRate : null;
    const expectedFrames = output.frameRate > 0 ? Math.round(Number(clip.duration) * output.frameRate) : null;
    const actualFrames = output.frameRate > 0 ? Math.round(output.duration * output.frameRate) : null;
    const roundedDuration = expectedFrames === null ? null : expectedFrames / output.frameRate;
    const durationMatchesFrames = actualFrames !== null && output.frameRate > 0 &&
      Math.abs(output.duration - actualFrames / output.frameRate) <= tolerance;
    const frameDelta = actualFrames !== null && expectedFrames !== null ? actualFrames - expectedFrames : null;
    const minimumFrames = output.frameRate > 0 ? Math.round(8 * output.frameRate) : null;
    const maximumFrames = output.frameRate > 0 ? Math.round(20 * output.frameRate) : null;
    const valid = output.hasVideo && output.hasAudio && tolerance !== null && actualFrames >= minimumFrames && actualFrames <= maximumFrames &&
      frameDelta !== null && Math.abs(frameDelta) <= 1 && durationMatchesFrames && withinSource && nonSilent;
    const summary = { index: clip.index, filenameSha256: createHash("sha256").update(outputName).digest("hex"), ...output, requestedDuration: clip.duration, expectedFrames, actualFrames, minimumFrames, maximumFrames, roundedDuration, frameDelta, durationMatchesFrames, frameToleranceSeconds: tolerance, volumedetect: audioLevels, sourceEndWithinDuration: withinSource, sourceFrameToleranceSeconds: frameTolerance, nonSilent, valid };
    report.mediaVerification.outputs.push(summary);
    if (!valid) exitCode = 1;
  }
  const source = report.mediaVerification.source;
  if (!source.hasVideo || !source.hasAudio || !(source.duration > 0)) exitCode = 1;
  if (!successfulClips.length) exitCode = 1;
  outputFiles = [];
} catch (error) {
  report.mediaVerificationFailure = { errorClass: error instanceof Error ? error.name : "UnknownError", step: "isolated ffprobe/ffmpeg verification" };
  exitCode = 1;
}
let acceptanceReport = null;
try {
  acceptanceReport = JSON.parse(await readFile(reportPath, "utf8"));
} catch {
  // Preserve the sanitized harness report if Playwright did not produce its report.
}
await writeFile(reportPath, `${JSON.stringify({ ...acceptanceReport, ...report, fixture: { ...report.fixture, ...(acceptanceReport?.fixture ?? {}) }, deployment: { ...(acceptanceReport?.deployment ?? {}), ...report.deployment }, finishedAt: new Date().toISOString() }, null, 2)}\n`);
process.exitCode = exitCode;
