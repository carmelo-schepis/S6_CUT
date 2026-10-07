/**
 * Isolated content-authenticity acceptance run.
 *
 * Phase 1 stands up a throwaway S6_cut Compose stack with NO test hooks — the
 * same code path a production deployment runs — and drives Smart and Fast clip
 * generation through the real browser UI.
 *
 * Phase 2 stands up a second throwaway stack with the provider-failure seam
 * enabled, so the OpenRouter fallback path is exercised against a real runtime
 * failure. The seam is never enabled in phase 1.
 *
 * The developer's own stack, dataset, Library, and provider profiles are never
 * touched: each phase uses its own Compose project name, ports, and dataset,
 * and removes both on exit.
 */
import { randomBytes } from "node:crypto";
import { access as fsAccess, cp, mkdir, mkdtemp, rm, chmod, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const composeFile = join(root, "compose.yaml");
const artifacts = join(root, "test-artifacts", "content-authenticity");
await mkdir(join(artifacts, "reports"), { recursive: true });

async function directoryExists(directory) {
  try { await fsAccess(directory); return true; } catch { return false; }
}

const fixtureDir = join(artifacts, "fixture");
const fixture = join(fixtureDir, "s6cut-authenticity-source.mp4");
const forensicsImage = process.env.S6_FORENSICS_IMAGE || "s6-cut-engine";

/**
 * Build the synthetic acceptance source if it is not already present.
 *
 * The fixture is generated rather than committed: it lives under the ignored
 * test-artifacts directory, so a fresh clone has to produce it. A throwaway
 * fixture-only image adds espeak-ng to the engine image to synthesize source
 * audio; the production engine image remains free of TTS tooling. The host
 * needs no media tooling. See scripts/qa/build-authenticity-fixture.sh for
 * what it contains and why the source narration avoids planner credit-roll
 * tokens.
 */
async function ensureFixture() {
  try {
    await fsAccess(fixture);
    console.log(`fixture present: ${fixture}`);
    return;
  } catch { /* build it below */ }
  console.log("building the synthetic acceptance fixture (no host FFmpeg required)…");
  await mkdir(fixtureDir, { recursive: true });
  await cp(join(root, "scripts", "qa", "build-authenticity-fixture.sh"), join(fixtureDir, "build-fixture.sh"));
  // The engine image is built by the first `compose up`; build it up front so
  // the fixture can be produced before any stack starts.
  await run("docker", ["build", "-f", join(root, "engine", "Dockerfile"), "-t", forensicsImage, root], { timeoutMs: 30 * 60_000 });
  const fixtureImage = `${forensicsImage}-authenticity-fixture`;
  await run("docker", ["build", "--build-arg", `BASE_IMAGE=${forensicsImage}`, "-f", join(root, "scripts", "qa", "Dockerfile.authenticity-fixture"), "-t", fixtureImage, root], { timeoutMs: 30 * 60_000 });
  await run("docker", ["run", "--rm", "--entrypoint", "sh",
    "-u", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    "-v", `${fixtureDir}:/work`, fixtureImage, "/work/build-fixture.sh"], { timeoutMs: 20 * 60_000 });
  console.log(`fixture built: ${fixture}`);
}

function run(command, args, options = {}) {
  const { timeoutMs = 45 * 60_000, env = process.env, ...spawnOptions } = options;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: "inherit", ...spawnOptions });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) { resolvePromise(); return; }
      const error = new Error(`${command} exited with ${code ?? signal}`);
      error.exitCode = code ?? 1;
      reject(error);
    });
  });
}

