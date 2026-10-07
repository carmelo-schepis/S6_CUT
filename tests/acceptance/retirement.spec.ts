import { expect, test } from "@playwright/test";
import { requireIsolatedTarget } from "./support/recent-clips";

function withoutSignedUrlExpiry(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSignedUrlExpiry);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => {
    if (["previewUrl", "downloadUrl", "url"].includes(key) && typeof nested === "string" && nested.startsWith("/api/")) {
      return [key, nested.split("?")[0]];
    }
    return [key, withoutSignedUrlExpiry(nested)];
  }));
}

test("retirement removes creation/navigation affordances without mutating profiles or legacy records", async ({ page, request }) => {
  const { base } = requireIsolatedTarget();
  const beforeProfiles = await request.get(`${base}/api/v1/profiles`);
  expect(beforeProfiles.ok()).toBeTruthy();
  const profilesBefore = await beforeProfiles.json();
  const beforeProjects = await request.get(`${base}/api/v1/projects`);
  const beforeJobs = await request.get(`${base}/api/v1/jobs`);
  expect(beforeProjects.ok()).toBeTruthy();
  expect(beforeJobs.ok()).toBeTruthy();
  const projectsBefore = await beforeProjects.json() as { id: string; mode: string }[];
  const jobsBefore = await beforeJobs.json() as { id: string; mode: string }[];

  await page.goto(base, { waitUntil: "networkidle" });
  await expect(page.getByRole("button", { name: "AI Video", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await expect(page.getByRole("button", { name: "Script mode", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Create script video/i })).toHaveCount(0);

  await page.getByRole("button", { name: "Open S6 Cut Help" }).click();
  const help = page.getByRole("dialog");
  await expect(help).toBeVisible();
  await expect(help).not.toContainText(/AI Video|Topic to Video|Script mode/i);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Jobs", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Jobs & recovery", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await expect(page.getByRole("button", { name: "Workspace", exact: true })).toHaveAttribute("aria-current", "page");
  for (const width of [1440, 375, 360]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.getByRole("button", { name: "AI Video", exact: true })).toHaveCount(0);
  }

  const profilesAfter = await request.get(`${base}/api/v1/profiles`);
  const projectsAfter = await request.get(`${base}/api/v1/projects`);
  const jobsAfter = await request.get(`${base}/api/v1/jobs`);
  expect(await profilesAfter.json()).toEqual(profilesBefore);
  expect(await projectsAfter.json()).toEqual(projectsBefore);
  expect(withoutSignedUrlExpiry(await jobsAfter.json())).toEqual(withoutSignedUrlExpiry(jobsBefore));

  // Historical rows remain readable; retirement is not a destructive migration.
  expect(Array.isArray(projectsBefore)).toBeTruthy();
  expect(Array.isArray(jobsBefore)).toBeTruthy();
  expect(projectsBefore.every((project) => typeof project.id === "string" && typeof project.mode === "string")).toBeTruthy();
  expect(jobsBefore.every((job) => typeof job.id === "string" && typeof job.mode === "string")).toBeTruthy();
  expect(JSON.stringify(profilesBefore)).not.toMatch(/sk-or-v1-[A-Za-z0-9]{20,}/);
});
