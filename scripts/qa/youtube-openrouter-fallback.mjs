/**
 * Isolated YouTube import + runtime OpenRouter failure acceptance run.
 *
 * Stands up a throwaway S6_cut Compose stack with its own dataset and unique
 * ports, connects a provider profile that is made to fail at runtime, then
 * drives the real YouTube URL workflow in Smart mode through the browser UI and
 * validates the media the application actually produced.
 *
 * Failure injection lives only in this throwaway stack, through `S6_TEST_MODE`
 * — never in production. The import itself is the production code path: the
 * application's own constrained yt-dlp integration performs it, and nothing
 * here bypasses authentication, age or geographic restrictions, rate limits,
 * bot protection, or signatures.
 *
 * The imported source is copied out of the throwaway dataset before teardown so
 * output-to-source correspondence can be proven after the stack is gone. That
 * copy is media downloaded from YouTube: it lives only under the ignored
 * test-artifacts directory and is deleted once validation has finished, unless
 * `--retain-source` explicitly keeps it for diagnosis.
 */
import { randomBytes } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const composeFile = join(root, "compose.yaml");
const artifactsRelative = "test-artifacts/youtube-openrouter";
const artifacts = join(root, artifactsRelative);
await mkdir(join(artifacts, "reports"), { recursive: true });

const youtubeUrl = process.env.S6_YOUTUBE_URL;
if (!youtubeUrl) {
  console.error("S6_YOUTUBE_URL must supply the authorised public YouTube URL under test.");
  process.exit(2);
}
const retainSource = process.argv.includes("--retain-source");

function run(command, args, options = {}) {
  const { timeoutMs = 90 * 60_000, env = process.env, ...spawnOptions } = options;
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

function capture(command, args, options = {}) {
  const { env = process.env, timeoutMs = 120_000 } = options;
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { out += chunk; });
    child.once("error", () => { clearTimeout(timer); resolvePromise(out); });
    child.once("exit", () => { clearTimeout(timer); resolvePromise(out); });
  });
}

const data = await mkdtemp(join(root, "test-artifacts", "youtube-openrouter-data-"));
await chmod(data, 0o777);
const overrideFile = join(data, "compose.override.yaml");
const project = `s6-yt-or-${process.pid}-${Date.now()}-${randomBytes(3).toString("hex")}`;
const port = process.env.S6_YOUTUBE_OR_PORT || "19086";
const enginePort = process.env.S6_YOUTUBE_OR_ENGINE_PORT || "19007";
const url = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  S6_DATA_PATH: data,
  S6_PORT: String(port),
  S6_ENGINE_PORT: String(enginePort),
  S6_ACCEPTANCE_URL: url,
  S6_YOUTUBE_URL: youtubeUrl,
  S6_YOUTUBE_ROOT: artifactsRelative,
  // The isolated harness supplies the profile key so the spec never types a
  // credential into a password field that Playwright would record in a trace.
  S6_E2E_PROFILE_KEY: `fixture-${randomBytes(24).toString("hex")}`,
};
const compose = ["compose", "-p", project, "-f", composeFile, "-f", overrideFile];
let torn = false;

