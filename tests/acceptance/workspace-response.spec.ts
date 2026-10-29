import { expect, test, type Page } from "@playwright/test";
import { jobBoundaries } from "./support/workspace";

const projects = [{ id: "project-1", name: "Example project" }];
const jobs = [{ id: "job-1", projectId: "project-1" }];

test("jobBoundaries checks fetch and Playwright response status correctly", async () => {
  const playwrightResponse = (body: unknown, status = 200) => ({
    ok: () => status >= 200 && status < 300,
    status: () => status,
    json: async () => body,
  });
  const page = {
    request: {
      get: async (url: string) => url.endsWith("/projects")
        ? playwrightResponse(projects)
        : playwrightResponse(jobs),
    },
  } as unknown as Page;

  await expect(jobBoundaries("Example project", page)).resolves.toMatchObject({
    project: projects[0],
    job: jobs[0],
  });

  const failedPage = {
    request: {
      get: async (url: string) => url.endsWith("/projects")
        ? playwrightResponse(projects)
        : playwrightResponse({ detail: "unavailable" }, 503),
    },
  } as unknown as Page;
  await expect(jobBoundaries("Example project", failedPage)).rejects.toThrow("job lookup failed (503)");

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input) => new Response(
      JSON.stringify(String(input).endsWith("/projects") ? projects : jobs),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    await expect(jobBoundaries("Example project")).resolves.toMatchObject({ project: projects[0], job: jobs[0] });

    globalThis.fetch = async (input) => String(input).endsWith("/projects")
      ? new Response(JSON.stringify(projects), { status: 200 })
      : new Response(JSON.stringify({ detail: "unavailable" }), { status: 502 });
    await expect(jobBoundaries("Example project")).rejects.toThrow("job lookup failed (502)");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
