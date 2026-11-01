/**
 * Real-import acceptance for the editing presentation feature
 * (docs/plans/youtube-editing-style-library.md).
 *
 * Only runs under scripts/qa/editing-style-library-acceptance.mjs, which supplies
 * an isolated Compose stack, the validated source manifest and a 60 minute live
 * budget. Everything is driven through the visible app UI:
 *   - YouTube URLs are typed into the normal source picker; the app downloads and
 *     transcribes them locally (Whisper). No transcript is injected, nothing about
 *     the import or recognizer is mocked or stubbed, and this spec downloads no
 *     media itself.
 *   - Outputs are read back through the app's own preview / download / ZIP paths.
 *     Media inspection (ffprobe / ffmpeg) uses the disposable stack's engine image.
 *   - The only direct API use is: reading job records, and (documented in the
 *     report as method "api") caption edit + rerender where the app exposes no
 *     visible control.
 *
 * Selector contract (kept in `ui` below) follows the labels in the plan and the
 * current Projects UI: groups "Subtitle style", "Video filter", "Music video
 * filter", "Heading appearance", "Emoji reactions", "Lyrics subtitle theme",
 * "Lyric animation"; a "Style sample:" image; "Play sample"/"Replay sample"; and a
 * read-only "Editing style" Workspace summary. Each picker sits inside a
 * collapsible create option row ("Subtitle style", "Video filter", "Heading
 * appearance", "Emoji reactions", "Lyrics presentation"); the spec opens the row
 * that contains a group before touching its buttons (see ROW_FOR_GROUP). If the UI diverges, the affected
 * check FAILS with a clear message; it is never silently skipped.
 *
 * The report (live-report.json) separates pass / fail / unmet checks. Any unmet
 * required check yields INCOMPLETE, never PASS. Expected-error probes are the only
 * place browser errors are tolerated, and they are reported separately.
 */
import { expect, test, type Locator, type Page, type Request } from "@playwright/test";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { assertPlayback, checkPlayback, gateway, openProjects, zipEntry, zipNames, assertZipIntact } from "./support/workspace";

const exec = promisify(execFile);
const enabled = process.env.S6_EDITING_RUNNER === "1" && process.env.S6_ACCEPTANCE_ISOLATED === "1" && Boolean(process.env.S6_EDITING_ARTIFACTS);
const artifactRoot = process.env.S6_EDITING_ARTIFACTS || "";
const deadline = Number(process.env.S6_EDITING_DEADLINE_MS || 0);
const engineImage = process.env.S6_EDITING_ENGINE_IMAGE_ID || "";
const engineContainer = process.env.S6_EDITING_ENGINE_CONTAINER || "";
const composeProject = process.env.S6_EDITING_COMPOSE_PROJECT || "";
const evidence = path.join(artifactRoot || "test-artifacts/editing-style-library/unrunnable", "evidence");
const reportPath = path.join(artifactRoot || "test-artifacts/editing-style-library/unrunnable", "live-report.json");

type Candidate = {
  url: string; channel: string; durationSeconds: number; title?: string;
  interval: { startSeconds: number; endSeconds: number };
  attribution: string; reuseTerms: string; preEffectFrames?: string[];
  verification: Record<string, unknown>;
};
type Manifest = { speech: Candidate[]; music: Candidate[]; maxSubstitutionsPerMode: number };
const manifest: Manifest | null = enabled ? JSON.parse(readFileSync(process.env.S6_EDITING_MANIFEST_VALIDATED!, "utf8")) : null;

// Selection defaults (override with S6_EDITING_{SPEECH,MUSIC}_{STYLE,FILTER,HEADING,EMOJI,THEME,ANIMATION}).
const pick = {
  speechStyle: process.env.S6_EDITING_SPEECH_STYLE || "Active word box",
  speechFilter: process.env.S6_EDITING_SPEECH_FILTER || "Warm",
  speechHeading: process.env.S6_EDITING_SPEECH_HEADING || "Dark box",
  speechEmoji: process.env.S6_EDITING_SPEECH_EMOJI || "Sparse",
  musicTheme: process.env.S6_EDITING_MUSIC_THEME || "Karaoke focus",
  musicAnimation: process.env.S6_EDITING_MUSIC_ANIMATION || "Word build",
  musicFilter: process.env.S6_EDITING_MUSIC_FILTER || "Warm",
};
const SUBTITLE_STYLES = ["Editorial default", "Clean sentence", "Bold outline", "Yellow focus", "Word pop", "Active word box", "Dark caption plate", "Light caption plate", "Word build", "Cinematic serif", "Condensed stack", "Karaoke line"];
const VIDEO_FILTERS = ["Existing look", "Original colour", "Warm", "Cool", "Vibrant", "Black & white", "Vintage"];
const HEADING_STYLES = ["Plain", "Dark box", "White banner"];
const EMOJI_MODES = ["Existing behaviour", "Off", "Sparse"];
const ORIGINAL_MUSIC_THEMES = ["Clean sans", "Warm highlight", "Soft serif", "Reference white sans", "Reference yellow sans", "Reference white serif", "Condensed black", "Condensed white", "Handwritten stack"];
const NEW_MUSIC_THEMES = ["Karaoke focus", "Soft glow", "Lyric plate"];
const MUSIC_ANIMATIONS = ["Original", "Slow fade", "Line crossfade", "Word build"];
const EDITORIAL = ["Funny", "Serious", "Educational", "Hype"];
// Wire ids for the filter labels (ids may be adjusted by the implementation; update here if they are).
const FILTER_IDS: Record<string, string> = { "Existing look": "existing", "Original colour": "original", Warm: "warm", Cool: "cool", Vibrant: "vibrant", "Black & white": "black_white", Vintage: "vintage" };

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
type Check = { id: string; status: "pass" | "fail" | "unmet" | "info"; detail?: unknown; at: string };
const checks: Check[] = [];
const unmet: string[] = [];
const substitutions: unknown[] = [];
const sources: Record<string, unknown> = {};
const browserErrors: { phase: string; message: string; expected: boolean }[] = [];
const completed = new Set<string>();
const failedJourneys: string[] = [];
let blockedExternal: string | null = null;

function flush(final = false) {
  let status = "RUNNING";
  if (final) {
    if (blockedExternal) status = "BLOCKED_EXTERNAL";
    else if (failedJourneys.length || checks.some((item) => item.status === "fail") || browserErrors.some((item) => !item.expected)) status = "FAIL";
    else if (unmet.length || !["ui", "speech", "music"].every((id) => completed.has(id))) status = "INCOMPLETE";
    else status = "PASS";
  }
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify({
    status, finishedAt: final ? new Date().toISOString() : null, completedJourneys: [...completed], failedJourneys,
    blockedExternal, unmet, substitutions, sources, checks, browserErrors,
    liveJourneysRun: ["speech", "music"].filter((id) => completed.has(id)),
    claim: "Live YouTube journeys cover only the selections recorded in `sources`; deterministic catalog/render tests are separate and are not claimed here.",
  }, null, 2));
}
function record(id: string, status: Check["status"], detail?: unknown) {
  checks.push({ id, status, detail, at: new Date().toISOString() });
  if (status === "unmet") unmet.push(`${id}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  flush();
}
const remainingMs = () => deadline - Date.now();

async function journey(id: string, testInfo: { setTimeout(ms: number): void }, body: () => Promise<void>) {
  testInfo.setTimeout(Math.max(30_000, remainingMs() + 60_000));
  try {
    await body();
    completed.add(id);
    record(`journey:${id}`, "pass");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("EXTERNAL_BLOCKER")) blockedExternal = message;
    else failedJourneys.push(id);
    record(`journey:${id}`, "fail", message.slice(0, 1500));
    throw error;
  } finally {
    flush();
  }
}

// ---------------------------------------------------------------------------
// Browser watching, request capture
// ---------------------------------------------------------------------------
let phase = "setup";
let expectErrors = false;
function watchBrowser(page: Page) {
  const add = (message: string) => { browserErrors.push({ phase, message: message.slice(0, 500), expected: expectErrors }); flush(); };
  page.on("pageerror", (error) => add(`pageerror: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") add(`console: ${message.text()}`); });
  page.on("requestfailed", (request) => { const error = request.failure()?.errorText; if (error !== "net::ERR_ABORTED") add(`request failed: ${request.method()} ${request.url()} ${error}`); });
  page.on("response", (response) => { if (response.status() >= 400) add(`HTTP ${response.status()} ${response.request().method()} ${response.url()}`); });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== new URL(gateway).origin) add(`external origin contacted by the browser: ${request.url()}`);
  });
}

