import type { Job } from "./types";

export type WorkspaceJobSelection = { projectId: string; jobId: string } | null;

function stableTime(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function byCreatedAtThenId(left: Job, right: Job): number {
  return stableTime(left.createdAt) - stableTime(right.createdAt) || left.id.localeCompare(right.id);
}

/** Pick a stable clip job for the shell's automatically-followed Workspace. */
export function selectWorkspaceJob(jobs: Job[], previous: WorkspaceJobSelection): WorkspaceJobSelection {
  const clipJobs = jobs.filter((job) => job.mode === "clip");
  const previousJob = previous && clipJobs.find((job) => job.id === previous.jobId && job.projectId === previous.projectId);
  if (previousJob?.state === "active") return previous;

  const active = clipJobs.filter((job) => job.state === "active").sort(byCreatedAtThenId)[0];
  if (active) return { projectId: active.projectId, jobId: active.id };
  if (previous) return previous;

  const queued = clipJobs.filter((job) => job.state === "queued").sort((left, right) => (
    (left.queuePosition ?? Number.MAX_SAFE_INTEGER) - (right.queuePosition ?? Number.MAX_SAFE_INTEGER)
    || byCreatedAtThenId(left, right)
  ))[0];
  return queued ? { projectId: queued.projectId, jobId: queued.id } : null;
}
