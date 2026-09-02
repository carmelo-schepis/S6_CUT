import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { Browserbase } from "@browserbasehq/sdk";
import type { SessionCreateResponse } from "@browserbasehq/sdk/resources/sessions/sessions.js";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "playwright-core";
import { Type } from "typebox";

const MAX_OUTPUT = 18_000;
const MAX_LOG_ENTRIES = 50;
const MAX_LOG_TEXT = 1_000;
const DEFAULT_ACTION_TIMEOUT = 30_000;
const DEFAULT_NAVIGATION_TIMEOUT = 60_000;
const DEFAULT_SESSION_TIMEOUT = 900;
const REGIONS = [
  "us-west-2",
  "us-east-1",
  "eu-central-1",
  "ap-southeast-1",
] as const;
const ROLES = [
  "alert",
  "alertdialog",
  "application",
  "article",
  "banner",
  "blockquote",
  "button",
  "caption",
  "cell",
  "checkbox",
  "code",
  "columnheader",
  "combobox",
  "complementary",
  "contentinfo",
  "definition",
  "dialog",
  "directory",
  "document",
  "feed",
  "figure",
  "form",
  "grid",
  "gridcell",
  "group",
  "heading",
  "img",
  "link",
  "list",
  "listbox",
  "listitem",
  "log",
  "main",
  "marquee",
  "math",
  "menu",
  "menubar",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "meter",
  "navigation",
  "none",
  "note",
  "option",
  "paragraph",
  "presentation",
  "progressbar",
  "radio",
  "radiogroup",
  "region",
  "row",
  "rowgroup",
  "rowheader",
  "scrollbar",
  "search",
  "searchbox",
  "separator",
  "slider",
  "spinbutton",
  "status",
  "strong",
  "subscript",
  "superscript",
  "switch",
  "tab",
  "table",
  "tablist",
  "tabpanel",
  "term",
  "textbox",
  "time",
  "timer",
  "toolbar",
  "tooltip",
  "tree",
  "treegrid",
  "treeitem",
] as const;

type LogEntry = { timestamp: string; message?: string; [key: string]: unknown };
type NavigationEntry = LogEntry & {
  url: string;
  status?: number;
  title?: string;
  error?: string;
};
type ScreenshotStatus = "success" | "failure" | "evidence" | "debugging";
export type ManifestScreenshot = {
  sequence: number;
  filename: string;
  repositoryPath: string;
  absolutePath: string;
  capturedAt: string;
  url: string;
  title: string;
  viewport: { width: number; height: number } | null;
  reason: string;
  relatedAction?: string;
  status: ScreenshotStatus;
  sessionId: string;
  sessionInspectorUrl: string;
  dimensions?: { width: number; height: number };
};
export type Manifest = {
  runId: string;
  sessionId: string;
  startedAt: string;
  endedAt?: string;
  screenshots: ManifestScreenshot[];
};

type LocatorSpec = {
  ref?: string;
  role?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  testId?: string;
  text?: string;
  css?: string;
  target?: string;
  exact?: boolean;
};

type StartOptions = {
  timeout?: number;
  region?: (typeof REGIONS)[number];
  proxy?: boolean;
  keepAlive?: boolean;
  viewport?: { width?: number; height?: number };
  userMetadata?: Record<string, unknown>;
};

type Runtime = {
  client: Browserbase;
  session: SessionCreateResponse;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  runId: string;
  screenshotDir: string;
  manifestPath: string;
  manifest: Manifest;
};

type ToolDetails = Record<string, unknown>;

export function truncate(text: string, limit = MAX_OUTPUT) {
  const safeLimit = Math.max(1, Math.floor(limit));
  if (text.length <= safeLimit) return text;
  return `${text.slice(0, safeLimit)}\n...[truncated; ${text.length - safeLimit} characters omitted]`;
}

export function sanitizeFilename(value: string) {
  const clean = value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80);
  return clean || "screenshot";
}

export function validateUrl(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Invalid URL. Use a complete http:// or https:// URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      "Only http:// and https:// URLs are allowed; javascript:, data:, and file: URLs are rejected.",
    );
  }
  if (parsed.username || parsed.password) {
    throw new Error("URLs containing embedded credentials are rejected.");
  }
  return parsed;
}

export function publicUrl(value: string) {
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "") || "/";
  } catch {
    return "[invalid URL]";
  }
}

export function publicLink(value: string, base: string) {
  try {
    return publicUrl(new URL(value, base).toString());
  } catch {
    return "[invalid link]";
  }
}

export function redactSecrets(value: string) {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  let redacted = value;
  if (apiKey) redacted = redacted.split(apiKey).join("[redacted-api-key]");
  return redacted
    .replace(/\b(?:bb_(?:live|test)_[A-Za-z0-9_-]+)\b/g, "[redacted-api-key]")
    .replace(/(Bearer\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(/(Basic\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(
      /((?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|password|token|secret)\s*[:=]\s*)[^,;\s]+/gi,
      "$1[redacted]",
    )
    .replace(
      /([?&](?:token|access_token|api_key|apikey|key|signature|sig|auth|password|secret)=)[^&#\s]*/gi,
      "$1[redacted]",
    )
    .replace(/https?:\/\/[^\s)]+/g, (url) => publicUrl(url));
}

export function locatorDescription(spec: LocatorSpec) {
  if (spec.ref) return `snapshot reference ${spec.ref}`;
  if (spec.role)
    return `role=${spec.role}${spec.name ? ` name=${JSON.stringify(spec.name)}` : ""}`;
  if (spec.label) return `label=${JSON.stringify(spec.label)}`;
  if (spec.testId) return `testId=${JSON.stringify(spec.testId)}`;
  if (spec.placeholder)
    return `placeholder=${JSON.stringify(spec.placeholder)}`;
  if (spec.text) return `text=${JSON.stringify(spec.text)}`;
  if (spec.css || spec.target)
    return `CSS ${JSON.stringify(spec.css ?? spec.target)}`;
  return "unspecified locator";
}

function errorMessage(error: unknown) {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

function publicTitle(title: string) {
  return redactSecrets(truncate(title.replace(/\s+/g, " ").trim(), 300));
}

function publicText(text: string, limit = 700) {
  return redactSecrets(truncate(text.replace(/\s+/g, " ").trim(), limit));
}

function now() {
  return new Date().toISOString();
}

function timestampForFilename() {
  return now()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
}

function envNumber(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) return fallback;
  return Math.floor(value);
}

function envBoolean(name: string) {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return undefined;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return undefined;
}

export function readConfiguration(): StartOptions {
  const region = REGIONS.includes(
    process.env.BROWSERBASE_REGION as (typeof REGIONS)[number],
  )
    ? (process.env.BROWSERBASE_REGION as (typeof REGIONS)[number])
    : undefined;
  return {
    timeout: envNumber(
      "BROWSERBASE_TIMEOUT_SECONDS",
      DEFAULT_SESSION_TIMEOUT,
      60,
      21_600,
    ),
    region,
    proxy: envBoolean("BROWSERBASE_USE_PROXY"),
    keepAlive: envBoolean("BROWSERBASE_KEEP_ALIVE") ?? false,
    viewport: {
      width: envNumber("BROWSERBASE_VIEWPORT_WIDTH", 1440, 320, 3840),
      height: envNumber("BROWSERBASE_VIEWPORT_HEIGHT", 1000, 240, 2160),
    },
  };
}

function progress<T>(
  onUpdate: AgentToolUpdateCallback<T> | undefined,
  text: string,
) {
  onUpdate?.({ content: [{ type: "text", text }], details: undefined as T });
}

function textResult<T extends ToolDetails>(
  text: string,
  details: T,
): AgentToolResult<T> {
  return { content: [{ type: "text", text }], details };
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw new Error("Browserbase operation cancelled.");
}

function wait(ms: number, signal?: AbortSignal) {
  throwIfAborted(signal);
  return new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(resolvePromise, ms);
    if (!signal) return;
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Browserbase operation cancelled."));
      },
      { once: true },
    );
  });
}

