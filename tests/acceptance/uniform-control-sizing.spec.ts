import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs/promises";

const viewports = [
  ["desktop", 1440, 900],
  ["laptop", 1024, 768],
  ["tablet", 768, 1024],
  ["mobile", 390, 844],
] as const;
const destinations = ["Projects", "Library", "Workspace", "Shorts Editor", "AI Video", "Jobs", "Settings"] as const;

async function navigate(page: Page, destination: string) {
  const button = page.getByRole("button", { name: destination, exact: true }).first();
  await expect(button, `navigation to ${destination}`).toBeVisible();
  await button.click();
}

async function visibleInventory(page: Page, screen: string) {
  return page.evaluate((screenName) => {
    const accessibleName = (element: HTMLElement) => element.getAttribute("aria-label")
      || element.getAttribute("title") || element.innerText?.trim().replace(/\s+/g, " ").slice(0, 100)
      || element.getAttribute("placeholder") || element.tagName.toLowerCase();
    const elements = [...document.querySelectorAll<HTMLElement>("button, input, select, textarea, a.button, [role=tab], [role=checkbox], .status")];
    return elements.filter((element) => element.getClientRects().length > 0).map((element) => {
      const rect = element.getBoundingClientRect();
      const className = typeof element.className === "string" ? element.className.trim().split(/\s+/).filter(Boolean).join(".") : "";
      return {
        screen: screenName,
        name: accessibleName(element),
        class: className || element.tagName.toLowerCase(),
        width: rect.width,
        height: rect.height,
        tag: element.tagName.toLowerCase(),
        disabled: (element as HTMLButtonElement).disabled || element.getAttribute("aria-disabled") === "true",
        role: element.getAttribute("role"),
        inputType: (element as HTMLInputElement).type,
        boxSizing: getComputedStyle(element).boxSizing,
        value: "value" in element ? String((element as HTMLInputElement).value) : "",
        ariaValueNow: element.getAttribute("aria-valuenow"),
      };
    });
  }, screen);
}

async function checkPage(page: Page, label: string) {
  const overflow = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth }));
  expect(overflow.width, `${label}: horizontal document overflow`).toBeLessThanOrEqual(overflow.viewport + 1);
}

async function snap(page: Page, path: string) {
  await page.screenshot({ path, fullPage: false, animations: "disabled" });
}

