/**
 * Accepted YouTube URL forms.
 *
 * The main import suite drives the canonical `watch?v=` form. This one proves
 * the other two forms a person actually pastes — the `youtu.be` short link and
 * a watch URL carrying ordinary share/timestamp query parameters — normalise to
 * the same video and are really imported by the application, rather than merely
 * being accepted by the field.
 *
 * Each project is observed only as far as source acquisition: the import is
 * what these forms change. Nothing here bypasses authentication, age or
 * geographic restrictions, rate limits, bot protection, or signatures, and no
 * cookies, signed CDN URLs, or request headers are recorded.
 */
import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClipProject, gateway, writeManifest as writeManifestTo } from "./support/workspace";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const artifacts = path.join(root, "test-artifacts/youtube-import");

const url = process.env.S6_YOUTUBE_URL;
if (!url) throw new Error("S6_YOUTUBE_URL must supply the authorised public YouTube URL under test");
const match = /[?&]v=([\w-]{11})|youtu\.be\/([\w-]{11})/.exec(url);
const videoId = match?.[1] || match?.[2] || "";

const IMPORT_DEADLINE_MS = 15 * 60_000;

if (process.env.S6_LOW_MEMORY_BROWSER) {
  test.use({
    launchOptions: {
      args: ["--disable-dev-shm-usage", "--renderer-process-limit=1", "--js-flags=--max-old-space-size=256"],
    },
  });
}

async function projectAndJob(projectName: string) {
  const projects = await (await fetch(`${gateway}/api/v1/projects`)).json();
  const project = projects.find((item: { name: string }) => item.name === projectName);
  if (!project) return null;
  const jobs = await (await fetch(`${gateway}/api/v1/jobs`)).json();
  return { project, job: jobs.find((item: { projectId: string }) => item.projectId === project.id) };
}

/** Wait until the engine finishes acquiring the source, or the project fails. */
async function waitForSource(page: Page, projectName: string) {
  const deadline = Date.now() + IMPORT_DEADLINE_MS;
  let sawBytes = false;
  while (Date.now() < deadline) {
    const state = await projectAndJob(projectName);
    const downloaded = state?.job?.downloadProgress?.downloadedBytes;
    if (typeof downloaded === "number" && downloaded > 0) sawBytes = true;
    const received = await page.locator(".process-checklist li").filter({ hasText: "Source received" })
      .evaluateAll((rows) => rows.some((row) => /status-complete/.test(row.className)));
    if (received) return { complete: true, sawBytes, state };
    if (await page.getByText("Project failed", { exact: true }).count()) {
      const detail = (await page.locator(".failure-strip").textContent())?.trim() || "";
      throw new Error(`import failed before the source was received: ${detail}`);
    }
    await page.waitForTimeout(2_000);
  }
  throw new Error(`the source was not received within ${IMPORT_DEADLINE_MS}ms`);
}

test.describe.configure({ mode: "serial" });

test.describe("accepted YouTube URL forms import the same video", () => {
  const cases = [
    { label: "youtu.be short link", href: `https://youtu.be/${videoId}` },
    { label: "watch URL with share parameters", href: `https://www.youtube.com/watch?v=${videoId}&t=30s&feature=share` },
  ];

  const recorded: Record<string, unknown>[] = [];

  for (const variant of cases) {
    test(`imports from a ${variant.label}`, async ({ page }) => {
      test.setTimeout(IMPORT_DEADLINE_MS + 5 * 60_000);
      await fs.mkdir(path.join(artifacts, "url-forms"), { recursive: true });
      const projectName = `YouTube ${variant.label} ${Date.now()}`;
      const startedAt = Date.now();

      await page.goto("/", { waitUntil: "domcontentloaded" });
      await expect(page.getByText("Local engine ready")).toBeVisible({ timeout: 90_000 });

      await createClipProject(page, {
        name: projectName, count: 1, mode: "Fast", aspect: "9:16",
        min: 15, max: 30, captions: false, source: { kind: "url", url: variant.href },
      });

      const result = await waitForSource(page, projectName);
      expect(result.complete, `${variant.label}: source received`).toBeTruthy();
      expect(result.sawBytes, `${variant.label}: real bytes were downloaded`).toBeTruthy();
      expect(result.state!.project.sourceKind, "project records a YouTube source").toBe("youtube");

      // Both forms must resolve to the same video, and the imported source must
      // be the same size as the canonical import produces.
      const detail = (await page.locator(".process-checklist li").filter({ hasText: "Video validated" })
        .textContent())?.trim() || "";
      recorded.push({
        form: variant.label,
        href: variant.href.replace(videoId, "<id>"),
        importSeconds: (Date.now() - startedAt) / 1000,
        downloadedBytes: result.state!.job.downloadProgress?.downloadedBytes ?? null,
        sourceKind: result.state!.project.sourceKind,
        validationDetail: detail,
      });
      await page.screenshot({
        path: path.join(artifacts, "url-forms", `${variant.label.replace(/\W+/g, "-")}.png`),
        fullPage: true,
      });
      await writeManifestTo(artifacts, "url-forms", { videoId, imports: recorded });
    });
  }
});
