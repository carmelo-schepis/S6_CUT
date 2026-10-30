#!/usr/bin/env node
/**
 * Bounded, isolated, real-import acceptance runner for the editing presentation
 * feature (docs/plans/youtube-editing-style-library.md).
 *
 * What it does
 *   1. Validates user-supplied inputs (two explicit YouTube URLs + a manifest that
 *      records source URL / channel / interval / attribution, with a MANUAL
 *      interval verification attestation). Anything missing is reported as an
 *      UNMET live-test requirement (exit 3) and nothing is started.
 *   2. Starts a brand-new Compose project on loopback ports with a disposable
 *      absolute S6_DATA_PATH under ignored test-artifacts/. Production stacks and
 *      data are never attached to, restarted, or read.
 *   3. Runs tests/acceptance/editing-style-library-real.spec.ts (authentic UI
 *      imports + local Whisper; no transcript injection, no mocked import).
 *   4. Tears down only its own project and removes its disposable data.
 *
 * What it does NOT do: download or discover any reference video itself (the app
 * does the import, from URLs the user supplied), publish outputs, inject
 * S6_TEST_TRANSCRIPT_JSON, or copy secrets (the child environment is an
 * allowlist; compose reads an empty --env-file so no repository .env leaks in).
 *
 * S6_EDITING_VALIDATE_ONLY=1 validates inputs/manifest and exits without Docker.
 *
 * Exit codes: 0 PASS, 1 FAIL, 2 BLOCKED (bad configuration/preflight),
 *             3 UNMET (required live inputs missing), 4 INCOMPLETE/BLOCKED_EXTERNAL
 *             (spec ran but a required check was unmet or the external source
 *             failed after the allowed substitutions), 5 TIMEOUT (60 min live cap).
 */
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, rm, statfs, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LIVE_BUDGET_MS = 60 * 60_000;
const SETUP_BUDGET_MS = Number(process.env.S6_EDITING_SETUP_TIMEOUT_MIN || 30) * 60_000;
const MAX_SUBSTITUTIONS_PER_MODE = 2;
const OWNER_TAGS = new Set(["s6-cut-engine", "s6-cut-web", "s6-cut-engine:latest", "s6-cut-web:latest"]);
const OWNER_PORTS = new Set([8080, 8001]);
const MIN_FREE_GIB = 15;

const runId = `${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}-${process.pid}-${randomBytes(3).toString("hex")}`;
const project = `s6-editstyle-${runId}`.toLowerCase();
const runRoot = join(root, "test-artifacts", "editing-style-library", runId);
const dataRoot = join(runRoot, "data");
const playwrightRoot = join(runRoot, "playwright");
const tmpRoot = join(runRoot, "tmp");
const emptyEnvFile = join(runRoot, "empty.env");
const overrideFile = join(runRoot, "compose.override.yaml");
const reportFile = join(runRoot, "runner-report.json");

const report = { runId, project, startedAt: new Date().toISOString(), status: "STARTING", unmet: [], notes: [], exit: null };
let exitCode = 0;
const finish = async (status, code, extra = {}) => {
  Object.assign(report, { status, exit: code, finishedAt: new Date().toISOString() }, extra);
  try { await mkdir(runRoot, { recursive: true }); await writeFile(reportFile, JSON.stringify(report, null, 2)); } catch { /* best effort */ }
  console.log(`${status}: ${reportFile}`);
  return code;
};

// ---------------------------------------------------------------------------
// Input validation (no docker, no network). Missing inputs => UNMET, exit 3.
// ---------------------------------------------------------------------------
const unmet = [];
if (process.env.S6_EDITING_ACCEPTANCE !== "1") unmet.push("S6_EDITING_ACCEPTANCE=1 (explicit authorization to build an isolated stack and import user-supplied YouTube URLs)");
if (process.env.S6_TEST_TRANSCRIPT_JSON) unmet.push("S6_TEST_TRANSCRIPT_JSON must be unset: transcript injection is forbidden in this live journey");
const speechUrl = process.env.S6_EDITING_SPEECH_URL?.trim();
const musicUrl = process.env.S6_EDITING_MUSIC_URL?.trim();
const manifestPath = process.env.S6_EDITING_MANIFEST?.trim();
if (!speechUrl) unmet.push("S6_EDITING_SPEECH_URL (explicit plain public YouTube speech URL)");
if (!musicUrl) unmet.push("S6_EDITING_MUSIC_URL (explicit plain public YouTube sung-vocal URL)");
if (!manifestPath) unmet.push("S6_EDITING_MANIFEST (absolute path to the source manifest JSON; see docs/plans/youtube-editing-style-library-acceptance.md)");
else if (!isAbsolute(manifestPath)) unmet.push("S6_EDITING_MANIFEST must be an absolute path");

