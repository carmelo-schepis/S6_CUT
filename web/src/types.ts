import { z } from "zod";

export const styleSchema = z.enum(["funny", "serious", "educational", "hype"]);
export type Style = z.infer<typeof styleSchema>;

export const jobStateSchema = z.enum([
  "queued",
  "active",
  "paused",
  "partial",
  "failed",
  "recovered",
  "cancelled_kept",
  "complete",
]);
export type JobState = z.infer<typeof jobStateSchema>;

export const scoreSchema = z.object({
  hook: z.number().min(0).max(100),
  coherence: z.number().min(0).max(100),
  ending: z.number().min(0).max(100),
  energy: z.number().min(0).max(100),
  practicalValue: z.number().min(0).max(100),
  visualPotential: z.number().min(0).max(100),
  completeness: z.number().min(0).max(100),
  penalties: z.number().min(0).max(100),
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

export const clipSchema = z.object({
  id: z.string(),
  index: z.number().int().min(1),
  state: z.enum(["queued", "rendering", "complete", "failed"]),
  start: z.number().min(0),
  end: z.number().positive(),
  duration: z.number().positive(),
  openingLine: z.string(),
  score: scoreSchema,
  selected: z.boolean(),
  outputName: z.string().nullable().optional(),
  downloadUrl: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  fallbackUsed: z.boolean().default(false),
  visualLabel: z.string().nullable().optional(),
  provenance: z.array(provenanceSchema).default([]),
}).superRefine((clip, context) => {
  if (clip.end <= clip.start) context.addIssue({ code: z.ZodIssueCode.custom, message: "Clip end must follow its start", path: ["end"] });
  if (Math.abs(clip.duration - (clip.end - clip.start)) > .1) context.addIssue({ code: z.ZodIssueCode.custom, message: "Clip duration must match its range", path: ["duration"] });
});
export type Clip = z.infer<typeof clipSchema>;

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
  mode: z.enum(["clip", "script"]),
  state: jobStateSchema,
  stage: z.string(),
  stageLabel: z.string(),
  progress: z.number(),
  currentItem: z.number().default(0),
  totalItems: z.number().default(0),
  style: styleSchema,
  warnings: z.array(z.string()).default([]),
  error: z.string().nullable().optional(),
  clips: z.array(clipSchema).default([]),
  beats: z.array(beatSchema).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Job = z.infer<typeof jobSchema>;

export const projectSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  name: z.string(),
  mode: z.enum(["clip", "script"]),
  style: styleSchema,
  state: jobStateSchema,
  sourceName: z.string(),
  sourceKind: z.enum(["upload", "youtube", "script"]),
  requestedCount: z.number(),
  latestJobId: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Project = z.infer<typeof projectSchema>;

export const healthSchema = z.object({
  status: z.enum(["ready", "degraded", "starting"]),
  version: z.string(),
  database: z.boolean(),
  ffmpeg: z.boolean(),
  ffprobe: z.boolean(),
  whisper: z.boolean(),
  ytdlp: z.boolean(),
  localTts: z.boolean(),
  dataPath: z.string(),
  freeBytes: z.number(),
  activeWorkers: z.number(),
  queuedJobs: z.number(),
  fallbacks: z.record(z.string()),
});
export type Health = z.infer<typeof healthSchema>;

export const profileSchema = z.object({
  id: z.string(),
  name: z.string(),
  modelId: z.string(),
  voiceId: z.string().nullable().optional(),
  selected: z.boolean(),
  persistence: z.enum(["session", "encrypted"]),
  openrouterConfigured: z.boolean(),
  elevenlabsConfigured: z.boolean(),
  openrouterMasked: z.string().nullable().optional(),
  elevenlabsMasked: z.string().nullable().optional(),
  status: z.string(),
  capabilities: z.array(z.string()),
  fallbacks: z.record(z.string()),
});
export type ProviderProfile = z.infer<typeof profileSchema>;

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
  createdAt: z.string(),
});
export type LibraryAsset = z.infer<typeof assetSchema>;

export type MatchExplanation = {
  query: string;
  selected: LibraryAsset | null;
  matchedTriggers: string[];
  score: number;
  reason: string;
  rejected: { assetId: string; title: string; reason: string }[];
};

export const SCHEMA_VERSION = 1 as const;
