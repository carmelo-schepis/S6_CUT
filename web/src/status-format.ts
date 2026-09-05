/**
 * Shared presentation model for engine status data.
 *
 * Views must not build status sentences by concatenating raw engine fields:
 * that is what produced run-together strings such as
 * `Download: 148.1 MB Of 148.1 MB · 100%` and one full-width warning strip per
 * clip. Every helper here returns structured, already-normalised values so each
 * view can lay the parts out itself.
 */
import type { DownloadProgress, Job } from "./types";

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Sentence-case a single engine enum value (`stopped_partial` → `Stopped partial`). */
export function sentenceCase(value: string): string {
  const words = value.replace(/[_-]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1).toLowerCase() : "";
}

const downloadPhaseLabels: Record<DownloadProgress["phase"], string> = {
  queued: "Queued",
  connecting: "Connecting",
  downloading: "Downloading",
  stalled: "Stalled",
  retrying: "Retrying",
  stopped_partial: "Stopped — partial file kept",
  failed: "Download failed",
  complete: "Downloaded",
};

export function downloadPhaseLabel(phase: DownloadProgress["phase"]): string {
  return downloadPhaseLabels[phase] || sentenceCase(phase);
}

export function formatSeconds(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
    : `${minutes}:${String(rest).padStart(2, "0")}`;
}

/** "about 3 min left" / "about 40s left" — never a bare number of seconds. */
export function formatEta(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return `about ${Math.max(1, Math.round(seconds))}s left`;
  return `about ${Math.ceil(seconds / 60)} min left`;
}

export type DownloadFacts = {
  phase: string;
  percent: number | null;
  transferred: string;
  speed: string | null;
  eta: string | null;
  lastProgressAt: string;
  message: string | null;
};

/**
 * Normalise a download into discrete labelled values. Percentages are clamped
 * so a stale or out-of-range engine value can never render as e.g. `104%`.
 */
export function downloadFacts(download: DownloadProgress): DownloadFacts {
  const percent = download.percent == null || !Number.isFinite(download.percent)
    ? null
    : Math.max(0, Math.min(100, download.percent));
  const downloaded = formatBytes(download.downloadedBytes);
  return {
    phase: downloadPhaseLabel(download.phase),
    percent,
    transferred: download.totalBytes ? `${downloaded} of ${formatBytes(download.totalBytes)}` : downloaded,
    speed: download.speedBytesPerSecond ? `${formatBytes(download.speedBytesPerSecond)}/s` : null,
    eta: formatEta(download.etaSeconds),
    lastProgressAt: download.lastProgressAt,
    message: download.message?.trim() || null,
  };
}

/** The download only belongs on screen while it is still the live stage. */
export function activeDownload(job: Job | null | undefined): DownloadProgress | null {
  const download = job?.downloadProgress;
  if (!download || download.phase === "complete") return null;
  return download;
}

export type JobFacts = {
  /** Headline for the current stage — one short phrase, never a concatenation. */
  stage: string;
  /** Secondary line: item counts or download transfer, whichever is live. */
  detail: string | null;
  percent: number;
  /** True when the engine reports no percentage for the live download. */
  indeterminate: boolean;
};

export function jobFacts(job: Job): JobFacts {
  const download = activeDownload(job);
  const facts = download ? downloadFacts(download) : null;
  const items = job.currentItem > 0 && job.totalItems > 0 ? `${job.currentItem} of ${job.totalItems}` : null;
  return {
    stage: facts ? facts.phase : job.stageLabel,
    detail: facts ? facts.transferred : items,
    percent: Math.max(0, Math.min(100, facts?.percent ?? job.progress)),
    indeterminate: Boolean(facts && facts.percent == null),
  };
}

export type GroupedWarning = {
  /** The message with any per-clip prefix removed. */
  message: string;
  /** "Clip 3" or "Clips 1–5" when the message repeated per clip, else null. */
  scope: string | null;
  count: number;
};

const clipPrefix = /^clips?\s+(\d+)\s*[:–—-]\s*/i;

/** Format an ascending list of clip numbers as "1–5" or "1, 3, 7". */
function formatRange(numbers: number[]): string {
  const sorted = [...numbers].sort((left, right) => left - right);
  const contiguous = sorted.every((value, index) => index === 0 || value === sorted[index - 1] + 1);
  return contiguous && sorted.length > 2 ? `${sorted[0]}–${sorted[sorted.length - 1]}` : sorted.join(", ");
}

/**
 * Collapse per-clip repetitions of the same warning into one row.
 * `["Clip 1: No speech detected", …, "Clip 5: No speech detected"]` becomes a
 * single `{ message: "No speech detected", scope: "Clips 1–5", count: 5 }`.
 */
export function groupWarnings(warnings: string[]): GroupedWarning[] {
  const order: string[] = [];
  const groups = new Map<string, { message: string; clips: number[]; count: number }>();
  for (const raw of warnings) {
    const warning = raw.trim();
    if (!warning) continue;
    const match = clipPrefix.exec(warning);
    const message = match ? warning.slice(match[0].length).trim() : warning;
    const key = message.toLowerCase();
    let group = groups.get(key);
    if (!group) {
      group = { message, clips: [], count: 0 };
      groups.set(key, group);
      order.push(key);
    }
    group.count += 1;
    if (match) group.clips.push(Number(match[1]));
  }
  return order.map((key) => {
    const group = groups.get(key)!;
    const scope = group.clips.length
      ? `${group.clips.length === 1 ? "Clip" : "Clips"} ${formatRange(group.clips)}`
      : null;
    return { message: group.message, scope, count: group.count };
  });
}
