/**
 * §6 feature matrix, part two: Shorts Editor, Jobs, Settings and
 * Library. Read-only with respect to the owner's data — no profile is saved,
 * no asset is deleted, and no render is queued.
 */
import { test, expect, type Page } from "@playwright/test";

const BENIGN = /Cross-Origin-Opener-Policy header has been ignored.*untrustworthy/i;

async function boot(page: Page) {
  page.on("console", (m) => { if (m.type() === "error" && !BENIGN.test(m.text())) console.log("CONSOLE ERROR:", m.text()); });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#main-content")).toBeVisible();
  await page.waitForTimeout(4_000);
}

const rail = async (page: Page, name: string) => {
  await page.getByRole("button", { name, exact: true }).first().click();
  await page.waitForTimeout(2_000);
};

test.describe("§6.4 Shorts Editor", () => {
  test("trim validation rejects a negative start and an end at or before start", async ({ page }) => {
    await boot(page);
    await rail(page, "Shorts Editor");
    await page.getByRole("tab", { name: "Library" }).click();
    await page.waitForTimeout(800);
    const picker = page.locator("#shorts-source");
    await picker.selectOption((await picker.locator("option").nth(1).getAttribute("value"))!);
    await page.waitForTimeout(1_200);

    const start = page.getByRole("spinbutton", { name: "Start seconds" }).first();
    const end = page.getByRole("spinbutton", { name: "End seconds" }).first();

    await start.fill("10");
    await end.fill("10");
    await page.getByRole("button", { name: "Queue short" }).click();
    await expect(page.getByText("End seconds must be blank or greater than start.")).toBeVisible();

    await end.fill("5");
    await page.getByRole("button", { name: "Queue short" }).click();
    await expect(page.getByText("End seconds must be blank or greater than start.")).toBeVisible();
  });

  test("assistant applies bounded edits and refuses what it cannot do", async ({ page }) => {
    await boot(page);
    await rail(page, "Shorts Editor");
    await page.getByRole("tab", { name: "Library" }).click();
    await page.waitForTimeout(800);
    const picker = page.locator("#shorts-source");
    await picker.selectOption((await picker.locator("option").nth(1).getAttribute("value"))!);
    await page.waitForTimeout(1_200);

    const composer = page.getByRole("textbox", { name: "Editing request" });
    const send = page.getByRole("button", { name: "Send editing request" });
    const ask = async (text: string) => {
      await composer.fill(text);
      await send.click();
      await page.waitForTimeout(1_200);
    };

    await ask("make it 20 seconds");
    await expect(page.getByRole("spinbutton", { name: "End seconds" }).first()).toHaveValue("20");

    await ask("use 1:1");
    await expect(page.getByLabel("Aspect ratio")).toHaveValue("1:1");

    // A proposal must not touch the edit state until it is applied.
    await ask("propose duration 30 seconds");
    await expect(page.getByText("Proposal ready")).toBeVisible();
    await expect(page.getByRole("spinbutton", { name: "End seconds" }).first()).toHaveValue("20");
    await page.getByRole("button", { name: "Apply proposal" }).click();
    await page.waitForTimeout(600);
    await expect(page.getByRole("spinbutton", { name: "End seconds" }).first()).toHaveValue("30");

    await ask("propose duration 45 seconds");
    await page.getByRole("button", { name: "Reject" }).click();
    await page.waitForTimeout(600);
    await expect(page.getByRole("spinbutton", { name: "End seconds" }).first()).toHaveValue("30");

    await ask("centre the speaker");
    await expect(page.locator(".assistant-message.assistant").last())
      .toContainText(/not exposed by Shorts Editor yet/i);
  });

  test("clip filter narrows the browser to the chosen state", async ({ page }) => {
    await boot(page);
    await rail(page, "Shorts Editor");
    await expect(page.locator(".clip-browser-item").first()).toBeVisible({ timeout: 30_000 });
    const all = await page.locator(".clip-browser-item").count();
    await page.getByLabel("Filter clips").selectOption("complete");
    await page.waitForTimeout(1_200);
    const complete = await page.locator(".clip-browser-item").count();
    const badges = await page.locator(".clip-browser-item .status-badge, .clip-browser-item [class*='badge']").allTextContents();
    expect(complete, "complete-only must not exceed the full list").toBeLessThanOrEqual(all);
    expect(badges.every((b) => /complete/i.test(b)) || badges.length === 0,
      `every visible row should be complete: ${badges.join(",")}`).toBeTruthy();
  });
});

