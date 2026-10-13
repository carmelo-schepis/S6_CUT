// DO-NOT-CHANGE: see DO-NOT-CHANGE/AGENTS.md
// zod schemas must mirror engine/models.py camelCase fields exactly
// A parse failure on any view is a hard error — add fields on both sides together

import { z } from "zod";

export const styleSchema = z.enum(["funny", "serious", "educational", "hype"]);
export type Style = z.infer<typeof styleSchema>;

export const jobStateSchema = z.enum([
  "queued",
  "active",
  "paused",
  "stalled",
  "partial",
  "failed",
  "recovered",
  "cancelled_kept",
  "complete",
]);
export type JobState = z.infer<typeof jobStateSchema>;

export const processingModeSchema = z.enum(["auto", "fast", "smart"]);
export type ProcessingMode = z.infer<typeof processingModeSchema>;

export const contentFormatSchema = z.enum(["short", "long"]);
export type ContentFormat = z.infer<typeof contentFormatSchema>;
export const batchModeSchema = z.enum(["standard", "high_volume"]);
export type BatchMode = z.infer<typeof batchModeSchema>;
export const sourceProfileSchema = z.enum(["speech", "music"]);
export type SourceProfile = z.infer<typeof sourceProfileSchema>;
export const musicThemeSchema = z.enum(["clean", "warm", "serif", "reference_white_sans", "reference_yellow_sans", "reference_white_serif"]);
export type MusicTheme = z.infer<typeof musicThemeSchema>;
export const musicPresentationSchema = z.object({ version: z.literal(1), subtitleTheme: musicThemeSchema });
export type MusicPresentationConfig = z.infer<typeof musicPresentationSchema>;

export const subscribeAnimationSchema = z.object({
  enabled: z.boolean(),
  version: z.literal(1),
  shortFormLeadSeconds: z.union([z.literal(5), z.literal(10)]),
});
export type SubscribeAnimationConfig = z.infer<typeof subscribeAnimationSchema>;

export const DEFAULT_SUBSCRIBE_ANIMATION: SubscribeAnimationConfig = {
  enabled: true,
  version: 1,
  shortFormLeadSeconds: 5,
};

export const videoDownloadTaskSchema = z.object({
  id: z.string(), url: z.string(), state: z.enum(["queued", "active", "complete", "failed"]), phase: z.string(),
  downloadedBytes: z.number().nonnegative(), totalBytes: z.number().nonnegative().nullable().optional(),
  percent: z.number().min(0).max(100).nullable().optional(), message: z.string().nullable().optional(),
  filename: z.string().nullable().optional(), downloadUrl: z.string().nullable().optional(), error: z.string().nullable().optional(),
  createdAt: z.string(), updatedAt: z.string(),
});
export type VideoDownloadTask = z.infer<typeof videoDownloadTaskSchema>;

export const downloadProgressSchema = z.object({
  downloadedBytes: z.number().nonnegative(),
  totalBytes: z.number().nonnegative().nullable().optional(),
  percent: z.number().min(0).max(100).nullable().optional(),
  phase: z.enum(["queued", "connecting", "downloading", "stalled", "retrying", "stopped_partial", "failed", "complete"]),
  lastProgressAt: z.string(),
  speedBytesPerSecond: z.number().nonnegative().nullable().optional(),
  etaSeconds: z.number().nonnegative().nullable().optional(),
  message: z.string().nullable().optional(),
  resumable: z.boolean().default(true),
});
export type DownloadProgress = z.infer<typeof downloadProgressSchema>;

export const penaltyItemSchema = z.object({
  kind: z.string(),
  points: z.number(),
  fillerWordCounts: z.record(z.string(), z.number()).nullable().optional(),
  pointsPerWord: z.number().nullable().optional(),
  speechSeconds: z.number().nullable().optional(),
  targetSeconds: z.number().nullable().optional(),
});
export type PenaltyItem = z.infer<typeof penaltyItemSchema>;

export const scoreSchema = z.object({
  hook: z.number().min(0).max(100),
  coherence: z.number().min(0).max(100),
  ending: z.number().min(0).max(100),
  energy: z.number().min(0).max(100),
  practicalValue: z.number().min(0).max(100),
  visualPotential: z.number().min(0).max(100),
  completeness: z.number().min(0).max(100),
  penalties: z.number().min(0).max(100),
  penaltyItems: z.array(penaltyItemSchema).nullable().optional(),
  llmContribution: z.number().min(0).max(100).nullable().default(null),
  total: z.number().min(0).max(100),
  explanation: z.string(),
});
export type ScoreBreakdown = z.infer<typeof scoreSchema>;

