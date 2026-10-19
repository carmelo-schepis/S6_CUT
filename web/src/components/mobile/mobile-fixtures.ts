import { mobileOverviewSchema, type LibraryAsset, type MobileOverview } from "../../types";

const iso = (offsetMs = 0) => new Date(Date.now() - offsetMs).toISOString();

/** Parsed through the real zod schema, so a fixture can never drift from the engine contract. */
export function overview(patch: Record<string, unknown> = {}): MobileOverview {
  return mobileOverviewSchema.parse({
    generatedAt: iso(),
    running: [],
    recent: [],
    recentTotal: 0,
    downloads: [],
    clipsLastDay: 0,
    failedLastDay: 0,
    ...patch,
  });
}

export const runningJob = (patch: Record<string, unknown> = {}) => ({
  id: "job-running-1", projectId: "project-1", projectName: "Studio session", mode: "clip", state: "active",
  stage: "render", stageLabel: "Rendering clips", progress: 62, currentItem: 5, totalItems: 8, style: "educational",
  contentFormat: "short", sourceTitle: "A long talk about editing", sourceThumbnailUrl: "/api/v1/library/assets/source-1/thumbnail?expires=1&signature=a",
  steps: [
    { id: "source", label: "Download source", status: "complete", completedAt: iso(60_000) },
    { id: "render", label: "Render clips", status: "active", startedAt: iso(20_000), currentItem: 5, totalItems: 8 },
  ],
  clipsReady: 2,
  clips: [
    { id: "clip-a", index: 1, title: "Cold open", duration: 12, thumbnailUrl: "/thumb/clip-a.jpg?sig=1", previewUrl: "/preview/clip-a.mp4?sig=1" },
    { id: "clip-b", index: 2, title: "The turn", duration: 9, thumbnailUrl: "/thumb/clip-b.jpg?sig=1", previewUrl: "/preview/clip-b.mp4?sig=1" },
  ],
  createdAt: iso(120_000), updatedAt: iso(1_000),
  ...patch,
});

export const finishedJob = (patch: Record<string, unknown> = {}) => ({
  id: "job-done-1", projectId: "project-2", projectName: "Podcast ep 12", mode: "clip", state: "complete",
  stage: "complete", stageLabel: "8 clips ready", progress: 100, style: "serious", contentFormat: "short",
  clipsReady: 8, clips: [{ id: "clip-z", index: 1, title: "Best moment", duration: 20, thumbnailUrl: "/thumb/clip-z.jpg?sig=1", previewUrl: "/preview/clip-z.mp4?sig=1" }],
  createdAt: iso(7_200_000), updatedAt: iso(3_600_000),
  ...patch,
});

export const downloadTask = (patch: Record<string, unknown> = {}) => ({
  id: "d".repeat(32), state: "active", phase: "downloading", downloadedBytes: 1_572_864, totalBytes: 4_194_304, percent: 38,
  message: "Downloading", title: "How I edit Shorts", thumbnailUrl: "/api/v1/video-downloads/ddd/thumbnail?expires=1&signature=a",
  createdAt: iso(30_000), updatedAt: iso(1_000),
  ...patch,
});

export const asset = (patch: Partial<LibraryAsset> = {}): LibraryAsset => ({
  id: "asset-1", title: "Scene 12 – Hal Jordan", description: "", mediaType: "video/mp4", filename: "12-cut.mp4",
  previewUrl: "/api/v1/library/assets/asset-1/preview?expires=1&signature=a", thumbnailUrl: "/api/v1/library/assets/asset-1/thumbnail?expires=1&signature=a",
  tags: [], triggers: [], aliases: [], negativeTriggers: [], policy: "neutral", protected: false, minSpacingSeconds: 0, maxUsesPerProject: 1,
  licence: "Owned", attribution: "", contentHash: "h1", folderId: "unsorted", origin: "generated-clip", blobId: "b1", brands: [], people: [],
  durationSeconds: 42, createdAt: "2026-01-01", ...patch,
});