function youtubeId(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    const host = url.hostname.replace(/^www\.|^m\./, "");
    if (host === "youtu.be") return /^[\w-]{11}$/.test(url.pathname.slice(1)) ? url.pathname.slice(1) : null;
    if (host === "youtube.com") {
      const id = url.pathname === "/watch" ? url.searchParams.get("v") : url.pathname.startsWith("/shorts/") ? url.pathname.split("/")[2] : null;
      return id && /^[\w-]{11}$/.test(id) ? id : null;
    }
  } catch { /* invalid */ }
  return null;
}

/** A candidate is usable only with a recorded, manually-attested interval. */
function validateCandidate(label, candidate) {
  const problems = [];
  const need = (condition, text) => { if (!condition) problems.push(`${label}: ${text}`); };
  need(candidate && typeof candidate === "object", "candidate must be an object");
  if (!candidate || typeof candidate !== "object") return problems;
  need(youtubeId(candidate.url), "url must be an https youtube.com/watch?v=, /shorts/ or youtu.be URL with an 11-character id");
  need(typeof candidate.channel === "string" && candidate.channel.trim(), "channel is required");
  need(Number.isFinite(candidate.durationSeconds) && candidate.durationSeconds > 0, "durationSeconds (number, from the video page) is required");
  const interval = candidate.interval;
  need(interval && Number.isFinite(interval.startSeconds) && Number.isFinite(interval.endSeconds) && interval.startSeconds >= 0 && interval.endSeconds > interval.startSeconds, "interval.startSeconds/endSeconds are required (the span you manually verified)");
  if (interval && Number.isFinite(candidate.durationSeconds)) need(interval.endSeconds <= candidate.durationSeconds + 1, "interval must lie inside the video duration");
  need(typeof candidate.attribution === "string" && candidate.attribution.trim(), "attribution text is required");
  need(typeof candidate.reuseTerms === "string" && candidate.reuseTerms.trim(), "reuseTerms (licence / permission note for video AND audio) is required");
  const verification = candidate.verification;
  need(verification && typeof verification === "object", "verification block is required");
  if (verification && typeof verification === "object") {
    need(typeof verification.verifiedBy === "string" && verification.verifiedBy.trim(), "verification.verifiedBy is required");
    need(typeof verification.verifiedAt === "string" && !Number.isNaN(Date.parse(verification.verifiedAt)), "verification.verifiedAt must be an ISO timestamp");
    for (const key of ["intervalVerifiedManually", "audibleSpeechOrSinging", "noBurnedSubtitles", "noBurnedHeadings", "noDecorativeEmoji"])
      need(verification[key] === true, `verification.${key} must be true (verify the interval by watching/listening before execution)`);
  }
  return problems;
}

let manifest = null;
const candidates = { speech: [], music: [] };
if (manifestPath && isAbsolute(manifestPath)) {
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    unmet.push(`S6_EDITING_MANIFEST is unreadable or invalid JSON: ${error.message}`);
  }
}
if (manifest) {
  if (manifest.version !== 1) unmet.push("manifest.version must be 1");
  for (const [mode, primary] of [["speech", speechUrl], ["music", musicUrl]]) {
    const list = manifest[mode]?.candidates;
    if (!Array.isArray(list) || list.length === 0) { unmet.push(`manifest.${mode}.candidates must list the primary source (and optionally up to ${MAX_SUBSTITUTIONS_PER_MODE} manually vetted substitutions)`); continue; }
    if (list.length > 1 + MAX_SUBSTITUTIONS_PER_MODE) unmet.push(`manifest.${mode}.candidates has ${list.length} entries; at most 1 primary + ${MAX_SUBSTITUTIONS_PER_MODE} substitutions are allowed`);
    list.slice(0, 1 + MAX_SUBSTITUTIONS_PER_MODE).forEach((candidate, index) => unmet.push(...validateCandidate(`manifest.${mode}.candidates[${index}]`, candidate)));
    if (primary && list[0]?.url !== primary) unmet.push(`S6_EDITING_${mode.toUpperCase()}_URL must equal manifest.${mode}.candidates[0].url so the recorded interval belongs to the imported URL`);
    candidates[mode] = list.slice(0, 1 + MAX_SUBSTITUTIONS_PER_MODE);
  }
}
for (const [name, value] of [["S6_EDITING_ENGINE_IMAGE", process.env.S6_EDITING_ENGINE_IMAGE], ["S6_EDITING_WEB_IMAGE", process.env.S6_EDITING_WEB_IMAGE]])
  if (value && OWNER_TAGS.has(value)) unmet.push(`${name}=${value} is an owner deployment tag; use a uniquely tagged branch image (or unset to build one)`);