export const provenanceSchema = z.object({
  id: z.string(),
  provider: z.string(),
  creator: z.string().nullable().optional(),
  originalUrl: z.string().nullable().optional(),
  licence: z.string(),
  attribution: z.string(),
  query: z.string().nullable().optional(),
  matchReason: z.string(),
  contentHash: z.string().nullable().optional(),
});
export type ProvenanceRecord = z.infer<typeof provenanceSchema>;

export const captionDownloadSchema = z.object({ format: z.enum(["ass", "srt", "vtt"]), filename: z.string(), url: z.string() });
export const captionCueSchema = z.object({ id: z.string(), start: z.number().nonnegative(), end: z.number().positive(), text: z.string().min(1), confidence: z.number().min(0).max(1).nullable().optional(), warnings: z.array(z.string()).default([]) });

export const clipSchema = z.object({
  id: z.string(),
  index: z.number().int().min(1),
  state: z.enum(["queued", "rendering", "complete", "failed"]),
  start: z.number().min(0),
  end: z.number().positive(),
  duration: z.number().positive(),
  openingLine: z.string(),
  hookText: z.string().nullable().optional(),
  score: scoreSchema.nullable().default(null),
  selected: z.boolean(),
  reviewRequired: z.boolean().optional(),
  reviewReason: z.string().nullable().optional(),
  transcriptExcerpt: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  captionQaWarnings: z.array(z.string()).optional(),
  captionDownloads: z.array(captionDownloadSchema).optional(),
  captionCues: z.array(captionCueSchema).optional(),
  captionRevision: z.number().int().nonnegative().optional(),
  outputName: z.string().nullable().optional(),
  blobId: z.string().nullable().optional(),
  creatorCredit: z.string().nullable().optional(),
  musicTopText: z.string().max(100).nullable().optional(),
  musicTreatment: z.enum(["color", "grayscale"]).nullable().optional(),
  downloadUrl: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  fallbackUsed: z.boolean().default(false),
  visualLabel: z.string().nullable().optional(),
  provenance: z.array(provenanceSchema).default([]),
  // Publication metadata: only the engine may set these when the rendered
  // output passes validation AND its Media Library asset transaction commits.
  // `libraryAssetId` is the server-confirmed link used to display
  // "Saved to Library" — the UI never shows it from optimistic state.
  libraryAssetId: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  width: z.number().int().positive().nullable().optional(),
  height: z.number().int().positive().nullable().optional(),
  folderId: z.string().nullable().optional(),
  folderName: z.string().nullable().optional(),
  publishedAt: z.string().nullable().optional(),
  previewUrl: z.string().nullable().optional(),
}).superRefine((clip, context) => {
  if (clip.end <= clip.start) context.addIssue({ code: z.ZodIssueCode.custom, message: "Clip end must follow its start", path: ["end"] });
  if (Math.abs(clip.duration - (clip.end - clip.start)) > .1) context.addIssue({ code: z.ZodIssueCode.custom, message: "Clip duration must match its range", path: ["duration"] });
});
export type Clip = z.infer<typeof clipSchema>;

export const processingStepStatusSchema = z.enum(["pending", "active", "complete", "skipped", "failed"]);
export type ProcessingStepStatus = z.infer<typeof processingStepStatusSchema>;

export const processingStepSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  status: processingStepStatusSchema,
  detail: z.string().nullable().optional(),
  startedAt: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional(),
  currentItem: z.number().int().min(0).nullable().optional(),
  totalItems: z.number().int().min(0).nullable().optional(),
}).superRefine((step, context) => {
  const terminal = ["complete", "skipped", "failed"].includes(step.status);
  if (terminal && !step.completedAt) context.addIssue({ code: z.ZodIssueCode.custom, message: "Terminal steps require completedAt", path: ["completedAt"] });
  if (!terminal && step.completedAt) context.addIssue({ code: z.ZodIssueCode.custom, message: "Pending and active steps cannot be completed", path: ["completedAt"] });
  if (step.currentItem != null && step.totalItems != null && step.currentItem > step.totalItems) context.addIssue({ code: z.ZodIssueCode.custom, message: "currentItem cannot exceed totalItems", path: ["currentItem"] });
});
export type ProcessingStep = z.infer<typeof processingStepSchema>;

