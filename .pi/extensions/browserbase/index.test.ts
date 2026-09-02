import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Page } from "playwright-core";
import browserbaseExtension, {
  BrowserController,
  boundedAppend,
  createScreenshotRun,
  locatorDescription,
  readConfiguration,
  redactSecrets,
  resolveLocator,
  sanitizeFilename,
  truncate,
  validateUrl,
} from "./index.ts";

test("validates safe HTTP(S) URLs and rejects dangerous schemes and credentials", () => {
  assert.equal(validateUrl("https://example.com/path").hostname, "example.com");
  for (const value of [
    "javascript:alert(1)",
    "data:text/html,hi",
    "file:///tmp/a",
    "not a URL",
    "https://user:pass@example.com",
  ]) {
    assert.throws(() => validateUrl(value));
  }
});

test("redacts API keys, bearer tokens, query secrets, and URLs", () => {
  const previous = process.env.BROWSERBASE_API_KEY;
  process.env.BROWSERBASE_API_KEY = "bb_live_test-secret-value";
  const value = redactSecrets(
    "bb_live_test-secret-value Bearer abc https://example.com/?token=secret",
  );
  assert.equal(value.includes("secret-value"), false);
  assert.equal(value.includes("Bearer [redacted]"), true);
  assert.equal(value.includes("token=secret"), false);
  if (previous === undefined) delete process.env.BROWSERBASE_API_KEY;
  else process.env.BROWSERBASE_API_KEY = previous;
});

test("truncates output with an explicit marker and sanitizes portable filenames", () => {
  assert.match(truncate("abcdefgh", 5), /truncated/);
  assert.equal(
    sanitizeFilename("Login / validation: 01"),
    "Login-validation-01",
  );
  assert.equal(sanitizeFilename("..."), "screenshot");
});

test("parses bounded environment configuration without requiring a key", () => {
  const previous = { ...process.env };
  process.env.BROWSERBASE_TIMEOUT_SECONDS = "1200";
  process.env.BROWSERBASE_USE_PROXY = "true";
  process.env.BROWSERBASE_REGION = "eu-central-1";
  process.env.BROWSERBASE_VIEWPORT_WIDTH = "390";
  process.env.BROWSERBASE_VIEWPORT_HEIGHT = "844";
  const config = readConfiguration();
  assert.deepEqual(config, {
    timeout: 1200,
    proxy: true,
    region: "eu-central-1",
    keepAlive: false,
    viewport: { width: 390, height: 844 },
  });
  for (const key of Object.keys(process.env)) {
    if (!(key in previous)) delete process.env[key];
  }
  Object.assign(process.env, previous);
});

test("builds locator priority descriptions and rejects ambiguous locators", async () => {
  assert.equal(locatorDescription({ ref: "e1" }), "snapshot reference e1");
  assert.equal(
    locatorDescription({ role: "button", name: "Save" }),
    'role=button name="Save"',
  );
  const fakeLocator = {
    count: async () => 2,
    evaluateAll: async () => [
      'button "Save" (visible)',
      'button "Save" (hidden)',
    ],
  };
  const fakePage = { getByRole: () => fakeLocator } as unknown as Page;
  await assert.rejects(
    resolveLocator(fakePage, { role: "button", name: "Save" }),
    /Ambiguous.*2 matches/,
  );
});

test("allows count assertions to resolve multiple matches", async () => {
  const fakeLocator = { count: async () => 3, evaluateAll: async () => [] };
  const fakePage = { getByText: () => fakeLocator } as unknown as Page;
  const locator = await resolveLocator(
    fakePage,
    { text: "Item" },
    { allowMany: true },
  );
  assert.equal(await locator.count(), 3);
});

test("bounds retained diagnostic-style entries", () => {
  const entries: number[] = [];
  for (let index = 0; index < 60; index += 1) boundedAppend(entries, index, 50);
  assert.equal(entries.length, 50);
  assert.equal(entries[0], 10);
  assert.equal(entries.at(-1), 59);
});

test("creates a screenshot run directory with a valid manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-browserbase-test-"));
  try {
    const run = await createScreenshotRun(root, "session-test");
    const manifest = JSON.parse(await readFile(run.manifestPath, "utf8")) as {
      sessionId: string;
      screenshots: unknown[];
    };
    assert.equal(manifest.sessionId, "session-test");
    assert.deepEqual(manifest.screenshots, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanup is idempotent when no session was created", async () => {
  const controller = new BrowserController();
  const first = await controller.stop();
  const second = await controller.stop();
  assert.equal(first.released, false);
  assert.equal(second.released, false);
});

test("extension factory registers all tools and commands without creating a session", () => {
  const tools: string[] = [];
  const commands: string[] = [];
  const events: string[] = [];
  const pi = {
    registerTool: (tool: { name: string }) => tools.push(tool.name),
    registerCommand: (name: string) => commands.push(name),
    on: (name: string) => events.push(name),
  };
  browserbaseExtension(pi as never);
  assert.deepEqual(tools.sort(), [
    "browser_act",
    "browser_assert",
    "browser_diagnostics",
    "browser_navigate",
    "browser_screenshot",
    "browser_session",
    "browser_snapshot",
  ]);
  assert.deepEqual(commands.sort(), [
    "browser-close",
    "browser-open",
    "browser-screenshot",
    "browser-status",
  ]);
  assert.deepEqual(events, ["session_shutdown"]);
});
