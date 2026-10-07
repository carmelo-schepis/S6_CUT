/**
 * Isolated YouTube-import acceptance run.
 *
 * Stands up a throwaway S6_cut Compose stack with its own dataset and unique
 * ports, drives the real YouTube URL workflow through the browser UI, then
 * validates the media the application actually produced.
 *
 * No test hooks are enabled: this is the production code path. The application's
 * own constrained yt-dlp integration performs the import — nothing here
 * bypasses authentication, age or geographic restrictions, rate limits, bot
 * protection, or signatures.
 *
 * The imported source is copied out of the throwaway dataset before teardown so
 * output-to-source correspondence can be proven after the stack is gone. That
 * copy is media downloaded from YouTube: it lives only under the ignored
 * test-artifacts directory and is deleted once validation has finished, unless
 * `--retain-source` explicitly keeps it for diagnosis.
 */
import { randomBytes } from "node:crypto";
import { access as fsAccess, cp, mkdir, mkdtemp, readdir, rm, chmod, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve, basename } from "node:path";
import { spawn } from "node:child_process";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const composeFile = join(root, "compose.yaml");
const artifacts = join(root, "test-artifacts", "youtube-import");
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

const data = await mkdtemp(join(root, "test-artifacts", "youtube-import-data-"));
await chmod(data, 0o777);
const overrideFile = join(data, "compose.override.yaml");
const project = `s6-youtube-${process.pid}-${Date.now()}-${randomBytes(3).toString("hex")}`;
const port = process.env.S6_YOUTUBE_PORT || "19084";
const enginePort = process.env.S6_YOUTUBE_ENGINE_PORT || "19005";
const url = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  S6_DATA_PATH: data,
  S6_PORT: String(port),
  S6_ENGINE_PORT: String(enginePort),
  S6_ACCEPTANCE_URL: url,
  S6_YOUTUBE_URL: youtubeUrl,
};
const compose = ["compose", "-p", project, "-f", composeFile, "-f", overrideFile];
let torn = false;