export const beatSchema = z.object({
  id: z.string(),
  start: z.number(),
  end: z.number(),
  charStart: z.number(),
  charEnd: z.number(),
  text: z.string(),
  concept: z.string(),
  source: z.string(),
  confidence: z.number(),
  ruleState: z.string().nullable().optional(),
  matchReason: z.string(),
  assetId: z.string().nullable().optional(),
});
export type Beat = z.infer<typeof beatSchema>;

export const jobSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  projectId: z.string(),
  libraryFolderId: z.string().optional(),
  sourceBlobId: z.string().nullable().optional(),
  mode: z.enum(["clip", "script"]),
  state: jobStateSchema,
  stage: z.string(),
  stageLabel: z.string(),
  progress: z.number(),
  downloadProgress: downloadProgressSchema.nullable().optional(),
  currentItem: z.number().default(0),
  totalItems: z.number().default(0),
  style: styleSchema,
  processingMode: processingModeSchema.default("smart"),
  contentFormat: contentFormatSchema.default("short"),
  sourceProfile: sourceProfileSchema.optional(),
  requestedCount: z.number().int().min(1).max(500).optional(),
  batchMode: batchModeSchema.optional(),
  effectiveTarget: z.number().int().min(0).max(500).nullable().optional(),
  capExplanation: z.string().nullable().optional(),
  plannedCount: z.number().int().min(0).max(500).optional(),
  successfulCount: z.number().int().min(0).max(500).optional(),
  musicPresentation: musicPresentationSchema.nullable().optional(),
  musicTopText: z.string().max(100).nullable().optional(),
  hookTextEnabled: z.boolean().optional(),
  burnSubtitles: z.boolean().optional(),
  embedSubtitles: z.boolean().optional(),
  warnings: z.array(z.string()).default([]),
  queuedAt: z.string().nullable().optional(),
  queuePosition: z.number().int().positive().nullable().optional(),
  queuedElapsedSeconds: z.number().nonnegative().nullable().optional(),
  activeElapsedSeconds: z.number().nonnegative().nullable().optional(),
  blockerSummary: z.string().nullable().optional(),
  cancellationAvailable: z.boolean().optional(),
  transcriptionStartedAt: z.string().nullable().optional(),
  lastHeartbeatAt: z.string().nullable().optional(),
  transcriptionElapsedSeconds: z.number().nonnegative().nullable().optional(),
  transcriptionProcessedSeconds: z.number().nonnegative().nullable().optional(),
  transcriptionTotalSeconds: z.number().nonnegative().nullable().optional(),
  transcriptionActivity: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  canRetryImport: z.boolean().optional(),
  clips: z.array(clipSchema).default([]),
  beats: z.array(beatSchema).default([]),
  steps: z.array(processingStepSchema).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
}).superRefine((job, context) => {
  if (job.steps.filter((step) => step.status === "active").length > 1) context.addIssue({ code: z.ZodIssueCode.custom, message: "Only one processing step may be active", path: ["steps"] });
  const ready = job.steps.find((step) => step.id === "ready");
  if (ready?.status === "complete" && ["queued", "active", "paused", "stalled", "recovered"].includes(job.state)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Project ready cannot complete while work is active", path: ["steps"] });
});
export type Job = Omit<z.infer<typeof jobSchema>, "contentFormat"> & { contentFormat?: ContentFormat };

export const projectSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  name: z.string(),
  mode: z.enum(["clip", "script"]),
  style: styleSchema,
  state: jobStateSchema,
  sourceName: z.string(),
  sourceTitle: z.string().max(200).nullable().optional(),
  sourceKind: z.enum(["upload", "youtube", "script"]),
  sourceCreator: z.string().nullable().optional(),
  requestedCount: z.number().int().min(1).max(500),
  batchMode: batchModeSchema.optional(),
  effectiveTarget: z.number().int().min(0).max(500).nullable().optional(),
  capExplanation: z.string().nullable().optional(),
  contentFormat: contentFormatSchema.default("short"),
  sourceProfile: sourceProfileSchema.optional(),
  latestJobId: z.string().nullable().optional(),
  libraryFolderId: z.string().optional(),
  sourceBlobId: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Project = Omit<z.infer<typeof projectSchema>, "contentFormat"> & { contentFormat?: ContentFormat };

export const healthSchema = z.object({
  status: z.enum(["ready", "degraded", "starting"]),
  version: z.string(),
  database: z.boolean(),
  ffmpeg: z.boolean(),
  ffprobe: z.boolean(),
  whisper: z.boolean(),
  ytdlp: z.boolean(),
  dataPath: z.string(),
  freeBytes: z.number(),
  configuredWorkers: z.number().int().positive().optional(),
  activeWorkers: z.number(),
  queuedJobs: z.number(),
  fallbacks: z.record(z.string()),
});
export type Health = z.infer<typeof healthSchema>;

export const openRouterModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  contextLength: z.number().int().positive().nullable().optional(),
  outputModalities: z.array(z.string()).optional(),
  free: z.boolean().optional(),
});
export type OpenRouterModel = z.infer<typeof openRouterModelSchema>;

