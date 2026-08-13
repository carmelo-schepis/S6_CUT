import { spawn } from "node:child_process";
import process from "node:process";

const windows = process.platform === "win32";
const python = process.env.S6_PYTHON || (windows ? "python" : "python3");
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