function multipartFields(request: Request): Record<string, string> {
  const buffer = request.postDataBuffer();
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(request.headers()["content-type"] || "");
  if (!buffer || !boundary) return {};
  const marker = `--${boundary[1] || boundary[2]}`;
  const fields: Record<string, string> = {};
  for (const part of buffer.toString("latin1").split(marker)) {
    const split = part.indexOf("\r\n\r\n");
    if (split < 0) continue;
    const head = part.slice(0, split);
    const name = /name="([^"]+)"/.exec(head)?.[1];
    if (!name || /filename=/.test(head)) continue;
    fields[name] = Buffer.from(part.slice(split + 4).replace(/\r\n$/, ""), "latin1").toString("utf8");
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Media inspection in the disposable engine image (no host ffmpeg required)
// ---------------------------------------------------------------------------
const containerPath = (file: string) => {
  const relative = path.relative(artifactRoot, path.resolve(file));
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`media path outside the run directory: ${file}`);
  return path.posix.join("/qa", relative.split(path.sep).join("/"));
};
const media = (tool: string, args: string[], binary = false) => {
  const command = ["run", "--rm", "--network", "none", "--volume", `${artifactRoot}:/qa:ro`, "--entrypoint", tool, engineImage, ...args];
  return binary ? exec("docker", command, { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 }) : exec("docker", command, { maxBuffer: 64 * 1024 * 1024 });
};
async function ffprobe(file: string) {
  return JSON.parse(String((await media("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", containerPath(file)])).stdout)) as {
    streams: { codec_type: string; width?: number; height?: number; duration?: string }[]; format: { duration: string };
  };
}
async function decodeFully(file: string) { await media("ffmpeg", ["-v", "error", "-xerror", "-i", containerPath(file), "-f", "null", "-"]); }
async function meanVolumeDb(file: string): Promise<number | null> {
  const result = await media("ffmpeg", ["-hide_banner", "-i", containerPath(file), "-map", "0:a:0", "-af", "volumedetect", "-f", "null", "-"]).catch((error) => error as { stderr?: string });
  const match = /mean_volume:\s*(-?[\d.]+) dB/.exec(String((result as { stderr?: string }).stderr || ""));
  return match ? Number(match[1]) : null;
}
type RegionStats = { r: number; g: number; b: number; luma: number; chroma: number; pixels: number };
/** Mean colour of one or more pixel regions (`w:h:x:y`) at a time, pooled. */
async function regionStats(file: string, time: number, regions: string[]): Promise<RegionStats> {
  let r = 0, g = 0, b = 0, chroma = 0, pixels = 0;
  for (const region of regions) {
    const raw = Buffer.from((await media("ffmpeg", ["-v", "error", "-ss", time.toFixed(3), "-i", containerPath(file), "-vf", `crop=${region},format=rgb24`, "-frames:v", "1", "-f", "rawvideo", "pipe:1"], true)).stdout);
    for (let index = 0; index + 2 < raw.length; index += 3) {
      r += raw[index]; g += raw[index + 1]; b += raw[index + 2];
      chroma += Math.max(raw[index], raw[index + 1], raw[index + 2]) - Math.min(raw[index], raw[index + 1], raw[index + 2]);
      pixels += 1;
    }
  }
  if (!pixels) throw new Error(`no pixels decoded from ${path.basename(file)} at ${time}s`);
  return { r: r / pixels, g: g / pixels, b: b / pixels, luma: (0.299 * r + 0.587 * g + 0.114 * b) / pixels, chroma: chroma / pixels, pixels };
}
/** Count pixels whose luma differs from the control by more than `threshold` in a region. */
async function changedPixels(file: string, control: string, time: number, controlTime: number, region: string, threshold = 60): Promise<number> {
  const filter = `[0:v]crop=${region},format=gray[a];[1:v]crop=${region},format=gray[b];[a][b]blend=all_mode=difference[d]`;
  const raw = Buffer.from((await media("ffmpeg", ["-v", "error", "-ss", time.toFixed(3), "-i", containerPath(file), "-ss", controlTime.toFixed(3), "-i", containerPath(control), "-filter_complex", filter, "-map", "[d]", "-frames:v", "1", "-f", "rawvideo", "pipe:1"], true)).stdout);
  let count = 0;
  for (const value of raw) if (value > threshold) count += 1;
  return count;
}
async function writeFrame(file: string, time: number, name: string) {
  const png = Buffer.from((await media("ffmpeg", ["-v", "error", "-ss", time.toFixed(3), "-i", containerPath(file), "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "pipe:1"], true)).stdout);
  const target = path.join(evidence, "frames", name);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, png);
  return target;
}
const sha256 = async (file: string) => createHash("sha256").update(await fs.readFile(file)).digest("hex");

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------
const escapeRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ui = {
  group: (page: Page, name: string) => page.getByRole("group", { name, exact: true }),
  choice: (group: Locator, label: string) => group.getByRole("button", { name: new RegExp(`^${escapeRe(label)}$`, "i") }),
  sample: (page: Page) => page.getByRole("img", { name: /^Style sample:/ }),
  summary: (page: Page) => page.locator('[aria-label="Editing style"]'),
};
// The Projects create panel keeps the heavy pickers in collapsible option rows
// that show their current value; a row's controls are hidden until it is opened.
// Map each control group to its containing row so interactions open it first.
const ROW_FOR_GROUP: Record<string, string> = {
  "Subtitle style": "Subtitle style",
  "Video filter": "Video filter",
  "Music video filter": "Video filter",
  "Heading appearance": "Heading appearance",
  "Emoji reactions": "Emoji reactions",
  "Lyrics subtitle theme": "Lyrics presentation",
  "Lyric animation": "Lyrics presentation",
};
async function openGroupRow(page: Page, groupName: string) {
  const title = ROW_FOR_GROUP[groupName];
  if (!title) return;
  const toggle = page.getByRole("button", { name: title, exact: true });
  await expect(toggle, `create option row "${title}" is present (UI contract; see spec header)`).toBeVisible({ timeout: 20_000 });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(toggle, `create option row "${title}" is open`).toHaveAttribute("aria-expanded", "true");
}
async function selectChoice(page: Page, groupName: string, label: string) {
  await openGroupRow(page, groupName);
  const group = ui.group(page, groupName);
  await expect(group, `control group "${groupName}" is present (UI contract; see spec header)`).toBeVisible({ timeout: 20_000 });
  const button = ui.choice(group, label);
  await expect(button, `"${label}" in "${groupName}"`).toBeVisible();
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  for (const other of await group.getByRole("button").all()) if (other !== button && (await other.getAttribute("aria-label")) !== label) await expect(other).toHaveAttribute("aria-pressed", "false");
}
async function expectNoHorizontalOverflow(page: Page, label: string) {
  const sizes = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: window.innerWidth }));
  expect(sizes.width, `${label}: no horizontal overflow`).toBeLessThanOrEqual(sizes.viewport + 1);
}
async function startPage(browser: import("@playwright/test").Browser, size = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ acceptDownloads: true, baseURL: gateway, viewport: size });
  const page = await context.newPage();
  watchBrowser(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Local engine ready")).toBeVisible({ timeout: 180_000 });
  return { context, page };
}

