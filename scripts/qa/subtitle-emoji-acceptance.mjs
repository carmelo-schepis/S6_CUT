import { chmod, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const runId = `${Date.now()}-${process.pid}`;
const project = `s6-subtitle-emoji-${runId}`.toLowerCase();
const runRoot = join(root, ".run-artifacts", "acceptance", runId);
const dataRoot = join(runRoot, "data");
const artifactRoot = join(runRoot, "playwright");
const fixture = join(root, "tests", "fixtures", "openrouter-fallback.mp4");
const override = join(runRoot, "compose.override.yaml");
const transcriptWords = [
  ["Today", .5, .9], ["we", 1.0, 1.2], ["talk", 1.3, 1.8],
  ["about", 2.0, 2.5], ["the", 2.6, 2.8], ["future", 2.9, 3.4],
  ["I", 4.0, 4.25], ["feel", 4.3, 4.65], ["😩!", 4.7, 5.4],
  ["and", 5.7, 5.95], ["this", 6.0, 6.3], ["matters.", 6.4, 7.0],
  ["We", 7.3, 7.5], ["can", 7.55, 7.8], ["learn", 7.85, 8.3],
  ["together", 8.35, 9.0], ["every", 9.1, 9.35], ["day.", 9.4, 10.0],
].map(([text, start, end]) => ({ text, start, end, confidence: .98 }));
const transcript = JSON.stringify({
  language: "en",
  words: transcriptWords,
  segments: [{ start: .5, end: 10, text: transcriptWords.map((word) => word.text).join(" ") }],
});

async function unusedPort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to reserve a test port");
  await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  return address.port;
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
  throw new Error("isolated emoji test gateway did not become healthy within 180 seconds");
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
const yamlQuoted = JSON.stringify(transcript);
await writeFile(override, `services:\n  engine:\n    environment:\n      S6_TEST_TRANSCRIPT_JSON: ${yamlQuoted}\nnetworks:\n  private:\n    ipam:\n      config:\n        - subnet: 10.253.231.0/24\n`);
let passed = false;
try {
  console.log(`Starting isolated ${project} at ${gateway}; dataset=${dataRoot}`);
  await run("docker", [...compose, "up", "-d", "--build"], { env: environment });
  await waitForGateway(gateway);
  await run("npm", ["run", "test:acceptance", "--", "--project=Desktop Chromium", "tests/acceptance/caption-emoji-render.spec.ts"], {
    env: {
      ...environment,
      S6_ACCEPTANCE_URL: gateway,
      S6_ACCEPTANCE_ISOLATED: "1",
      S6_EMOJI_CAPTION_FIXTURE: fixture,
      S6_TEST_TRANSCRIPT_JSON: transcript,
      S6_PLAYWRIGHT_ARTIFACTS: artifactRoot,
    },
  });
  passed = true;
} finally {
  try { await run("docker", [...compose, "down", "--remove-orphans"], { env: environment }); } catch (error) { console.error(error); }
  console.log(`${passed ? "PASS" : "FAIL"} isolated emoji acceptance artifacts: ${artifactRoot}`);
}
