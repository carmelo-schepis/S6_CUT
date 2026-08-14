import {
  assetSchema,
  healthSchema,
  jobSchema,
  profileSchema,
  projectSchema,
  type Health,
  type Job,
  type LibraryAsset,
  type MatchExplanation,
  type Project,
  type ProviderProfile,
  type Style,
} from "./types";

const API = "/api/v1";

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, init);
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { detail?: string; message?: string };
      message = body.detail || body.message || message;
    } catch {
      // Keep the bounded status-only message when a proxy returns non-JSON.
    }
    throw new ApiError(message, response.status);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export async function getHealth(): Promise<Health> {
  return healthSchema.parse(await request("/health"));
}

export async function listProjects(): Promise<Project[]> {
  return projectSchema.array().parse(await request("/projects"));
}

export async function getProject(id: string): Promise<Project> {
  return projectSchema.parse(await request(`/projects/${encodeURIComponent(id)}`));
}

type ClipJobInput = {
  file?: File;
  url?: string;
  style: Style;
  count: number;
  minDuration: number;
  maxDuration: number;
  aspectRatio: string;
};

export async function createClipJob(input: ClipJobInput): Promise<{ project: Project; job: Job }> {
  const form = new FormData();
  if (input.file) form.set("file", input.file);
  if (input.url) form.set("url", input.url);
  form.set("style", input.style);
  form.set("count", String(input.count));
  form.set("min_duration", String(input.minDuration));
  form.set("max_duration", String(input.maxDuration));
  form.set("aspect_ratio", input.aspectRatio);
  const value = await request<{ project: unknown; job: unknown }>("/jobs/clip", { method: "POST", body: form });
  return { project: projectSchema.parse(value.project), job: jobSchema.parse(value.job) };
}

export async function createScriptJob(input: {
  script: string;
  name?: string;
  style: Style;
  aspectRatio: string;
  narration: "auto" | "local" | "silent";
}): Promise<{ project: Project; job: Job }> {
  const value = await request<{ project: unknown; job: unknown }>("/jobs/script", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return { project: projectSchema.parse(value.project), job: jobSchema.parse(value.job) };
}

export async function listJobs(): Promise<Job[]> {
  return jobSchema.array().parse(await request("/jobs"));
}

export async function getJob(id: string): Promise<Job> {
  return jobSchema.parse(await request(`/jobs/${encodeURIComponent(id)}`));
}

export async function controlJob(id: string, action: "pause" | "resume" | "stop-keep" | "retry-failed"): Promise<Job> {
  return jobSchema.parse(await request(`/jobs/${encodeURIComponent(id)}/control/${action}`, { method: "POST" }));
}

export async function retryClip(jobId: string, clipId: string): Promise<Job> {
  return jobSchema.parse(await request(`/jobs/${encodeURIComponent(jobId)}/clips/${encodeURIComponent(clipId)}/retry`, { method: "POST" }));
}

export async function setClipSelection(jobId: string, clipIds: string[]): Promise<Job> {
  return jobSchema.parse(await request(`/jobs/${encodeURIComponent(jobId)}/selection`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clipIds }),
  }));
}

export async function createZip(jobId: string, clipIds: string[]): Promise<{ downloadUrl: string; filename: string }> {
  return request(`/jobs/${encodeURIComponent(jobId)}/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clipIds }),
  });
}

export function jobEventsUrl(jobId: string): string {
  return `${API}/jobs/${encodeURIComponent(jobId)}/events`;
}

export async function listProfiles(): Promise<ProviderProfile[]> {
  return profileSchema.array().parse(await request("/profiles"));
}

export async function saveProfile(input: Record<string, unknown>, id?: string): Promise<ProviderProfile> {
  return profileSchema.parse(await request(id ? `/profiles/${encodeURIComponent(id)}` : "/profiles", {
    method: id ? "PUT" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }));
}

export async function testProfile(id: string): Promise<ProviderProfile> {
  return profileSchema.parse(await request(`/profiles/${encodeURIComponent(id)}/test`, { method: "POST" }));
}

export async function duplicateProfile(id: string): Promise<ProviderProfile> {
  return profileSchema.parse(await request(`/profiles/${encodeURIComponent(id)}/duplicate`, { method: "POST" }));
}

export async function deleteProfile(id: string): Promise<void> {
  await request(`/profiles/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function listAssets(): Promise<LibraryAsset[]> {
  return assetSchema.array().parse(await request("/library/assets"));
}

export async function uploadAsset(form: FormData): Promise<LibraryAsset> {
  return assetSchema.parse(await request("/library/assets", { method: "POST", body: form }));
}

export async function updateAsset(id: string, input: Record<string, unknown>): Promise<LibraryAsset> {
  return assetSchema.parse(await request(`/library/assets/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }));
}

export async function explainMatch(query: string): Promise<MatchExplanation> {
  return request(`/library/match?text=${encodeURIComponent(query)}`);
}

export function readableError(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}