if (Boolean(process.env.S6_EDITING_ENGINE_IMAGE) !== Boolean(process.env.S6_EDITING_WEB_IMAGE)) unmet.push("set both S6_EDITING_ENGINE_IMAGE and S6_EDITING_WEB_IMAGE, or neither (neither => build uniquely tagged images)");

if (unmet.length) {
  console.error("UNMET live-test requirements (nothing was started, nothing was imported):");
  for (const item of unmet) console.error(`  - ${item}`);
  report.unmet = unmet;
  process.exit(await finish("UNMET", 3));
}

if (process.env.S6_EDITING_VALIDATE_ONLY === "1") {
  console.log("Inputs and manifest validate. S6_EDITING_VALIDATE_ONLY=1: no stack was built, nothing was imported.");
  process.exit(await finish("VALIDATED_ONLY", 0, { notes: ["inputs validated; no live journey was run"] }));
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------
await mkdir(dataRoot, { recursive: true });
await mkdir(playwrightRoot, { recursive: true });
await mkdir(tmpRoot, { recursive: true });
await writeFile(emptyEnvFile, "");
await chmod(dataRoot, 0o777); // engine runs as uid 10001
if (project === "s6-cut" || !project.startsWith("s6-editstyle-")) process.exit(await finish("BLOCKED", 2, { notes: ["refusing a non-unique Compose project name"] }));
if (!isAbsolute(dataRoot) || !dataRoot.startsWith(join(root, "test-artifacts") + "/")) process.exit(await finish("BLOCKED", 2, { notes: ["S6_DATA_PATH is not under test-artifacts/"] }));
const ignored = spawnSync("git", ["check-ignore", "-q", "test-artifacts/placeholder"], { cwd: root });
if (ignored.status !== 0) process.exit(await finish("BLOCKED", 2, { notes: ["test-artifacts/ is not git-ignored here; refusing to write media/private data"] }));
const composeVersion = spawnSync("docker", ["compose", "version", "--short"], { encoding: "utf8" });
if (composeVersion.status !== 0) process.exit(await finish("BLOCKED", 2, { notes: [`docker compose unavailable: ${composeVersion.stderr?.trim()}`] }));
try {
  const fs = await statfs(runRoot);
  const freeGiB = Number(fs.bavail) * Number(fs.bsize) / 2 ** 30;
  if (freeGiB < MIN_FREE_GIB) process.exit(await finish("BLOCKED", 2, { notes: [`only ${freeGiB.toFixed(1)} GiB free under test-artifacts; need >= ${MIN_FREE_GIB} GiB for build + downloads`] }));
} catch { /* statfs unsupported: continue */ }

async function freePort() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const server = createServer();
    await new Promise((res, rej) => server.once("error", rej).listen(0, "127.0.0.1", res));
    const { port } = server.address();
    await new Promise((res, rej) => server.close((error) => error ? rej(error) : res()));
    if (!OWNER_PORTS.has(port)) return port;
  }
  throw new Error("could not allocate a non-owner loopback port");
}
const webPort = await freePort();
let enginePort = await freePort();
while (enginePort === webPort) enginePort = await freePort();
const gateway = `http://127.0.0.1:${webPort}`;

// Child environment: allowlist only. No API keys/tokens are copied.
const passthrough = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT", "XDG_RUNTIME_DIR", "XDG_CACHE_HOME", "PLAYWRIGHT_BROWSERS_PATH", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"];
const baseEnv = Object.fromEntries(passthrough.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
const revision = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).stdout?.trim() || "unknown";
const stackEnv = {
  ...baseEnv,
  TMPDIR: tmpRoot, // /tmp can be full on the host
  S6_PORT: `127.0.0.1:${webPort}`,
  S6_ENGINE_PORT: String(enginePort),
  S6_DATA_PATH: dataRoot,
  S6_BUILD_REVISION: revision,
  OPENROUTER_API_KEY: "", // engine-only; the isolated stack never receives a provider key
  ...(process.env.S6_EDITING_WHISPER_MODEL ? { S6_WHISPER_MODEL: process.env.S6_EDITING_WHISPER_MODEL } : {}),
  ...(process.env.S6_EDITING_MUSIC_WHISPER_MODEL ? { S6_MUSIC_WHISPER_MODEL: process.env.S6_EDITING_MUSIC_WHISPER_MODEL } : {}),
};
const prebuilt = Boolean(process.env.S6_EDITING_ENGINE_IMAGE);
await writeFile(overrideFile, prebuilt
  ? `services:\n  engine:\n    image: ${process.env.S6_EDITING_ENGINE_IMAGE}\n  web:\n    image: ${process.env.S6_EDITING_WEB_IMAGE}\n`
  : "services: {}\n");