/** Keep the engine log before teardown, with session material stripped out. */
async function captureDiagnostics(label) {
  const log = await capture("docker", [...compose, "logs", "--no-color", "--tail", "6000", "engine"], { env });
  const sanitized = log
    .replace(/https?:\/\/[^\s"']*googlevideo[^\s"']*/gi, "<signed-cdn-url-redacted>")
    .replace(/(cookie|authorization|set-cookie)\s*[:=]\s*\S+/gi, "$1: <redacted>")
    .replace(/[?&](sig|signature|lsig|pot|token)=[^&\s"']*/gi, "&$1=<redacted>")
    .replace(/("?(?:poToken|integrityToken|visitorData|potc?)"?\s*[:=]\s*"?)[A-Za-z0-9_\-=+/]{16,}"?/gi, "$1<redacted>")
    .replace(/\bpo_token=[^\s&"']+/gi, "po_token=<redacted>")
    .split(env.S6_E2E_PROFILE_KEY).join("<profile-key-redacted>");
  await writeFile(join(artifacts, "reports", `engine-log-${label}.txt`), sanitized);
  console.log(`engine log saved (sanitized): reports/engine-log-${label}.txt`);
}

/** Copy the imported YouTube source out so correspondence survives teardown. */
async function preserveImportedSources() {
  const found = [];
  const jobsDir = join(data, "jobs");
  let entries = [];
  try { entries = await readdir(jobsDir); } catch { return found; }
  const destination = join(artifacts, "imported-source");
  await mkdir(destination, { recursive: true });
  const isMedia = (name) => /^source-.*\.(mp4|mkv|webm|mov|m4v|avi)$/i.test(name);
  for (const jobId of entries) {
    // The engine downloads into `jobs/<job id>/source/` (JobManager._source);
    // older datasets kept the file directly in the job directory. Check the
    // real layout first and fall back, so both are preserved.
    for (const dir of [join(jobsDir, jobId, "source"), join(jobsDir, jobId)]) {
      let files = [];
      try { files = await readdir(dir); } catch { continue; }
      for (const file of files) {
        if (!isMedia(file)) continue;
        const target = join(destination, `${jobId}-${file}`);
        await cp(join(dir, file), target);
        found.push(target);
        console.log(`preserved imported source: ${basename(target)}`);
      }
      if (found.length) break;
    }
  }
  // A completed import that preserved nothing means the dataset layout moved.
  // Say so here, where the dataset still exists, rather than letting the
  // correspondence step fail later with no way to diagnose it.
  if (entries.length && !found.length) {
    console.error(`no imported source found under ${jobsDir} for ${entries.length} job(s); `
      + "the engine's source layout may have changed");
  }
  return found;
}

async function teardown({ keepLogs = false, label = "youtube-openrouter" } = {}) {
  if (torn) return;
  torn = true;
  if (keepLogs) await captureDiagnostics(label);
  try { await run("docker", [...compose, "down", "--volumes", "--remove-orphans"], { timeoutMs: 180_000, env }); }
  catch (error) { console.error(error); }
  await rm(data, { recursive: true, force: true });
}
process.once("SIGINT", () => teardown({ keepLogs: true }).finally(() => process.exit(130)));
process.once("SIGTERM", () => teardown({ keepLogs: true }).finally(() => process.exit(143)));

async function waitForGateway() {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/healthz`);
      if (response.ok) return;
    } catch { /* keep waiting */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error("the isolated gateway did not become ready");
}

let exitCode = 1;
let sources = [];
try {
  // The engine runs as the invoking user so the throwaway dataset stays
  // writable and removable. The test hooks below exist only on this stack.
  await writeFile(overrideFile,
    `services:\n  engine:\n    user: "${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}"\n`
    + `    environment:\n      S6_TEST_MODE: "1"\n      S6_TEST_OPENROUTER_FAILURE: "timeout"\n`);
  console.log(`YouTube + OpenRouter failure E2E: isolated stack "${project}" on ${url}`);
  console.log(`dataset: ${data}`);
  await run("docker", [...compose, "up", "-d", "--build"], { env });
  await waitForGateway();

  const traceArgs = process.env.S6_ACCEPTANCE_TRACE ? ["--trace", process.env.S6_ACCEPTANCE_TRACE] : [];
  let specError = null;
  try {
    await run("npm", ["run", "test:acceptance", "--", ...traceArgs,
      "tests/acceptance/youtube-openrouter-fallback.spec.ts"], { env });
  } catch (error) {
    specError = error;
  }
  sources = await preserveImportedSources();
  await captureDiagnostics("youtube-openrouter");
  if (specError) throw specError;
  exitCode = 0;
} catch (error) {
  console.error(error);
  exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
} finally {
  await teardown();
}

if (exitCode === 0) {
  try {
    await run("node", ["scripts/qa/verify-youtube-outputs.mjs"], { timeoutMs: 60 * 60_000, env });
  } catch (error) {
    console.error(error);
    exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
  }
}

// The preserved source is downloaded YouTube media. Remove it unless it was
// explicitly retained for diagnosis; it must never be committed.
if (!retainSource) {
  for (const file of sources) {
    await rm(file, { force: true });
    console.log(`removed preserved YouTube media: ${basename(file)}`);
  }
  try { await rm(join(artifacts, "imported-source"), { recursive: true, force: true }); } catch { /* already gone */ }
} else if (sources.length) {
  console.log(`retained ${sources.length} imported source file(s) under ${artifactsRelative}/imported-source (gitignored)`);
}

process.exitCode = exitCode;
