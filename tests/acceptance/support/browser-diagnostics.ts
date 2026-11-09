import type { Page, TestInfo } from "@playwright/test";

type BrowserDiagnostic = { kind: string; detail: string };

function redact(value: string): string {
  return value
    .replace(/(https?:\/\/[^\s?#]+)[^\s#]*/g, "$1?[redacted]")
    .replace(/([?&](?:signature|expires|token|key)=)[^&\s]+/gi, "$1[redacted]");
}

/** Record browser failures with media request paths but never signed query data. */
export function recordBrowserDiagnostics(page: Page, testInfo: TestInfo): () => Promise<void> {
  const events: BrowserDiagnostic[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") events.push({ kind: "console.error", detail: redact(message.text()) });
  });
  page.on("pageerror", (error) => events.push({ kind: "pageerror", detail: redact(`${error.name}: ${error.message}`) }));
  page.on("crash", () => events.push({ kind: "page.crash", detail: "Chromium page crashed" }));
  page.on("requestfailed", (request) => events.push({
    kind: "requestfailed",
    detail: redact(`${request.method()} ${request.url()} — ${request.failure()?.errorText || "unknown failure"}`),
  }));
  page.on("response", (response) => {
    if (response.status() >= 400) events.push({
      kind: "http.error",
      detail: redact(`${response.status()} ${response.request().method()} ${response.url()}`),
    });
  });
  return async () => {
    await testInfo.attach("browser-diagnostics.json", {
      body: Buffer.from(JSON.stringify(events, null, 2)),
      contentType: "application/json",
    });
  };
}