const compose = ["compose", "-p", project, "--env-file", emptyEnvFile, "-f", join(root, "compose.yaml"), "-f", overrideFile];

// ---------------------------------------------------------------------------
// Process helpers with hard kill support
// ---------------------------------------------------------------------------
const children = new Set();
function run(command, args, { env, label, stdio = "inherit", timeoutMs } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio, detached: true });
    children.add(child);
    const timer = timeoutMs ? setTimeout(() => { terminate(child); reject(Object.assign(new Error(`${label || command} exceeded ${Math.round(timeoutMs / 1000)}s`), { timeout: true })); }, timeoutMs) : null;
    child.once("error", (error) => { children.delete(child); clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => {
      children.delete(child); clearTimeout(timer);
      code === 0 ? resolvePromise() : reject(Object.assign(new Error(`${label || command} exited ${code ?? signal}`), { code }));
    });
  });
}
function terminate(child) {
  try { process.kill(-child.pid, "SIGTERM"); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } }, 10_000).unref();
}
let interrupted = null;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { interrupted = signal; for (const child of children) terminate(child); });

const capture = (args) => spawnSync("docker", args, { encoding: "utf8", env: stackEnv });

async function waitHealthy() {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline && !interrupted) {
    try { if ((await fetch(`${gateway}/healthz`)).ok) return; } catch { /* starting */ }
    await new Promise((res) => setTimeout(res, 1_000));
  }
  throw new Error(`isolated gateway ${gateway} not healthy within 240 s`);
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------
let up = false;
let engineImageId = "";
let specStatus = "NOT_RUN";
try {
  console.log(`Isolated stack ${project} -> ${gateway} (engine loopback ${enginePort}); data=${dataRoot}`);
  console.log(`Sources: speech=${candidates.speech[0].url}  music=${candidates.music[0].url}  (live budget ${LIVE_BUDGET_MS / 60_000} min, ${MAX_SUBSTITUTIONS_PER_MODE} substitutions/mode max)`);
  up = true;
  await run("docker", [...compose, "up", "-d", ...(prebuilt ? ["--no-build"] : ["--build"])], { env: stackEnv, label: "compose up", timeoutMs: SETUP_BUDGET_MS });
  await waitHealthy();

  // Prove isolation before any import: our project, our data mount, loopback bind.
  const engineContainer = capture([...compose, "ps", "-q", "engine"]).stdout.trim().split("\n")[0];
  if (!engineContainer) throw new Error("engine container not found in the isolated project");
  const inspect = JSON.parse(capture(["inspect", engineContainer]).stdout)[0];
  const mount = inspect.Mounts.find((item) => item.Destination === "/app/data");
  if (inspect.Config.Labels["com.docker.compose.project"] !== project) throw new Error("engine container is not in the unique project");
  if (!mount || mount.Source !== dataRoot) throw new Error(`engine data mount ${mount?.Source} is not the disposable ${dataRoot}`);
  const published = JSON.stringify(inspect.NetworkSettings.Ports);
  if (!published.includes("127.0.0.1") || published.includes("0.0.0.0")) throw new Error(`engine port is not loopback-only: ${published}`);
  engineImageId = inspect.Image;
  report.isolation = { project, gateway, dataRoot, engineContainer, engineImageId, buildRevision: revision, composeVersion: composeVersion.stdout.trim() };

  const validatedManifest = join(runRoot, "manifest.validated.json");
  await writeFile(validatedManifest, JSON.stringify({ speech: candidates.speech, music: candidates.music, maxSubstitutionsPerMode: MAX_SUBSTITUTIONS_PER_MODE }, null, 2));
  const deadline = Date.now() + LIVE_BUDGET_MS;
  report.liveDeadline = new Date(deadline).toISOString();
  const specEnv = {
    ...stackEnv,
    S6_ACCEPTANCE_URL: gateway,
    S6_ACCEPTANCE_ISOLATED: "1",
    S6_PLAYWRIGHT_ARTIFACTS: playwrightRoot,
    S6_EDITING_RUNNER: "1",
    S6_EDITING_RUN_ID: runId,
    S6_EDITING_ARTIFACTS: runRoot,
    S6_EDITING_MANIFEST_VALIDATED: validatedManifest,
    S6_EDITING_DEADLINE_MS: String(deadline),
    S6_EDITING_ENGINE_IMAGE_ID: engineImageId,
    S6_EDITING_ENGINE_CONTAINER: engineContainer,
    S6_EDITING_COMPOSE_PROJECT: project,
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^S6_EDITING_(SPEECH|MUSIC)_(STYLE|FILTER|HEADING|EMOJI|THEME|ANIMATION)$|^S6_EDITING_(UNAVAILABLE_URL|INCLUDE_CAPTIONS_OFF_FILTER|SKIP_RESTART|TEST_GREP)$/.test(key))),
  };
  try {
    const grep = process.env.S6_EDITING_TEST_GREP?.trim();
    await run("npm", ["run", "test:acceptance", "--", "--project=Desktop Chromium", ...(grep ? ["--grep", grep] : []), "tests/acceptance/editing-style-library-real.spec.ts"], { env: specEnv, label: "playwright", timeoutMs: LIVE_BUDGET_MS + 5 * 60_000 });
    specStatus = "SPEC_PASSED";
  } catch (error) {
    specStatus = error.timeout ? "TIMEOUT" : "SPEC_FAILED";
  }
  report.spec = specStatus;
  try { report.live = JSON.parse(await readFile(join(runRoot, "live-report.json"), "utf8")); } catch { report.live = null; }
} catch (error) {
  console.error(`BLOCKED/FAILED before or during the live campaign: ${error.message}`);
  report.notes.push(error.message);
  specStatus = "BLOCKED";
} finally {
  if (up) {
    try { const logs = capture([...compose, "logs", "--no-color", "--tail", "2000"]); await writeFile(join(runRoot, "compose.log"), `${logs.stdout}\n${logs.stderr}`); } catch { /* best effort */ }
    try { await run("docker", [...compose, "down", "--volumes", "--remove-orphans"], { env: stackEnv, label: "compose down", timeoutMs: 180_000 }); } catch (error) { console.error(`Teardown of ${project} failed: ${error.message}`); report.notes.push(`teardown failed: ${error.message}`); exitCode = exitCode || 1; }
  }
  // Data written by the engine container (uid 10001) must be made removable first.
  if (engineImageId) {
    const fix = spawnSync("docker", ["run", "--rm", "--network", "none", "--volume", `${dataRoot}:/data:rw`, "--entrypoint", "sh", engineImageId, "-lc", "chmod -R a+rwX /data 2>/dev/null || true"], { encoding: "utf8", env: baseEnv });
    if (fix.status !== 0) report.notes.push(`could not relax permissions on disposable data: ${fix.stderr?.trim()}`);
  }
  if (process.env.S6_EDITING_KEEP_DATA === "1") report.notes.push(`disposable data kept: ${dataRoot}`);
  else await rm(dataRoot, { recursive: true, force: true }).catch((error) => report.notes.push(`data removal failed: ${error.message}`));
  await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  if (up && !prebuilt && process.env.S6_EDITING_KEEP_IMAGES !== "1") {
    for (const service of ["engine", "web"]) spawnSync("docker", ["image", "rm", `${project}-${service}`], { stdio: "ignore", env: baseEnv });
  }
}

const live = report.live;
let status;
if (interrupted) { status = "INTERRUPTED"; exitCode = 130; }
else if (specStatus === "TIMEOUT") { status = "TIMEOUT"; exitCode = 5; }
else if (specStatus === "BLOCKED") { status = "BLOCKED"; exitCode = 2; }
else if (specStatus === "SPEC_PASSED" && live?.status === "PASS") { status = "PASS"; exitCode = exitCode || 0; }
else if (live?.status === "BLOCKED_EXTERNAL" || live?.status === "INCOMPLETE") { status = live.status; exitCode = 4; }
else { status = "FAIL"; exitCode = 1; }
if (specStatus === "SPEC_PASSED" && live?.status !== "PASS" && status === "FAIL") report.notes.push("spec exited 0 but live-report.json did not say PASS; treated as FAIL");
console.log(`${status} — editing style library acceptance. Evidence: ${runRoot}`);
if (live?.unmet?.length) for (const item of live.unmet) console.log(`  unmet: ${item}`);
process.exit(await finish(status, exitCode));
