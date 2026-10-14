import { chmod, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const youtubeUrl = process.env.S6_SPEECH_STYLE_YOUTUBE_URL;
if (!youtubeUrl) throw new Error("Set S6_SPEECH_STYLE_YOUTUBE_URL to an authorized public YouTube speech URL. This acceptance never mocks YouTube import.");
const runId = `${Date.now()}-${process.pid}`;
const project = `s6-speech-style-${runId}`.toLowerCase();
const runRoot = join(root, ".run-artifacts", "acceptance", `speech-subtitle-styles-${runId}`);
const dataRoot = join(runRoot, "data");
const artifactRoot = join(runRoot, "playwright");
const override = join(runRoot, "compose.override.yaml");

async function unusedPort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to allocate a test port");
  await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  return address.port;
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0
      ? resolvePromise()
      : reject(new Error(`${command} exited ${code ?? signal}`)));
  });
}

async function waitForGateway(url) {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/healthz`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error("isolated speech-subtitle-style stack did not become healthy within 240 seconds");
}

await mkdir(dataRoot, { recursive: true });
await mkdir(artifactRoot, { recursive: true });
await chmod(dataRoot, 0o777);
const [webPort, enginePort] = await Promise.all([unusedPort(), unusedPort()]);
const gateway = `http://127.0.0.1:${webPort}`;
const compose = ["compose", "-p", project, "-f", join(root, "compose.yaml"), "-f", override];
const environment = {
  ...process.env,
  S6_PORT: `127.0.0.1:${webPort}`,
  S6_ENGINE_PORT: String(enginePort),
  S6_DATA_PATH: dataRoot,
};
// No test transcript injection: local Smart jobs must run actual Whisper; YouTube
// import uses the app's normal downloader and transcription path.
await writeFile(override, "services: {}\n");
let passed = false;
try {
  console.log(`Starting isolated ${project} at ${gateway}; private data=${dataRoot}`);
  await run("docker", [...compose, "up", "-d", "--build"], { env: environment });
  await waitForGateway(gateway);
  await run("npm", ["run", "test:acceptance", "--", "--project=Desktop Chromium", "tests/acceptance/speech-subtitle-styles.spec.ts"], {
    env: {
      ...environment,
      S6_ACCEPTANCE_URL: gateway,
      S6_ACCEPTANCE_ISOLATED: "1",
      S6_SPEECH_STYLE_YOUTUBE_URL: youtubeUrl,
      S6_SPEECH_STYLE_FIXTURE: join(root, "tests/fixtures/openrouter-fallback.mp4"),
      S6_PLAYWRIGHT_ARTIFACTS: artifactRoot,
    },
  });
  passed = true;
} finally {
  try {
    await run("docker", [...compose, "down", "--remove-orphans"], { env: environment });
  } catch (error) {
    console.error("Could not fully stop isolated compose project:", error);
  }
  console.log(`${passed ? "PASS" : "FAIL"} speech subtitle styles evidence: ${artifactRoot}`);
}
