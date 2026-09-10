import { randomBytes } from "node:crypto";
import { access as fsAccess, chmod, cp, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

async function directoryExists(directory) {
  try { await fsAccess(directory); return true; } catch { return false; }
}

const composeFile = join(root, "compose.yaml");
const artifacts = join(root, "test-artifacts", "openrouter-fallback");
await mkdir(artifacts, { recursive: true });
// The isolated dataset must be bind-mountable by the Docker daemon. The OS
// temp directory is not: Docker Desktop only shares an explicit list of host
// paths, and `/tmp` is not on it by default, so mounting from there fails with
// "mounts denied" before the stack can start. The repository is already a
// shared path — compose.yaml binds ./data — so the ignored test-artifacts
// directory is the portable place for a throwaway dataset. `cleanup()` removes
// it on every exit path.
const isolatedData = await mkdtemp(join(artifacts, "..", "openrouter-fallback-data-"));
// Compose runs the engine as uid 10001. Keep this test dataset isolated while
// allowing that container user to create its SQLite, job, and blob directories.
const overrideFile = join(isolatedData, "compose.override.yaml");
const project = `s6-openrouter-fallback-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const environment = {
  ...process.env,
  S6_DATA_PATH: isolatedData,
  S6_PORT: "18080",
  S6_ENGINE_PORT: "18001",
  S6_ACCEPTANCE_URL: "http://127.0.0.1:18080",
  S6_E2E_PROFILE_KEY: `fixture-${randomBytes(24).toString("hex")}`,
};
const compose = ["compose", "-p", project, "-f", composeFile, "-f", overrideFile];
let cleanupPromise;

async function run(command, args, options = {}) {
  const { timeoutMs = 15 * 60_000, ...spawnOptions } = options;
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, env: environment, stdio: "inherit", ...spawnOptions });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolvePromise();
        return;
      }
      const error = new Error(`${command} exited with ${code ?? signal}`);
      error.exitCode = code ?? 1;
      reject(error);
    });
  });
}

async function capture(command, args, options = {}) {
  const { timeoutMs = 120_000, ...spawnOptions } = options;
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"], ...spawnOptions });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolvePromise(stdout);
        return;
      }
      const error = new Error(`${command} exited with ${code ?? signal}: ${stderr.slice(-1000)}`);
      error.exitCode = code ?? 1;
      reject(error);
    });
  });
}

async function cleanup() {
  if (!cleanupPromise) {
    cleanupPromise = (async () => {
      try { await run("docker", [...compose, "down", "--volumes", "--remove-orphans"], { timeoutMs: 120_000 }); } catch (error) { console.error(error); }
      await rm(isolatedData, { recursive: true, force: true });
    })();
  }
  await cleanupPromise;
}

function stopOnSignal(signal) {
  const exitCode = signal === "SIGINT" ? 130 : 143;
  cleanup().finally(() => process.exit(exitCode));
}
process.once("SIGINT", () => stopOnSignal("SIGINT"));
process.once("SIGTERM", () => stopOnSignal("SIGTERM"));

async function waitForGateway() {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${environment.S6_ACCEPTANCE_URL}/healthz`);
      if (response.ok) return;
    } catch {
      // The engine and nginx start independently; keep waiting for readiness.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error("Isolated S6_cut gateway did not become ready");
}

async function validateOutput() {
  const outputPath = join(artifacts, "fallback-output.mp4");
  const outputStat = await stat(outputPath);
  if (outputStat.size <= 1024) throw new Error("The acceptance output video is empty");
  await cp(outputPath, join(isolatedData, "qa-output.mp4"));
  const probeText = await capture("docker", [
    ...compose, "run", "--rm", "--no-deps", "engine", "ffprobe", "-v", "error",
    "-show_entries", "stream=codec_type,codec_name,width,height,duration:format=duration", "-of", "json", "/app/data/qa-output.mp4",
  ]);
  const probe = JSON.parse(probeText);
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  if (!video || video.codec_name !== "h264" || video.width !== 1080 || video.height !== 1920) {
    throw new Error("Acceptance output is not the expected 1080x1920 H.264 video");
  }
  if (!audio || !Number(probe.format?.duration || video.duration) || Number(probe.format?.duration || video.duration) <= 0) {
    throw new Error("Acceptance output has no plausible audio/duration metadata");
  }
  await run("docker", [
    ...compose, "run", "--rm", "--no-deps", "engine", "ffmpeg", "-v", "error", "-i", "/app/data/qa-output.mp4",
    "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-",
  ]);
  console.log(`Validated output: ${outputStat.size} bytes, ${video.width}x${video.height}, ${probe.format?.duration ?? video.duration}s, H.264/AAC`);
}

let exitCode = 1;
try {
  await chmod(isolatedData, 0o777);
  // Reuse the already-downloaded local Whisper model without putting model
  // downloads on the acceptance test's critical path.
  const modelCache = join(root, "data", "models");
  if (await directoryExists(modelCache)) await cp(modelCache, join(isolatedData, "models"), { recursive: true });
  await writeFile(overrideFile, `services:\n  engine:\n    user: "${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}"\n    environment:\n      S6_TEST_MODE: "1"\n      S6_TEST_OPENROUTER_FAILURE: "timeout"\n`);
  console.log("OpenRouter fallback E2E: application runs in an isolated Docker Compose stack; Playwright runs on the host against its gateway.");
  await run("docker", [...compose, "up", "-d", "--build"]);
  await waitForGateway();
  const traceArgs = process.env.S6_ACCEPTANCE_TRACE ? ["--trace", process.env.S6_ACCEPTANCE_TRACE] : [];
  await run("npm", ["run", "test:acceptance", "--", ...traceArgs, "tests/acceptance/openrouter-fallback.spec.ts"], { env: environment });
  await validateOutput();
  exitCode = 0;
} catch (error) {
  console.error(error);
  exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
} finally {
  await cleanup();
}
process.exitCode = exitCode;
