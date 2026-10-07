import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative, resolve } from "node:path";

// ElevenLabs was retired as a provider. The engine still scrubs its old key
// from previously stored data, but nothing under web/src may reference the
// provider or the name reaches a customer's screen and shipped bundle.
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SEARCH_ROOTS = ["web/src", "web/public"];
const RETIRED = /eleven\s*labs|elevenlabs/i;
const SKIP_DIRECTORIES = new Set(["node_modules", "dist", ".git"]);

async function* sourceFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) yield* sourceFiles(path);
    } else if (entry.isFile()) {
      yield path;
    }
  }
}

const offences = [];
for (const searchRoot of SEARCH_ROOTS) {
  for await (const path of sourceFiles(join(root, searchRoot))) {
    const contents = await readFile(path, "utf8");
    contents.split("\n").forEach((line, index) => {
      if (RETIRED.test(line)) offences.push(`${relative(root, path)}:${index + 1}: ${line.trim()}`);
    });
  }
}

if (offences.length) {
  console.error("Retired provider referenced in customer-facing source:");
  for (const offence of offences) console.error(`  ${offence}`);
  console.error("\nThe engine-side cleanup of legacy provider data is deliberate; the provider name");
  console.error("stored data (engine/providers.py) is deliberate; the provider name must not appear");
  console.error("in web/src or web/public.");
  process.exit(1);
}

console.log(`No retired provider references in ${SEARCH_ROOTS.join(", ")}.`);
