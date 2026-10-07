import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const id = `${Date.now()}-${process.pid}-${randomBytes(4).toString("hex")}`;
const project = `s6-library-stills-${id}`;
const dataPath = join(tmpdir(), project);
const overridePath = join(tmpdir(), `${project}.yaml`);
const artifactPath = join(root, "test-artifacts", project);
const fixturePath = join(artifactPath, "fixtures");
const keep = process.argv.includes("--keep");
const projectFilter = process.argv.find((argument) => argument.startsWith("--projects="))?.slice("--projects=".length);
const suite = process.argv.find((argument) => argument.startsWith("--suite="))?.slice("--suite=".length) || "tests/acceptance/library-media-loading.spec.ts tests/acceptance/library-still-thumbnails.spec.ts";

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status ?? result.signal}`);
}

async function freePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a loopback port");
  await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  return address.port;
}

async function waitForApp(url, engineUrl) {
  const deadline = Date.now() + 5 * 60_000;
  let lastError = "not ready";
  while (Date.now() < deadline) {
    try {
      const [web, engine] = await Promise.all([fetch(`${url}/healthz`), fetch(`${engineUrl}/api/health`)]);
      if (web.ok && engine.ok) {
        const health = await engine.json();
        if (health.status === "ready") return health;
        lastError = `engine status ${health.status}`;
      } else lastError = `web ${web.status}, engine ${engine.status}`;
    } catch (error) { lastError = String(error); }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error(`Disposable app did not become healthy: ${lastError}`);
}

let webPort;
let enginePort;
let stackStarted = false;
let exitCode = 1;
let environment;
const compose = ["compose", "--project-name", project, "--file", join(root, "compose.yaml"), "--file", overridePath];
try {
  webPort = await freePort();
  enginePort = await freePort();
  while (enginePort === webPort) enginePort = await freePort();
  const url = `http://127.0.0.1:${webPort}`;
  const engineUrl = `http://127.0.0.1:${enginePort}`;
  environment = {
    ...process.env,
    COMPOSE_PROJECT_NAME: project,
    S6_DATA_PATH: dataPath,
    S6_PORT: `127.0.0.1:${webPort}`,
    S6_ENGINE_PORT: String(enginePort),
    S6_ACCEPTANCE_URL: url,
    S6_ACCEPTANCE_ISOLATED: "1",
    S6_THUMBNAIL_FIXTURES: `/work/test-artifacts/${project}/fixtures`,
    S6_PLAYWRIGHT_ARTIFACTS: `test-artifacts/${project}`,
    S6_PLAYWRIGHT_BASE_URL: url,
  };
  await mkdir(dataPath, { recursive: false });
  await chmod(dataPath, 0o777);
  await mkdir(fixturePath, { recursive: true });
  await chmod(fixturePath, 0o777);
  await writeFile(overridePath, "services:\n  engine:\n    image: " + project + "-engine:review\n");
  console.log(JSON.stringify({ project, dataPath, url, engineUrl, artifactPath, fixturePath, browserImage: "mcr.microsoft.com/playwright:v1.63.0-noble" }, null, 2));

  run("docker", ["build", "--tag", `${project}-engine:review`, "--file", "engine/Dockerfile", "."]);
  run("docker", ["run", "--rm", "--volume", `${root}:/work:ro`, "--volume", `${artifactPath}:/artifacts`, "--workdir", "/work", "--entrypoint", "python", `${project}-engine:review`, "/work/tests/acceptance/support/build_thumbnail_media.py", "/artifacts/fixtures"]);
  run("docker", [...compose, "build", "web"], environment);
  stackStarted = true;
  run("docker", [...compose, "up", "--detach", "--no-build"], environment);
  const health = await waitForApp(url, engineUrl);
  console.log(`Isolated backend ready: ${JSON.stringify({ version: health.version, ffmpeg: health.ffmpeg, ffprobe: health.ffprobe, bundle: (await fetch(url)).headers.get("etag") })}`);

  const args = ["run", "--rm", "--network", "host", "--volume", `${root}:/work`, "--workdir", "/work", "--env", `S6_ACCEPTANCE_URL=${url}`, "--env", "S6_ACCEPTANCE_ISOLATED=1", "--env", `S6_THUMBNAIL_FIXTURES=${environment.S6_THUMBNAIL_FIXTURES}`, "--env", `S6_PLAYWRIGHT_ARTIFACTS=${environment.S6_PLAYWRIGHT_ARTIFACTS}`, "--env", `S6_PLAYWRIGHT_BASE_URL=${url}`, "--entrypoint", "bash", "mcr.microsoft.com/playwright:v1.63.0-noble", "-lc", `npx playwright test --config playwright.config.ts --retries=0 ${suite}${projectFilter ? ` --project=${JSON.stringify(projectFilter)}` : ""}`];
  run("docker", args, environment);
  console.log(`Acceptance checks passed at ${url}; artifacts: ${artifactPath}`);
  exitCode = 0;
} finally {
  if (stackStarted) {
    const logs = spawnSync("docker", [...compose, "logs", "--no-color"], { cwd: root, env: environment, encoding: "utf8" });
    await writeFile(join(artifactPath, "compose.log"), `${logs.stdout || ""}${logs.stderr || ""}`);
    const serverErrors = `${logs.stdout || ""}${logs.stderr || ""}`.split("\n").filter((line) => /\b(ERROR|Traceback|Unhandled|Exception)\b/.test(line));
    console.log(`Compose server error evidence (${serverErrors.length} matched lines): ${join(artifactPath, "compose.log")}`);
    if (serverErrors.length) console.log(serverErrors.join("\n"));
  }
  if (stackStarted && !keep) {
    try { run("docker", [...compose, "down", "--volumes", "--remove-orphans"], environment); }
    catch (error) { console.error("Disposable Compose cleanup failed:", error); }
  }
  if (!keep) {
    try {
      run("docker", ["run", "--rm", "--user", "0:0", "--volume", `${dataPath}:${dataPath}`, "--entrypoint", "python", `${project}-engine:review`, "-c", `from pathlib import Path; import shutil; root=Path(${JSON.stringify(dataPath)}); [shutil.rmtree(p) if p.is_dir() and not p.is_symlink() else p.unlink() for p in root.iterdir()]`]);
    } catch { /* engine image or data volume may not exist yet */ }
    await rm(dataPath, { recursive: true, force: true }).catch((error) => console.error("Isolated data cleanup needs operator attention:", error));
    await rm(overridePath, { force: true });
    try { run("docker", ["image", "rm", `${project}-engine:review`]); } catch { /* no consumers remain */ }
  } else {
    console.log(`Review stack kept running as ${project}; use this exact S6_ACCEPTANCE_URL: ${environment.S6_ACCEPTANCE_URL}`);
  }
}
process.exitCode = exitCode;