test.describe("uniform rendered control sizing", () => {
  test("all destinations expose labelled controls; geometry inventory and priority screenshots", async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    const inventory: Awaited<ReturnType<typeof visibleInventory>> = [];

    for (const [viewport, width, height] of viewports) {
      await page.setViewportSize({ width, height });
      await page.goto("/", { waitUntil: "domcontentloaded" });
      for (const destination of destinations) {
        await navigate(page, destination);
        await page.waitForTimeout(180);
        await checkPage(page, `${viewport}/${destination}`);
        const records = await visibleInventory(page, destination);
        expect(records.length, `${viewport}/${destination}: expected interactive controls`).toBeGreaterThan(0);
        expect(records.some((control) => !control.name.trim()), `${destination}: controls need readable accessible names`).toBe(false);
        for (const record of records) {
          expect(record.width, `${destination}/${record.name}: zero-width control`).toBeGreaterThan(0);
          expect(record.height, `${destination}/${record.name}: zero-height control`).toBeGreaterThan(0);
          const expected = record.tag === "input" && record.inputType === "checkbox" ? { width: 24, height: 24 }
            : { width: 144, height: 40 };
          expect(Math.abs(record.width - expected.width), `${viewport}/${destination}/${record.name}: expected outer width ${expected.width}px, got ${record.width}px`).toBeLessThanOrEqual(1);
          expect(Math.abs(record.height - expected.height), `${viewport}/${destination}/${record.name}: expected outer height ${expected.height}px, got ${record.height}px`).toBeLessThanOrEqual(1);
          expect(record.boxSizing, `${viewport}/${destination}/${record.name}: expected border-box`).toBe("border-box");
        }
        inventory.push(...records);
        if (viewport === "desktop" && ["Projects", "Workspace", "Settings"].includes(destination)) {
          await snap(page, testInfo.outputPath(`${destination.toLowerCase().replaceAll(" ", "-")}-desktop.png`));
        }
      }
    }

    const artifact = testInfo.outputPath("control-dimensions.json");
    await fs.writeFile(artifact, JSON.stringify({ kind: "gateway-backed-layout-observation", viewports: viewports.map(([name, width, height]) => ({ name, width, height })), dimensions: inventory }, null, 2));
    await testInfo.attach("control-dimensions", { path: artifact, contentType: "application/json" });

    await page.setViewportSize({ width: 390, height: 844 });
    for (const destination of ["Projects", "Workspace", "Settings"]) {
      await navigate(page, destination);
      await snap(page, testInfo.outputPath(`${destination.toLowerCase().replaceAll(" ", "-")}-mobile.png`));
    }
  });

  test("Projects states, count field, keyboard interaction and no decorative clutter actions", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await navigate(page, "Projects");
    await expect(page.getByRole("heading", { name: "Create a project" })).toBeVisible();
    for (const name of ["Auto", "Fast", "Smart"]) await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Create/ })).toBeVisible();
    const businessFolder = page.getByLabel("Business folder");
    await expect(businessFolder).toBeVisible();
    expect(await businessFolder.locator("option").count()).toBeGreaterThan(0);
    await businessFolder.focus();
    await expect(businessFolder).toBeFocused();
    await page.getByLabel("Project name").fill("Control sizing interaction");
    await expect(page.getByLabel("Project name")).toHaveValue("Control sizing interaction");
    await page.getByRole("button", { name: "Advanced controls" }).click();
    await expect(page.getByLabel("Minimum seconds")).toBeVisible();

    await page.getByRole("button", { name: /High-volume · up to 500/ }).click();
    const count = page.getByLabel("Clips requested");
    await expect(count).toBeVisible();
    await expect(page.locator(".count-control button")).toHaveCount(0);
    if (await count.count()) {
      await count.fill("500");
      await expect(count).toHaveValue("500");
      await count.fill("501");
      await count.press("Tab");
      const value = Number(await count.inputValue());
      expect(value, "high-volume over-limit value is rejected or capped").toBeGreaterThan(0);
      if (value > 500) {
        await expect(count).toHaveAttribute("aria-invalid", "true");
        await expect(page.getByRole("status")).toContainText("Maximum is 500");
        await page.getByRole("tab", { name: "YouTube" }).click();
        await page.locator("#source-youtube-url").fill("https://www.youtube.com/watch?v=abcdefghijk");
        await page.getByRole("button", { name: /^Create/ }).click();
        await expect(page.getByRole("alert")).toContainText("High-volume batches support 1–500");
      } else expect(value).toBe(500);
    }

    const tabs = page.locator(".processing-mode-tabs");
    for (const name of ["Auto", "Fast", "Smart"]) {
      const option = tabs.getByRole("button", { name, exact: true });
      const before = await option.boundingBox();
      await option.evaluate((element) => (element as HTMLButtonElement).focus({ focusVisible: true }));
      expect(await option.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe("none");
      await option.click();
      const after = await option.boundingBox();
      expect(Math.abs(before!.width - after!.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(before!.height - after!.height)).toBeLessThanOrEqual(1);
    }
    const actions = await page.locator(".create-panel button").allTextContents();
    expect(actions.map((label) => label.trim()).filter(Boolean)).not.toContain("Edit");
    await page.getByRole("button", { name: "Music / sung vocals" }).click();
    const disabledHighVolume = page.getByRole("button", { name: /High-volume · up to 500/ });
    await expect(disabledHighVolume).toBeDisabled();
    const disabledBox = await disabledHighVolume.boundingBox();
    expect(Math.abs(disabledBox!.width - 144), "disabled batch mode width").toBeLessThanOrEqual(1);
    expect(Math.abs(disabledBox!.height - 40), "disabled batch mode height").toBeLessThanOrEqual(1);
  });

  test("mocked Settings profile workflow keeps saved, adding, testing, and bare actions reachable", async ({ page }) => {
    const profile = {
      id: "control-profile", name: "Control profile", textModelId: "openai/gpt-4.1-mini", ttsModelId: "free/speech", ttsVoice: "alloy", ttsSpeed: 1, selected: true,
      persistence: "encrypted", openrouterConfigured: true, openrouterMasked: "••••test", textStatus: "configured", ttsStatus: "configured",
      textMessage: "Ready to test", textLastCheckedAt: null, ttsMessage: "Ready to test", ttsLastCheckedAt: null,
      status: "configured", capabilities: [], fallbacks: { planning: "Deterministic local planning" },
    };
    let profiles = [profile];
    let duplicateCount = 0;
    let testingRequestObserved = false;
    await page.route("**/api/v1/profiles", async (route) => {
      if (route.request().method() === "GET") return route.fulfill({ json: profiles });
      const body = route.request().postDataJSON();
      const saved = { ...profile, ...body, id: "created-profile" };
      profiles = [...profiles, saved];
      return route.fulfill({ json: saved });
    });
    await page.route("**/api/v1/profiles/*", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.endsWith("/test")) {
        await new Promise((resolve) => setTimeout(resolve, 600));
        const connected = { ...profile, textStatus: "connected", ttsStatus: "connected", status: "connected", textMessage: "Connected; text generation succeeded", ttsMessage: "Connected; speech is available" };
        profiles = profiles.map((item) => item.id === connected.id ? connected : item);
        return route.fulfill({ json: connected });
      }
      if (path.endsWith("/duplicate")) {
        duplicateCount += 1;
        const copied = { ...profile, id: `duplicate-${duplicateCount}`, name: `${profile.name} copy`, selected: false };
        profiles = [...profiles, copied];
        return route.fulfill({ json: copied });
      }
      if (request.method() === "DELETE") {
        profiles = profiles.filter((item) => item.id !== "duplicate-1");
        return route.fulfill({ status: 204, body: "" });
      }
      return route.fulfill({ json: profile });
    });
    await page.route(/\/api\/v1\/profiles\/[^/]+\/test$/, async (route) => {
      testingRequestObserved = true;
      await new Promise((resolve) => setTimeout(resolve, 600));
      const connected = { ...profile, textStatus: "connected", ttsStatus: "connected", status: "connected", textMessage: "Connected; text generation succeeded", ttsMessage: "Connected; speech is available" };
      profiles = profiles.map((item) => item.id === connected.id ? connected : item);
      return route.fulfill({ json: connected });
    });
    await page.route(/\/api\/v1\/profiles\/[^/]+\/duplicate$/, async (route) => {
      duplicateCount += 1;
      const copied = { ...profile, id: `duplicate-${duplicateCount}`, name: `${profile.name} copy`, selected: false };
      profiles = [...profiles, copied];
      return route.fulfill({ json: copied });
    });
    await page.route("**/api/v1/health", async (route) => route.fulfill({ json: { status: "ready", version: "test", database: true, ffmpeg: true, ffprobe: true, whisper: true, ytdlp: true, localTts: true, dataPath: "/test", freeBytes: 0, activeWorkers: 0, queuedJobs: 0, fallbacks: {} } }));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await navigate(page, "Settings");
    const row = page.getByRole("article").filter({ hasText: "Control profile" });
    await expect(row).toContainText("configured");
    await expect(row).toContainText("Ready to test");
    const measureControl = async (locator: ReturnType<typeof page.locator>, name: string) => {
      const box = await locator.boundingBox();
      expect(box, name).not.toBeNull();
      expect(Math.abs(box!.width - 144), `${name} width`).toBeLessThanOrEqual(1);
      expect(Math.abs(box!.height - 40), `${name} height`).toBeLessThanOrEqual(1);
      expect(await locator.evaluate((element) => getComputedStyle(element).boxSizing), `${name} border-box`).toBe("border-box");
    };
    await measureControl(row.locator(".status").first(), "Settings status box");
    const testButton = row.locator(".profile-actions > button").first();
    await expect(testButton).toBeEnabled();
    await measureControl(testButton, "Settings Test action");
    await testButton.click();
    await expect.poll(() => testingRequestObserved).toBe(true);
    await measureControl(testButton, "Settings in-flight Test action");
    await expect(row).toContainText("Connected; text generation succeeded");
    await measureControl(testButton, "Settings completed Test action");
    const add = page.getByRole("button", { name: "Add profile" });
    await expect(add).toBeVisible();
    await measureControl(add, "Settings Add profile action");
    await add.click();
    const profileName = page.getByLabel("Profile name");
    await expect(profileName).toBeVisible();
    await measureControl(profileName, "Add profile dialog field");
    await profileName.fill("Edited fixture");
    await expect(profileName).toHaveValue("Edited fixture");
    const cancelAdd = page.getByRole("button", { name: "Cancel", exact: true });
    await measureControl(cancelAdd, "Add profile dialog Cancel action");
    await cancelAdd.click();
    const edit = row.getByRole("button", { name: "Edit Control profile" });
    await measureControl(edit, "Settings Edit action");
    await edit.click();
    await expect(page.getByLabel("Profile name")).toHaveValue("Control profile");
    await measureControl(page.getByRole("button", { name: "Cancel", exact: true }), "Edit profile dialog Cancel action");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    const duplicate = row.getByRole("button", { name: "Duplicate Control profile" });
    await measureControl(duplicate, "Settings Duplicate action");
    await duplicate.click();
    await expect(page.getByText("Control profile copy")).toBeVisible();
    const deleteAction = page.getByRole("button", { name: "Delete Control profile copy" });
    await measureControl(deleteAction, "Settings Delete action");
    page.once("dialog", (dialog) => dialog.accept());
    await deleteAction.click();
    await expect(page.getByText("Control profile copy")).toHaveCount(0);
  });

  test("mocked completed Workspace keeps folder, status, media, and transport controls at fixed size", async ({ page }) => {
    test.setTimeout(90_000);
    test.info().annotations.push({ type: "scope", description: "Mocked UI/API fixture only; no real gateway, media rendering, or encoding is exercised." });
    const now = "2026-01-01T00:00:00Z";
    const folders = [
      { id: "unsorted", name: "Unsorted", description: "", color: null, parentId: null, archived: false, system: true, createdAt: now, updatedAt: now },
      { id: "business", name: "Business", description: "", color: null, parentId: null, archived: false, system: false, createdAt: now, updatedAt: now },
    ];
    const project = { schemaVersion: 1, id: "sizing-project", name: "Sizing Workspace fixture", mode: "clip", style: "educational", state: "complete", sourceName: "fixture.mp4", sourceKind: "upload", requestedCount: 3, contentFormat: "short", latestJobId: "sizing-job", libraryFolderId: "business", sourceBlobId: null, createdAt: now, updatedAt: now };
    let job = {
      schemaVersion: 1, id: "sizing-job", projectId: project.id, libraryFolderId: "business", sourceBlobId: null, mode: "clip", state: "complete", stage: "complete", stageLabel: "3 clips ready", progress: 100, currentItem: 3, totalItems: 3, style: "educational", processingMode: "fast", contentFormat: "short", burnSubtitles: false, embedSubtitles: false, warnings: [], error: null,
      clips: [1, 2, 3].map((index) => ({ id: `sizing-clip-${index}`, index, state: "complete", start: index * 10, end: index * 10 + 8, duration: 8, openingLine: `Fixture clip ${index}`, score: null, selected: true, outputName: `0${index}-clip.mp4`, blobId: `sizing-blob-${index}`, downloadUrl: "/mock/clip.mp4", previewUrl: "/mock/clip.mp4", libraryAssetId: `sizing-asset-${index}`, title: `Fixture clip ${index}`, width: 1080, height: 1920, folderId: "business", publishedAt: now, fallbackUsed: false, provenance: [] })),
      beats: [], steps: [{ id: "render", label: "Clips rendered and saved", status: "complete", completedAt: now, currentItem: 3, totalItems: 3 }, { id: "ready", label: "Project ready", status: "complete", completedAt: now }], createdAt: now, updatedAt: now,
    };
    await page.route("**/mock/clip.mp4", (route) => route.fulfill({ status: 200, contentType: "video/mp4", body: "mock media" }));
    await page.route("**/api/v1/**", async (route) => {
      const request = route.request(); const path = new URL(request.url()).pathname;
      if (path.endsWith("/health")) return route.fulfill({ json: { status: "ready", version: "mock", database: true, ffmpeg: true, ffprobe: true, whisper: true, ytdlp: true, localTts: true, dataPath: "mock", freeBytes: 0, activeWorkers: 0, queuedJobs: 0, fallbacks: {} } });
      if (path.endsWith("/profiles")) return route.fulfill({ json: [] });
      if (path.endsWith("/library/folders")) return route.fulfill({ json: folders });
      if (path.endsWith("/library/assets")) return route.fulfill({ json: [] });
      if (path.endsWith("/projects") || path.endsWith("/projects/sizing-project")) return route.fulfill({ json: path.endsWith("/projects") ? [project] : project });
      if (path.endsWith("/jobs") ) return route.fulfill({ json: [job] });
      if (path.endsWith("/jobs/sizing-job/events")) return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": keep-alive\\n\\n" });
      if (path.endsWith("/jobs/sizing-job/selection") && request.method() === "PUT") {
        const ids = new Set((request.postDataJSON() as { clipIds: string[] }).clipIds);
        job = { ...job, clips: job.clips.map((clip) => ({ ...clip, selected: ids.has(clip.id) })) };
        return route.fulfill({ json: job });
      }
      if (path.endsWith("/jobs/sizing-job/export")) return route.fulfill({ json: { downloadUrl: "#download", filename: "sizing.zip" } });
      if (path.endsWith("/jobs/sizing-job")) return route.fulfill({ json: job });
      return route.fulfill({ status: 404, json: { detail: `Unhandled mock: ${request.method()} ${path}` } });
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await navigate(page, "Workspace");
    await expect(page.getByRole("heading", { name: project.name })).toBeVisible();
    await expect(page.getByText("3 clips ready")).toBeVisible();
    await expect(page.getByText(/saved/i).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /Download ZIP 3/i })).toBeVisible();
    const dimensions = async (locator: ReturnType<typeof page.locator>, name: string) => {
      await expect(locator, `${name} exists`).toBeVisible();
      const box = await locator.boundingBox();
      expect(box, name).not.toBeNull();
      const isCheckbox = await locator.evaluate((element) => element instanceof HTMLInputElement && element.type === "checkbox");
      const expectedWidth = isCheckbox ? 24 : 144;
      const expectedHeight = isCheckbox ? 24 : 40;
      expect(Math.abs(box!.width - expectedWidth), `${name} width`).toBeLessThanOrEqual(1);
      expect(Math.abs(box!.height - expectedHeight), `${name} height`).toBeLessThanOrEqual(1);
      const sizing = await locator.evaluate((element) => getComputedStyle(element).boxSizing);
      expect(sizing, `${name} border-box`).toBe("border-box");
      return box!;
    };
    const folderSelect = page.locator("select").filter({ has: page.locator("option") }).first();
    await dimensions(folderSelect, "Workspace Business folder select");
    await expect(folderSelect.locator("option", { hasText: "Business" })).toHaveCount(1);
    await folderSelect.selectOption({ label: "Unsorted" });
    await folderSelect.selectOption({ label: "Business" });
    const selection = page.locator(".clip-board .clip-tile input[type=checkbox]").first();
    const selectBox = await dimensions(selection, "clip selection checkbox");
    expect(Math.abs(selectBox.width - 24)).toBeLessThanOrEqual(1);
    expect(Math.abs(selectBox.height - 24)).toBeLessThanOrEqual(1);
    const selectionResponse = page.waitForResponse((response) => response.request().method() === "PUT" && response.url().endsWith("/selection"));
    await selection.click(); await selectionResponse; await expect(selection).not.toBeChecked();
    const unselectedCheckbox = await selection.boundingBox();
    expect(Math.abs(selectBox.width - unselectedCheckbox!.width), "selection state does not resize checkbox").toBeLessThanOrEqual(1);
    expect(Math.abs(selectBox.height - unselectedCheckbox!.height), "selection state does not resize checkbox").toBeLessThanOrEqual(1);
    await dimensions(selection, "unselected clip checkbox");
    const reducedZip = page.getByRole("button", { name: /Download ZIP 2/i });
    await expect(reducedZip).toBeVisible();
    const beforeCountBox = await reducedZip.boundingBox();
    await page.locator(".clip-board .clip-tile").first().getByRole("button", { name: "Preview", exact: true }).click();
    await expect(page.locator(".viewer-frame video")).toBeVisible();
    const play = page.locator(".play-button");
    const playBox = await dimensions(play, "media play control");
    await play.click();
    for (const [label, selector] of [["previous frame", "Previous frame"], ["next frame", "Next frame"]] as const) {
      const control = page.getByRole("button", { name: selector, exact: true });
      await dimensions(control, `transport ${label}`);
      await control.focus(); await expect(control).toBeFocused();
      await control.click();
    }
    const pauseBox = await play.boundingBox();
    await dimensions(play, "media pause control");
    expect(Math.abs(playBox.width - pauseBox!.width), "play/pause state preserves control width").toBeLessThanOrEqual(1);
    expect(Math.abs(playBox.height - pauseBox!.height), "play/pause state preserves control height").toBeLessThanOrEqual(1);
    const zip = page.getByRole("button", { name: /Download ZIP 2/i });
    const afterCountBox = await zip.boundingBox();
    expect(Math.abs(beforeCountBox!.width - afterCountBox!.width), "selection count does not resize ZIP action").toBeLessThanOrEqual(1);
    expect(Math.abs(beforeCountBox!.height - afterCountBox!.height), "selection count does not resize ZIP action").toBeLessThanOrEqual(1);
    await dimensions(zip, "Download ZIP action");
    const exportResponse = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/jobs/sizing-job/export"));
    await zip.click();
    expect((await exportResponse).ok(), "ZIP export request succeeds").toBe(true);
    await expect(page).toHaveURL(/#download$/);
    await expect(page.getByRole("button", { name: /Download ZIP 2/i })).toBeVisible();
    const noOverlap = await page.evaluate(() => {
      const prioritized = [...document.querySelectorAll<HTMLElement>(".clip-board input[type=checkbox], .workspace-page button")]
        .filter((element) => element.getClientRects().length && /Download ZIP|frame|play|pause/i.test(`${element.getAttribute("aria-label")} ${element.textContent}`));
      const rects = prioritized.map((element) => ({ name: element.getAttribute("aria-label") || element.textContent?.trim(), rect: element.getBoundingClientRect() }));
      return rects.flatMap((item, index) => rects.slice(index + 1).filter((other) => item.rect.left < other.rect.right && item.rect.right > other.rect.left && item.rect.top < other.rect.bottom && item.rect.bottom > other.rect.top).map((other) => [item.name, other.name]));
    });
    expect(noOverlap, "priority transport and ZIP actions do not overlap").toEqual([]);
  });

  test("Shorts clip actions retain fixed size without selecting the card", async ({ page }) => {
    const now = "2026-01-01T00:00:00Z";
    const clipJob = {
      schemaVersion: 1, id: "shorts-sizing-job", projectId: "shorts-sizing-project", libraryFolderId: "unsorted", sourceBlobId: null, mode: "clip", state: "complete", stage: "complete", stageLabel: "Review clips", progress: 100, currentItem: 2, totalItems: 2, style: "educational", processingMode: "fast", contentFormat: "short", burnSubtitles: false, embedSubtitles: false, warnings: [], error: null,
      clips: (["failed", "rendering"] as const).map((state, index) => ({ id: `shorts-${state}-clip`, index: index + 1, state, start: index * 10, end: index * 10 + 8, duration: 8, openingLine: `Fixture ${state} clip`, score: null, selected: false, outputName: null, blobId: null, downloadUrl: null, previewUrl: null, libraryAssetId: null, title: `${state} fixture`, width: 1080, height: 1920, folderId: "unsorted", publishedAt: null, fallbackUsed: false, provenance: [] })),
      beats: [], steps: [{ id: "ready", label: "Project ready", status: "complete", completedAt: now }], createdAt: now, updatedAt: now,
    };
    let retryObserved = false;
    let stopObserved = false;
    await page.route("**/api/v1/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.endsWith("/health")) return route.fulfill({ json: { status: "ready", version: "test", database: true, ffmpeg: true, ffprobe: true, whisper: true, ytdlp: true, localTts: true, dataPath: "/test", freeBytes: 0, activeWorkers: 0, queuedJobs: 0, fallbacks: {} } });
      if (path.endsWith("/library/assets")) return route.fulfill({ json: [] });
      if (path.endsWith("/jobs")) return route.fulfill({ json: [clipJob] });
      if (path.endsWith("/retry")) { retryObserved = true; return route.fulfill({ json: clipJob }); }
      if (path.endsWith("/control/stop-keep")) { stopObserved = true; return route.fulfill({ json: clipJob }); }
      return route.fulfill({ status: 404, json: { detail: `Unhandled fixture request: ${request.method()} ${path}` } });
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await navigate(page, "Shorts Editor");
    const dimensions = async (locator: ReturnType<typeof page.locator>, name: string) => {
      await expect(locator, `${name} exists`).toBeVisible();
      const box = await locator.boundingBox();
      expect(box, name).not.toBeNull();
      expect(Math.abs(box!.width - 144), `${name} width`).toBeLessThanOrEqual(1);
      expect(Math.abs(box!.height - 40), `${name} height`).toBeLessThanOrEqual(1);
      expect(await locator.evaluate((element) => getComputedStyle(element).boxSizing), `${name} border-box`).toBe("border-box");
    };
    const failedCard = page.getByRole("group", { name: "Clip failed fixture" });
    const failedSelection = failedCard.getByRole("button", { name: "Select clip" });
    const retry = failedCard.getByRole("button", { name: "Retry failed clip" });
    await dimensions(failedCard.locator(".status"), "Shorts failed status box");
    await dimensions(failedSelection, "Shorts clip selection action");
    await dimensions(retry, "Shorts retry action");
    const retryRequest = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/shorts-failed-clip/retry"));
    await retry.click();
    expect((await retryRequest).ok()).toBe(true);
    await expect.poll(() => retryObserved).toBe(true);
    await expect(failedSelection).toHaveAttribute("aria-pressed", "false");

    const renderingCard = page.getByRole("group", { name: "Clip rendering fixture" });
    const renderingSelection = renderingCard.getByRole("button", { name: "Select clip" });
    const stop = renderingCard.getByRole("button", { name: "Stop clip and keep completed outputs" });
    await dimensions(renderingCard.locator(".status"), "Shorts rendering status box");
    await dimensions(stop, "Shorts stop action");
    const stopRequest = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/control/stop-keep"));
    await stop.click();
    expect((await stopRequest).ok()).toBe(true);
    await expect.poll(() => stopObserved).toBe(true);
    await expect(renderingSelection).toHaveAttribute("aria-pressed", "false");
  });

  test("textarea retains long content and scrolls internally", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await navigate(page, "Projects");
    const script = page.getByRole("button", { name: "Script mode", exact: true });
    if (!(await script.count())) test.skip(true, "Script mode is not available on this Projects view");
    await script.click();
    const textarea = page.locator("textarea").first();
    await expect(textarea).toBeVisible();
    const longValue = Array.from({ length: 80 }, (_, index) => `Long script line ${index + 1}: ${"content ".repeat(12)}`).join("\n");
    await textarea.fill(longValue);
    await expect(textarea).toHaveValue(longValue);
    const metrics = await textarea.evaluate((element: HTMLTextAreaElement) => {
      element.scrollTop = element.scrollHeight;
      return { width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, scrollTop: element.scrollTop, overflowY: getComputedStyle(element).overflowY, boxSizing: getComputedStyle(element).boxSizing };
    });
    expect(Math.abs(metrics.width - 144)).toBeLessThanOrEqual(1);
    expect(Math.abs(metrics.height - 40)).toBeLessThanOrEqual(1);
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
    expect(metrics.scrollTop).toBeGreaterThan(0);
    expect(metrics.overflowY).toMatch(/auto|scroll/);
    expect(metrics.boxSizing).toBe("border-box");
  });

  test("destination navigation, Help, and native dialogs are operable", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    for (const destination of destinations) await navigate(page, destination);
    const help = page.getByRole("button", { name: "Open S6 Cut Help" });
    if (await help.count()) {
      await help.click();
      const dialog = page.getByRole("dialog", { name: "S6 Cut Help" });
      await expect(dialog).toBeVisible();
      const close = dialog.getByRole("button", { name: "Close S6 Cut Help" });
      await expect(close).toBeVisible();
      const box = await close.boundingBox();
      expect(box).not.toBeNull();
      expect(Math.abs(box!.width - 144)).toBeLessThanOrEqual(1);
      expect(Math.abs(box!.height - 40)).toBeLessThanOrEqual(1);
      expect(await close.evaluate((element) => getComputedStyle(element).boxSizing)).toBe("border-box");
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    }

    await navigate(page, "Projects");
    const folderButton = page.getByRole("button", { name: /New folder/i });
    if (await folderButton.count()) {
      page.once("dialog", async (dialog) => {
        expect(dialog.type()).toBe("prompt");
        expect(dialog.message()).toContain("Business folder name");
        await dialog.dismiss();
      });
      await folderButton.click();
    }
  });

  test("isolated production gateway creates and removes a business folder through same-origin API", async ({ page }) => {
    test.skip(process.env.S6_ACCEPTANCE_REAL_GATEWAY !== "true", "requires the explicitly designated disposable gateway");
    const name = `Control sizing review ${Date.now()}`;
    let folderId: string | undefined;
    try {
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await navigate(page, "Library");
      const add = page.getByRole("button", { name: "New business folder" });
      const addBox = await add.boundingBox();
      expect(addBox).not.toBeNull();
      expect(Math.abs(addBox!.width - 144)).toBeLessThanOrEqual(1);
      expect(Math.abs(addBox!.height - 40)).toBeLessThanOrEqual(1);
      page.once("dialog", (dialog) => dialog.accept(name));
      await add.click();
      const treeItem = page.getByRole("treeitem", { name: new RegExp(name) });
      await expect(treeItem).toBeVisible();
      const folders = await (await page.request.get("/api/v1/library/folders")).json() as { id: string; name: string; system?: boolean }[];
      folderId = folders.find((folder) => folder.name === name)?.id;
      expect(folderId, "new business folder persisted through same-origin API").toBeTruthy();
      const remove = page.getByRole("button", { name: `Remove ${name}` });
      const removeBox = await remove.boundingBox();
      expect(removeBox).not.toBeNull();
      expect(Math.abs(removeBox!.width - 144)).toBeLessThanOrEqual(1);
      expect(Math.abs(removeBox!.height - 40)).toBeLessThanOrEqual(1);
      page.once("dialog", (dialog) => dialog.accept());
      await remove.click();
      await expect(treeItem).toHaveCount(0);
      const remaining = await (await page.request.get("/api/v1/library/folders")).json() as { id: string }[];
      expect(remaining.some((folder) => folder.id === folderId)).toBe(false);
    } finally {
      if (folderId) {
        const folders = await page.request.get("/api/v1/library/folders").then((response) => response.json() as Promise<{ id: string; system?: boolean }[]>).catch(() => []);
        const destination = folders.find((folder) => folder.system) || folders[0];
        if (destination) await page.request.delete(`/api/v1/library/folders/${folderId}?destination_folder_id=${destination.id}&confirmed=true`).catch(() => undefined);
      }
    }
  });
});