async function writeJsonAtomically(path: string, value: unknown) {
  const temporaryPath = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

export function boundedAppend<T>(
  entries: T[],
  entry: T,
  max = MAX_LOG_ENTRIES,
) {
  entries.push(entry);
  if (entries.length > max) entries.splice(0, entries.length - max);
}

export async function createScreenshotRun(cwd: string, sessionId: string) {
  const date = new Date();
  const runId = `run-${date
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14)}-${Math.random().toString(36).slice(2, 7)}`;
  const screenshotDir = resolve(cwd, "screenshots", "browserbase", runId);
  const manifestPath = join(screenshotDir, "manifest.json");
  const manifest: Manifest = {
    runId,
    sessionId,
    startedAt: now(),
    screenshots: [],
  };
  await mkdir(screenshotDir, { recursive: true });
  await writeJsonAtomically(manifestPath, manifest);
  return { runId, screenshotDir, manifestPath, manifest };
}

function isLocalhostUrl(url: URL) {
  return ["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(url.hostname);
}

function inspectorUrl(sessionId: string) {
  return `https://browserbase.com/sessions/${encodeURIComponent(sessionId)}`;
}

export async function resolveLocator(
  page: Page,
  spec: LocatorSpec,
  options: { allowMany?: boolean } = {},
) {
  let locator: Locator;
  if (spec.ref) {
    locator = page.locator(
      `[data-pi-bb-ref="${spec.ref.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`,
    );
  } else if (spec.role) {
    locator = page.getByRole(
      spec.role as Parameters<Page["getByRole"]>[0],
      spec.name ? { name: spec.name, exact: spec.exact } : undefined,
    );
  } else if (spec.label) {
    locator = page.getByLabel(spec.label, { exact: spec.exact });
  } else if (spec.testId) {
    locator = page.getByTestId(spec.testId);
  } else if (spec.placeholder) {
    locator = page.getByPlaceholder(spec.placeholder, { exact: spec.exact });
  } else if (spec.text) {
    locator = page.getByText(spec.text, { exact: spec.exact ?? false });
  } else {
    const css = spec.css ?? spec.target;
    if (!css)
      throw new Error(
        "Provide ref, role/name, label, testId, placeholder, text, or css.",
      );
    locator = page.locator(css);
  }

  const count = await locator.count();
  if (options.allowMany || count === 1) return locator;
  const candidates = (
    await locator.evaluateAll((elements) =>
      elements.slice(0, 8).map((element) => {
        const html = element as HTMLElement;
        const role =
          element.getAttribute("role") ?? element.tagName.toLowerCase();
        const name =
          element.getAttribute("aria-label") ??
          element.textContent?.replace(/\s+/g, " ").trim().slice(0, 100) ??
          "";
        const visible = Boolean(
          html.offsetWidth ||
          html.offsetHeight ||
          element.getClientRects().length,
        );
        return `${role}${name ? ` ${JSON.stringify(name)}` : ""} (${visible ? "visible" : "hidden"})`;
      }),
    )
  ).map(redactSecrets);
  if (count === 0)
    throw new Error(
      `No element matched ${redactSecrets(locatorDescription(spec))}. Inspect the page with browser_snapshot and try a semantic locator.`,
    );
  throw new Error(
    `Ambiguous ${redactSecrets(locatorDescription(spec))}: ${count} matches. Candidates: ${candidates.join("; ")}`,
  );
}

async function pageSummary(page: Page) {
  const title = await page.title().catch(() => "");
  const headings = await page
    .locator("h1,h2,h3")
    .allTextContents()
    .catch(() => [] as string[]);
  const body = await page
    .locator("body")
    .innerText()
    .catch(() => "");
  const headingText = headings
    .map((heading) => publicText(heading, 120))
    .filter(Boolean)
    .slice(0, 5)
    .join(" | ");
  return `Headings: ${headingText || "(none)"}\nVisible text: ${publicText(body) || "(none)"}`;
}

async function attachSnapshotRefs(page: Page) {
  await page.locator("body").evaluate((body) => {
    for (const element of body.querySelectorAll("[data-pi-bb-ref]"))
      element.removeAttribute("data-pi-bb-ref");
    const selector = [
      "a",
      "button",
      "input",
      "textarea",
      "select",
      "summary",
      "[contenteditable=true]",
      "[role=button]",
      "[role=checkbox]",
      "[role=combobox]",
      "[role=dialog]",
      "[role=alert]",
      "[role=link]",
      "[role=radio]",
      "[role=tab]",
      "[role=menuitem]",
      "[role=option]",
      "[role=navigation]",
      "[role=banner]",
      "[role=main]",
      "[role=form]",
      "[role=region]",
      "[role=heading]",
    ].join(",");
    Array.from(body.querySelectorAll(selector)).forEach((element, index) => {
      element.setAttribute("data-pi-bb-ref", `e${index + 1}`);
    });
  });
}

async function snapshot(
  page: Page,
  options: {
    maxChars?: number;
    scope?: string;
    interactiveOnly?: boolean;
  } = {},
) {
  await attachSnapshotRefs(page);
  const root =
    options.scope && options.scope !== "page"
      ? page.locator(options.scope).first()
      : page.locator("body");
  const title = await page.title().catch(() => "");
  const items = await root.locator("[data-pi-bb-ref]").evaluateAll((elements) =>
    elements.map((element) => {
      const html = element as HTMLElement;
      const tag = element.tagName.toLowerCase();
      const role =
        element.getAttribute("role") ??
        {
          a: "link",
          button: "button",
          input: "textbox",
          select: "combobox",
          textarea: "textbox",
        }[tag] ??
        tag;
      const name =
        element.getAttribute("aria-label") ??
        element.getAttribute("name") ??
        element.textContent?.replace(/\s+/g, " ").trim().slice(0, 120) ??
        "";
      const href = tag === "a" ? element.getAttribute("href") : null;
      const visible = Boolean(
        html.offsetWidth ||
        html.offsetHeight ||
        element.getClientRects().length,
      );
      const disabled =
        html.matches(":disabled") ||
        element.getAttribute("aria-disabled") === "true";
      const checked =
        html.matches(":checked") ||
        element.getAttribute("aria-checked") === "true";
      const expanded = element.getAttribute("aria-expanded");
      const selected =
        html.matches(":checked") ||
        element.getAttribute("aria-selected") === "true";
      const type = element.getAttribute("type");
      return {
        ref: element.getAttribute("data-pi-bb-ref"),
        tag,
        role,
        name,
        visible,
        disabled,
        checked,
        selected,
        expanded,
        type,
        href,
      };
    }),
  );
  const filtered = options.interactiveOnly
    ? items.filter((item) => item.visible)
    : items;
  const lines = filtered.map((item) => {
    const states = [
      item.visible ? "visible" : "hidden",
      item.disabled ? "disabled" : "enabled",
      item.checked ? "checked" : "",
      item.selected ? "selected" : "",
      item.expanded ? `expanded=${item.expanded}` : "",
    ]
      .filter(Boolean)
      .join(", ");
    const name = publicText(item.name, 160);
    const href = item.href ? publicLink(item.href, page.url()) : "";
    return `[${item.ref}] ${item.role}${item.type ? ` type=${item.type}` : ""}${name ? ` ${JSON.stringify(name)}` : ""}${href ? ` href=${JSON.stringify(href)}` : ""} (${states})`;
  });
  const aria = await root
    .ariaSnapshot({ timeout: 10_000 })
    .catch(() => "(ARIA snapshot unavailable)");
  const headings = await root
    .locator("h1,h2,h3")
    .allTextContents()
    .catch(() => [] as string[]);
  const body = options.interactiveOnly
    ? ""
    : await root.innerText().catch(() => "");
  const output = [
    `URL: ${publicUrl(page.url())}`,
    `Title: ${publicTitle(title) || "(untitled)"}`,
    `Headings: ${
      headings
        .map((heading) => publicText(heading, 150))
        .filter(Boolean)
        .join(" | ") || "(none)"
    }`,
    `Visible text: ${publicText(body) || "(omitted; interactiveOnly=true)"}`,
    `Elements:\n${lines.join("\n") || "(none)"}`,
    `ARIA:\n${redactSecrets(aria ?? "(none)")}`,
  ].join("\n\n");
  return {
    text: truncate(output, options.maxChars ?? MAX_OUTPUT),
    refs: filtered
      .map((item) => item.ref)
      .filter((ref): ref is string => Boolean(ref)),
    title,
  };
}

export class BrowserController {
  private runtime: Runtime | undefined;
  private startPromise: Promise<Runtime> | undefined;
  private readonly diagnostics = {
    console: [] as LogEntry[],
    pageErrors: [] as LogEntry[],
    failedRequests: [] as LogEntry[],
    httpErrors: [] as LogEntry[],
    navigations: [] as NavigationEntry[],
  };
  private screenshotSequence = 0;
  private screenshotStateChanged = true;
  private readonly attachedPages = new WeakSet<Page>();

  private retain(list: LogEntry[], entry: LogEntry) {
    boundedAppend(list, entry);
  }

  private currentPage() {
    const page = this.runtime?.page;
    if (!page || page.isClosed())
      throw new Error(
        "No active Browserbase page. Call browser_session with action=start.",
      );
    return page;
  }

  getPage() {
    return this.currentPage();
  }

  getRuntime() {
    return this.runtime;
  }

  private async attachPage(page: Page) {
    if (this.attachedPages.has(page)) return;
    this.attachedPages.add(page);
    page.setDefaultTimeout(DEFAULT_ACTION_TIMEOUT);
    page.setDefaultNavigationTimeout(DEFAULT_NAVIGATION_TIMEOUT);
    page.on("console", (message) => {
      if (!["warning", "error"].includes(message.type())) return;
      this.retain(this.diagnostics.console, {
        timestamp: now(),
        type: message.type(),
        message: publicText(message.text(), MAX_LOG_TEXT),
      });
    });
    page.on("pageerror", (error) => {
      this.retain(this.diagnostics.pageErrors, {
        timestamp: now(),
        message: publicText(error.message, MAX_LOG_TEXT),
      });
    });
    page.on("requestfailed", (request) => {
      this.retain(this.diagnostics.failedRequests, {
        timestamp: now(),
        url: publicUrl(request.url()),
        method: request.method(),
        resourceType: request.resourceType(),
        message: publicText(
          request.failure()?.errorText ?? "request failed",
          MAX_LOG_TEXT,
        ),
      });
    });
    page.on("response", (response) => {
      if (response.status() < 400) return;
      this.retain(this.diagnostics.httpErrors, {
        timestamp: now(),
        url: publicUrl(response.url()),
        status: response.status(),
        method: response.request().method(),
      });
    });
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      const url = publicUrl(frame.url());
      this.retain(this.diagnostics.navigations, {
        timestamp: now(),
        url,
        title: undefined,
      });
      this.screenshotStateChanged = true;
    });
    page.on("close", () => {
      if (this.runtime?.page === page) {
        this.runtime.page = this.runtime.context.pages().at(-1) ?? page;
      }
    });
  }

  private async makeManifest(cwd: string, session: SessionCreateResponse) {
    return createScreenshotRun(cwd, session.id);
  }

  private async persistManifest() {
    if (!this.runtime) return;
    this.runtime.manifest.endedAt = now();
    await writeJsonAtomically(this.runtime.manifestPath, this.runtime.manifest);
  }

  async liveUrls(signal?: AbortSignal) {
    if (!this.runtime) throw new Error("No active Browserbase session.");
    const urls = await this.runtime.client.sessions.debug(
      this.runtime.session.id,
      { expiresIn: 3_600 },
      { signal },
    );
    return {
      liveViewUrl: urls.debuggerFullscreenUrl || urls.debuggerUrl,
      sessionInspectorUrl: inspectorUrl(this.runtime.session.id),
    };
  }

  async start(
    options: StartOptions = {},
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<ToolDetails>,
    cwd = process.cwd(),
  ) {
    if (this.runtime) return this.runtime;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.createRuntime(
      options,
      signal,
      onUpdate,
      cwd,
    ).finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  private async createRuntime(
    options: StartOptions,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<ToolDetails>,
    cwd = process.cwd(),
  ) {
    throwIfAborted(signal);
    const apiKey = process.env.BROWSERBASE_API_KEY?.trim();
    if (!apiKey)
      throw new Error(
        "Browserbase is not configured. Set BROWSERBASE_API_KEY in the environment, then reload Pi.",
      );
    const config = {
      ...readConfiguration(),
      ...options,
      viewport: { ...readConfiguration().viewport, ...options.viewport },
    };
    const client = new Browserbase({ apiKey });
    progress(onUpdate, "Creating Browserbase session…");
    let session: SessionCreateResponse;
    try {
      session = await client.sessions.create(
        {
          projectId: process.env.BROWSERBASE_PROJECT_ID || undefined,
          api_timeout: config.timeout,
          region: config.region,
          proxies: config.proxy,
          keepAlive: config.keepAlive,
          browserSettings: { viewport: config.viewport },
          userMetadata: config.userMetadata,
        },
        { signal },
      );
    } catch (error) {
      const message = errorMessage(error);
      if (/browser minutes limit|payment required|402/i.test(message)) {
        throw new Error(
          "Browserbase session creation failed: the account has reached its browser-minute limit. Upgrade the Browserbase plan or wait for the limit to reset.",
        );
      }
      throw new Error(`Browserbase session creation failed: ${message}`);
    }
    let browser: Browser | undefined;
    try {
      progress(onUpdate, "Connecting to Browserbase over CDP…");
      browser = await chromium.connectOverCDP(session.connectUrl);
      const context = browser.contexts()[0] ?? (await browser.newContext());
      const page = context.pages()[0] ?? (await context.newPage());
      const manifest = await this.makeManifest(cwd, session);
      this.runtime = { client, session, browser, context, page, ...manifest };
      context.on("page", (newPage) => {
        void this.attachPage(newPage);
        if (this.runtime) this.runtime.page = newPage;
      });
      for (const existingPage of context.pages())
        await this.attachPage(existingPage);
      this.screenshotStateChanged = true;
      return this.runtime;
    } catch (error) {
      await browser?.close().catch(() => undefined);
      await client.sessions
        .update(
          session.id,
          { status: "REQUEST_RELEASE", projectId: session.projectId },
          { signal: signal?.aborted ? undefined : signal },
        )
        .catch(() => undefined);
      throw new Error(`Browserbase connection failed: ${errorMessage(error)}`);
    }
  }

  async status(signal?: AbortSignal) {
    if (!this.runtime) return undefined;
    const session = await this.runtime.client.sessions.retrieve(
      this.runtime.session.id,
      { signal },
    );
    this.runtime.session = { ...this.runtime.session, ...session };
    const live = await this.liveUrls(signal);
    return { session, ...live, page: this.runtime.page };
  }

  async stop(signal?: AbortSignal) {
    const runtime = this.runtime;
    if (!runtime)
      return {
        released: false,
        screenshots: [] as ManifestScreenshot[],
        screenshotDir: undefined,
        manifestPath: undefined,
      };
    this.runtime = undefined;
    const pageCloseErrors = await Promise.all(
      runtime.context
        .pages()
        .map((page) => page.close().catch((error) => errorMessage(error))),
    );
    const closeError = await runtime.browser
      .close()
      .then(() => pageCloseErrors.filter(Boolean).join("; ") || undefined)
      .catch((error) =>
        [pageCloseErrors.filter(Boolean).join("; "), errorMessage(error)]
          .filter(Boolean)
          .join("; "),
      );
    let releaseError: string | undefined;
    try {
      await runtime.client.sessions.update(
        runtime.session.id,
        { status: "REQUEST_RELEASE", projectId: runtime.session.projectId },
        { signal: signal?.aborted ? undefined : signal },
      );
    } catch (error) {
      releaseError = errorMessage(error);
    }
    runtime.manifest.endedAt = now();
    await writeJsonAtomically(runtime.manifestPath, runtime.manifest).catch(
      () => undefined,
    );
    if (closeError || releaseError)
      throw new Error(
        `Browserbase cleanup completed with warning: ${[closeError, releaseError].filter(Boolean).join("; ")}`,
      );
    return {
      released: true,
      screenshots: runtime.manifest.screenshots,
      screenshotDir: runtime.screenshotDir,
      manifestPath: runtime.manifestPath,
    };
  }

  async navigate(
    urlValue: string,
    waitUntil: "load" | "domcontentloaded" | "networkidle",
    timeout: number,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<ToolDetails>,
  ) {
    const url = validateUrl(urlValue);
    if (isLocalhostUrl(url))
      throw new Error(
        "Browserbase cloud browsers cannot ordinarily reach localhost. Configure a supported tunnel or use a publicly reachable preview URL.",
      );
    const page = this.currentPage();
    progress(onUpdate, `Navigating to ${publicUrl(url.toString())}…`);
    throwIfAborted(signal);
    const started = Date.now();
    try {
      const response = await page.goto(url.toString(), { waitUntil, timeout });
      const title = await page.title().catch(() => "");
      const navigation = this.diagnostics.navigations.at(-1);
      if (navigation) {
        navigation.title = publicTitle(title);
        navigation.status = response?.status();
      }
      this.screenshotStateChanged = true;
      return {
        requestedUrl: publicUrl(url.toString()),
        finalUrl: publicUrl(page.url()),
        title: publicTitle(title),
        status: response?.status(),
        durationMs: Date.now() - started,
        summary: await pageSummary(page),
      };
    } catch (error) {
      const message = errorMessage(error);
      this.retain(this.diagnostics.navigations, {
        timestamp: now(),
        url: publicUrl(page.url()),
        error: message,
      });
      throw new Error(
        `Navigation failed for ${publicUrl(url.toString())}: ${message}`,
      );
    }
  }

  private async maybeNewTab(before: Page[]) {
    const pages = this.runtime?.context.pages() ?? [];
    const opened = pages.find((page) => !before.includes(page));
    if (opened) {
      await this.attachPage(opened);
      if (this.runtime) this.runtime.page = opened;
      await wait(250).catch(() => undefined);
    }
    return opened;
  }

  async act(
    action: string,
    spec: LocatorSpec,
    params: Record<string, unknown>,
    timeout: number,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<ToolDetails>,
  ) {
    const page = this.currentPage();
    const before = this.runtime?.context.pages() ?? [];
    const started = Date.now();
    throwIfAborted(signal);
    progress(onUpdate, `Performing browser action: ${action}…`);
    let locator: Locator | undefined;
    if (
      !["wait", "switch_tab", "close_tab"].includes(action) &&
      (action !== "scroll" ||
        spec.ref ||
        spec.role ||
        spec.label ||
        spec.placeholder ||
        spec.testId ||
        spec.text ||
        spec.css ||
        spec.target)
    )
      locator = await resolveLocator(page, spec);
    switch (action) {
      case "click":
        await locator!.click({
          button:
            (params.button as "left" | "right" | "middle" | undefined) ??
            "left",
          timeout,
        });
        break;
      case "fill":
        await locator!.fill(String(params.text ?? ""), { timeout });
        break;
      case "type":
        await locator!.pressSequentially(String(params.text ?? ""), {
          timeout,
        });
        break;
      case "press":
        await locator!.press(String(params.key ?? "Enter"), { timeout });
        break;
      case "select": {
        const value = params.value
          ? { value: String(params.value) }
          : { label: String(params.optionLabel ?? "") };
        await locator!.selectOption(value, { timeout });
        break;
      }
      case "check":
        await locator!.check({ timeout });
        break;
      case "uncheck":
        await locator!.uncheck({ timeout });
        break;
      case "hover":
        await locator!.hover({ timeout });
        break;
      case "focus":
        await locator!.focus({ timeout });
        break;
      case "clear":
        await locator!.fill("", { timeout });
        break;
      case "scroll":
        if (locator)
          await locator.evaluate(
            (element, offsets) => element.scrollBy(offsets.x, offsets.y),
            { x: Number(params.x ?? 0), y: Number(params.y ?? 700) },
          );
        else
          await page.mouse.wheel(
            Number(params.x ?? 0),
            Number(params.y ?? 700),
          );
        break;
      case "wait": {
        if (params.ms !== undefined)
          await wait(Math.min(120_000, Math.max(0, Number(params.ms))), signal);
        else if (params.state)
          await page.waitForLoadState(
            params.state as "load" | "domcontentloaded" | "networkidle",
            { timeout },
          );
        else if (params.url)
          await page.waitForURL(String(params.url), { timeout });
        else if (
          spec.ref ||
          spec.role ||
          spec.label ||
          spec.placeholder ||
          spec.testId ||
          spec.text ||
          spec.css ||
          spec.target
        )
          await resolveLocator(page, spec).then((item) =>
            item.waitFor({ state: "visible", timeout }),
          );
        else await wait(1_000, signal);
        break;
      }
      case "switch_tab": {
        const index = Number(params.index);
        const pages = this.runtime?.context.pages() ?? [];
        if (!Number.isInteger(index) || index < 0 || index >= pages.length)
          throw new Error(`Invalid tab index. Open tabs: ${pages.length}.`);
        if (this.runtime) this.runtime.page = pages[index];
        break;
      }
      case "close_tab": {
        await page.close();
        const pages = this.runtime?.context.pages() ?? [];
        if (this.runtime) this.runtime.page = pages.at(-1) ?? page;
        break;
      }
      default:
        throw new Error(`Unsupported browser action: ${action}`);
    }
    await page
      .waitForLoadState("domcontentloaded", {
        timeout: Math.min(timeout, 10_000),
      })
      .catch(() => undefined);
    const opened = await this.maybeNewTab(before);
    this.screenshotStateChanged = true;
    const active = this.currentPage();
    return {
      action,
      durationMs: Date.now() - started,
      url: publicUrl(active.url()),
      title: publicTitle(await active.title().catch(() => "")),
      newTab: Boolean(opened),
      summary: (await snapshot(active, { maxChars: 8_000 })).text,
    };
  }

  async captureScreenshot(
    cwd: string,
    options: {
      fullPage?: boolean;
      label?: string;
      reason?: string;
      status?: ScreenshotStatus;
      spec?: LocatorSpec;
      mask?: string[];
      relatedAction?: string;
    },
    signal?: AbortSignal,
  ) {
    const runtime = this.runtime;
    if (!runtime)
      throw new Error(
        "No active Browserbase session. Call browser_session with action=start.",
      );
    const page = this.currentPage();
    throwIfAborted(signal);
    const label = sanitizeFilename(options.label ?? "page");
    const filename = `${String(++this.screenshotSequence).padStart(2, "0")}-${label}-${timestampForFilename()}.png`;
    const absolutePath = join(runtime.screenshotDir, filename);
    const target =
      options.spec &&
      (options.spec.ref ||
        options.spec.role ||
        options.spec.label ||
        options.spec.placeholder ||
        options.spec.testId ||
        options.spec.text ||
        options.spec.css ||
        options.spec.target)
        ? await resolveLocator(page, options.spec)
        : undefined;
    const masks = [
      page.locator(
        'input[type="password"], input[autocomplete*="password" i], input[autocomplete="one-time-code"]',
      ),
      ...(options.mask?.length ? [page.locator(options.mask.join(","))] : []),
    ];
    const bytes = target
      ? await target.screenshot({
          path: absolutePath,
          type: "png",
          mask: masks,
        })
      : await page.screenshot({
          path: absolutePath,
          type: "png",
          fullPage: options.fullPage ?? false,
          mask: masks,
        });
    const title = await page.title().catch(() => "");
    const viewport = page.viewportSize();
    const dimensions = target
      ? await target
          .boundingBox()
          .then((box) =>
            box
              ? { width: Math.round(box.width), height: Math.round(box.height) }
              : undefined,
          )
      : undefined;
    const entry: ManifestScreenshot = {
      sequence: this.screenshotSequence,
      filename,
      repositoryPath: relative(cwd, absolutePath),
      absolutePath,
      capturedAt: now(),
      url: publicUrl(page.url()),
      title: publicTitle(title),
      viewport,
      reason: options.reason ?? "manual screenshot",
      relatedAction: options.relatedAction,
      status: options.status ?? "success",
      sessionId: runtime.session.id,
      sessionInspectorUrl: inspectorUrl(runtime.session.id),
      dimensions,
    };
    runtime.manifest.endedAt = undefined;
    runtime.manifest.screenshots.push(entry);
    await this.persistManifest();
    this.screenshotStateChanged = false;
    const text = `Captured "${options.label ?? "page"}". ${options.reason ?? "Rendered browser state captured."}\nScreenshot: ${entry.repositoryPath}\nAbsolute path: ${absolutePath}\nStatus: ${entry.status}\nManifest: ${runtime.manifestPath}`;
    return { entry, bytes, text };
  }

  async diagnosticsSnapshot(signal?: AbortSignal) {
    throwIfAborted(signal);
    const runtime = this.runtime;
    if (!runtime) throw new Error("No active Browserbase session.");
    const page = this.currentPage();
    const tabs = await Promise.all(
      runtime.context.pages().map(async (item, index) => ({
        index,
        url: publicUrl(item.url()),
        title: publicTitle(await item.title().catch(() => "")),
        active: item === page,
        closed: item.isClosed(),
      })),
    );
    return {
      sessionId: runtime.session.id,
      ...(await this.liveUrls(signal)),
      current: {
        url: publicUrl(page.url()),
        title: publicTitle(await page.title().catch(() => "")),
      },
      tabs,
      console: this.diagnostics.console,
      pageErrors: this.diagnostics.pageErrors,
      failedRequests: this.diagnostics.failedRequests,
      httpErrors: this.diagnostics.httpErrors,
      navigations: this.diagnostics.navigations,
      screenshotDir: runtime.screenshotDir,
      manifestPath: runtime.manifestPath,
      screenshots: runtime.manifest.screenshots,
    };
  }

  async assert(
    type: string,
    expected: string | number | boolean,
    spec: LocatorSpec,
    timeout: number,
    cwd: string,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<ToolDetails>,
  ) {
    const page = this.currentPage();
    const started = Date.now();
    let actual: string | number | boolean = "(not evaluated)";
    let passed = false;
    progress(onUpdate, `Checking browser assertion: ${type}…`);
    const deadline = Date.now() + timeout;
    let evaluationError: string | undefined;
    const check = async () => {
      switch (type) {
        case "url_equals":
          actual = page.url();
          passed = actual === expected;
          break;
        case "url_contains":
          actual = page.url();
          passed = actual.includes(String(expected));
          break;
        case "title_equals":
          actual = await page.title();
          passed = actual === expected;
          break;
        case "title_contains":
          actual = await page.title();
          passed = actual.includes(String(expected));
          break;
        case "visible_text":
          actual = await page
            .getByText(String(expected), { exact: false })
            .count();
          passed =
            actual > 0 &&
            (await page
              .getByText(String(expected), { exact: false })
              .evaluateAll((items) =>
                items.some((item) => {
                  const html = item as HTMLElement;
                  return Boolean(
                    html.offsetWidth ||
                    html.offsetHeight ||
                    item.getClientRects().length,
                  );
                }),
              ));
          break;
        case "hidden_text":
          actual = await page
            .getByText(String(expected), { exact: false })
            .count();
          passed =
            actual === 0 ||
            !(await page
              .getByText(String(expected), { exact: false })
              .evaluateAll((items) =>
                items.some((item) => {
                  const html = item as HTMLElement;
                  return Boolean(
                    html.offsetWidth ||
                    html.offsetHeight ||
                    item.getClientRects().length,
                  );
                }),
              ));
          break;
        case "visible":
          actual = await (await resolveLocator(page, spec)).isVisible();
          passed = actual === expected;
          break;
        case "hidden":
          actual = !(await (await resolveLocator(page, spec)).isVisible());
          passed = actual === expected;
          break;
        case "enabled":
          actual = await (await resolveLocator(page, spec)).isEnabled();
          passed = actual === expected;
          break;
        case "disabled":
          actual = !(await (await resolveLocator(page, spec)).isEnabled());
          passed = actual === expected;
          break;
        case "checked":
          actual = await (await resolveLocator(page, spec)).isChecked();
          passed = actual === expected;
          break;
        case "unchecked":
          actual = !(await (await resolveLocator(page, spec)).isChecked());
          passed = actual === expected;
          break;
        case "value":
          actual = "[redacted form value]";
          passed =
            (await (await resolveLocator(page, spec)).inputValue()) ===
            String(expected);
          break;
        case "element_text":
          actual = publicText(
            await (await resolveLocator(page, spec)).innerText(),
            300,
          );
          passed = actual.includes(String(expected));
          break;
        case "count":
          actual = await (
            await resolveLocator(page, spec, { allowMany: true })
          ).count();
          passed = actual === expected;
          break;
        default:
          throw new Error(`Unsupported assertion: ${type}`);
      }
    };
    try {
      do {
        throwIfAborted(signal);
        await check();
        if (passed || Date.now() >= deadline) break;
        await wait(100, signal);
      } while (!passed);
    } catch (error) {
      if (signal?.aborted) throw error;
      evaluationError = errorMessage(error);
      actual = evaluationError;
      passed = false;
    }
    const safeExpected =
      type === "value"
        ? "[redacted form value]"
        : typeof expected === "string"
          ? redactSecrets(expected)
          : expected;
    const result = {
      passed,
      assertion: type,
      expected: safeExpected,
      actual: evaluationError
        ? redactSecrets(String(actual))
        : type === "url_equals" || type === "url_contains"
          ? publicUrl(String(actual))
          : type === "value"
            ? "[redacted form value]"
            : actual,
      locator: redactSecrets(locatorDescription(spec)),
      error: evaluationError,
      durationMs: Date.now() - started,
      url: publicUrl(page.url()),
      title: publicTitle(await page.title().catch(() => "")),
      evidence: undefined as ManifestScreenshot | undefined,
      snapshot: undefined as string | undefined,
      diagnostics: undefined as
        | {
            console: LogEntry[];
            pageErrors: LogEntry[];
            failedRequests: LogEntry[];
          }
        | undefined,
    };
    if (!passed) {
      let evidence:
        Awaited<ReturnType<BrowserController["captureScreenshot"]>> | undefined;
      try {
        evidence = await this.captureScreenshot(
          cwd,
          {
            label: `assertion-${type}-failure`,
            reason: `Evidence for failed ${type} assertion`,
            status: "failure",
            relatedAction: `browser_assert:${type}`,
            spec: undefined,
          },
          signal,
        );
      } catch (error) {
        if (signal?.aborted) throw error;
        /* Preserve the assertion failure if evidence capture fails. */
      }
      const pageSnapshot = await snapshot(page, { maxChars: 5_000 }).catch(
        () => ({ text: "(snapshot unavailable)" }),
      );
      return {
        ...result,
        evidence: evidence?.entry,
        snapshot: pageSnapshot.text,
        diagnostics: {
          console: this.diagnostics.console.slice(-5),
          pageErrors: this.diagnostics.pageErrors.slice(-5),
          failedRequests: this.diagnostics.failedRequests.slice(-5),
        },
      };
    }
    return result;
  }
}

const locatorSchema = Type.Object({
  ref: Type.Optional(
    Type.String({
      description: "Stable [eN] reference from browser_snapshot.",
    }),
  ),
  role: Type.Optional(
    StringEnum(ROLES, { description: "Accessible role, used with name." }),
  ),
  name: Type.Optional(Type.String({ description: "Accessible role name." })),
  label: Type.Optional(Type.String({ description: "Associated form label." })),
  testId: Type.Optional(Type.String({ description: "data-testid value." })),
  placeholder: Type.Optional(
    Type.String({ description: "Input placeholder." }),
  ),
  text: Type.Optional(
    Type.String({ description: "Visible text; partial by default." }),
  ),
  css: Type.Optional(Type.String({ description: "CSS fallback selector." })),
  target: Type.Optional(
    Type.String({ description: "Deprecated alias for css." }),
  ),
  exact: Type.Optional(Type.Boolean()),
});
const viewportSchema = Type.Object({
  width: Type.Optional(Type.Integer({ minimum: 320, maximum: 3840 })),
  height: Type.Optional(Type.Integer({ minimum: 240, maximum: 2160 })),
});
const waitSchema = StringEnum([
  "load",
  "domcontentloaded",
  "networkidle",
] as const);
const screenshotSchema = Type.Object({
  captureScreenshot: Type.Optional(Type.Boolean()),
  screenshotLabel: Type.Optional(Type.String()),
  screenshotReason: Type.Optional(Type.String()),
  fullPage: Type.Optional(Type.Boolean()),
});

export default function browserbaseExtension(pi: ExtensionAPI) {
  const controller = new BrowserController();
  const guidelines = [
    "Use browser_snapshot before browser_act on an unfamiliar page; prefer its stable references.",
    "Use browser_act with semantic role/name, label, test ID, or placeholder locators before CSS.",
    "Use browser_screenshot whenever visual appearance matters, and mention important screenshot paths in the response.",
    "Use browser_assert for testable outcomes and browser_diagnostics after unexpected behavior.",
    "Use browser_session with action=stop when browsing or testing is complete; never claim success without evidence.",
    "Browserbase cloud browsers cannot ordinarily reach localhost without a supported tunnel or public preview URL.",
  ];
  const common = {
    promptSnippet:
      "Use Browserbase cloud browser tools for inspection, semantic interaction, screenshots, assertions, and diagnostics.",
    promptGuidelines: guidelines,
  };

  pi.registerTool({
    name: "browser_session",
    label: "Browserbase Session",
    description:
      "Start, inspect, or stop one lazy Browserbase session for this Pi session.",
    ...common,
    parameters: Type.Object({
      action: StringEnum(["start", "status", "stop"] as const),
      timeout: Type.Optional(Type.Integer({ minimum: 60, maximum: 21_600 })),
      region: Type.Optional(StringEnum(REGIONS)),
      proxy: Type.Optional(Type.Boolean()),
      keepAlive: Type.Optional(Type.Boolean()),
      viewport: Type.Optional(viewportSchema),
      userMetadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      try {
        if (params.action === "stop") {
          const stopped = await controller.stop(signal);
          return textResult(
            `Browserbase session stopped. Released: ${stopped.released}\nScreenshot directory: ${stopped.screenshotDir ?? "none"}\nManifest: ${stopped.manifestPath ?? "none"}\nScreenshots: ${stopped.screenshots.map((item) => item.repositoryPath).join(", ") || "none"}`,
            stopped,
          );
        }
        const runtime =
          params.action === "start"
            ? await controller.start(
                {
                  timeout: params.timeout,
                  region: params.region,
                  proxy: params.proxy,
                  keepAlive: params.keepAlive,
                  viewport: params.viewport,
                  userMetadata: params.userMetadata,
                },
                signal,
                onUpdate,
                ctx.cwd,
              )
            : controller.getRuntime();
        if (!runtime)
          return textResult(
            "No active Browserbase session. Call browser_session with action=start.",
            { active: false },
          );
        const current = await controller.status(signal);
        const page = current?.page ?? runtime.page;
        const details = {
          active: true,
          status: current?.session.status ?? runtime.session.status,
          sessionId: runtime.session.id,
          pageUrl: publicUrl(page.url()),
          pageTitle: publicTitle(await page.title().catch(() => "")),
          runId: runtime.runId,
          screenshotDir: runtime.screenshotDir,
          manifestPath: runtime.manifestPath,
          liveViewUrl: current?.liveViewUrl,
          sessionInspectorUrl:
            current?.sessionInspectorUrl ?? inspectorUrl(runtime.session.id),
          keepAlive: runtime.session.keepAlive,
        };
        return textResult(
          `Browserbase session ${params.action === "start" ? "ready" : "status"}.\nSession ID: ${details.sessionId}\nStatus: ${details.status}\nPage: ${details.pageUrl}\nTitle: ${details.pageTitle || "(untitled)"}\nLive View: ${details.liveViewUrl ?? "unavailable"}\nSession Inspector: ${details.sessionInspectorUrl}\nScreenshot directory: ${details.screenshotDir}\nManifest: ${details.manifestPath}`,
          details,
        );
      } catch (error) {
        throw new Error(errorMessage(error));
      }
    },
  });

  pi.registerTool({
    name: "browser_navigate",
    label: "Browserbase Navigate",
    description:
      "Navigate the active Browserbase page to an explicitly requested HTTP(S) URL.",
    ...common,
    parameters: Type.Intersect([
      Type.Object({
        url: Type.String(),
        waitUntil: Type.Optional(waitSchema),
        timeout: Type.Optional(
          Type.Integer({ minimum: 1_000, maximum: 180_000 }),
        ),
      }),
      screenshotSchema,
    ]),
    async execute(_id, params, signal, onUpdate, ctx) {
      validateUrl(params.url);
      await controller.start({}, signal, onUpdate, ctx.cwd);
      const result = await controller.navigate(
        params.url,
        params.waitUntil ?? "domcontentloaded",
        params.timeout ?? DEFAULT_NAVIGATION_TIMEOUT,
        signal,
        onUpdate,
      );
      let screenshot:
        Awaited<ReturnType<BrowserController["captureScreenshot"]>> | undefined;
      if (params.captureScreenshot !== false)
        screenshot = await controller.captureScreenshot(
          ctx.cwd,
          {
            fullPage: params.fullPage,
            label: params.screenshotLabel ?? "navigation",
            reason:
              params.screenshotReason ?? "Initial or navigated page state",
            status: "success",
            relatedAction: "browser_navigate",
          },
          signal,
        );
      return textResult(
        `Navigated.\nRequested URL: ${result.requestedUrl}\nFinal URL: ${result.finalUrl}\nTitle: ${result.title || "(untitled)"}\nHTTP status: ${result.status ?? "unavailable"}\n${result.summary}${screenshot ? `\n${screenshot.text}` : ""}`,
        { ...result, screenshot: screenshot?.entry },
      );
    },
  });

  pi.registerTool({
    name: "browser_snapshot",
    label: "Browserbase Snapshot",
    description:
      "Return compact ARIA and model-friendly page information with stable references.",
    ...common,
    parameters: Type.Object({
      scope: Type.Optional(
        Type.String({ description: "page or a CSS selector scope." }),
      ),
      maxChars: Type.Optional(
        Type.Integer({ minimum: 1_000, maximum: 30_000 }),
      ),
      interactiveOnly: Type.Optional(Type.Boolean()),
      captureScreenshot: Type.Optional(Type.Boolean()),
      screenshotLabel: Type.Optional(Type.String()),
      screenshotReason: Type.Optional(Type.String()),
      fullPage: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      throwIfAborted(signal);
      await controller.start({}, signal, undefined, ctx.cwd);
      const page = controller.getPage();
      const result = await snapshot(page, params);
      let screenshot:
        Awaited<ReturnType<BrowserController["captureScreenshot"]>> | undefined;
      if (params.captureScreenshot)
        screenshot = await controller.captureScreenshot(
          ctx.cwd,
          {
            fullPage: params.fullPage,
            label: params.screenshotLabel ?? "snapshot",
            reason: params.screenshotReason ?? "Page inspection evidence",
            status: "debugging",
            relatedAction: "browser_snapshot",
          },
          signal,
        );
      return textResult(
        result.text + (screenshot ? `\n\n${screenshot.text}` : ""),
        {
          url: publicUrl(page.url()),
          title: publicTitle(result.title),
          refs: result.refs,
          screenshot: screenshot?.entry,
        },
      );
    },
  });

  pi.registerTool({
    name: "browser_act",
    label: "Browserbase Act",
    description:
      "Perform a deterministic Playwright UI action using a stable reference or semantic locator.",
    ...common,
    parameters: Type.Intersect([
      Type.Object({
        action: StringEnum([
          "click",
          "fill",
          "type",
          "press",
          "select",
          "check",
          "uncheck",
          "hover",
          "scroll",
          "wait",
          "focus",
          "clear",
          "switch_tab",
          "close_tab",
        ] as const),
        text: Type.Optional(Type.String()),
        key: Type.Optional(Type.String()),
        value: Type.Optional(Type.String()),
        optionLabel: Type.Optional(Type.String()),
        button: Type.Optional(StringEnum(["left", "right", "middle"] as const)),
        x: Type.Optional(Type.Number()),
        y: Type.Optional(Type.Number()),
        ms: Type.Optional(Type.Number({ minimum: 0, maximum: 120_000 })),
        state: Type.Optional(waitSchema),
        url: Type.Optional(Type.String()),
        index: Type.Optional(Type.Integer({ minimum: 0 })),
        timeout: Type.Optional(
          Type.Integer({ minimum: 1_000, maximum: 180_000 }),
        ),
      }),
      locatorSchema,
      screenshotSchema,
    ]),
    async execute(_id, params, signal, onUpdate, ctx) {
      await controller.start({}, signal, onUpdate, ctx.cwd);
      const significant = [
        "click",
        "fill",
        "type",
        "press",
        "select",
        "check",
        "uncheck",
        "close_tab",
      ].includes(params.action);
      let beforeScreenshot:
        Awaited<ReturnType<BrowserController["captureScreenshot"]>> | undefined;
      if (significant && params.captureScreenshot !== false)
        beforeScreenshot = await controller.captureScreenshot(
          ctx.cwd,
          {
            fullPage: params.fullPage,
            label: params.screenshotLabel
              ? `before-${params.screenshotLabel}`
              : `before-${params.action}`,
            reason: "Before significant browser interaction",
            status: "debugging",
            relatedAction: `browser_act:${params.action}`,
          },
          signal,
        );
      const result = await controller.act(
        params.action,
        params,
        params,
        params.timeout ?? DEFAULT_ACTION_TIMEOUT,
        signal,
        onUpdate,
      );
      let screenshot:
        Awaited<ReturnType<BrowserController["captureScreenshot"]>> | undefined;
      if (significant && params.captureScreenshot !== false)
        screenshot = await controller.captureScreenshot(
          ctx.cwd,
          {
            fullPage: params.fullPage,
            label: params.screenshotLabel ?? `after-${params.action}`,
            reason:
              params.screenshotReason ?? `After ${params.action} interaction`,
            status: "evidence",
            relatedAction: `browser_act:${params.action}`,
          },
          signal,
        );
      return textResult(
        `Action complete: ${result.action}\nURL: ${result.url}\nTitle: ${result.title || "(untitled)"}\nNew tab: ${result.newTab}\nUpdated snapshot:\n${result.summary}${beforeScreenshot ? `\n\n${beforeScreenshot.text}` : ""}${screenshot ? `\n\n${screenshot.text}` : ""}`,
        {
          ...result,
          beforeScreenshot: beforeScreenshot?.entry,
          screenshot: screenshot?.entry,
        },
      );
    },
  });

  pi.registerTool({
    name: "browser_screenshot",
    label: "Browserbase Screenshot",
    description:
      "Capture and save a Browserbase page or element screenshot with a manifest entry and inline PNG.",
    ...common,
    parameters: Type.Intersect([
      Type.Object({
        fullPage: Type.Optional(Type.Boolean()),
        screenshotLabel: Type.Optional(Type.String()),
        screenshotReason: Type.Optional(Type.String()),
        status: Type.Optional(
          StringEnum(["success", "failure", "evidence", "debugging"] as const),
        ),
        mask: Type.Optional(Type.Array(Type.String())),
        relatedAction: Type.Optional(Type.String()),
      }),
      locatorSchema,
    ]),
    async execute(_id, params, signal, _onUpdate, ctx) {
      await controller.start({}, signal, undefined, ctx.cwd);
      const screenshot = await controller.captureScreenshot(
        ctx.cwd,
        {
          fullPage: params.fullPage,
          label: params.screenshotLabel,
          reason: params.screenshotReason,
          status: params.status,
          relatedAction: params.relatedAction,
          mask: params.mask,
          spec:
            params.ref ||
            params.role ||
            params.label ||
            params.testId ||
            params.placeholder ||
            params.text ||
            params.css ||
            params.target
              ? params
              : undefined,
        },
        signal,
      );
      return {
        content: [
          { type: "text", text: screenshot.text },
          {
            type: "image",
            data: screenshot.bytes.toString("base64"),
            mimeType: "image/png",
          },
        ],
        details: screenshot.entry,
      };
    },
  });

  pi.registerTool({
    name: "browser_assert",
    label: "Browserbase Assert",
    description:
      "Run a bounded deterministic UI assertion; failures capture evidence and a compact snapshot.",
    ...common,
    parameters: Type.Intersect([
      Type.Object({
        assertion: StringEnum([
          "url_equals",
          "url_contains",
          "title_equals",
          "title_contains",
          "visible_text",
          "hidden_text",
          "visible",
          "hidden",
          "enabled",
          "disabled",
          "checked",
          "unchecked",
          "value",
          "element_text",
          "count",
        ] as const),
        expected: Type.Union([Type.String(), Type.Number(), Type.Boolean()]),
        timeout: Type.Optional(
          Type.Integer({ minimum: 100, maximum: 120_000 }),
        ),
      }),
      locatorSchema,
    ]),
    async execute(_id, params, signal, onUpdate, ctx) {
      try {
        await controller.start({}, signal, onUpdate, ctx.cwd);
        const assertion = await controller.assert(
          params.assertion,
          params.expected,
          params,
          params.timeout ?? DEFAULT_ACTION_TIMEOUT,
          ctx.cwd,
          signal,
          onUpdate,
        );
        const outcome = assertion.passed ? "passed" : "FAILED";
        return textResult(
          `Assertion ${outcome}: ${assertion.assertion} (expected ${JSON.stringify(assertion.expected)}, actual ${JSON.stringify(assertion.actual)}) in ${assertion.durationMs}ms.${assertion.evidence ? `\nEvidence screenshot: ${assertion.evidence.repositoryPath}\nManifest: ${controller.getRuntime()?.manifestPath ?? "unavailable"}` : ""}${assertion.snapshot ? `\nSnapshot:\n${assertion.snapshot}` : ""}`,
          assertion,
        );
      } catch (error) {
        throw new Error(errorMessage(error));
      }
    },
  });

  pi.registerTool({
    name: "browser_diagnostics",
    label: "Browserbase Diagnostics",
    description:
      "Return bounded, redacted console, page, network, HTTP, navigation, tab, and screenshot diagnostics.",
    ...common,
    parameters: Type.Object({
      captureScreenshot: Type.Optional(Type.Boolean()),
      screenshotLabel: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      await controller.start({}, signal, undefined, ctx.cwd);
      const diagnostics = await controller.diagnosticsSnapshot(signal);
      let screenshot:
        Awaited<ReturnType<BrowserController["captureScreenshot"]>> | undefined;
      if (params.captureScreenshot)
        screenshot = await controller.captureScreenshot(
          ctx.cwd,
          {
            label: params.screenshotLabel ?? "diagnostics",
            reason: "Diagnostic evidence",
            status: "debugging",
            relatedAction: "browser_diagnostics",
          },
          signal,
        );
      const text = `Session: ${diagnostics.sessionId}\nCurrent: ${diagnostics.current.url} — ${diagnostics.current.title}\nTabs: ${diagnostics.tabs.map((tab) => `${tab.index}: ${tab.url}${tab.active ? " (active)" : ""}`).join(" | ")}\nConsole warnings/errors: ${diagnostics.console.length}\nPage errors: ${diagnostics.pageErrors.length}\nFailed requests: ${diagnostics.failedRequests.length}\nHTTP errors: ${diagnostics.httpErrors.length}\nRecent navigation: ${diagnostics.navigations.length}\nScreenshot directory: ${diagnostics.screenshotDir}\nManifest: ${diagnostics.manifestPath}\n\n${JSON.stringify({ console: diagnostics.console, pageErrors: diagnostics.pageErrors, failedRequests: diagnostics.failedRequests, httpErrors: diagnostics.httpErrors, navigations: diagnostics.navigations }, null, 2)}${screenshot ? `\n\n${screenshot.text}` : ""}`;
      return textResult(truncate(redactSecrets(text)), {
        ...diagnostics,
        screenshot: screenshot?.entry,
      });
    },
  });

  pi.registerCommand("browser-open", {
    description: "Start Browserbase and optionally navigate to an HTTP(S) URL",
    handler: async (args, ctx) => {
      try {
        if (args.trim()) validateUrl(args.trim());
        const runtime = await controller.start(
          {},
          undefined,
          undefined,
          ctx.cwd,
        );
        let screenshot:
          | Awaited<ReturnType<BrowserController["captureScreenshot"]>>
          | undefined;
        if (args.trim()) {
          await controller.navigate(
            args.trim(),
            "domcontentloaded",
            DEFAULT_NAVIGATION_TIMEOUT,
          );
          screenshot = await controller.captureScreenshot(ctx.cwd, {
            label: "browser-open",
            reason: "Initial state opened by /browser-open",
            status: "success",
            relatedAction: "browser-open",
          });
        }
        ctx.ui.notify(
          `Browserbase ready: ${publicUrl(runtime.page.url())}\nLive View: ${(await controller.liveUrls()).liveViewUrl}${screenshot ? `\nScreenshot: ${screenshot.entry.repositoryPath}` : ""}`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });
  pi.registerCommand("browser-status", {
    description: "Show Browserbase session and screenshot status",
    handler: async (_args, ctx) => {
      try {
        const diagnostics = await controller.diagnosticsSnapshot();
        ctx.ui.notify(
          `Browserbase ${diagnostics.sessionId}\n${diagnostics.current.url}\nLive View: ${diagnostics.liveViewUrl}\nScreenshots: ${diagnostics.screenshots.length}\nManifest: ${diagnostics.manifestPath}`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });
  pi.registerCommand("browser-screenshot", {
    description: "Save an important Browserbase screenshot",
    handler: async (args, ctx) => {
      try {
        const screenshot = await controller.captureScreenshot(ctx.cwd, {
          label: args.trim() || "important-state",
          reason: "Important state captured by /browser-screenshot",
          status: "evidence",
        });
        ctx.ui.notify(
          `${screenshot.text}\nImportant screenshot: ${screenshot.entry.repositoryPath}`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });
  pi.registerCommand("browser-close", {
    description: "Release Browserbase and report saved screenshots",
    handler: async (_args, ctx) => {
      try {
        const stopped = await controller.stop();
        ctx.ui.notify(
          `Browserbase closed. Screenshots: ${stopped.screenshots.map((item) => item.repositoryPath).join(", ") || "none"}\nManifest: ${stopped.manifestPath ?? "none"}`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });
  pi.on("session_shutdown", async () => {
    await controller.stop().catch(() => undefined);
  });
}