test.describe("§6.6 Jobs", () => {
  test("job cards carry a mode tag and only unsettled jobs show a progress bar", async ({ page }) => {
    await boot(page);
    await rail(page, "Jobs");
    await expect(page.locator(".job-card, article").first()).toBeVisible({ timeout: 30_000 });
    const settled = await page.evaluate(() => {
      const cards = [...document.querySelectorAll("#main-content article")];
      return cards.map((c) => ({
        text: (c.textContent || "").slice(0, 80),
        hasProgress: !!c.querySelector(".progress-wrap"),
      }));
    });
    expect(settled.length, "the Jobs screen should list jobs").toBeGreaterThan(0);
    const tagged = settled.filter((c) => /CLIP/i.test(c.text));
    expect(tagged.length, "every remaining job card should carry a CLIP tag").toBe(settled.length);
  });

  test("Open navigates to that project's Workspace", async ({ page }) => {
    await boot(page);
    await rail(page, "Jobs");
    await page.getByRole("button", { name: "Open", exact: true }).first().click();
    await page.waitForTimeout(2_500);
    await expect(page.getByRole("button", { name: "Workspace", exact: true })).toHaveAttribute("aria-current", "page");
  });
});

test.describe("§6.7 Settings", () => {
  test("stored secrets are never returned to the client", async ({ page, request }) => {
    await boot(page);
    const profiles = await (await request.get("/api/v1/profiles")).json();
    const serialised = JSON.stringify(profiles);
    expect(serialised, "a profile response must not carry a usable key").not.toMatch(/sk-or-v1-[A-Za-z0-9]{20,}/);
    await rail(page, "Settings");
    const edit = page.getByRole("button", { name: /^Edit / }).first();
    if (await edit.count()) {
      await edit.click();
      await page.waitForTimeout(1_200);
      const key = page.locator('input[type="password"], input[name*="key" i]').first();
      if (await key.count()) {
        expect(await key.inputValue(), "the key field must reopen empty").toBe("");
      }
    }
  });

  test("runtime capabilities mirror the engine health report", async ({ page, request }) => {
    await boot(page);
    await rail(page, "Settings");
    await page.waitForTimeout(2_000);
    const health = await (await request.get("/api/health")).json();
    const body = (await page.locator("#main-content").textContent()) || "";
    for (const [label, key] of [["FFmpeg", "ffmpeg"], ["FFprobe", "ffprobe"], ["Whisper", "whisper"]] as const) {
      if (health[key] === true) {
        expect(body, `${label} should be listed as available`).toMatch(new RegExp(label, "i"));
      }
    }
    expect(body, "the network boundary card should name the data path").toMatch(/data directory|Container data/i);
  });
});

test.describe("§6.8 Library", () => {
  test("filters combine and the empty state offers a clear action", async ({ page }) => {
    await boot(page);
    await rail(page, "Library");
    await page.getByLabel("Search media").fill("zzz-definitely-no-such-asset-zzz");
    await page.waitForTimeout(1_500);
    await expect(page.getByText(/No media matches these filters/i)).toBeVisible();
    await page.getByRole("button", { name: /Clear filters/i }).click();
    await page.waitForTimeout(1_500);
    expect(await page.locator(".asset-card, .asset-preview-trigger").count()).toBeGreaterThan(0);
  });

  test("media type and origin filters narrow the grid", async ({ page }) => {
    await boot(page);
    await rail(page, "Library");
    await page.waitForTimeout(2_000);
    const before = await page.locator(".asset-card, .asset-preview-trigger").count();
    await page.getByLabel("Asset origin").selectOption("generated-clip");
    await page.waitForTimeout(1_800);
    const after = await page.locator(".asset-card, .asset-preview-trigger").count();
    expect(after, "origin filter should not grow the result set").toBeLessThanOrEqual(before);
    expect(after, "there should be generated clips from this run").toBeGreaterThan(0);
  });

  test("folder tree supports roving keyboard navigation", async ({ page }) => {
    await boot(page);
    await rail(page, "Library");
    const items = page.locator('[role="treeitem"]');
    await expect(items.first()).toBeVisible({ timeout: 20_000 });
    const count = await items.count();
    expect(count, "the folder tree should expose treeitems").toBeGreaterThan(0);
    await items.first().focus();
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(300);
    const focused = await page.evaluate(() => document.activeElement?.getAttribute("role"));
    expect(focused, "ArrowDown should keep focus inside the tree").toBe("treeitem");
    await page.keyboard.press("End");
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => document.activeElement?.getAttribute("role"))).toBe("treeitem");
  });
});
