import { spawnSync } from "node:child_process";
import process from "node:process";

const root = process.cwd();
const configured = process.env.S6_PYTHON;
const candidates = configured
  ? [configured]
  : process.platform === "win32"
    ? [`${root}\\.venv\\Scripts\\python.exe`, "python"]
    : [`${root}/.venv/bin/python`, "python3", "python"];

for (const python of candidates) {
  const result = spawnSync(python, ["-m", "pytest", "engine/tests", "-q"], { stdio: "inherit" });
  if (result.error?.code === "ENOENT") continue;
  process.exit(result.status ?? 1);
}

console.error(`Unable to find Python for engine tests. Set S6_PYTHON or install Python 3.`);
process.exit(1);
