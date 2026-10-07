import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const runId = `${Date.now()}-${process.pid}-${randomBytes(4).toString("hex")}`;
const project = `s6-recent-clips-${runId}`;
const dataPath = join(tmpdir(), project);
const overridePath = join(tmpdir(), `${project}-compose.yaml`);
const engineImage = `${project}-engine:acceptance`;
const artifacts = join(root, "test-artifacts", project);

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
        if (health.status === "ready") return;
        lastError = `engine status ${health.status}`;
      } else lastError = `web ${web.status}, engine ${engine.status}`;
    } catch (error) {
      lastError = String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error(`Disposable app did not become healthy: ${lastError}`);
}

function composeArgs() {
  return ["compose", "--env-file", "/dev/null", "--project-name", project, "--file", join(root, "compose.yaml"), "--file", overridePath];
}

let stackStarted = false;
let composeEnvironment = process.env;
let exitCode = 1;
let webPort;
let enginePort;
try {
  webPort = await freePort();
  enginePort = await freePort();
  if (webPort < 20_000 || enginePort < 20_000 || webPort === enginePort) {
    webPort = 30_000 + Number.parseInt(runId.slice(-4), 16) % 15_000;
    enginePort = webPort === 44_416 ? 44_417 : webPort + 1;
  }
  const url = `http://127.0.0.1:${webPort}`;
  const engineUrl = `http://127.0.0.1:${enginePort}`;
  const environment = {
    ...process.env,
    S6_DATA_PATH: dataPath,
    S6_PORT: `127.0.0.1:${webPort}`,
    S6_ENGINE_PORT: String(enginePort),
    S6_ACCEPTANCE_URL: url,
    S6_PLAYWRIGHT_ARTIFACTS: `test-artifacts/${project}`,
    OPENROUTER_API_KEY: "",
  };
  composeEnvironment = environment;

  await mkdir(dataPath, { recursive: false });
  await chmod(dataPath, 0o777);
  await mkdir(artifacts, { recursive: true });
  await writeFile(overridePath, `services:\n  engine:\n    image: ${engineImage}\n`);

  console.log(`Recent clips acceptance: isolated Compose project ${project}`);
  console.log(`Disposable data: ${dataPath}`);
  console.log(`Local app: ${url} (engine ${engineUrl})`);
  console.log(`Artifacts: ${artifacts}`);

  run("docker", ["build", "--tag", engineImage, "--file", "engine/Dockerfile", "."]);
  run("docker", [
    "run", "--rm", "--volume", `${root}:/src:ro`, "--volume", `${dataPath}:${dataPath}`,
    "--workdir", "/src", "--env", `S6_DATA_PATH=${dataPath}`, "--env", `S6_ACCEPTANCE_URL=${url}`,
    "--entrypoint", "python", engineImage, "/src/tests/acceptance/support/seed_recent_clips.py",
  ]);
  run("docker", composeArgs().concat(["build", "web"]), environment);
  stackStarted = true;
  run("docker", composeArgs().concat(["up", "--detach", "--no-build"]), environment);
  await waitForApp(url, engineUrl);

  const seeded = await fetch(`${url}/api/v1/library/recent-clips?search=&page=1&page_size=12`).then((response) => response.json());
  if (seeded.total <= 12 || seeded.items.length !== 12 || !seeded.hasMore) throw new Error("Seeded app does not expose a paginated output set");

  run("npx", ["playwright", "test", "--config", "playwright.config.ts", "tests/acceptance/recent-clips-assets.spec.ts"], environment);
  run("npx", ["playwright", "test", "--config", "playwright.config.ts", "tests/acceptance/retirement.spec.ts"], {
    ...environment,
    S6_PLAYWRIGHT_ARTIFACTS: join("test-artifacts", project, "retirement"),
  });
  run("docker", composeArgs().concat(["restart", "engine"]), environment);
  await waitForApp(url, engineUrl);
  const afterRestart = await fetch(`${url}/api/v1/library/recent-clips?search=&page=1&page_size=12`).then((response) => response.json());
  if (afterRestart.total !== 0 || afterRestart.items.length !== 0) throw new Error(`Recent clips were not empty after isolated engine restart: ${afterRestart.total} items`);
  await writeFile(join(artifacts, "restart-verification.json"), `${JSON.stringify({ url, project, dataPath, totalAfterRestart: afterRestart.total, checkedAt: new Date().toISOString() }, null, 2)}\n`);

  // Run only after the empty Recent clips restart assertion: this spec creates
  // a disposable Clip project to prove Projects still opens its exact Workspace.
  // Give Playwright a separate output directory so its run cannot clear the
  // earlier acceptance screenshots and report.
  const postRestartEnvironment = {
    ...environment,
    S6_PLAYWRIGHT_ARTIFACTS: join("test-artifacts", project, "post-restart"),
  };
  run("npx", ["playwright", "test", "--config", "playwright.config.ts", "tests/acceptance/recent-clips-projects.spec.ts"], postRestartEnvironment);
  console.log("Isolated browser suites passed; engine restart retained the empty Recent clips state before the follow-up disposable job.");
  exitCode = 0;
} finally {
  if (stackStarted) {
    try { run("docker", composeArgs().concat(["down", "--volumes", "--remove-orphans"]), composeEnvironment); }
    catch (error) { console.error("Disposable Compose cleanup failed:", error); }
  }
  if (dirname(dataPath) === tmpdir() && /^s6-recent-clips-[a-zA-Z0-9-]{8,}$/.test(dataPath.split("/").at(-1) || "")) {
    try {
      run("docker", [
        "run", "--rm", "--user", "0:0", "--volume", `${dataPath}:${dataPath}`,
        "--entrypoint", "python", engineImage, "-c",
        `from pathlib import Path; import shutil; root=Path(${JSON.stringify(dataPath)}); [shutil.rmtree(p) if p.is_dir() and not p.is_symlink() else p.unlink() for p in root.iterdir()]`,
      ], composeEnvironment);
    } catch { /* The image may not exist if the build failed before creating it. */ }
    await chmod(dataPath, 0o777).catch(() => undefined);
    await rm(dataPath, { recursive: true, force: true });
  }
  await rm(overridePath, { force: true });
  try { run("docker", ["image", "rm", engineImage]); } catch { /* Docker may remove an unused test image automatically. */ }
}
process.exitCode = exitCode;