// ---------------------------------------------------------------------------
// Job helpers
// ---------------------------------------------------------------------------
type JobClip = {
  id: string; index: number; state: string; start: number; end: number; duration: number; transcriptExcerpt?: string | null;
  captionRevision?: number; creatorCredit?: string | null; musicTreatment?: string | null; downloadUrl?: string | null; previewUrl?: string | null;
  captionCues?: { id: string; start: number; end: number; text: string; confidence?: number | null }[];
  captionDownloads?: { format: string; url: string }[]; hookText?: string | null;
};
type JobRecord = {
  id: string; projectId: string; state: string; stage?: string; error?: string | null; canRetryImport?: boolean; sourceProfile: string; processingMode: string;
  executionPolicy?: string; burnSubtitles: boolean; hookTextEnabled?: boolean; editingPresentation?: Record<string, unknown> | null;
  musicPresentation?: Record<string, unknown> | null; clips: JobClip[]; steps?: { id: string; status: string }[];
};
async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(new URL(url, gateway));
  if (!response.ok) throw new Error(`GET ${url} -> HTTP ${response.status}`);
  return response.json() as Promise<T>;
}
const createdJobIds = new Map<string, string>();
async function jobForProject(name: string): Promise<{ project: Record<string, unknown> & { id: string }; job: JobRecord } | null> {
  const projects = await getJson<(Record<string, unknown> & { id: string; name: string })[]>("/api/v1/projects");
  let project = projects.find((item) => item.name === name);
  let jobId: string | undefined;
  if (project) {
    const jobs = await getJson<{ id: string; projectId: string }[]>("/api/v1/jobs");
    jobId = jobs.find((item) => item.projectId === project!.id)?.id;
  } else {
    // A source can fail before its Project row is materialized. Keep polling
    // the job id captured from the normal creation response so import failures
    // are reported and eligible source substitutions can run.
    jobId = createdJobIds.get(name);
  }
  if (!jobId) return null;
  const job = await getJson<JobRecord>(`/api/v1/jobs/${encodeURIComponent(jobId)}`);
  project ??= { id: job.projectId, name };
  return { project, job };
}
const refreshJob = (id: string) => getJson<JobRecord>(`/api/v1/jobs/${encodeURIComponent(id)}`);
const TERMINAL = new Set(["complete", "failed", "partial", "cancelled_kept"]);
/** Poll to a terminal state; records the visible checklist stages as they pass. */
async function waitTerminal(page: Page, name: string, stages: Set<string>, budgetMs: number) {
  const until = Math.min(Date.now() + budgetMs, deadline);
  let last = Date.now();
  while (Date.now() < until) {
    const found = await jobForProject(name);
    if (found) {
      for (const row of await page.locator(".process-checklist li").evaluateAll((rows) => rows.map((row) => ({ label: row.querySelector(".checklist-label")?.textContent?.trim() || "", status: /status-(active|complete|failed|skipped|pending)/.exec(row.className)?.[1] || "unknown" })))) if (row.label && row.status !== "pending") stages.add(`${row.label}:${row.status}`);
      if (TERMINAL.has(found.job.state) || (found.job.state === "stalled" && found.job.canRetryImport)) {
        // The API can publish completion a poll before the Workspace updates its
        // checklist. Wait for the final visible state so stage evidence is complete.
        if (found.job.state === "complete") await expect.poll(async () => {
          const rows = await page.locator(".process-checklist li").evaluateAll((items) => items.map((row) => ({
            label: row.querySelector(".checklist-label")?.textContent?.trim() || "",
            status: /status-(active|complete|failed|skipped|pending)/.exec(row.className)?.[1] || "unknown",
          })));
          for (const row of rows) if (row.label && row.status !== "pending") stages.add(`${row.label}:${row.status}`);
          return rows.some((row) => row.label === "Project ready" && row.status === "complete");
        }, { timeout: 30_000, intervals: [500, 1_000, 2_000] }).toBe(true);
        return found;
      }
      if (Date.now() - last > 60_000) { last = Date.now(); console.log(`  … ${name}: state=${found.job.state} stage=${found.job.stage} (${Math.round(remainingMs() / 60_000)} min of budget left)`); }
    }
    await page.waitForTimeout(3_000);
  }
  throw new Error(`"${name}" did not reach a terminal state within the live budget`);
}
const EXTERNAL_IMPORT_FAILURE = /download|youtube|yt-dlp|unavailable|private|sign in|confirm you|age|geo|blocked|HTTP Error|timed out|network|connection|not available|copyright|removed|forbidden/i;
function isExternalImportFailure(job: JobRecord) {
  return (job.state === "failed" || job.state === "stalled") && !job.clips.some((clip) => clip.state === "complete")
    && Boolean(job.canRetryImport || EXTERNAL_IMPORT_FAILURE.test(`${job.error || ""} ${job.stage || ""}`));
}
function parseSrtCues(text: string) {
  const seconds = (stamp: string) => {
    const match = /^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/.exec(stamp.trim());
    if (!match) throw new Error(`Invalid SRT timestamp: ${stamp}`);
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
  };
  return text.trim().split(/\r?\n\s*\r?\n/).flatMap((block, index) => {
    const lines = block.split(/\r?\n/);
    const timing = lines.findIndex((line) => /^\d{2}:\d{2}:\d{2}[,.]\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}[,.]\d{3}$/.test(line.trim()));
    if (timing < 0) return [];
    const [start, end] = lines[timing].split(/\s+-->\s+/).map(seconds);
    const cueText = lines.slice(timing + 1).join(" ").replace(/<[^>]+>/g, "").trim();
    return cueText ? [{ id: `acceptance-${index + 1}`, start, end, text: cueText, confidence: null }] : [];
  });
}

type CreateOptions = {
  name: string; url: string; music: boolean; count: number; min: number; max: number; processing: "Smart" | "Fast";
  editorial?: string; captions?: boolean; select?: (page: Page) => Promise<void>;
};
/** Visible-control project creation; returns the captured multipart request fields. */
async function createProject(page: Page, options: CreateOptions) {
  const checkpoint = (id: string) => { if (options.music) record(`music:form-${id}`, "info"); };
  checkpoint("open-start");
  await openProjects(page);
  checkpoint("projects-open");
  await page.getByRole("tab", { name: "YouTube" }).click();
  checkpoint("youtube-tab");
  const field = page.locator("#source-youtube-url");
  await field.fill(options.url);
  await expect(field).toHaveValue(options.url);
  checkpoint("url-filled");
  await page.getByLabel("Project name").fill(options.name);
  checkpoint("name-filled");
  if (options.music) await page.getByRole("button", { name: "Music / sung vocals", exact: true }).click();
  checkpoint("profile-selected");
  const countValue = page.locator(".count-control strong");
  for (let guard = 0; guard < 40 && Number(await countValue.textContent()) > options.count; guard += 1) await page.getByRole("button", { name: "Fewer clips", exact: true }).click();
  for (let guard = 0; guard < 40 && Number(await countValue.textContent()) < options.count; guard += 1) await page.getByRole("button", { name: "More clips", exact: true }).click();
  await expect(countValue).toHaveText(String(options.count));
  checkpoint("count-selected");
  if (!options.music) await page.getByRole("button", { name: options.processing, exact: true }).click();
  checkpoint("processing-mode-selected");
  await page.getByRole("button", { name: "Engine only", exact: true }).click(); // no provider is configured in the isolated stack
  checkpoint("execution-policy-selected");
  if (options.editorial && !options.music) {
    const card = page.locator(".style-card").filter({ hasText: options.editorial }).first();
    await card.click();
    await expect(card).toHaveAttribute("aria-pressed", "true");
  }
  if (!options.music && options.captions !== undefined) {
    const subtitles = page.locator(".subtitle-toggle").filter({ hasText: "Burn in subtitles" }).locator('input[type="checkbox"]');
    if (await subtitles.isEnabled() && (await subtitles.isChecked()) !== options.captions) await subtitles.setChecked(options.captions);
    expect(await subtitles.isChecked()).toBe(options.captions);
  }
  checkpoint("before-style-selection");
  await options.select?.(page);
  checkpoint("after-style-selection");
  await page.getByRole("button", { name: "Advanced controls", exact: true }).click();
  checkpoint("advanced-open");
  const aspect = page.getByLabel("Aspect");
  if (await aspect.isEnabled()) await aspect.selectOption("9:16");
  await page.getByLabel("Minimum seconds").fill(String(options.min));
  await page.getByLabel("Maximum seconds").fill(String(options.max));
  const isCreateRequest = (request: Request) => request.method() === "POST" && /\/api\/v1\/jobs\/clip$/.test(new URL(request.url()).pathname);
  const posted = page.waitForRequest(isCreateRequest);
  const created = page.waitForResponse((response) => isCreateRequest(response.request()));
  checkpoint("submit-clicking");
  await page.getByRole("button", { name: new RegExp(`^Create ${options.count} short clips?$`) }).click();
  checkpoint("submit-clicked");
  const [request, response] = await Promise.all([posted, created]);
  const body = await response.json() as { job?: JobRecord };
  if (body.job?.id) createdJobIds.set(options.name, body.job.id);
  const fields = multipartFields(request);
  checkpoint("request-captured");
  await expect(page.getByRole("heading", { name: options.name })).toBeVisible({ timeout: 60_000 });
  return fields;
}
/** Case/underscore-insensitive keys, nulls dropped, so a request and its saved record compare equal. */
const normalizeKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(normalizeKeys)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined).map(([key, item]) => [key.replace(/_/g, "").toLowerCase(), normalizeKeys(item)]).sort(([a], [b]) => String(a).localeCompare(String(b))))
    : value;

async function downloadClip(page: Page, clip: JobClip, target: string, tileIndex = 0) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tile = page.locator(".clip-tile.complete").nth(tileIndex);
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 120_000 }), tile.locator("a[download]").click()]);
  await download.saveAs(target);
  expect((await fs.stat(target)).size, `${clip.id} download size`).toBeGreaterThan(20_000);
  return target;
}
async function openWorkspace(page: Page, project: Record<string, unknown> & { id: string; name?: unknown }, jobId: string) {
  await page.getByRole("button", { name: "Jobs", exact: true }).click();
  const card = page.locator(`.job-card[data-job-id="${jobId}"]`);
  const showAll = page.getByRole("button", { name: /^Show all \d+ jobs$/ });
  await expect.poll(async () => (await card.count()) > 0 || (await showAll.count()) > 0, { timeout: 30_000 }).toBe(true);
  if (await card.count() === 0) await showAll.click();
  await card.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByRole("heading", { name: String(project.name), exact: true })).toBeVisible({ timeout: 30_000 });
}

