import { expect, test } from "@playwright/test";

function isExpectedRequestCancellation(resourceType: string, url: string, errorText: string): boolean {
  if (!["net::ERR_ABORTED", "Load request cancelled"].includes(errorText)) return false;
  if (resourceType === "media") return true;
  return resourceType === "eventsource" && /^\/api\/v1\/jobs\/[^/]+\/events$/.test(new URL(url).pathname);
}

test("request cancellation classification", () => {
  const jobUrl = "http://localhost/api/v1/jobs/123/events?watch=1";
  const cases: [string, string, string, boolean][] = [
    ["eventsource", jobUrl, "net::ERR_ABORTED", true],
    ["eventsource", jobUrl, "Load request cancelled", true],
    ["media", "http://localhost/video", "net::ERR_ABORTED", true],
    ["media", "http://localhost/video", "Load request cancelled", true],
    ["eventsource", jobUrl, "net::ERR_CONNECTION_RESET", false],
    ["eventsource", jobUrl, "", false],
    ["eventsource", "http://localhost/api/other", "net::ERR_ABORTED", false],
    ["eventsource", "http://localhost/api/v1/jobs/id/events/extra", "net::ERR_ABORTED", false],
    ["fetch", jobUrl, "net::ERR_ABORTED", false],
    ["xhr", jobUrl, "Load request cancelled", false],
    ["script", "http://localhost/app.js", "net::ERR_ABORTED", false],
    ["fetch", "http://localhost/api/data", "Load request cancelled", false],
    ["media", "http://localhost/video", "net::ERR_CONNECTION_RESET", false],
  ];
  for (const [resourceType, url, errorText, expected] of cases) {
    expect(isExpectedRequestCancellation(resourceType, url, errorText), `${resourceType} ${url} ${errorText}`).toBe(expected);
  }
});

const sections = [
  ["Projects", "Projects"],
  ["Library", "Library"],
  ["Workspace", /.+/],
  ["Shorts Editor", "Editor"],
  ["Jobs", "Jobs & recovery"],
  ["Settings", "Settings"],
] as const;

test("production sections load without client or request failures", async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  const badResponses: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    // Section changes intentionally tear down lazy media and Workspace
    // EventSource.close() subscriptions; other transport failures remain reportable.
    const errorText = request.failure()?.errorText || "";
    const expectedCancellation = isExpectedRequestCancellation(request.resourceType(), request.url(), errorText);
    if (!request.isNavigationRequest() && !expectedCancellation) requestFailures.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText || "failed"}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400 && response.request().resourceType() !== "document") badResponses.push(`${response.status()} ${response.url()}`);
  });

  await page.goto("/", { waitUntil: "networkidle" });
  for (const [name, heading] of sections) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.waitForTimeout(250);
  }

  expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
  expect(requestFailures, requestFailures.join("\n")).toEqual([]);
  expect(badResponses, badResponses.join("\n")).toEqual([]);
});
