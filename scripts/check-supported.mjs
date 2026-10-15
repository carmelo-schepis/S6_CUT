import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dataPath = await mkdtemp(join(tmpdir(), "s6-cut-check-"));
await chmod(dataPath, 0o777);
const overrideFile = join(dataPath, "compose.override.yaml");
const project = `s6-cut-check-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const compose = ["compose", "-p", project, "-f", join(root, "compose.yaml"), "-f", overrideFile];
const testUid = process.getuid?.() ?? 1000;
const testGid = process.getgid?.() ?? 1000;
const environment = { ...process.env, S6_DATA_PATH: dataPath };
let cleanupPromise;

async function run(command, args, options = {}) {
  const { timeoutMs = 45 * 60_000, ...spawnOptions } = options;
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

async function cleanup() {
  if (!cleanupPromise) {
    cleanupPromise = (async () => {
      try { await run("docker", [...compose, "down", "--volumes", "--remove-orphans"], { timeoutMs: 120_000 }); } catch (error) { console.error(error); }
      await rm(dataPath, { recursive: true, force: true });
    })();
  }
  await cleanupPromise;
}

function stopOnSignal(signal) {
  cleanup().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
}
process.once("SIGINT", () => stopOnSignal("SIGINT"));
process.once("SIGTERM", () => stopOnSignal("SIGTERM"));

let exitCode = 1;
try {
  await writeFile(overrideFile, `services:\n  engine:\n    user: "${testUid}:${testGid}"\n    volumes:\n      - type: bind\n        source: ${JSON.stringify(dataPath)}\n        target: /app/data\n      - type: bind\n        source: ${JSON.stringify(join(root, "tests"))}\n        target: /app/tests\n        read_only: true\n      - type: bind\n        source: ${JSON.stringify(join(root, "scripts"))}\n        target: /app/scripts\n        read_only: true\n`);
  console.log("Supported check: frontend checks/build run on the host; backend tests run in a freshly built Docker engine image.");
  await run("npm", ["run", "lint"]);
  await run("npm", ["run", "typecheck"]);
  await run("npm", ["test"]);
  await run("docker", [...compose, "config"]);
  await run("docker", [...compose, "run", "--rm", "--no-deps", "--build", "engine", "sh", "-c", "python -m pip install --no-cache-dir --target /tmp/s6-cut-pytest pytest==9.1.1 && PYTHONPATH=/tmp/s6-cut-pytest python -m pytest engine/tests -q -p no:cacheprovider"]);
  await run("npm", ["run", "build"]);
  exitCode = 0;
} catch (error) {
  console.error(error);
  exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
} finally {
  await cleanup();
}
process.exitCode = exitCode;