/** The saved read-only summaries live in the Workspace inspector's Captions tab. */
async function openCaptionsInspector(page: Page) {
  const tab = page.getByRole("button", { name: /^Captions$/i });
  await expect(tab.first(), "Workspace inspector Captions tab").toBeVisible({ timeout: 30_000 });
  await tab.first().click();
}

/** Run one mode's candidates in order; substitute only after an external import failure. */
async function importWithSubstitution(mode: "speech" | "music", attempt: (candidate: Candidate, index: number) => Promise<void>) {
  const list = manifest![mode];
  const allowed = Math.min(manifest!.maxSubstitutionsPerMode, 2);
  for (let index = 0; index < list.length && index <= allowed; index += 1) {
    if (remainingMs() < 12 * 60_000) { record(`${mode}:budget`, "unmet", `only ${Math.round(remainingMs() / 60_000)} min of the 60 min live budget remain; not starting another import`); throw new Error(`EXTERNAL_BLOCKER: live budget exhausted before a ${mode} import could complete`); }
    try {
      await attempt(list[index], index);
      return list[index];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.startsWith("IMPORT_FAILED:")) throw error;
      substitutions.push({ mode, index, url: list[index].url, reason: message.slice(0, 600), at: new Date().toISOString(), substituted: index < Math.min(list.length - 1, allowed) });
      flush();
      if (index >= Math.min(list.length - 1, allowed)) throw new Error(`EXTERNAL_BLOCKER: ${mode} import failed for ${index + 1} candidate(s) (${allowed} substitutions allowed): ${message}`);
    }
  }
  throw new Error(`EXTERNAL_BLOCKER: no ${mode} candidate available`);
}

function assertWithinVerifiedInterval(clip: JobClip, candidate: Candidate, label: string) {
  const { startSeconds, endSeconds } = candidate.interval;
  expect(clip.start, `${label}: clip starts inside the manually verified interval ${startSeconds}-${endSeconds}s`).toBeGreaterThanOrEqual(startSeconds - 0.25);
  expect(clip.end, `${label}: clip ends inside the manually verified interval ${startSeconds}-${endSeconds}s`).toBeLessThanOrEqual(endSeconds + 0.25);
}
const filterExpectation = (label: string, treated: RegionStats, control: RegionStats | null): { ok: boolean; detail: string } | null => {
  const dRB = control ? (treated.r - treated.b) - (control.r - control.b) : 0;
  const dChroma = control ? treated.chroma - control.chroma : 0;
  switch (label) {
    case "Warm": return { ok: control !== null && dRB >= 4, detail: `R-B shift ${dRB.toFixed(1)} (need >= 4)` };
    case "Cool": return { ok: control !== null && dRB <= -4, detail: `R-B shift ${dRB.toFixed(1)} (need <= -4)` };
    case "Black & white": return { ok: treated.chroma < 8, detail: `mean chroma ${treated.chroma.toFixed(1)} (need < 8)` };
    case "Vibrant": return { ok: control !== null && dChroma >= 3, detail: `chroma shift ${dChroma.toFixed(1)} (need >= 3)` };
    case "Vintage": case "Original colour": return control ? { ok: Math.abs(dRB) + Math.abs(dChroma) + Math.abs(treated.luma - control.luma) >= 2 || label === "Original colour", detail: `dRB ${dRB.toFixed(1)} dChroma ${dChroma.toFixed(1)}` } : null;
    default: return null;
  }
};
// Footage-only sampling: narrow side strips avoid centred captions and the upper heading.
const FOOTAGE_REGIONS = ["90:600:0:700", "90:600:990:700"];

test.describe.configure({ mode: "serial" });
test.beforeAll(() => { if (enabled) { mkdirSync(evidence, { recursive: true }); flush(); } });
test.afterAll(() => { if (enabled) flush(true); });

