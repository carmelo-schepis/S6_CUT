// DO-NOT-CHANGE: see DO-NOT-CHANGE/AGENTS.md
// API paths (/api/v1/...), signed URLs from server only, never construct file paths client-side

import {
  assetPageSchema,
  recentClipsPageSchema,
  assetSchema,
  assetDeleteResultSchema,
  healthSchema,
  jobSchema,
  libraryFolderSchema,
  libraryPurgeResultSchema,
  profileSchema,
  openRouterModelSchema,
  projectSchema,
  type Health,
  type Job,
  type AssetOrigin,
  type LibraryAsset,
  type LibraryFolder,
  type RecentClipsPage,
  type MatchExplanation,
  type ContentFormat,
  type BatchMode,
  type ProcessingMode,
  type SourceProfile,
  type MusicPresentationConfig,
  type Project,
  type ProviderProfile,
  type OpenRouterModel,
  type Style,
  type SubscribeAnimationConfig,
  videoDownloadTaskSchema,
  type VideoDownloadTask,
  titleSuggestionResponseSchema,
  titleApplyResponseSchema,
  type TitleSuggestionResponse,
  type TitleApplyItem,
  type TitleApplyResponse,
} from "./types";

const API = "/api/v1";

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

// Engine form fields are snake_case; customers read the UI labels.
const fieldLabels: Record<string, string> = {
  min_duration: "Minimum seconds",
  max_duration: "Maximum seconds",
  count: "Clips requested",
  aspect_ratio: "Aspect",
  content_format: "Format",
  processing_mode: "Mode",
  source_profile: "Source audio",
  name: "Project name",
  url: "YouTube URL",
  file: "Video file",
  start: "Start seconds",
  end: "End seconds",
};

/**
 * FastAPI reports request-validation problems as an array of objects. Passing
 * that straight to `Error` rendered "[object Object]" to the customer, so
 * flatten it into a sentence naming the field they can actually fix.
 */
export function readableDetail(detail: unknown, fallback: string): string {
  if (typeof detail === "string" && detail.trim()) return detail.trim();
  if (Array.isArray(detail)) {
    const parts = detail.map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return "";
      const record = item as { msg?: unknown; loc?: unknown };
      const message = typeof record.msg === "string" ? record.msg.replace(/^Value error,\s*/i, "") : "";
      const field = Array.isArray(record.loc) ? String(record.loc.at(-1) ?? "") : "";
      const label = fieldLabels[field] || "";
      return label && message ? `${label}: ${message}` : message;
    }).filter(Boolean);
    if (parts.length) return [...new Set(parts)].join(". ");
  }
  return fallback;
}

/**
 * A request that never came back. A pending promise used to leave the shell on
 * "Connecting to local engine…" forever, because only a *rejection* reaches the
 * global alert — so every polled read now fails loudly instead of hanging.
 */
export class TimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`The local engine did not respond within ${Math.round(timeoutMs / 1000)}s.`);
    this.name = "TimeoutError";
  }
}

/** Liveness probe: normally answers in milliseconds, so it fails fast. */
export const HEALTH_TIMEOUT_MS = 8_000;
/** List reads are heavier (jobs carries every clip), so they get more room. */
export const READ_TIMEOUT_MS = 20_000;

type RequestInitWithTimeout = RequestInit & { timeoutMs?: number };

/**
 * Aborts the fetch once `timeoutMs` elapses and reports it as a `TimeoutError`,
 * while still honouring a caller-supplied signal (which stays an AbortError so
 * deliberate cancellation is not mistaken for an unresponsive engine).
 */
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const caller = init.signal;
  const abortFromCaller = () => controller.abort(caller?.reason);
  if (caller?.aborted) abortFromCaller();
  else caller?.addEventListener("abort", abortFromCaller);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (cause) {
    if (timedOut) throw new TimeoutError(timeoutMs);
    throw cause;
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener("abort", abortFromCaller);
  }
}

