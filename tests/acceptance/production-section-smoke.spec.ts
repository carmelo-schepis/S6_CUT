import { expect, test } from "@playwright/test";

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
    // Route changes intentionally tear down distant lazy media. Those aborted
    // media fetches are covered separately by the bounded-preview regression;
    // this smoke check reports real non-navigation transport failures.
    const cancelledMedia = request.resourceType() === "media" && ["net::ERR_ABORTED", "Load request cancelled"].includes(request.failure()?.errorText || "");
    if (!request.isNavigationRequest() && !cancelledMedia) requestFailures.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText || "failed"}`);
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
