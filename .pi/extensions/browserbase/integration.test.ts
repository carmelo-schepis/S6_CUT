import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { test } from "node:test";
import { BrowserController } from "./index.ts";

const enabled = Boolean(process.env.BROWSERBASE_API_KEY);

test("Browserbase example.com smoke test", { skip: !enabled }, async () => {
  const controller = new BrowserController();
  try {
    await controller.start({}, undefined, undefined, process.cwd());
    await controller.navigate(
      "https://example.com",
      "domcontentloaded",
      60_000,
    );
    const initial = await controller.captureScreenshot(process.cwd(), {
      label: "example-initial",
      reason: "Initial example.com smoke-test state",
      status: "debugging",
      relatedAction: "integration-smoke-test:navigate",
    });
    await access(initial.entry.absolutePath);
    const assertion = await controller.assert(
      "title_contains",
      "Example Domain",
      {},
      15_000,
      process.cwd(),
    );
    assert.equal(assertion.passed, true);
    const screenshot = await controller.captureScreenshot(process.cwd(), {
      label: "example-success",
      reason: "Integration smoke test success evidence",
      status: "success",
      relatedAction: "integration-smoke-test",
    });
    await access(screenshot.entry.absolutePath);
    const manifestText = await readFile(
      controller.getRuntime()?.manifestPath ?? "",
      "utf8",
    );
    const manifest = JSON.parse(manifestText) as { screenshots: unknown[] };
    assert.equal(manifest.screenshots.length, 2);
    console.log(`Smoke screenshot: ${screenshot.entry.repositoryPath}`);
  } finally {
    await controller.stop();
  }
});
