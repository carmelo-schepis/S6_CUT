import { expect, test } from "@playwright/test";

// S6_cut uses OpenRouter for Smart clip selection. ElevenLabs is a retired
// provider; its legacy credential is scrubbed from encrypted profiles at
// startup and must never reach a customer's screen or the shipped bundle.
const FORBIDDEN = /eleven\s*labs|elevenlabs/i;

test("Settings and the provider form never mention ElevenLabs", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Runtime capabilities", exact: true })).toBeVisible();

  const settingsText = await page.locator("body").innerText();
  expect(settingsText, "Settings screen").not.toMatch(FORBIDDEN);

  // The provider form is the surface that used to carry a per-provider key
  // field, so it is the one most likely to regrow an ElevenLabs input.
  await page.getByRole("button", { name: "New profile" }).click();
  await expect(page.getByPlaceholder("My OpenRouter profile")).toBeVisible();
  const formText = await page.locator("body").innerText();
  expect(formText, "provider form").not.toMatch(FORBIDDEN);

  // Every labelled control on the form, including ones whose text is only an
  // accessible name rather than rendered copy.
  const controlNames = await page.locator("input, select, textarea, button, label").evaluateAll((elements) => elements
    .map((element) => [element.getAttribute("aria-label"), element.getAttribute("placeholder"), element.textContent].join(" "))
    .join(" "));
  expect(controlNames, "provider form controls").not.toMatch(FORBIDDEN);
});

test("the served bundle ships no ElevenLabs string", async ({ request }) => {
  const shell = await request.get("/");
  expect(shell.ok()).toBeTruthy();
  const html = await shell.text();
  expect(html, "index.html").not.toMatch(FORBIDDEN);

  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]);
  expect(assets.length, "index.html references hashed assets").toBeGreaterThan(0);

  for (const asset of assets) {
    const response = await request.get(asset);
    expect(response.ok(), asset).toBeTruthy();
    expect(await response.text(), asset).not.toMatch(FORBIDDEN);
  }
});
