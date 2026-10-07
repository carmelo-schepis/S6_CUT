import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const fixtureRoot = process.env.S6_THUMBNAIL_FIXTURES;
const media = [
  { file: "portrait-source.mp4", title: "Still QA portrait red", channel: "red" },
  { file: "landscape-source.mp4", title: "Still QA landscape blue", channel: "blue" },
  { file: "black-intro.mp4", title: "Still QA black intro green", channel: "green" },
  { file: "very-short.mp4", title: "Still QA short yellow", channel: "yellow" },
  { file: "generated-clip.mp4", title: "Still QA generated purple", channel: "purple" },
] as const;

function isUnexpectedDiagnostic(event: unknown) {
  if (typeof event !== "object" || event === null || !("kind" in event)) return false;
  if (event.kind === "requestfailed" || event.kind === "pageerror") return true;
  if (event.kind === "response" && "status" in event) return typeof event.status === "number" && event.status >= 400;
  if (event.kind === "console" && "message" in event && typeof event.message === "string") {
    // WebKit reports the existing strict no-inline-style CSP as a console
    // error; retain it in evidence without weakening the app's policy.
    return !event.message.startsWith("Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline'");
  }
  return false;
}

function channelDominates(channel: string, rgb: number[]) {
  const [r, g, b] = rgb;
  if (channel === "red") return r > 100 && r > g * 1.35 && r > b * 1.35;
  if (channel === "green") return g > 80 && g > r * 1.2 && g > b * 1.15;
  if (channel === "blue") return b > 100 && b > r * 1.3 && b > g * 1.2;
  if (channel === "yellow") return r > 100 && g > 80 && b < Math.min(r, g) * 0.7;
  return r > 80 && b > 80 && r > g * 1.25 && b > g * 1.25;
}

async function recordEvidence(page: Page, events: unknown[], label: string, testInfo: TestInfo) {
  const diagnostics = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    bundleScripts: [...document.scripts].map((script) => script.src).filter(Boolean),
    media: [...document.querySelectorAll("video,audio,img")].map((node) => {
      const element = node as HTMLMediaElement & HTMLImageElement;
      return { tag: node.tagName, src: element.currentSrc || element.src, readyState: element.readyState, paused: element instanceof HTMLVideoElement ? element.paused : undefined, naturalWidth: element instanceof HTMLImageElement ? element.naturalWidth : undefined, naturalHeight: element instanceof HTMLImageElement ? element.naturalHeight : undefined, error: element instanceof HTMLMediaElement ? element.error?.code : undefined };
    }),
  }));
  await testInfo.attach("thumbnail-diagnostics", { body: JSON.stringify({ label, diagnostics, network: events }, null, 2), contentType: "application/json" });

}

