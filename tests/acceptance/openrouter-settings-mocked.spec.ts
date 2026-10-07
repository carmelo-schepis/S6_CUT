import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

const profile = {
  id: "mock-openrouter", name: "Mock OpenRouter", textModelId: "openai/gpt-4.1-mini", selected: true,
  persistence: "encrypted", openrouterConfigured: true, openrouterMasked: "••••test", textStatus: "configured",
  textMessage: "Ready to test", textLastCheckedAt: null,
  status: "configured", capabilities: [], fallbacks: { planning: "Deterministic local planning" },
};
const verifiedProfile = { ...profile, textStatus: "connected", textMessage: "Connected; text generation succeeded", textLastCheckedAt: "2026-01-01T12:00:00+00:00", status: "connected", capabilities: ["OpenRouter text generation"] };

for (const [name, width, height] of [["desktop", 1440, 900], ["mobile", 390, 844]] as const) {
  test(`maps mocked OpenRouter text verification to a safe ${name} Settings state`, async ({ page }) => {
    const artifact = path.resolve(process.cwd(), "test-artifacts", "openrouter-settings-mocked", `${name}.png`);
    await fs.mkdir(path.dirname(artifact), { recursive: true }); await page.setViewportSize({ width, height });
    let current = profile;
    await page.route("**/api/v1/profiles", async (route) => route.request().method() === "GET" ? route.fulfill({ json: [current] }) : route.fulfill({ json: current }));
    await page.route("**/api/v1/profiles/mock-openrouter/test", async (route) => { current = verifiedProfile; return route.fulfill({ json: verifiedProfile }); });
    await page.goto("/", { waitUntil: "domcontentloaded" }); await page.getByRole("button", { name: "Settings", exact: true }).click();
    const row = page.getByRole("article"); await expect(row).toContainText("Ready to test"); await expect(row).toContainText("••••test"); await expect(row.locator(".provider-results .connection-result")).toHaveCount(1);
    await row.getByRole("button", { name: "Test" }).click(); await expect(row).toContainText("Connected; text generation succeeded"); await expect(row).not.toContainText("API key");
    await page.screenshot({ path: artifact, fullPage: false }); await page.reload({ waitUntil: "domcontentloaded" }); await page.getByRole("button", { name: "Settings", exact: true }).click(); await expect(page.getByRole("article")).toContainText("••••test");
  });
}
