import { chmod, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Isolated, serial fixture-assisted media acceptance. Run this script explicitly;
// it builds and runs Compose.
const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const runId = `${Date.now()}-${process.pid}`;
const project = `s6-reaction-policy-${runId}`.toLowerCase();
const runRoot = join(root, ".run-artifacts", "acceptance", `reaction-policy-${runId}`);
const dataRoot = join(runRoot, "data");
const artifactRoot = join(runRoot, "playwright");
const override = join(runRoot, "compose.override.yaml");
const words = [
  ["We", .5, .8], ["were", .85, 1.1], ["just", 1.15, 1.45], ["talking", 1.5, 2.0],
  ["about", 2.05, 2.35], ["the", 2.4, 2.6], ["whole", 2.65, 3.0], ["thing", 3.05, 3.45],
  ["that", 3.8, 4.1], ["was", 4.15, 4.45], ["hilarious", 4.5, 5.25],
  ["and", 5.6, 5.9], ["then", 5.95, 6.25], ["we", 6.3, 6.5], ["moved", 6.55, 6.9], ["on", 6.95, 7.35],
  ["We", 7.6, 7.9], ["left", 7.95, 8.15], ["it", 8.2, 8.4], ["there.", 8.45, 8.9],
].map(([text, start, end]) => ({ text, start, end, confidence: .99 }));
const transcript = JSON.stringify({ language: "en", words, segments: [{ start: .5, end: 8.9, text: words.map((word) => word.text).join(" ") }] });

async function unusedPort(exclude = new Set()) {
  for (;;) {
    const server = createServer();
    await new Promise((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolvePromise);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("failed to reserve isolated stack port");
    const port = address.port;
    await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
    if (!exclude.has(port)) return port;
  }
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${code ?? signal}`)));
  });
}

async function waitForGateway(url) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/healthz`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error("isolated reaction-policy gateway did not become healthy within 180 seconds");
}

await mkdir(dataRoot, { recursive: true });
await mkdir(artifactRoot, { recursive: true });
await chmod(dataRoot, 0o777);
const webPort = await unusedPort();
const enginePort = await unusedPort(new Set([webPort]));
const gateway = `http://127.0.0.1:${webPort}`;
const compose = ["compose", "-p", project, "-f", join(root, "compose.yaml"), "-f", override];
const environment = { ...process.env, S6_PORT: `127.0.0.1:${webPort}`, S6_ENGINE_PORT: String(enginePort), S6_DATA_PATH: dataRoot };
const yamlQuotedTranscript = `'${transcript.replaceAll("'", "''")}'`;
await writeFile(override, `services:\n  engine:\n    environment:\n      S6_TEST_TRANSCRIPT_JSON: ${yamlQuotedTranscript}\n`);
let passed = false;
let started = false;
try {
  console.log(`Starting isolated ${project} at ${gateway}; data=${dataRoot}; artifacts=${artifactRoot}`);
  started = true;
  // Avoid concurrent BuildKit workloads on this host: finish the engine image,
  // then the web image, and only then start the isolated stack.
  await run("docker", [...compose, "build", "engine"], { env: environment });
  await run("docker", [...compose, "build", "web"], { env: environment });
  await run("docker", [...compose, "up", "-d", "--no-build"], { env: environment });
  await waitForGateway(gateway);
  // Playwright executes the single spec serially; the two render jobs within it
  // are likewise strictly awaited one after the other by the test.
  await run("npm", ["run", "test:acceptance", "--", "--project=Desktop Chromium", "tests/acceptance/reaction-policy-render.spec.ts"], {
    env: { ...environment, S6_ACCEPTANCE_URL: gateway, S6_ACCEPTANCE_ISOLATED: "1", S6_TEST_TRANSCRIPT_JSON: transcript, S6_PLAYWRIGHT_ARTIFACTS: artifactRoot, S6_FORENSICS_IMAGE: `${project}-engine` },
  });
  passed = true;
} finally {
  if (started) {
    try { await run("docker", [...compose, "down", "--remove-orphans"], { env: environment }); }
    catch (error) { console.error(`cleanup failed for owned stack ${project}:`, error); }
  }
  console.log(`${passed ? "PASS" : "FAIL"} fixture-assisted reaction-policy acceptance artifacts: ${artifactRoot}`);
}