test.describe("isolated Library still-thumbnail acceptance", () => {
  test("shows real decoded fixture frames without requesting or playing source video", async ({ page, request }, testInfo) => {
    expect(process.env.S6_ACCEPTANCE_ISOLATED, "mutating upload test requires a dedicated disposable app/backend").toBe("1");
    expect(process.env.S6_ACCEPTANCE_URL, "set the isolated app URL explicitly; shared/default app is not safe").toBeTruthy();
    expect(fixtureRoot, "generate local media with support/build_thumbnail_media.py and set S6_THUMBNAIL_FIXTURES").toBeTruthy();

    const observed: unknown[] = [];
    page.on("request", (requestEvent) => {
      if (/\.mp4(?:\?|$)/i.test(requestEvent.url())) observed.push({ kind: "request", url: requestEvent.url(), resourceType: requestEvent.resourceType() });
    });
    page.on("response", (response) => {
      if (response.status() >= 400 || response.url().includes("thumbnail") || response.url().includes("/library/assets")) observed.push({ kind: "response", url: response.url(), status: response.status(), resourceType: response.request().resourceType(), contentType: response.headers()["content-type"] });
    });
    page.on("requestfailed", (requestEvent) => observed.push({ kind: "requestfailed", url: requestEvent.url(), resourceType: requestEvent.resourceType(), failure: requestEvent.failure()?.errorText }));
    page.on("console", (message) => { if (message.type() === "error") observed.push({ kind: "console", message: message.text(), location: message.location() }); });
    page.on("pageerror", (error) => observed.push({ kind: "pageerror", message: error.message }));
    const uploaded: string[] = [];
    try {
      for (const fixture of media) {
        const filePath = path.join(fixtureRoot!, fixture.file);
        const response = await request.post("/api/v1/library/assets", {
          multipart: { file: { name: fixture.file, mimeType: "video/mp4", buffer: await readFile(filePath) }, title: fixture.title, licence: "QA disposable", policy: "neutral" },
        });
        expect(response.status(), `upload ${fixture.file}`).toBe(200);
        const asset = await response.json() as { id: string };
        uploaded.push(asset.id);
      }

      await page.goto("/");
      await page.getByRole("button", { name: "Library", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Personal Media Library", exact: true })).toBeVisible();
      const search = page.getByRole("textbox", { name: "Search media" });
      const thumbnailSources = new Set<string>();
      for (const fixture of media) {
        await search.fill(fixture.title);
        const card = page.locator(".asset-card").filter({ has: page.getByText(fixture.title, { exact: true }) });
        await expect(card).toHaveCount(1);
        const image = card.locator("img");
        await expect(image, `${fixture.title} should render an image, not a video poster`).toBeVisible();
        const decoded = await image.evaluate(async (element) => {
          const img = element as HTMLImageElement;
          await img.decode();
          const canvas = document.createElement("canvas");
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const context = canvas.getContext("2d", { willReadFrequently: true })!;
          context.drawImage(img, 0, 0);
          const { data } = context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1);
          return { width: img.naturalWidth, height: img.naturalHeight, rgb: [data[0], data[1], data[2]] };
        });
        expect(decoded.width, `${fixture.title} natural width`).toBeGreaterThan(0);
        expect(decoded.height, `${fixture.title} natural height`).toBeGreaterThan(0);
        expect(channelDominates(fixture.channel, decoded.rgb), `${fixture.title} center pixel ${decoded.rgb}`).toBe(true);
        thumbnailSources.add(await image.evaluate((element) => (element as HTMLImageElement).currentSrc));
        await card.screenshot({ path: testInfo.outputPath(`thumbnail-${fixture.file.replaceAll(/[^a-z0-9]+/gi, "-")}.png`) });
      }
      expect(thumbnailSources.size, "each thumbnail is from its own signed asset endpoint").toBeGreaterThanOrEqual(media.length);
      await search.fill("");
      expect(await page.locator("video[src]").count(), "cards must not assign the source video URL").toBe(0);
      expect(observed.filter((event) => JSON.stringify(event).includes(".mp4")), "no source-video requests before opening the explicit player").toEqual([]);
      const initialErrors = observed.filter(isUnexpectedDiagnostic);
      expect(initialErrors, "thumbnail loading has no failed responses or browser/media errors").toEqual([]);
      expect(await page.locator("video").evaluateAll((items) => items.every((item) => (item as HTMLVideoElement).paused)), "browsing never starts a video").toBe(true);
      expect(await page.locator("audio").evaluateAll((items) => items.every((item) => (item as HTMLAudioElement).paused)), "browsing never starts audio").toBe(true);

      const retainedCard = page.locator(".asset-card").filter({ has: page.getByText(media[0].title, { exact: true }) });
      const retainedUrl = await retainedCard.locator("img").getAttribute("src");
      await page.getByRole("textbox", { name: "Search media" }).fill(media[0].title);
      await expect(page.locator(".asset-card")).toHaveCount(1);
      await expect(page.locator(".asset-card img")).toHaveAttribute("src", /./);
      await page.getByRole("textbox", { name: "Search media" }).fill("");
      for (const fixture of media) {
        const card = page.locator(".asset-card").filter({ has: page.getByText(fixture.title, { exact: true }) });
        await expect(card, `${fixture.title} remains in the unfiltered Library`).toHaveCount(1);
      }
      expect(await retainedCard.locator("img").getAttribute("src")).toBe(retainedUrl);
      await page.reload();
      await page.getByRole("button", { name: "Library", exact: true }).click();
      const reloadedImage = page.locator(".asset-card img").first();
      await expect(reloadedImage).toBeVisible();
      expect(await reloadedImage.evaluate(async (element) => {
        const image = element as HTMLImageElement;
        try { await image.decode(); return image.naturalWidth > 0 && image.naturalHeight > 0; } catch { return false; }
      })).toBe(true);
      await page.getByRole("textbox", { name: "Search media" }).fill(media[0].title);

      // Card selection and preview controls remain usable and separate.
      await page.getByRole("checkbox", { name: media[0].title }).check();
      await expect(page.getByRole("checkbox", { name: media[0].title })).toBeChecked();
      await page.getByRole("button", { name: `Select ${media[0].title} for Rule Inspector` }).click();
      await expect(page.locator(".asset-inspector input").first()).toHaveValue(media[0].title);
      await page.getByRole("button", { name: `Preview ${media[0].title}` }).click();
      const dialog = page.getByRole("dialog", { name: `${media[0].title} video preview` });
      await expect(dialog.locator("video")).toBeVisible();
      await expect.poll(() => dialog.locator("video").evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
      await expect(page.getByRole("checkbox", { name: media[0].title })).toBeChecked();
      if (testInfo.project.use.browserName === "chromium") {
        const video = dialog.locator("video");
        await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThan(0);
        await page.getByRole("button", { name: "Play video", exact: true }).click();
        await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0);
      }
      await page.getByRole("button", { name: "Close video preview", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByRole("button", { name: `Preview ${media[0].title}` })).toBeFocused();
      const runtimeErrors = observed.filter(isUnexpectedDiagnostic);
      expect(runtimeErrors, "no console/page errors or unexpected HTTP failures").toEqual([]);
      await recordEvidence(page, observed, testInfo.project.name, testInfo);
    } finally {
      for (const id of uploaded) await request.delete(`/api/v1/library/assets/${id}`).catch(() => undefined);
    }
  });

  test("renews an expired signed thumbnail without a reload loop", async ({ page, request }, testInfo) => {
    expect(process.env.S6_ACCEPTANCE_ISOLATED, "mutating upload test requires a dedicated disposable app/backend").toBe("1");
    expect(process.env.S6_ACCEPTANCE_URL, "set the isolated app URL explicitly; shared/default app is not safe").toBeTruthy();
    expect(fixtureRoot, "generate local media and set S6_THUMBNAIL_FIXTURES").toBeTruthy();
    const uploaded = await request.post("/api/v1/library/assets", { multipart: {
      file: { name: "expired-link.mp4", mimeType: "video/mp4", buffer: await readFile(path.join(fixtureRoot!, "landscape-source.mp4")) },
      title: "Still QA expired signature blue", licence: "QA disposable", policy: "neutral",
    } });
    expect(uploaded.status()).toBe(200);
    const asset = await uploaded.json() as { id: string };
    const expiredResponses: number[] = [];
    const renewalStatuses: number[] = [];
    let forcedExpiry = false;
    page.on("response", (response) => {
      if (response.url().includes("/thumbnail-url")) renewalStatuses.push(response.status());
      if (response.url().includes("/thumbnail?")) expiredResponses.push(response.status());
    });
    if (testInfo.project.use.browserName !== "webkit") {
      await page.route("**/api/v1/library/assets**", async (route) => {
        const url = new URL(route.request().url());
        if (route.request().method() !== "GET" || url.pathname !== "/api/v1/library/assets") return route.fallback();
        const response = await route.fetch();
        const result = await response.json() as Array<{ id: string; thumbnailUrl?: string | null }>;
        const item = result.find((candidate) => candidate.thumbnailUrl);
        if (!forcedExpiry && item?.thumbnailUrl) {
          const url = new URL(item.thumbnailUrl, process.env.S6_ACCEPTANCE_URL);
          url.searchParams.set("expires", "1");
          item.thumbnailUrl = url.toString();
          forcedExpiry = true;
        }
        await route.fulfill({ response, json: result });
      });
    }

    try {
      await page.goto("/");
      await page.getByRole("button", { name: "Library", exact: true }).click();
      await page.getByRole("textbox", { name: "Search media" }).fill("Still QA expired signature blue");
      const card = page.locator(".asset-card").filter({ has: page.getByText("Still QA expired signature blue", { exact: true }) });
      const image = card.locator("img");
      await expect(image).toBeVisible();
      await image.scrollIntoViewIfNeeded();
      if (testInfo.project.use.browserName === "webkit") {
        await page.waitForTimeout(1100);
        const expiredUrl = new URL(await image.getAttribute("src")!, process.env.S6_ACCEPTANCE_URL);
        expiredUrl.searchParams.set("expires", "1");
        await image.evaluate((element, url) => { (element as HTMLImageElement).src = url; }, expiredUrl.toString());
        forcedExpiry = true;
      }
      await expect.poll(() => image.evaluate(async (element) => {
        const img = element as HTMLImageElement;
        try { await img.decode(); return img.naturalWidth > 0 && img.naturalHeight > 0; } catch { return false; }
      })).toBe(true);
      expect(forcedExpiry).toBe(true);
      expect(expiredResponses).toContain(403);
      expect(expiredResponses).toContain(200);
      expect(renewalStatuses).toEqual([200]);
      await expect(page.locator("video[src]")).toHaveCount(0);
      await card.screenshot({ path: testInfo.outputPath("thumbnail-expired-link-recovered.png") });
      await recordEvidence(page, [{ expiredResponses, renewalStatuses }], testInfo.project.name, testInfo);
    } finally {
      await request.delete(`/api/v1/library/assets/${asset.id}`).catch(() => undefined);
    }
  });
});