export const providerConnectionStatusSchema = z.enum([
  "not_configured", "configured", "connected", "invalid_credentials", "insufficient_balance",
  "rate_limited", "timeout_offline", "unavailable",
  "malformed_response", "provider_service_failure",
]);

export const profileSchema = z.object({
  id: z.string(),
  name: z.string(),
  textModelId: z.string(),
  selected: z.boolean(),
  persistence: z.enum(["session", "encrypted"]),
  openrouterConfigured: z.boolean(),
  openrouterMasked: z.string().nullable().optional(),
  textStatus: providerConnectionStatusSchema.default("not_configured"),
  textMessage: z.string().nullable().optional(),
  textLastCheckedAt: z.string().nullable().optional(),
  status: z.string(),
  capabilities: z.array(z.string()),
  fallbacks: z.record(z.string()),
});
export type ProviderProfile = z.infer<typeof profileSchema>;

export const assetOriginSchema = z.enum(["manual-import", "project-source", "generated-clip", "script-output"]);
export type AssetOrigin = z.infer<typeof assetOriginSchema>;

export const libraryFolderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  parentId: z.string().nullable().optional(),
  description: z.string().default(""),
  color: z.string().nullable().optional(),
  archived: z.boolean().default(false),
  system: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type LibraryFolder = z.infer<typeof libraryFolderSchema>;

export const assetSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  mediaType: z.string(),
  filename: z.string(),
  tags: z.array(z.string()),
  triggers: z.array(z.string()),
  aliases: z.array(z.string()),
  negativeTriggers: z.array(z.string()),
  policy: z.enum(["required", "prefer", "neutral", "never"]),
  protected: z.boolean(),
  minSpacingSeconds: z.number(),
  maxUsesPerProject: z.number(),
  activeFrom: z.string().nullable().optional(),
  activeUntil: z.string().nullable().optional(),
  licence: z.string(),
  attribution: z.string(),
  contentHash: z.string(),
  folderId: z.string().default("00000000-0000-0000-0000-000000000001"),
  origin: assetOriginSchema.default("manual-import"),
  blobId: z.string().default("legacy"),
  sourceProjectId: z.string().nullable().optional(),
  sourceJobId: z.string().nullable().optional(),
  sourceClipId: z.string().nullable().optional(),
  durationSeconds: z.number().nonnegative().nullable().optional(),
  width: z.number().int().positive().nullable().optional(),
  height: z.number().int().positive().nullable().optional(),
  previewUrl: z.string().optional(),
  thumbnailUrl: z.string().nullable().optional(),
  aspectRatio: z.string().nullable().optional(),
  publishedAt: z.string().optional(),
  brands: z.array(z.string()).default([]),
  people: z.array(z.string()).default([]),
  createdAt: z.string(),
});
export type LibraryAsset = z.infer<typeof assetSchema>;

export const assetPageSchema = z.object({ items: assetSchema.array(), page: z.number().int().positive(), pageSize: z.number().int().positive(), hasMore: z.boolean() });
export type AssetPage = z.infer<typeof assetPageSchema>;

export const recentClipsPageSchema = z.object({ items: assetSchema.array(), page: z.number().int().positive(), pageSize: z.number().int().positive(), hasMore: z.boolean(), total: z.number().int().nonnegative() });
export type RecentClipsPage = z.infer<typeof recentClipsPageSchema>;

export const assetDeleteResultSchema = z.object({ deleted: z.array(z.string()), failed: z.record(z.string()) });

export const libraryPurgeResultSchema = z.object({
  assetsDeleted: z.number().int().nonnegative(),
  projectsDeleted: z.number().int().nonnegative(),
  blobsDeleted: z.number().int().nonnegative(),
  bytesReclaimed: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
});
export type LibraryPurgeResult = z.infer<typeof libraryPurgeResultSchema>;

export type MatchExplanation = {
  query: string;
  selected: LibraryAsset | null;
  matchedTriggers: string[];
  score: number;
  reason: string;
  rejected: { assetId: string; title: string; reason: string }[];
};

export const SCHEMA_VERSION = 1 as const;