async function request<T>(path: string, init?: RequestInitWithTimeout): Promise<T> {
  const { timeoutMs, ...rest } = init ?? {};
  const response = timeoutMs === undefined
    // Uploads stream whole video files; they must never be cut off by a timer.
    ? await fetch(`${API}${path}`, rest)
    : await fetchWithTimeout(`${API}${path}`, rest, timeoutMs);
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { detail?: unknown; message?: unknown };
      const detail = readableDetail(body.detail, "");
      message = detail || (typeof body.message === "string" && body.message) || message;
    } catch {
      // Keep the bounded status-only message when a proxy returns non-JSON.
    }
    throw new ApiError(message, response.status);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export async function createVideoOnlyDownload(url: string): Promise<VideoDownloadTask> {
  return videoDownloadTaskSchema.parse(await request("/video-downloads", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }),
  }));
}

export async function getVideoOnlyDownload(id: string): Promise<VideoDownloadTask> {
  return videoDownloadTaskSchema.parse(await request(`/video-downloads/${encodeURIComponent(id)}`));
}

export async function getHealth(): Promise<Health> {
  return healthSchema.parse(await request("/health", { timeoutMs: HEALTH_TIMEOUT_MS }));
}

export async function listProjects(): Promise<Project[]> {
  return projectSchema.array().parse(await request("/projects", { timeoutMs: READ_TIMEOUT_MS }));
}

export async function getProject(id: string): Promise<Project> {
  return projectSchema.parse(await request(`/projects/${encodeURIComponent(id)}`));
}

/** Permanently removes all Library media while preserving app configuration. */
export async function purgeLibraryContent(confirmation: string) {
  return libraryPurgeResultSchema.parse(await request("/library/purge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmation }),
  }));
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
  name?: string;
  url?: string;
  style: Style;
  count: number;
  minDuration: number;
  maxDuration: number;
  aspectRatio: string;
  contentFormat?: ContentFormat;
  batchMode?: BatchMode;
  processingMode?: ProcessingMode;
  /** Serialized as the engine's snake_case multipart field; responses use sourceProfile. */
  sourceProfile?: SourceProfile;
  burnSubtitles?: boolean;
  embedSubtitles?: boolean;
  subscribeAnimation?: SubscribeAnimationConfig;
  libraryFolderId?: string;
  musicPresentation?: MusicPresentationConfig;
  musicTopText?: string;
  hookText?: boolean;
  youtubeMetadata?: boolean;
  youtubeMetadataModelId?: string;
};

export async function createClipJob(input: ClipJobInput): Promise<{ project: Project; job: Job }> {
  const form = new FormData();
  if (input.file) form.set("file", input.file);
  if (input.url) form.set("url", input.url);
  if (input.name?.trim()) form.set("name", input.name.trim());
  form.set("style", input.style);
  form.set("count", String(input.count));
  form.set("min_duration", String(input.minDuration));
  form.set("max_duration", String(input.maxDuration));
  form.set("aspect_ratio", input.aspectRatio);
  form.set("content_format", input.contentFormat ?? "short");
  form.set("batch_mode", input.batchMode ?? "standard");
  if (input.processingMode) form.set("processing_mode", input.processingMode);
  form.set("source_profile", input.sourceProfile ?? "speech");
  form.set("burn_subtitles", String(input.burnSubtitles ?? true));
  form.set("embed_subtitles", String(input.embedSubtitles ?? false));
  if (input.hookText === true) form.set("hook_text", "true");
  // Omitted lets the engine follow the profile's auto-SEO-titles default; an
  // explicit false must reach it so a customer's opt-out is respected.
  if (input.youtubeMetadata !== undefined) form.set("youtube_metadata", String(input.youtubeMetadata));
  if (input.youtubeMetadataModelId?.trim()) form.set("youtube_metadata_model_id", input.youtubeMetadataModelId.trim());
  if (input.libraryFolderId) form.set("library_folder_id", input.libraryFolderId);
  if (input.subscribeAnimation) form.set("subscribe_animation", JSON.stringify(input.subscribeAnimation));
  if (input.sourceProfile === "music") {
    form.set("music_presentation", JSON.stringify(input.musicPresentation ?? { version: 1, subtitleTheme: "clean" }));
    if (input.musicTopText !== undefined) form.set("music_top_text", input.musicTopText);
  }
  const value = await request<{ project: unknown; job: unknown }>("/jobs/clip", { method: "POST", body: form });
  return { project: projectSchema.parse(value.project), job: jobSchema.parse(value.job) };
}

