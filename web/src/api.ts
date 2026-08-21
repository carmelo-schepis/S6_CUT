// DO-NOT-CHANGE: see DO-NOT-CHANGE/AGENTS.md
// API paths (/api/v1/...), signed URLs from server only, never construct file paths client-side

import {
  assetSchema,
  healthSchema,
  jobSchema,
  libraryFolderSchema,
  profileSchema,
  projectSchema,
  type Health,
  type Job,
  type AssetOrigin,
  type LibraryAsset,
  type LibraryFolder,
  type MatchExplanation,
  type ProcessingMode,
  type Project,
  type ProviderProfile,
  type Style,
  topicVideoPlanSchema,
  type TopicVideoPlan,
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

export async function changeProjectFolder(id: string, folderId: string, moveExistingAssets: boolean): Promise<Project> {
  return projectSchema.parse(await request(`/projects/${encodeURIComponent(id)}/folder`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folderId, moveExistingAssets }),
  }));
}

type ClipJobInput = {
  file?: File;
  url?: string;
  style: Style;
  count: number;
  minDuration: number;
  maxDuration: number;
  aspectRatio: string;
  processingMode?: ProcessingMode;
  libraryFolderId?: string;
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
  if (input.processingMode) form.set("processing_mode", input.processingMode);
  if (input.libraryFolderId) form.set("library_folder_id", input.libraryFolderId);
  const value = await request<{ project: unknown; job: unknown }>("/jobs/clip", { method: "POST", body: form });
  return { project: projectSchema.parse(value.project), job: jobSchema.parse(value.job) };
}

export async function createScriptJob(input: {
  script: string;
  name?: string;
  style: Style;
  aspectRatio: string;
  narration: "auto" | "local" | "silent";
  libraryFolderId?: string;
}): Promise<{ project: Project; job: Job }> {
  const value = await request<{ project: unknown; job: unknown }>("/jobs/script", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return { project: projectSchema.parse(value.project), job: jobSchema.parse(value.job) };
}

export async function createShortsJob(input: { assetId: string; start: number; end?: number; aspectRatio: "9:16" | "16:9" | "1:1" | "4:5"; libraryFolderId?: string }): Promise<{ project: Project; job: Job }> {
  const value = await request<{ project: unknown; job: unknown }>("/jobs/shorts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  return { project: projectSchema.parse(value.project), job: jobSchema.parse(value.job) };
}

export async function createShortsSourceJob(input: { file?: File; url?: string; start: number; end?: number; aspectRatio: "9:16" | "16:9" | "1:1" | "4:5"; libraryFolderId?: string }): Promise<{ project: Project; job: Job }> {
  const form = new FormData();
  if (input.file) form.set("file", input.file);
  if (input.url) form.set("url", input.url);
  form.set("start", String(input.start));
  if (input.end !== undefined) form.set("end", String(input.end));
  form.set("aspect_ratio", input.aspectRatio);
  if (input.libraryFolderId) form.set("library_folder_id", input.libraryFolderId);
  const value = await request<{ project: unknown; job: unknown }>("/jobs/shorts/source", { method: "POST", body: form });
  return { project: projectSchema.parse(value.project), job: jobSchema.parse(value.job) };
}

export async function createTopicPlan(input: { topic: string; audience: string; tone: string; language: string; callToAction: string; instructions: string; durationSeconds: number; aspectRatio: string; variants: number; customScript: string }): Promise<TopicVideoPlan> {
  return topicVideoPlanSchema.parse(await request("/ai/topic-plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }));
}

export async function listJobs(): Promise<Job[]> {
  return jobSchema.array().parse(await request("/jobs"));
}

export async function getJob(id: string): Promise<Job> {
  return jobSchema.parse(await request(`/jobs/${encodeURIComponent(id)}`));
}

export async function controlJob(id: string, action: "pause" | "resume" | "stop-keep" | "retry-failed" | "switch-fast"): Promise<Job> {
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

export type AssetFilters = { folderId?: string; mediaType?: string; origin?: AssetOrigin; search?: string; includeArchived?: boolean };

export async function listAssets(filters: AssetFilters = {}): Promise<LibraryAsset[]> {
  const query = new URLSearchParams();
  if (filters.folderId) query.set("folder_id", filters.folderId);
  if (filters.mediaType) query.set("media_type", filters.mediaType);
  if (filters.origin) query.set("origin", filters.origin);
  if (filters.search) query.set("search", filters.search);
  if (filters.includeArchived) query.set("include_archived", "true");
  const suffix = query.size ? `?${query}` : "";
  return assetSchema.array().parse(await request(`/library/assets${suffix}`));
}

export async function listFolders(options: { includeArchived?: boolean } = {}): Promise<LibraryFolder[]> {
  const suffix = options.includeArchived ? "?include_archived=true" : "";
  return libraryFolderSchema.array().parse(await request(`/library/folders${suffix}`));
}

export async function createFolder(input: { name: string; parentId?: string | null }): Promise<LibraryFolder> {
  return libraryFolderSchema.parse(await request("/library/folders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }));
}

export async function updateFolder(id: string, input: { name?: string; description?: string; color?: string | null }): Promise<LibraryFolder> {
  return libraryFolderSchema.parse(await request(`/library/folders/${encodeURIComponent(id)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }));
}

export async function moveFolder(id: string, parentId: string | null): Promise<LibraryFolder> {
  return libraryFolderSchema.parse(await request(`/library/folders/${encodeURIComponent(id)}/move`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parentId }) }));
}

export async function archiveFolder(id: string, archived = true): Promise<LibraryFolder> {
  return libraryFolderSchema.parse(await request(`/library/folders/${encodeURIComponent(id)}/archive?archived=${archived}`, { method: "POST" }));
}

export async function removeFolder(id: string, destinationFolderId: string): Promise<void> {
  await request(`/library/folders/${encodeURIComponent(id)}?destination_folder_id=${encodeURIComponent(destinationFolderId)}&confirmed=true`, { method: "DELETE" });
}

export async function moveAssets(assetIds: string[], folderId: string): Promise<number> {
  const result = await request<{ moved: number }>("/library/assets/move", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ assetIds, folderId }) });
  return result.moved;
}

export async function uploadAsset(form: FormData): Promise<LibraryAsset> {
  return assetSchema.parse(await request("/library/assets", { method: "POST", body: form }));
}

export async function deleteAsset(id: string): Promise<void> {
  await request(`/library/assets/${encodeURIComponent(id)}`, { method: "DELETE" });
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
  if (error instanceof ApiError && error.status === 502) return "The web service cannot reach the media engine (502).";
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}