async function waitForGateway(url, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/healthz`);
      if (response.ok) return;
    } catch { /* nginx and the engine start independently; keep waiting */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error(`the isolated gateway at ${url} did not become ready`);
}

const active = [];

/**
 * Keep the engine's own log before the stack is destroyed. Without this a
 * render failure leaves nothing to diagnose: the container, its logs, and the
 * dataset all disappear in teardown.
 */
async function captureLogs(stack) {
  const target = join(artifacts, "reports", `engine-log-${stack.label}.txt`);
  await new Promise((resolvePromise) => {
    const child = spawn("docker", [...stack.compose, "logs", "--no-color", "--tail", "4000", "engine"],
      { cwd: root, env: stack.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", () => resolvePromise());
    child.once("exit", () => {
      writeFile(target, output).catch(() => undefined).finally(() => {
        console.log(`engine log saved: ${target}`);
        resolvePromise();
      });
    });
  });
}

async function teardown(stack, { keepLogs = false } = {}) {
  if (stack.torn) return;
  stack.torn = true;
  if (keepLogs) await captureLogs(stack);
  try { await run("docker", [...stack.compose, "down", "--volumes", "--remove-orphans"], { timeoutMs: 180_000, env: stack.env }); }
  catch (error) { console.error(error); }
  await rm(stack.data, { recursive: true, force: true });
}
async function teardownAll(options) { for (const stack of active) await teardown(stack, options); }
function stopOnSignal(signal) {
  teardownAll().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
}
process.once("SIGINT", () => stopOnSignal("SIGINT"));
process.once("SIGTERM", () => stopOnSignal("SIGTERM"));

/**
 * Start an isolated stack. `hooks` are extra engine environment entries; phase
 * 1 passes none so the production code path is what gets measured.
 */
async function startStack({ label, port, enginePort, hooks = {} }) {
  // The dataset must be bind-mountable by the Docker daemon; the OS temp
  // directory is not a Docker Desktop shared path, so it lives under the
  // ignored test-artifacts directory and is removed on teardown.
  const data = await mkdtemp(join(root, "test-artifacts", `content-authenticity-${label}-`));
  await chmod(data, 0o777);
  const overrideFile = join(data, "compose.override.yaml");
  const project = `s6-authenticity-${label}-${process.pid}-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const url = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    S6_DATA_PATH: data,
    S6_PORT: String(port),
    S6_ENGINE_PORT: String(enginePort),
    S6_ACCEPTANCE_URL: url,
    S6_AUTHENTICITY_FIXTURE: join(artifacts, "fixture", "s6cut-authenticity-source.mp4"),
    S6_E2E_PROFILE_KEY: `fixture-${randomBytes(24).toString("hex")}`,
    ...hooks,
  };
  const compose = ["compose", "-p", project, "-f", composeFile, "-f", overrideFile];
  const stack = { label, project, data, env, compose, url, torn: false };
  active.push(stack);

  // Reuse the already-downloaded Whisper model so a model download is not on
  // the acceptance test's critical path. Nothing is written back to it.
  const modelCache = join(root, "data", "models");
  if (await directoryExists(modelCache)) await cp(modelCache, join(data, "models"), { recursive: true });

  const engineEnv = Object.entries(hooks).map(([key, value]) => `      ${key}: "${value}"\n`).join("");
  await writeFile(overrideFile,
    `services:\n  engine:\n    user: "${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}"\n`
    + (engineEnv ? `    environment:\n${engineEnv}` : ""));

  console.log(`\n=== ${label} stack "${project}" on ${url} ===`);
  console.log(`dataset: ${data}${engineEnv ? `\nengine hooks: ${Object.keys(hooks).join(", ")}` : "\nno test hooks (production code path)"}`);
  await run("docker", [...compose, "up", "-d", "--build"], { env });
  await waitForGateway(url);
  return stack;
}

const traceArgs = process.env.S6_ACCEPTANCE_TRACE ? ["--trace", process.env.S6_ACCEPTANCE_TRACE] : [];
let exitCode = 1;
try {
  await ensureFixture();

  // --- Phase 1: production code path -------------------------------------
  const clean = await startStack({ label: "clean", port: 19080, enginePort: 19001 });
  await run("npm", ["run", "test:acceptance", "--", ...traceArgs,
    "tests/acceptance/content-authenticity.spec.ts",
    "-g", "Smart mode renders|Fast mode renders"], { env: clean.env });
  await teardown(clean);

  // --- Phase 2: real provider failure -------------------------------------
  const failing = await startStack({
    label: "providerfail", port: 19082, enginePort: 19003,
    hooks: { S6_TEST_MODE: "1", S6_TEST_OPENROUTER_FAILURE: "timeout" },
  });
  await run("npm", ["run", "test:acceptance", "--", ...traceArgs,
    "tests/acceptance/content-authenticity.spec.ts",
    "-g", "keeps rendering real video when OpenRouter fails"], { env: failing.env });
  await teardown(failing);
  exitCode = 0;
} catch (error) {
  console.error(error);
  exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
} finally {
  // On any failure keep the engine log of every stack still standing.
  await teardownAll({ keepLogs: exitCode !== 0 });
}

// Media validation runs against the downloaded files after the stacks are gone.
if (exitCode === 0) {
  try {
    await run("node", ["scripts/qa/verify-outputs.mjs"], { timeoutMs: 40 * 60_000 });
  } catch (error) {
    console.error(error);
    exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
  }
}
process.exitCode = exitCode;
