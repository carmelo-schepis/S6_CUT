import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

const fixtureCredential = "fixture-credential-for-mock-only";
const baseProfile = {
  id: "mock-elevenlabs",
  name: "My profile",
  modelId: "openai/gpt-4.1-mini",
  voiceId: null,
  selected: true,
  persistence: "encrypted",
  openrouterConfigured: true,
  elevenlabsConfigured: true,
  openrouterMasked: "masked key",
  elevenlabsMasked: "masked key",
  openrouterStatus: "connected",
  elevenlabsStatus: "connected",
  openrouterMessage: "Connected",
  openrouterLastCheckedAt: "2026-01-01T12:00:00+00:00",
  elevenlabsMessage: "Connected; ElevenLabs authentication succeeded",
  elevenlabsLastCheckedAt: "2026-01-01T12:00:00+00:00",
  status: "connected",
  capabilities: ["structured planning", "ElevenLabs narration"],
  fallbacks: { planning: "Deterministic local planning" },
};

test("retains masked secrets and handles mocked ElevenLabs validation safely", async ({ page }) => {
  const artifactDir = path.resolve(process.cwd(), "test-artifacts", "elevenlabs-settings-regression");
  await fs.mkdir(artifactDir, { recursive: true });
  let current = { ...baseProfile };
  await page.route("**/api/v1/profiles", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: [current] });
    return route.fulfill({ json: current });
  });
  await page.route("**/api/v1/profiles/mock-elevenlabs", async (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      expect(body.elevenlabsKey === undefined || body.elevenlabsKey === fixtureCredential).toBeTruthy();
      current = { ...current, elevenlabsStatus: "configured", elevenlabsMessage: "Ready to test" };
      return route.fulfill({ json: current });
    }
    return route.fulfill({ json: current });
  });
  await page.route("**/api/v1/profiles/mock-elevenlabs/test", async (route) => {
    expect(route.request().method()).toBe("POST");
    current = { ...current, elevenlabsStatus: "connected", elevenlabsMessage: "Connected; ElevenLabs authentication succeeded" };
    return route.fulfill({ json: current });
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const row = page.getByRole("article");
  await expect(row).toContainText("masked key");
  await expect(row).toContainText("OpenRouter");
  await expect(row).toContainText("Connected");

  await row.getByRole("button", { name: "Edit My profile" }).click();
  await page.getByRole("button", { name: "Save and test connection" }).click();
  await expect(page.getByRole("article")).toContainText("Connected; ElevenLabs authentication succeeded");
  await expect(page.getByRole("article")).toContainText("OpenRouter");

  await page.getByRole("button", { name: "Edit My profile" }).click();
  await page.getByRole("textbox", { name: /ElevenLabs API key Show/ }).fill(fixtureCredential);
  await page.getByRole("button", { name: "Save and test connection" }).click();
  await expect(page.getByRole("article")).toContainText("Connected; ElevenLabs authentication succeeded");
  await expect(page.locator("body")).not.toContainText(fixtureCredential);

  await page.screenshot({ path: path.join(artifactDir, "masked-retention-success.png"), fullPage: true });
  await fs.writeFile(path.join(artifactDir, "verification.json"), JSON.stringify({
    scenario: "masked-retention-success",
    credential: "redacted",
    elevenlabs: "connected",
    openrouter: "connected",
    fixtureCredential: "redacted",
  }, null, 2));
});

test("shows a mocked invalid ElevenLabs credential without claiming connection", async ({ page }) => {
  const artifactDir = path.resolve(process.cwd(), "test-artifacts", "elevenlabs-settings-regression");
  await fs.mkdir(artifactDir, { recursive: true });
  const invalidProfile = { ...baseProfile, elevenlabsStatus: "invalid_credentials", elevenlabsMessage: "ElevenLabs rejected the saved credentials" };
  await page.route("**/api/v1/profiles", (route) => route.fulfill({ json: [invalidProfile] }));
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const row = page.getByRole("article");
  await expect(row).toContainText("ElevenLabs rejected the saved credentials");
  await expect(row).not.toContainText("ElevenLabs authentication succeeded");
  await expect(row).toContainText("OpenRouter");
  await page.screenshot({ path: path.join(artifactDir, "invalid-credential.png"), fullPage: true });
});