export async function createShortsJob(input: { assetId: string; name?: string; burnSubtitles?: boolean; embedSubtitles?: boolean; subscribeAnimation?: SubscribeAnimationConfig; start: number; end?: number; aspectRatio: "9:16" | "16:9" | "1:1" | "4:5"; libraryFolderId?: string; muted?: boolean; volume?: number; filterPreset?: "none" | "warm" | "cool" | "black_white" | "tint" | "monochrome"; filterIntensity?: number; tintColor?: string; tintOpacity?: number; textOverlays?: Array<{ id: string; text: string; color: string; size: number; x: number; y: number; start: number; duration: number }> }): Promise<{ project: Project; job: Job }> {
  const value = await request<{ project: unknown; job: unknown }>("/jobs/shorts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...input, embedSubtitles: input.embedSubtitles ?? false }) });
  return { project: projectSchema.parse(value.project), job: jobSchema.parse(value.job) };
}

export async function createShortsSourceJob(input: { file?: File; url?: string; name?: string; burnSubtitles?: boolean; subscribeAnimation?: SubscribeAnimationConfig; start: number; end?: number; aspectRatio: "9:16" | "16:9" | "1:1" | "4:5"; libraryFolderId?: string; muted?: boolean; volume?: number; filterPreset?: "none" | "warm" | "cool" | "black_white" | "tint" | "monochrome"; filterIntensity?: number; tintColor?: string; tintOpacity?: number; textOverlays?: Array<{ id: string; text: string; color: string; size: number; x: number; y: number; start: number; duration: number }> }): Promise<{ project: Project; job: Job }> {
  const form = new FormData();
  if (input.file) form.set("file", input.file);
  if (input.url) form.set("url", input.url);
  if (input.name?.trim()) form.set("name", input.name.trim());
  form.set("start", String(input.start));
  if (input.end !== undefined) form.set("end", String(input.end));
  form.set("aspect_ratio", input.aspectRatio);
  if (input.libraryFolderId) form.set("library_folder_id", input.libraryFolderId);
  form.set("burn_subtitles", String(input.burnSubtitles ?? true));
  if (input.subscribeAnimation) form.set("subscribe_animation", JSON.stringify(input.subscribeAnimation));
  form.set("muted", String(input.muted ?? false));
  form.set("volume", String(input.volume ?? 1));
  form.set("filter_preset", input.filterPreset ?? "none");
  form.set("filter_intensity", String(input.filterIntensity ?? 1));
  form.set("tint_color", input.tintColor ?? "#d58a55");
  form.set("tint_opacity", String(input.tintOpacity ?? 0));
  form.set("text_overlays", JSON.stringify(input.textOverlays ?? []));
  const value = await request<{ project: unknown; job: unknown }>("/jobs/shorts/source", { method: "POST", body: form });
  return { project: projectSchema.parse(value.project), job: jobSchema.parse(value.job) };
}

export async function listOpenRouterModels(outputModalities?: "text" | "speech"): Promise<OpenRouterModel[]> {
  const query = outputModalities ? `?outputModalities=${encodeURIComponent(outputModalities)}` : "";
  return openRouterModelSchema.array().parse(await request(`/openrouter/models${query}`));
}

export async function listJobs(): Promise<Job[]> {
  return jobSchema.array().parse(await request("/jobs", { timeoutMs: READ_TIMEOUT_MS }));
}

export async function getJob(id: string): Promise<Job> {
  return jobSchema.parse(await request(`/jobs/${encodeURIComponent(id)}`));
}

export async function controlJob(id: string, action: "pause" | "resume" | "stop-keep" | "retry-failed" | "retry-import" | "switch-fast"): Promise<Job> {
  return jobSchema.parse(await request(`/jobs/${encodeURIComponent(id)}/control/${action}`, { method: "POST" }));
}

export async function retryClip(jobId: string, clipId: string): Promise<Job> {
  return jobSchema.parse(await request(`/jobs/${encodeURIComponent(jobId)}/clips/${encodeURIComponent(clipId)}/retry`, { method: "POST" }));
}

export async function generateYoutubeMetadata(jobId: string, clipId: string, regenerate = false): Promise<Job> {
  return jobSchema.parse(await request(`/jobs/${encodeURIComponent(jobId)}/clips/${encodeURIComponent(clipId)}/youtube-metadata`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ regenerate }) }));
}

