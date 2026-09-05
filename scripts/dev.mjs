import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const windows = process.platform === "win32";
const virtualPython = resolve(windows ? ".venv/Scripts/python.exe" : ".venv/bin/python");
// A repository checkout is installed into `.venv` by the supported installers.
// Prefer that interpreter so `npm run dev` works even when the system Python
// does not have the engine dependencies. S6_PYTHON remains the explicit escape
// hatch for contributors using another environment.
const python = process.env.S6_PYTHON || (existsSync(virtualPython) ? virtualPython : windows ? "python" : "python3");
const npm = windows ? "npm.cmd" : "npm";
const children = [
  spawn(python, ["-m", "uvicorn", "engine.app:app", "--host", "127.0.0.1", "--port", "8001", "--reload"], { stdio: "inherit", env: process.env }),
  spawn(npm, ["run", "dev:web"], { stdio: "inherit", env: process.env }),
];

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill(windows ? undefined : "SIGTERM");
  setTimeout(() => process.exit(code), 200).unref();
}

for (const child of children) child.on("exit", (code) => { if (!stopping && code) stop(code); });
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
