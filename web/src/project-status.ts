import type { Job, Project } from "./types";

export function authoritativeJob(project: Project, jobs: Job[]) {
  const linked = project.latestJobId && jobs.find((job) => job.id === project.latestJobId);
  if (linked) return linked;
  return jobs
    .filter((job) => job.projectId === project.id)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))[0];
}

export function projectStatus(project: Project, jobs: Job[]) {
  const job = authoritativeJob(project, jobs);
  const state = job?.state || project.state;
  return {
    state,
    label: job?.stageLabel,
    progress: job?.progress ?? (state === "complete" ? 100 : undefined),
  };
}

/** Job states that mean work is still in flight. */
const liveJobStates = new Set(["queued", "active", "paused", "recovered", "stalled"]);

export function hasLiveWork(jobs: Job[]): boolean {
  return jobs.some((job) => liveJobStates.has(job.state));
}

/**
 * The job list carries every clip of every job, so it is a large response.
 * Poll it quickly only while something is actually running; an idle queue does
 * not need a fresh copy every few seconds.
 */
export function jobPollInterval(jobs: Job[]): number {
  return hasLiveWork(jobs) ? 4_000 : 20_000;
}