export async function updateYoutubeMetadata(jobId: string, clipId: string, title: string, description: string, revision: number): Promise<Job> {
  return jobSchema.parse(await request(`/jobs/${encodeURIComponent(jobId)}/clips/${encodeURIComponent(clipId)}/youtube-metadata`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, description, revision }) }));
}

export async function saveCaptionCues(jobId: string, clipId: string, revision: number, cues: Array<{ id: string; start: number; end: number; text: string; confidence?: number | null }>): Promise<Job> {
  return jobSchema.parse(await request(`/jobs/${encodeURIComponent(jobId)}/clips/${encodeURIComponent(clipId)}/captions`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision, cues }) }));
}

export async function rerenderCaptions(jobId: string, clipId: string, revision: number): Promise<Job> {
  return jobSchema.parse(await request(`/jobs/${encodeURIComponent(jobId)}/clips/${encodeURIComponent(clipId)}/captions/rerender?revision=${encodeURIComponent(revision)}`, { method: "POST" }));
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
  return profileSchema.array().parse(await request("/profiles", { timeoutMs: READ_TIMEOUT_MS }));
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

export async function listAssetsPage(filters: AssetFilters & { page?: number; pageSize?: number } = {}) {
  const query = new URLSearchParams();
  if (filters.folderId) query.set("folder_id", filters.folderId);
  if (filters.mediaType) query.set("media_type", filters.mediaType);
  if (filters.origin) query.set("origin", filters.origin);
  if (filters.search) query.set("search", filters.search);
  if (filters.includeArchived) query.set("include_archived", "true");
  query.set("page", String(filters.page ?? 1)); query.set("page_size", String(filters.pageSize ?? 40));
  return assetPageSchema.parse(await request(`/library/assets/page?${query}`));
}

export async function listRecentClips(options: { search?: string; page?: number; pageSize?: number } = {}): Promise<RecentClipsPage> {
  const query = new URLSearchParams();
  query.set("search", options.search?.trim() ?? "");
  query.set("page", String(options.page ?? 1));
  query.set("page_size", String(options.pageSize ?? 12));
  return recentClipsPageSchema.parse(await request(`/library/recent-clips?${query}`, { timeoutMs: READ_TIMEOUT_MS }));
}

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

export async function deleteAssets(assetIds: string[]): Promise<{ deleted: string[]; failed: Record<string, string> }> {
  return assetDeleteResultSchema.parse(await request("/library/assets/bulk-delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ assetIds }),
  }));
}

export async function renewAssetThumbnail(id: string): Promise<string> {
  const result = await request<{ thumbnailUrl: string }>(`/library/assets/${encodeURIComponent(id)}/thumbnail-url`);
  return result.thumbnailUrl;
}

export async function updateAsset(id: string, input: Record<string, unknown>): Promise<LibraryAsset> {
  return assetSchema.parse(await request(`/library/assets/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }));
}

/** Asks the engine for SEO title suggestions. Writes nothing; may take tens of seconds. */
export async function suggestLibraryTitles(input: { assetIds: string[] } | { scope: "auto-titled" }): Promise<TitleSuggestionResponse> {
  return titleSuggestionResponseSchema.parse(await request("/library/title-suggestions", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  }));
}

export async function applyLibraryTitles(items: TitleApplyItem[]): Promise<TitleApplyResponse> {
  return titleApplyResponseSchema.parse(await request("/library/title-suggestions/apply", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }),
  }));
}

export async function explainMatch(query: string): Promise<MatchExplanation> {
  return request(`/library/match?text=${encodeURIComponent(query)}`);
}

export function readableError(error: unknown): string {
  if (error instanceof ApiError && error.status === 502) return "The web service cannot reach the media engine (502).";
  if (error instanceof TimeoutError) return `${error.message} It may still be starting up.`;
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}
