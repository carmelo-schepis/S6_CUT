import { expect, test } from "@playwright/test";

const profile = {
  id: "purge-profile", name: "Local profile", textModelId: "openai/gpt-4.1-mini", ttsModelId: null, ttsVoice: null, ttsSpeed: 1, selected: true,
  persistence: "encrypted", openrouterConfigured: false, openrouterMasked: null, textStatus: "not_configured", ttsStatus: "not_configured",
  textMessage: null, textLastCheckedAt: null, ttsMessage: null, ttsLastCheckedAt: null, status: "local only", capabilities: [], fallbacks: { planning: "deterministic" },
};

for (const [name, width, height] of [["desktop", 1440, 900], ["tablet", 768, 1024], ["mobile", 390, 844]] as const) {
  test(`confirms Library purge accessibly at ${name}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.route("**/api/v1/profiles", (route) => route.fulfill({ json: [profile] }));
    await page.route("**/api/v1/library/purge", async (route) => {
      expect(route.request().method()).toBe("POST");
      expect((await route.request().postDataJSON()).confirmation).toBe("DELETE ALL CONTENT");
      await route.fulfill({ json: { assetsDeleted: 4, projectsDeleted: 1, blobsDeleted: 4, bytesReclaimed: 4096, warnings: [] } });
    });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const trigger = page.getByRole("button", { name: "Delete all Library content" });
    await expect(trigger).toBeVisible();
    await trigger.focus(); await trigger.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Delete permanently" })).toBeDisabled();
    await dialog.getByLabel(/Type DELETE ALL CONTENT/i).fill("DELETE ALL CONTENT");
    await expect(dialog.getByRole("button", { name: "Delete permanently" })).toBeEnabled();
    await dialog.getByRole("button", { name: "Delete permanently" }).click();
    await expect(page.getByRole("status")).toContainText("Library is empty");
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
  });
}

test("Library purge dialog can be cancelled with Escape", async ({ page }) => {
  await page.route("**/api/v1/profiles", (route) => route.fulfill({ json: [profile] }));
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const trigger = page.getByRole("button", { name: "Delete all Library content" });
  await trigger.click(); await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape"); await expect(page.getByRole("dialog")).toBeHidden(); await expect(trigger).toBeFocused();
});