// ===========================================================================
// 1. Projects UI: catalog, selection, mode isolation (no import, no network)
// ===========================================================================
test("Projects UI: editorial intent stays separate; all subtitle/filter/music choices select and isolate by mode", async ({ browser }, testInfo) => {
  test.skip(!enabled, "runs only under scripts/qa/editing-style-library-acceptance.mjs (isolated stack, validated manifest)");
  await journey("ui", testInfo, async () => {
    phase = "ui";
    const { context, page } = await startPage(browser);
    await openProjects(page);
    // The default project form has burned-in subtitles off. Turn them on so
    // these style controls are eligible for this visual selection journey.
    const subtitleToggle = page.locator(".subtitle-toggle").filter({ hasText: "Burn in subtitles" }).locator('input[type="checkbox"]');
    if (!(await subtitleToggle.isChecked())) await subtitleToggle.check();
    await expect(subtitleToggle).toBeChecked();
    // Editorial intents.
    for (const label of EDITORIAL) {
      const card = page.locator(".style-card").filter({ hasText: label }).first();
      await card.click();
      await expect(card, `editorial ${label}`).toHaveAttribute("aria-pressed", "true");
    }
    const educational = page.locator(".style-card").filter({ hasText: "Educational" }).first();
    await educational.click();
    // Regular subtitle grid: every card selects and shows a sample; editorial intent is unchanged.
    for (const label of SUBTITLE_STYLES) {
      await selectChoice(page, "Subtitle style", label);
      await expect(ui.sample(page), `${label}: selected-style sample`).toHaveAttribute("aria-label", new RegExp(`^Style sample: ${escapeRe(label)}\\.`));
      await expect(educational, "editorial intent unchanged by a visual preset").toHaveAttribute("aria-pressed", "true");
    }
    // The grid sits directly in Step 2 after the editorial cards.
    const order = await page.evaluate(() => {
      const cards = document.querySelector(".style-card"); const group = document.querySelector('[role="group"][aria-label="Subtitle style"]');
      return cards && group ? Boolean(cards.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING) : false;
    });
    expect(order, "Subtitle style group follows the Editorial style cards").toBe(true);
    // Filter changes the sample's picture, not its caption text.
    await selectChoice(page, "Subtitle style", "Active word box");
    const sampleLabel = await page.locator(".speech-frame-caption").first().getAttribute("aria-label");
    for (const label of VIDEO_FILTERS) {
      await selectChoice(page, "Video filter", label);
      expect(await page.locator(".speech-frame-caption").first().getAttribute("aria-label"), `${label}: filter preserves the selected caption treatment`).toBe(sampleLabel);
      await expect(ui.choice(ui.group(page, "Subtitle style"), "Active word box"), `${label}: filter preserves selected subtitle style`).toHaveAttribute("aria-pressed", "true");
    }
    // Keyboard operation and explicit Play/Replay.
    await ui.choice(ui.group(page, "Subtitle style"), "Word pop").focus();
    await page.keyboard.press("Space");
    await expect(ui.choice(ui.group(page, "Subtitle style"), "Word pop")).toHaveAttribute("aria-pressed", "true");
    await ui.choice(ui.group(page, "Subtitle style"), "Yellow focus").focus();
    await page.keyboard.press("Enter");
    await expect(ui.choice(ui.group(page, "Subtitle style"), "Yellow focus")).toHaveAttribute("aria-pressed", "true");
    const play = page.getByRole("button", { name: /^(Play|Replay) sample$/ });
    await expect(play).toBeVisible();
    await play.click();
    await expect(page.getByRole("button", { name: "Replay sample" })).toBeVisible({ timeout: 15_000 });
    // Reduced motion: the sample starts still until Play is explicitly requested.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await openProjects(page);
    await selectChoice(page, "Subtitle style", "Word build");
    const running = await page.locator(".speech-style-selected").evaluate((node) => (node as HTMLElement).getAnimations({ subtree: true }).filter((item) => item.playState === "running").length);
    record("ui:reduced-motion-running-animations-before-play", running === 0 ? "pass" : "fail", { running });
    expect(running, "no sample animation runs before an explicit Play under reduced motion").toBe(0);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    // Heading / emoji controls: appearance never ticks Hook text or writes text.
    const hook = page.getByRole("checkbox", { name: "Hook text" });
    await expect(hook).not.toBeChecked();
    await hook.check();
    for (const label of HEADING_STYLES) await selectChoice(page, "Heading appearance", label);
    await selectChoice(page, "Heading appearance", "Dark box");
    await expect(page.getByRole("textbox", { name: "Hook text to display" })).toHaveValue("");
    await hook.uncheck();
    for (const label of EMOJI_MODES) await selectChoice(page, "Emoji reactions", label);
    // Fast: captions/emoji preview gated with a reason, filter still available.
    await page.getByRole("button", { name: "Fast", exact: true }).click();
    await expect(page.getByText(/Fast mode skips transcription, so there are no captions or emoji reactions to style/).first()).toBeVisible();
    await openGroupRow(page, "Video filter");
    await expect(ui.group(page, "Video filter")).toBeVisible();
    await page.getByRole("button", { name: "Smart", exact: true }).click();
    if (!(await subtitleToggle.isChecked())) await subtitleToggle.check();
    await expect(subtitleToggle).toBeChecked();
    // Narrow viewport.
    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoHorizontalOverflow(page, "Projects at 390px (speech)");
    await page.screenshot({ path: path.join(evidence, "ui-speech-390.png"), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await selectChoice(page, "Subtitle style", "Karaoke line");
    await selectChoice(page, "Video filter", "Black & white");
    await page.screenshot({ path: path.join(evidence, "ui-speech-1440.png"), fullPage: true });
    // Music: regular controls disappear, nine originals remain, three additions, independent choices.
    await page.getByRole("button", { name: "Music / sung vocals", exact: true }).click();
    await expect(ui.group(page, "Subtitle style"), "regular subtitle choices hidden in Music").toHaveCount(0);
    await expect(ui.group(page, "Heading appearance"), "regular heading appearance hidden in Music").toHaveCount(0);
    await expect(ui.group(page, "Emoji reactions"), "speech emoji reactions hidden in Music").toHaveCount(0);
    await openGroupRow(page, "Lyrics subtitle theme");
    const themes = ui.group(page, "Lyrics subtitle theme");
    await expect(themes).toBeVisible();
    for (const label of [...ORIGINAL_MUSIC_THEMES, ...NEW_MUSIC_THEMES]) await expect(ui.choice(themes, label), `Music theme ${label} in the existing grid`).toBeVisible();
    await selectChoice(page, "Lyrics subtitle theme", pick.musicTheme);
    await selectChoice(page, "Lyric animation", pick.musicAnimation);
    await selectChoice(page, "Music video filter", pick.musicFilter);
    for (const theme of [...NEW_MUSIC_THEMES, "Clean sans"]) {
      await selectChoice(page, "Lyrics subtitle theme", theme);
      await expect(ui.choice(ui.group(page, "Lyric animation"), pick.musicAnimation), "animation independent of theme").toHaveAttribute("aria-pressed", "true");
      await expect(ui.choice(ui.group(page, "Music video filter"), pick.musicFilter), "filter independent of theme").toHaveAttribute("aria-pressed", "true");
    }
    for (const animation of MUSIC_ANIMATIONS) await selectChoice(page, "Lyric animation", animation);
    await expect(ui.choice(ui.group(page, "Lyrics subtitle theme"), "Clean sans")).toHaveAttribute("aria-pressed", "true");
    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoHorizontalOverflow(page, "Projects at 390px (Music)");
    await page.screenshot({ path: path.join(evidence, "ui-music-390.png"), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    // Back to speech: Music selections persist but are not shown.
    await page.getByRole("button", { name: /Clip mode/ }).click();
    await expect(ui.group(page, "Lyrics subtitle theme")).toHaveCount(0);
    await context.close();
  });
});

// ===========================================================================
// 2. Speech: real YouTube import, local transcription, styled render + control
// ===========================================================================
test("Speech: real YouTube import renders the selected subtitle style, filter, heading and emoji mode", async ({ browser }, testInfo) => {
  test.skip(!enabled, "runs only under scripts/qa/editing-style-library-acceptance.mjs (isolated stack, validated manifest)");
  await journey("speech", testInfo, async () => {
    phase = "speech";
    const { context, page } = await startPage(browser);
    const used = await importWithSubstitution("speech", async (candidate, candidateIndex) => {
      const stamp = Date.now();
      const base = `Editing styles speech ${stamp}`;
      // --- control first: captions off, every presentation choice at its default (pre-effect reference)
      const controlName = `${base} control`;
      const controlFields = await createProject(page, { name: controlName, url: candidate.url, music: false, count: 1, min: 8, max: 20, processing: "Smart", editorial: "Educational", captions: false });
      expect(Object.keys(controlFields).filter((key) => /editing_?presentation/i.test(key)), "defaults omit the presentation field").toEqual([]);
      const controlStages = new Set<string>();
      const controlFound = await waitTerminal(page, controlName, controlStages, 25 * 60_000);
      if (isExternalImportFailure(controlFound.job)) throw new Error(`IMPORT_FAILED: ${candidate.url}: ${controlFound.job.error || controlFound.job.stage}`);
      expect(controlFound.job.state, `control job: ${controlFound.job.error}`).toBe("complete");
      expect(controlFound.project.sourceKind).toBe("youtube");
      const control = controlFound.job.clips[0];
      assertWithinVerifiedInterval(control, candidate, "control");
      expect(controlFound.job.burnSubtitles).toBe(false);

      // --- styled job: non-default style, filter, heading (existing checkbox/input), emoji mode.
      // Music options are staged first and abandoned, to prove nothing hidden is submitted.
      const styledName = `${base} styled`;
      const fields = await createProject(page, {
        name: styledName, url: candidate.url, music: false, count: 1, min: 8, max: 20, processing: "Smart", editorial: "Educational", captions: true,
        select: async (p) => {
          await p.getByRole("button", { name: "Music / sung vocals", exact: true }).click();
          await selectChoice(p, "Lyrics subtitle theme", pick.musicTheme);
          await selectChoice(p, "Lyric animation", pick.musicAnimation);
          await selectChoice(p, "Music video filter", "Vintage");
          await p.getByRole("button", { name: /Clip mode/ }).click();
          await p.locator(".style-card").filter({ hasText: "Educational" }).first().click();
          await selectChoice(p, "Subtitle style", pick.speechStyle);
          await selectChoice(p, "Video filter", pick.speechFilter);
          await p.getByRole("checkbox", { name: "Hook text" }).check();
          await p.getByRole("textbox", { name: "Hook text to display" }).fill("Small changes matter");
          await selectChoice(p, "Heading appearance", pick.speechHeading);
          await selectChoice(p, "Emoji reactions", pick.speechEmoji);
          await expect(ui.sample(p)).toHaveAttribute("aria-label", new RegExp(`^Style sample: ${escapeRe(pick.speechStyle)}\\.`));
        },
      });
      // Outgoing request: presentation present, hidden Music settings absent, editorial style kept.
      expect(fields.style, "editorial intent still submitted as the four-value style").toBe("educational");
      expect(fields.source_profile).toBe("speech");
      expect(Object.keys(fields).filter((key) => /^music_/i.test(key)), "hidden Music settings are not submitted").toEqual([]);
      const requestPresentation = JSON.parse(fields.editing_presentation || "null") as Record<string, unknown> | null;
      expect(requestPresentation, "editing_presentation field submitted").toBeTruthy();
      expect(requestPresentation!.version).toBe(1);
      expect(requestPresentation!.videoFilter, "the Speech filter was submitted and Music's Vintage did not leak into it").toBe(FILTER_IDS[pick.speechFilter]);
      expect(requestPresentation, "speech request carries no lyric fields").not.toHaveProperty("lyricAnimation");
      expect(fields.hook_text).toBe("true");
      expect(fields.manual_hook_text).toBe("Small changes matter");
      expect(fields.burn_subtitles).toBe("true");
      await fs.writeFile(path.join(evidence, "speech-request-fields.json"), JSON.stringify(fields, null, 2));
      await page.screenshot({ path: path.join(evidence, "speech-after-submit.png"), fullPage: true });

      const stages = new Set<string>();
      const found = await waitTerminal(page, styledName, stages, 30 * 60_000);
      if (isExternalImportFailure(found.job)) throw new Error(`IMPORT_FAILED: ${candidate.url}: ${found.job.error || found.job.stage}`);
      const { job, project } = found;
      expect(job.state, `styled job: ${job.error}`).toBe("complete");
      expect(project.sourceKind).toBe("youtube");
      for (const stage of ["Source received", "Video validated", "Speech transcribed", "Clips rendered and saved", "Outputs verified", "Project ready"])
        expect([...stages].some((item) => item.startsWith(`${stage}:`)), `real-import stage observed: ${stage}`).toBeTruthy();
      expect(job.processingMode).toBe("smart");
      expect(job.executionPolicy).toBe("engine_only");
      expect(job.burnSubtitles).toBe(true);
      expect(job.clips).toHaveLength(1);
      const clip = job.clips[0];
      assertWithinVerifiedInterval(clip, candidate, "styled");
      expect(clip.transcriptExcerpt?.trim(), "local Whisper recognised speech").toBeTruthy();
      // Saved settings equal the submission and the Workspace shows them.
      expect(normalizeKeys(job.editingPresentation)).toEqual(normalizeKeys(requestPresentation));
      expect(JSON.stringify(normalizeKeys(job.musicPresentation ?? null))).toBe("null");
      await page.reload({ waitUntil: "domcontentloaded" });
      await openWorkspace(page, project, job.id);
      await openCaptionsInspector(page);
      const summary = ui.summary(page);
      await expect(summary, "Workspace shows the saved presentation read-only").toBeVisible();
      for (const label of [pick.speechStyle, pick.speechFilter, pick.speechHeading, pick.speechEmoji]) await expect(summary).toContainText(label);
      await page.screenshot({ path: path.join(evidence, "speech-workspace-after-refresh.png"), fullPage: true });

      // Preview + download are the same completed MP4; real playback; probe; decode.
      const mp4 = await downloadClip(page, clip, path.join(evidence, "speech-styled.mp4"));
      await page.locator(".clip-tile.complete").first().getByRole("button", { name: /Preview/ }).click();
      checkPlayback(await assertPlayback(page), "styled preview");
      const previewBytes = await (await page.request.get(new URL(clip.previewUrl || clip.downloadUrl!, gateway).toString())).body();
      expect(Buffer.compare(previewBytes, await fs.readFile(mp4)), "preview and download expose the same MP4").toBe(0);
      const probe = await ffprobe(mp4);
      const video = probe.streams.find((item) => item.codec_type === "video"); const audio = probe.streams.find((item) => item.codec_type === "audio");
      expect(video, "video stream").toMatchObject({ width: 1080, height: 1920 });
      expect(audio, "audio stream").toBeTruthy();
      expect(Math.abs(Number(probe.format.duration) - clip.duration), "duration matches the job record").toBeLessThan(1.5);
      await decodeFully(mp4);
      const volume = await meanVolumeDb(mp4);
      expect(volume, "speech audio is audible").not.toBeNull();
      expect(volume!, "speech audio is not silent").toBeGreaterThan(-60);

      // Captions: ASS/SRT/VTT downloads carry the transcript.
      const downloads = clip.captionDownloads || [];
      expect(downloads.map((item) => item.format).sort()).toEqual(["ass", "srt", "vtt"]);
      const captionText: Record<string, string> = {};
      for (const item of downloads) {
        const response = await page.request.get(new URL(item.url, gateway).toString());
        expect(response.ok(), `${item.format} download`).toBeTruthy();
        captionText[item.format] = (await response.body()).toString("utf8");
        await fs.writeFile(path.join(evidence, `speech-captions.${item.format}`), captionText[item.format]);
      }
      expect(captionText.ass).toMatch(/^Dialogue:/m);
      // Headings are composited as graphics above the footage, not written to
      // the timed caption sidecar. Verify the saved job value here and its
      // rendered pixels against the caption-free control below.
      expect(clip.hookText, "saved manual heading text").toBe("Small changes matter");
      const cueList = parseSrtCues(captionText.srt);
      expect(cueList.length, "plain SRT sidecar contains locally timed caption cues").toBeGreaterThan(0);

      // Decoded-frame evidence vs the recorded control (same source span, nothing else changed).
      const offset = Math.abs(clip.start - control.start) + Math.abs(clip.end - control.end);
      const comparable = offset <= 0.6;
      record("speech:control-span-comparable", comparable ? "pass" : "unmet", { styled: [clip.start, clip.end], control: [control.start, control.end], offset });
      const controlMp4 = await downloadControl(page, controlFound.project, controlFound.job, controlName);
      const cue = cueList[Math.floor((cueList.length - 1) / 2)];
      const cueMid = Math.min(Number(probe.format.duration) - 0.2, cue.start + (cue.end - cue.start) / 2);
      // A genuinely caption-free moment: a gap between cues, or before the first / after the last cue.
      const duration = Number(probe.format.duration);
      const quiet = cueList[0].start > 0.5 ? cueList[0].start / 2
        : cueList.slice(1).map((item, index) => ({ from: cueList[index].end, to: item.start })).find((gap) => gap.to - gap.from > 0.4)?.from ?? NaN;
      const quietTime = Number.isFinite(quiet) ? quiet + 0.1 : (duration - cueList[cueList.length - 1].end > 0.5 ? (duration + cueList[cueList.length - 1].end) / 2 : NaN);
      await writeFrame(mp4, cueMid, "speech-styled-cue.png");
      await writeFrame(controlMp4, cueMid, "speech-control-cue.png");
      if (comparable) {
        const treated = await regionStats(mp4, cueMid, FOOTAGE_REGIONS);
        const baseline = await regionStats(controlMp4, cueMid, FOOTAGE_REGIONS);
        const expectation = filterExpectation(pick.speechFilter, treated, baseline);
        record("speech:filter-footage-region", expectation ? (expectation.ok ? "pass" : "fail") : "info", { filter: pick.speechFilter, treated, baseline, expectation });
        if (expectation) expect(expectation.ok, `${pick.speechFilter}: ${expectation.detail}`).toBe(true);
        const captionBand = "1000:420:40:1050";
        const withCaption = await changedPixels(mp4, controlMp4, cueMid, cueMid, captionBand);
        const withoutCaption = Number.isFinite(quietTime) ? await changedPixels(mp4, controlMp4, quietTime, quietTime, captionBand) : null;
        if (withoutCaption === null) record("speech:caption-quiet-interval", "unmet", "every moment of the clip has an active cue, so 'no text during silence' could not be sampled");
        const needed = Math.max(400, (withoutCaption ?? 0) * 2);
        record("speech:caption-pixels-vs-control", withCaption > needed ? "pass" : "fail", { cueMid, withCaption, quietTime: Number.isFinite(quietTime) ? quietTime : null, withoutCaption, band: captionBand });
        expect(withCaption, "burned caption changes decoded pixels at an active cue (vs the caption-free control)").toBeGreaterThan(needed);
        const heading = await changedPixels(mp4, controlMp4, cueMid, cueMid, "1000:900:40:60");
        record("speech:heading-pixels-vs-control", heading > 400 ? "pass" : "fail", { heading });
        expect(heading, `${pick.speechHeading} heading is visible in the upper area`).toBeGreaterThan(400);
      }
      for (const [label, source] of [["pre-effect-control", controlMp4], ["styled", mp4]] as const) record(`speech:evidence:${label}`, "info", { file: path.relative(artifactRoot, source), sha256: await sha256(source) });

      // Caption edit + rerender must keep the selected presentation.
      const editedWord = "styleverified";
      const cues = cueList.map((item, index) => ({ id: item.id, start: item.start, end: Math.min(item.end, Math.max(item.start + 0.05, clip.duration - 0.01)), text: index === 0 ? `${item.text} ${editedWord}` : item.text, confidence: item.confidence ?? null }));
      const rerenderButton = page.getByRole("button", { name: /re-?render/i });
      const method = (await rerenderButton.count()) > 0 ? "ui-button-present-but-edit-via-api" : "api";
      const saved = await page.request.put(new URL(`/api/v1/jobs/${encodeURIComponent(job.id)}/clips/${encodeURIComponent(clip.id)}/captions`, gateway).toString(), { data: { revision: clip.captionRevision ?? 0, cues } });
      expect(saved.ok(), `caption edit saved: ${await saved.text()}`).toBeTruthy();
      const editedJob = await refreshJob(job.id);
      const editedClip = editedJob.clips.find((item) => item.id === clip.id)!;
      const rerender = await page.request.post(new URL(`/api/v1/jobs/${encodeURIComponent(job.id)}/clips/${encodeURIComponent(clip.id)}/captions/rerender?revision=${encodeURIComponent(editedClip.captionRevision ?? 0)}`, gateway).toString());
      expect(rerender.ok(), `caption rerender accepted: ${await rerender.text()}`).toBeTruthy();
      await expect.poll(async () => { const current = await refreshJob(job.id); const item = current.clips.find((entry) => entry.id === clip.id); return item?.state === "complete" && TERMINAL.has(current.state); }, { timeout: 15 * 60_000, intervals: [2_000, 5_000] }).toBe(true);
      const afterEdit = await refreshJob(job.id);
      expect(normalizeKeys(afterEdit.editingPresentation), "presentation survives caption rerender").toEqual(normalizeKeys(requestPresentation));
      const rerenderedClip = afterEdit.clips.find((item) => item.id === clip.id)!;
      const rerenderedAss = await (await page.request.get(new URL(rerenderedClip.captionDownloads!.find((item) => item.format === "ass")!.url, gateway).toString())).text();
      expect(rerenderedAss, "edited caption text reached the rerendered ASS").toContain(editedWord);
      record("speech:caption-edit-rerender", "pass", { method });
      await page.reload({ waitUntil: "domcontentloaded" });
      await openWorkspace(page, project, job.id);
      const rerenderedMp4 = await downloadClip(page, rerenderedClip, path.join(evidence, "speech-styled-rerendered.mp4"));
      await decodeFully(rerenderedMp4);
      expect(await sha256(rerenderedMp4), "rerender produced a new MP4").not.toBe(await sha256(mp4));

      // Safe restart of the ISOLATED engine only.
      if (process.env.S6_EDITING_SKIP_RESTART === "1") record("speech:engine-restart", "unmet", "skipped by S6_EDITING_SKIP_RESTART=1");
      else {
        const labels = JSON.parse(execFileSync("docker", ["inspect", "--format", "{{json .Config.Labels}}", engineContainer], { encoding: "utf8" })) as Record<string, string>;
        expect(labels["com.docker.compose.project"], "restart target belongs to the isolated project").toBe(composeProject);
        expect(composeProject).not.toBe("s6-cut");
        // Allow only the deliberate outage window: the still-open Workspace logs
        // transient gateway errors while the engine restarts. Scope it to the
        // restart and the health poll so unrelated errors after the engine is
        // healthy (including the reload below) still fail acceptance.
        expectErrors = true;
        try {
          execFileSync("docker", ["restart", engineContainer], { stdio: "ignore" });
          await expect.poll(async () => { try { return (await fetch(new URL("/healthz", gateway))).ok && (await fetch(new URL("/api/health", gateway))).ok; } catch { return false; } }, { timeout: 240_000, intervals: [2_000] }).toBe(true);
        } finally { expectErrors = false; }
        const afterRestart = await refreshJob(job.id);
        expect(normalizeKeys(afterRestart.editingPresentation), "presentation survives an engine restart").toEqual(normalizeKeys(requestPresentation));
        expect(afterRestart.state).toBe("complete");
        record("speech:engine-restart", "pass", { container: engineContainer, project: composeProject });
        await page.reload({ waitUntil: "domcontentloaded" });
        await openWorkspace(page, project, job.id);
        await openCaptionsInspector(page);
        await expect(ui.summary(page)).toContainText(pick.speechStyle);
      }

      // ZIP export agrees with the current download and carries presentation metadata + credits.
      await page.locator(".clip-tile.complete input[type=checkbox]").first().check();
      const [zipDownload] = await Promise.all([page.waitForEvent("download", { timeout: 120_000 }), page.getByRole("button", { name: /Download ZIP/ }).click()]);
      const zipPath = path.join(evidence, "speech-export.zip");
      await zipDownload.saveAs(zipPath);
      assertZipIntact(zipPath);
      const names = zipNames(zipPath);
      const manifestName = names.find((item) => item.endsWith("manifest.json")); const creditsName = names.find((item) => item.endsWith("credits.json"));
      expect(manifestName, "ZIP manifest.json").toBeTruthy(); expect(creditsName, "ZIP credits.json").toBeTruthy();
      const exportManifest = JSON.parse(zipEntry(zipPath, manifestName!)) as unknown;
      const metadata = JSON.stringify(normalizeKeys(exportManifest));
      for (const value of Object.values(requestPresentation!).filter((item) => typeof item === "string")) expect(metadata, `ZIP manifest carries presentation value ${String(value)}`).toContain(String(value));
      const credits = zipEntry(zipPath, creditsName!);
      expect(credits.trim(), "ZIP credits are not empty").not.toBe("");
      if (rerenderedClip.creatorCredit) expect(credits).toContain(rerenderedClip.creatorCredit);
      record("speech:zip-credits-channel", credits.toLowerCase().includes(candidate.channel.toLowerCase()) ? "pass" : "info", { expectedChannel: candidate.channel });
      const zipMp4 = names.find((item) => item.toLowerCase().endsWith(".mp4"))!;
      const extractDir = path.join(evidence, "speech-zip-media");
      await fs.mkdir(extractDir, { recursive: true });
      execFileSync("python3", ["-I", "-c", "import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extract(sys.argv[2], sys.argv[3])", zipPath, zipMp4, extractDir]);
      expect(await sha256(path.join(extractDir, zipMp4)), "ZIP MP4 equals the downloaded result").toBe(await sha256(rerenderedMp4));

      sources.speech = {
        candidateIndex, url: candidate.url, channel: candidate.channel, durationSeconds: candidate.durationSeconds, verifiedInterval: candidate.interval,
        attribution: candidate.attribution, reuseTerms: candidate.reuseTerms, verification: candidate.verification, preEffectFrames: await hashFiles(candidate.preEffectFrames),
        selected: pick, selectedClip: { start: clip.start, end: clip.end, duration: clip.duration }, projectId: project.id, jobId: job.id, stages: [...stages].sort(),
        liveCoverage: "ONE style/filter/heading/emoji combination only; the full catalog is not live-verified",
      };
      flush();
    });
    expect(used).toBeTruthy();

    // Optional step-9 journey (extra import): captions off + the same requested filter still applies.
    if (process.env.S6_EDITING_INCLUDE_CAPTIONS_OFF_FILTER === "1") await captionsOffFilterJourney(page, manifest!.speech[0]);
    else record("speech:captions-off-with-filter", "unmet", "not run (extra import); set S6_EDITING_INCLUDE_CAPTIONS_OFF_FILTER=1 to include it");

    // Unavailable-source probe uses only a user-supplied URL; no arbitrary reference is fetched.
    const unavailable = process.env.S6_EDITING_UNAVAILABLE_URL;
    if (!unavailable) record("speech:unavailable-source", "unmet", "no S6_EDITING_UNAVAILABLE_URL supplied; error-without-stale-success check not run");
    else if (remainingMs() > 8 * 60_000) {
      phase = "unavailable-probe"; expectErrors = true;
      const name = `Editing styles unavailable ${Date.now()}`;
      try {
        await createProject(page, { name, url: unavailable, music: false, count: 1, min: 8, max: 20, processing: "Smart", captions: true });
        const probeStages = new Set<string>();
        const probe = await waitTerminal(page, name, probeStages, 6 * 60_000);
        expect(["failed", "stalled"], "unavailable source ends in a failure state").toContain(probe.job.state);
        expect(probe.job.clips.filter((item) => item.state === "complete"), "no stale success outputs").toHaveLength(0);
        await expect(page.locator(".clip-tile.complete")).toHaveCount(0);
        // A failed import unbinds the Workspace (App keeps no selected project), so
        // the "Project ready" chip may legitimately not exist; assert no completed
        // checklist row is visible instead of requiring the row first.
        await expect(page.locator(".process-checklist li.status-complete")).toHaveCount(0);
        record("speech:unavailable-source", "pass", { state: probe.job.state, error: probe.job.error });
      } finally { expectErrors = false; phase = "speech"; }
    } else record("speech:unavailable-source", "unmet", "insufficient live budget remained");
    await context.close();
  });
});

async function hashFiles(files?: string[]) {
  if (!files?.length) return [];
  const out: { path: string; sha256: string | null }[] = [];
  for (const file of files) out.push({ path: file, sha256: await sha256(file).catch(() => null) });
  return out;
}
async function downloadControl(page: Page, project: Record<string, unknown> & { id: string }, job: JobRecord, name: string) {
  const target = path.join(evidence, "speech-control.mp4");
  await page.reload({ waitUntil: "domcontentloaded" });
  await openWorkspace(page, { ...project, name }, job.id);
  const clip = (await refreshJob(job.id)).clips[0];
  return downloadClip(page, clip, target);
}
async function captionsOffFilterJourney(page: Page, candidate: Candidate) {
  if (remainingMs() < 20 * 60_000) { record("speech:captions-off-with-filter", "unmet", "insufficient live budget remained for an extra import"); return; }
  const name = `Editing styles captions-off filter ${Date.now()}`;
  const fields = await createProject(page, {
    name, url: candidate.url, music: false, count: 1, min: 8, max: 20, processing: "Smart", editorial: "Educational", captions: false,
    select: async (p) => { await selectChoice(p, "Video filter", pick.speechFilter); },
  });
  const presentation = JSON.parse(fields.editing_presentation || "null") as Record<string, unknown> | null;
  expect(presentation?.videoFilter, "filter submitted while captions are off").toBeTruthy();
  expect(presentation, "caption/emoji choices are not submitted while captions are off").not.toHaveProperty("captionPreset");
  expect(presentation).not.toHaveProperty("emojiMode");
  const found = await waitTerminal(page, name, new Set(), 25 * 60_000);
  if (isExternalImportFailure(found.job)) throw new Error(`EXTERNAL_BLOCKER: captions-off journey import failed: ${found.job.error}`);
  expect(found.job.state).toBe("complete");
  expect(found.job.burnSubtitles).toBe(false);
  expect(normalizeKeys(found.job.editingPresentation)).toEqual(normalizeKeys(presentation));
  record("speech:captions-off-with-filter", "pass", { projectId: found.project.id, jobId: found.job.id });
}

// ===========================================================================
// 3. Music: real sung-vocal YouTube import, new theme + animation + explicit filter
// ===========================================================================
test("Music: real sung-vocal YouTube import renders the selected theme, animation and explicit filter", async ({ browser }, testInfo) => {
  test.skip(!enabled, "runs only under scripts/qa/editing-style-library-acceptance.mjs (isolated stack, validated manifest)");
  await journey("music", testInfo, async () => {
    phase = "music";
    const { context, page } = await startPage(browser);
    record("music:projects-ready", "info");
    await importWithSubstitution("music", async (candidate, candidateIndex) => {
      const name = `Editing styles music ${Date.now()}`;
      // No replacement soundtrack: original sung timing stays unambiguous. Two clips make the
      // automatic colour/grayscale assignment visible, so an explicit filter must override it.
      const fields = await createProject(page, {
        name, url: candidate.url, music: true, count: 2, min: 8, max: 20, processing: "Smart",
        select: async (p) => {
          record("music:form-selection-start", "info");
          await selectChoice(p, "Lyrics subtitle theme", pick.musicTheme);
          record("music:theme-selected", "info", pick.musicTheme);
          await selectChoice(p, "Lyric animation", pick.musicAnimation);
          record("music:animation-selected", "info", pick.musicAnimation);
          await selectChoice(p, "Music video filter", pick.musicFilter);
          await p.screenshot({ path: path.join(evidence, "music-project-form.png"), fullPage: true });
          record("music:filter-selected", "info", pick.musicFilter);
        },
      });
      expect(fields.source_profile).toBe("music");
      expect(fields.music_track_url ?? "", "no replacement soundtrack").toBe("");
      expect(fields.burn_subtitles).toBe("true");
      const musicPresentation = JSON.parse(fields.music_presentation) as Record<string, unknown>;
      const editing = JSON.parse(fields.editing_presentation || "null") as Record<string, unknown> | null;
      expect(String(musicPresentation.subtitleTheme)).toMatch(new RegExp(pick.musicTheme.toLowerCase().replace(/\s+/g, "_")));
      if (pick.musicAnimation === "Original") expect(musicPresentation.lyricAnimation, "Original animation is the omitted legacy value").toBeUndefined();
      else expect(String(musicPresentation.lyricAnimation)).toMatch(new RegExp(pick.musicAnimation.toLowerCase().split(/\s+/)[0]));
      expect(editing?.videoFilter, "explicit Music filter id").toBe(FILTER_IDS[pick.musicFilter]);
      expect(editing, "explicit Music filter submitted").toBeTruthy();
      expect(editing).not.toHaveProperty("captionPreset");
      expect(editing).not.toHaveProperty("headingStyle");
      expect(editing).not.toHaveProperty("emojiMode");
      expect(fields.hook_text, "speech hook text is not submitted for Music").toBeUndefined();
      await fs.writeFile(path.join(evidence, "music-request-fields.json"), JSON.stringify(fields, null, 2));

      const stages = new Set<string>();
      const found = await waitTerminal(page, name, stages, 40 * 60_000);
      if (isExternalImportFailure(found.job)) throw new Error(`IMPORT_FAILED: ${candidate.url}: ${found.job.error || found.job.stage}`);
      const { job, project } = found;
      expect(job.state, `music job: ${job.error}`).toBe("complete");
      expect(job.sourceProfile).toBe("music");
      expect(project.sourceKind).toBe("youtube");
      expect(job.clips).toHaveLength(2);
      for (const stage of ["Source received", "Video validated", "Music words timed", "Clips rendered and saved", "Outputs verified", "Project ready"])
        expect([...stages].some((item) => item.startsWith(`${stage}:`)), `real-import stage observed: ${stage}`).toBeTruthy();
      expect(normalizeKeys(job.musicPresentation)).toMatchObject(normalizeKeys(musicPresentation) as Record<string, unknown>);
      expect(normalizeKeys(job.editingPresentation)).toEqual(normalizeKeys(editing));
      for (const clip of job.clips) {
        assertWithinVerifiedInterval(clip, candidate, `music clip ${clip.index}`);
        expect(clip.captionCues?.length ?? 0, `clip ${clip.index}: real word-timed sung-vocal transcription`).toBeGreaterThan(0);
      }

      await page.reload({ waitUntil: "domcontentloaded" });
      await openWorkspace(page, project, job.id);
      await openCaptionsInspector(page);
      await expect(ui.summary(page), "Workspace shows the saved Music filter").toContainText(pick.musicFilter);
      await expect(page.getByLabel("Music presentation")).toContainText(pick.musicTheme);
      await page.screenshot({ path: path.join(evidence, "music-workspace-after-refresh.png"), fullPage: true });

      const treatments: unknown[] = [];
      for (let index = 0; index < job.clips.length; index += 1) {
        const clip = job.clips[index];
        const mp4 = await downloadClip(page, clip, path.join(evidence, `music-clip-${clip.index}.mp4`), index);
        const probe = await ffprobe(mp4);
        expect(probe.streams.find((item) => item.codec_type === "video"), "video").toMatchObject({ width: 1080, height: 1920 });
        expect(probe.streams.find((item) => item.codec_type === "audio"), "original sung audio retained").toBeTruthy();
        expect(Math.abs(Number(probe.format.duration) - clip.duration)).toBeLessThan(1.5);
        await decodeFully(mp4);
        const volume = await meanVolumeDb(mp4);
        expect(volume, "sung audio is audible").not.toBeNull();
        expect(volume!).toBeGreaterThan(-60);
        // Existing Music layout: source layer sits in the middle band; a grayscale assignment would drop chroma there.
        const source = await regionStats(mp4, Number(probe.format.duration) / 2, ["80:80:600:700"]);
        treatments.push({ clip: clip.index, assignedTreatment: clip.musicTreatment ?? null, chroma: source.chroma, r: source.r, b: source.b });
        const chromaFloor = pick.musicFilter === "Vibrant" ? 12 : 8;
        const check = pick.musicFilter === "Black & white" ? source.chroma < 8 : pick.musicFilter === "Existing look" ? true : source.chroma > chromaFloor;
        record(`music:clip-${clip.index}-explicit-filter-chroma`, check ? "pass" : "fail", { filter: pick.musicFilter, chroma: source.chroma, assigned: clip.musicTreatment });
        expect(check, `clip ${clip.index}: the explicit "${pick.musicFilter}" filter controls the result, not the automatic assignment (chroma ${source.chroma.toFixed(1)})`).toBe(true);
        const cues = clip.captionCues!;
        const cue = cues[Math.floor((cues.length - 1) / 2)];
        const mid = Math.min(Number(probe.format.duration) - 0.2, cue.start + Math.max(0.05, (cue.end - cue.start) / 2));
        await writeFrame(mp4, mid, `music-clip-${clip.index}-lyric.png`);
        await writeFrame(mp4, Math.min(0.4, Number(probe.format.duration) / 5), `music-clip-${clip.index}-early.png`);
        const ass = await (await page.request.get(new URL(clip.captionDownloads!.find((item) => item.format === "ass")!.url, gateway).toString())).text();
        await fs.writeFile(path.join(evidence, `music-clip-${clip.index}.ass`), ass);
        expect(ass).toMatch(/^Dialogue:/m);
        expect(ass).toMatch(/^Style: Caption,/m);
        for (const item of cues) { expect(item.start).toBeGreaterThanOrEqual(0); expect(item.end).toBeLessThanOrEqual(Number(probe.format.duration) + 0.1); }
      }
      if (job.clips.every((clip) => clip.musicTreatment === "grayscale" || clip.musicTreatment === "color") && new Set(job.clips.map((clip) => clip.musicTreatment)).size === 2)
        record("music:automatic-assignment-still-mixed-but-overridden", "info", treatments);
      await page.locator(".clip-tile.complete").first().getByRole("button", { name: /Preview/ }).click();
      checkPlayback(await assertPlayback(page), "music preview");
      sources.music = {
        candidateIndex, url: candidate.url, channel: candidate.channel, durationSeconds: candidate.durationSeconds, verifiedInterval: candidate.interval,
        attribution: candidate.attribution, reuseTerms: candidate.reuseTerms, verification: candidate.verification, preEffectFrames: await hashFiles(candidate.preEffectFrames),
        selected: { theme: pick.musicTheme, animation: pick.musicAnimation, filter: pick.musicFilter }, clips: job.clips.map((clip) => ({ id: clip.id, start: clip.start, end: clip.end })),
        projectId: project.id, jobId: job.id, stages: [...stages].sort(), treatments,
        liveCoverage: "ONE theme/animation/filter combination only; the 3 new themes x 4 animations matrix is deterministic-render territory",
      };
      record("music:no-pre-effect-control", "info", "Music has no caption-free control import; evidence is chroma of the source layer plus decoded lyric frames. Supply preEffectFrames in the manifest for a manual comparison.");
      flush();
    });
    await context.close();
  });
});