/** Keep the engine log and sanitized yt-dlp diagnostics before teardown. */
async function captureDiagnostics(label) {
  const log = await capture("docker", [...compose, "logs", "--no-color", "--tail", "6000", "engine"], { env });
  // Strip anything that could carry a signed CDN URL, cookie, auth header, or
  // an ephemeral bot-protection token. These are not user credentials, but they
  // are session secrets and must not reach a retained artifact.
  const sanitized = log
    .replace(/https?:\/\/[^\s"']*googlevideo[^\s"']*/gi, "<signed-cdn-url-redacted>")
    .replace(/(cookie|authorization|set-cookie)\s*[:=]\s*\S+/gi, "$1: <redacted>")
    .replace(/[?&](sig|signature|lsig|pot|token)=[^&\s"']*/gi, "&$1=<redacted>")
    .replace(/("?(?:poToken|integrityToken|visitorData|potc?)"?\s*[:=]\s*"?)[A-Za-z0-9_\-=+/]{16,}"?/gi, "$1<redacted>")
    .replace(/\bpo_token=[^\s&"']+/gi, "po_token=<redacted>");
  await writeFile(join(artifacts, "reports", `engine-log-${label}.txt`), sanitized);
  console.log(`engine log saved (sanitized): reports/engine-log-${label}.txt`);
}

/**
 * Record safe public metadata for the URL under test, using the application's
 * own format selector and extractor arguments so the recorded resolution is the
 * one the import will actually choose. This is a metadata-only simulation: no
 * media is fetched, and only a whitelist of public fields is retained — never
 * signed CDN URLs, cookies, request headers, or any other session material.
 */
async function recordPublicMetadata() {
  const selector = "bv*[height<=1080]+ba/b[height<=1080]";
  const raw = await capture("docker", [...compose, "exec", "-T", "engine", "yt-dlp",
    "--no-playlist", "--no-warnings", "--simulate", "--dump-single-json",
    "--format", selector,
    "--extractor-args", "youtube:player_client=mweb",
    "--extractor-args", "youtubepot-bgutilhttp:base_url=http://pot-provider:4416",
    youtubeUrl], { env, timeoutMs: 300_000 });
  const start = raw.indexOf("{");
  let info = null;
  if (start >= 0) { try { info = JSON.parse(raw.slice(start)); } catch { info = null; } }
  if (!info) {
    // Report the failure without echoing the output, which can carry URLs.
    console.error("public metadata probe produced no JSON; continuing without a baseline record");
    return null;
  }
  const requested = Array.isArray(info.requested_downloads) ? info.requested_downloads[0] : null;
  const chosen = requested || info;
  const summary = {
    capturedAt: new Date().toISOString(),
    formatSelector: selector,
    id: info.id ?? null,
    title: info.title ?? null,
    channel: info.channel ?? info.uploader ?? null,
    uploadDate: info.upload_date ?? null,
    durationSeconds: info.duration ?? null,
    availability: info.availability ?? null,
    liveStatus: info.live_status ?? null,
    isLive: Boolean(info.is_live),
    wasLive: Boolean(info.was_live),
    ageLimit: info.age_limit ?? null,
    selected: {
      formatId: chosen.format_id ?? null,
      resolution: chosen.resolution ?? null,
      width: chosen.width ?? null,
      height: chosen.height ?? null,
      fps: chosen.fps ?? null,
      videoCodec: chosen.vcodec ?? null,
      audioCodec: chosen.acodec ?? null,
      container: chosen.ext ?? null,
      approximateBytes: chosen.filesize ?? chosen.filesize_approx ?? null,
      // yt-dlp joins the ids of separately downloaded streams with "+".
      separateStreamsMerged: typeof chosen.format_id === "string" && chosen.format_id.includes("+"),
    },
    ytdlpVersion: (await capture("docker", [...compose, "exec", "-T", "engine", "yt-dlp", "--version"], { env })).trim(),
  };
  await writeFile(join(artifacts, "reports", "source-public-metadata.json"), JSON.stringify(summary, null, 2));
  console.log(`public metadata: ${summary.id} "${summary.title}" ${summary.durationSeconds}s `
    + `selected ${summary.selected.formatId} ${summary.selected.resolution} `
    + `${summary.selected.videoCodec}/${summary.selected.audioCodec} `
    + `merged=${summary.selected.separateStreamsMerged}`);
  return summary;
}

/**
 * Copy the imported YouTube source out of the throwaway dataset so the
 * correspondence step can compare outputs against it after teardown.
 */
async function preserveImportedSources() {
  const found = [];
  const jobsDir = join(data, "jobs");
  let entries = [];
  try { entries = await readdir(jobsDir); } catch { return found; }
  const destination = join(artifacts, "imported-source");
  // Never let a prior --retain-source run win the verifier's largest-file
  // selection when the current run resolved a different YouTube format.
  await rm(destination, { recursive: true, force: true });
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

async function teardown({ keepLogs = false, label = "youtube" } = {}) {
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
  // Run the engine as the invoking user so the throwaway dataset stays writable
  // and removable. No S6_TEST_* hook: this is the production code path.
  await writeFile(overrideFile,
    `services:\n  engine:\n    user: "${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}"\n`);
  console.log(`YouTube import E2E: isolated stack "${project}" on ${url}`);
  console.log(`dataset: ${data}`);
  await run("docker", [...compose, "up", "-d", "--build"], { env });
  await waitForGateway();
  const metadata = await recordPublicMetadata();
  if (metadata?.durationSeconds) env.S6_YOUTUBE_EXPECTED_DURATION = String(metadata.durationSeconds);

  const traceArgs = process.env.S6_ACCEPTANCE_TRACE ? ["--trace", process.env.S6_ACCEPTANCE_TRACE] : [];
  // One stack serves every YouTube spec. S6_YOUTUBE_SPECS narrows the list when
  // re-running a single one against a fresh stack.
  const specs = (process.env.S6_YOUTUBE_SPECS
    || "tests/acceptance/youtube-import.spec.ts tests/acceptance/youtube-url-forms.spec.ts").split(/\s+/).filter(Boolean);
  let specError = null;
  try {
    await run("npm", ["run", "test:acceptance", "--", ...traceArgs, ...specs], { env });
  } catch (error) {
    specError = error;
  }
  // Preserve the imported source and diagnostics either way: on failure they
  // are the evidence, on success they are the correspondence reference.
  sources = await preserveImportedSources();
  await captureDiagnostics("youtube");
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
  console.log(`retained ${sources.length} imported source file(s) under test-artifacts/youtube-import/imported-source (gitignored)`);
}

await fsAccess(artifacts).catch(() => undefined);
process.exitCode = exitCode;
