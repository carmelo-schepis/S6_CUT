/**
 * Pure view model for the iPhone/iPad status view. Everything the three tabs
 * show about work in flight is derived here, from one engine response, so the
 * Home, Jobs and tab-badge counts can never disagree with each other.
 */
import { dayLabel } from "../jobs-view";
import { downloadFacts, formatBytes, jobFacts, sentenceCase } from "../../status-format";
import type { JobState, MobileDownload, MobileJob, MobileOverview } from "../../types";

export type MobileTab = "home" | "library" | "jobs";
export const MOBILE_TABS: readonly MobileTab[] = ["home", "library", "jobs"];

/** `#/library` → "library". Anything unknown (or empty) is Home. */
export function tabFromHash(hash: string): MobileTab {
  const key = hash.replace(/^#\/?/, "").split(/[/?]/)[0];
  return (MOBILE_TABS as readonly string[]).includes(key) ? key as MobileTab : "home";
}

export function hashForTab(tab: MobileTab): string {
  return tab === "home" ? "#/" : `#/${tab}`;
}

export type WorkItem =
  | { kind: "job"; key: string; at: string; job: MobileJob }
  | { kind: "download"; key: string; at: string; task: MobileDownload };

export type WorkGroups = { running: WorkItem[]; queued: WorkItem[]; finished: WorkItem[] };

const RUNNING_JOB_STATES = new Set<JobState>(["active", "paused", "stalled", "recovered"]);

const jobItem = (job: MobileJob): WorkItem => ({ kind: "job", key: `job:${job.id}`, at: job.updatedAt, job });
const downloadItem = (task: MobileDownload): WorkItem => ({ kind: "download", key: `download:${task.id}`, at: task.updatedAt, task });

/** Running, waiting and finished work as one flat model (jobs and video downloads together). */
export function workGroups(overview: MobileOverview): WorkGroups {
  return {
    running: [
      ...overview.running.filter((job) => RUNNING_JOB_STATES.has(job.state)).map(jobItem),
      ...overview.downloads.filter((task) => task.state === "active").map(downloadItem),
    ],
    queued: [
      ...overview.running.filter((job) => job.state === "queued").map(jobItem),
      ...overview.downloads.filter((task) => task.state === "queued").map(downloadItem),
    ],
    finished: [
      ...overview.recent.map(jobItem),
      ...overview.downloads.filter((task) => task.state === "complete" || task.state === "failed").map(downloadItem),
    ].sort((left, right) => right.at.localeCompare(left.at)),
  };
}

/** True while anything is moving, which is what decides how often to poll. */
export function hasWorkInFlight(overview: MobileOverview | null): boolean {
  if (!overview) return false;
  return overview.running.length > 0 || overview.downloads.some((task) => task.state === "active" || task.state === "queued");
}

export type WorkFacts = {
  title: string;
  subtitle: string | null;
  poster: string | null;
  /** State for the shared status badge. */
  state: JobState;
  stage: string;
  /** "1.5 GB of 4.0 GB · 12.4 MB/s · about 3 min left", or "5 of 8". */
  detail: string | null;
  percent: number;
  indeterminate: boolean;
};

export function jobSubtitle(job: MobileJob): string | null {
  const source = job.sourceTitle?.trim();
  return source && source !== job.projectName ? source : null;
}

export function workFacts(item: WorkItem): WorkFacts {
  if (item.kind === "download") {
    const { task } = item;
    const percent = task.percent == null ? null : Math.max(0, Math.min(100, task.percent));
    const transferred = task.downloadedBytes > 0
      ? `${formatBytes(task.downloadedBytes)}${task.totalBytes ? ` of ${formatBytes(task.totalBytes)}` : ""}`
      : null;
    return {
      title: task.title?.trim() || "YouTube video",
      subtitle: "Video download",
      poster: task.thumbnailUrl ?? null,
      state: task.state === "complete" ? "complete" : task.state === "failed" ? "failed" : task.state === "queued" ? "queued" : "active",
      stage: task.message?.trim() || sentenceCase(task.phase),
      detail: transferred,
      percent: percent ?? 0,
      indeterminate: percent == null,
    };
  }
  const { job } = item;
  const facts = jobFacts(job);
  const live = job.downloadProgress && job.downloadProgress.phase !== "complete" ? downloadFacts(job.downloadProgress) : null;
  const detail = [facts.detail, live?.speed, live?.eta].filter(Boolean).join(" · ");
  return {
    title: job.projectName,
    subtitle: jobSubtitle(job),
    poster: job.sourceThumbnailUrl ?? null,
    state: job.state,
    stage: facts.stage,
    detail: detail || null,
    percent: facts.percent,
    indeterminate: facts.indeterminate,
  };
}

/** Plural-aware "5 outputs ready" used by the finished-work rows. */
export function outputsReady(count: number): string {
  return `${count} output${count === 1 ? "" : "s"} ready`;
}

/** Group finished work under the same Today / Yesterday / weekday headings the desktop Jobs page uses. */
export function groupFinishedByDay(items: WorkItem[], now = new Date()): [string, WorkItem[]][] {
  const groups = new Map<string, WorkItem[]>();
  for (const item of items) {
    const label = dayLabel(item.at, now);
    groups.set(label, [...(groups.get(label) || []), item]);
  }
  return [...groups];
}

/** The hero headline on Home: what the engine is doing right now. */
export function headline(groups: WorkGroups): { title: string; detail: string } {
  const running = groups.running.length;
  const queued = groups.queued.length;
  if (running > 0) return { title: `${running} job${running === 1 ? "" : "s"} running`, detail: queued > 0 ? `${queued} more waiting in the queue` : "Progress updates automatically" };
  if (queued > 0) return { title: `${queued} job${queued === 1 ? "" : "s"} queued`, detail: "Waiting for a free worker" };
  return { title: "Nothing running", detail: "Everything is up to date" };
}
