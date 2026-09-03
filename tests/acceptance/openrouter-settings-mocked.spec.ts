import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

const profile = {
  id: "mock-openrouter",
  name: "Mock OpenRouter",
  modelId: "openai/gpt-4.1-mini",
  voiceId: null,
  selected: true,
  persistence: "encrypted",
  openrouterConfigured: true,
  elevenlabsConfigured: false,
  openrouterMasked: "••••test",
  elevenlabsMasked: null,
  openrouterStatus: "configured",
  elevenlabsStatus: "not_configured",
  openrouterMessage: "Ready to test",
  openrouterLastCheckedAt: null,
  elevenlabsMessage: "Optional; local narration and silent rendering remain available",
  elevenlabsLastCheckedAt: null,
  status: "configured",
  capabilities: [],
  fallbacks: { planning: "Deterministic local planning" },
};

const verifiedProfile = {
  ...profile,
  openrouterStatus: "connected",
  openrouterMessage: "Connected; a structured planning request succeeded",
  openrouterLastCheckedAt: "2026-01-01T12:00:00+00:00",
  status: "connected",
  capabilities: ["structured planning"],
};

for (const [name, width, height] of [["desktop", 1440, 900], ["mobile", 390, 844]] as const) {
  test(`maps mocked OpenRouter verification to a safe ${name} Settings state`, async ({ page }) => {
    const artifact = path.resolve(process.cwd(), "test-artifacts", "openrouter-settings-mocked", `${name}.png`);
    await fs.mkdir(path.dirname(artifact), { recursive: true });
    await page.setViewportSize({ width, height });
    let current = profile;
    let releaseTest: (() => void) | undefined;
    const testResponse = new Promise<void>((resolve) => { releaseTest = resolve; });
    await page.route("**/api/v1/profiles", async (route) => {
      if (route.request().method() === "GET") return route.fulfill({ json: [current] });
      return route.fulfill({ json: current });
    });
    await page.route("**/api/v1/profiles/mock-openrouter/test", async (route) => {
      await testResponse;
      current = verifiedProfile;
      return route.fulfill({ json: verifiedProfile });
    });

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const row = page.getByRole("article");
    await expect(row).toContainText("Ready to test");
    await expect(row).toContainText("••••test");
    await expect(row).not.toContainText("mock-openrouter-key");

    await row.getByRole("button", { name: "Test" }).click();
    await expect(row.getByRole("button", { name: "Checking…" })).toBeVisible();
    releaseTest?.();
    await expect(row).toContainText("Connected; a structured planning request succeeded");
    await expect(row).toContainText("Checked");
    await expect(row).not.toContainText("API key");
    await page.screenshot({ path: artifact, fullPage: false });

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("article")).toContainText("Connected; a structured planning request succeeded");
    await expect(page.getByRole("article")).toContainText("••••test");
  });
}
