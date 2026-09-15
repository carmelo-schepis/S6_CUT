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

export type WorkspaceActivity = {
  liveJobCount: number;
  remainingClips: number;
} | null;

const preClipStages = new Set([
  "queued", "queue", "source", "download", "downloading", "probe", "validation",
  "validating", "validate", "audio", "transcribe", "transcription", "openrouter", "local_planning", "select",
  "boundaries", "plan", "planning",
]);

function nonNegativeInteger(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? value : null;
}

function clampCount(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function remainingForJob(job: Job, project: Project | undefined) {
  const render = job.steps.find((step) => step.id === "render");
  const currentItem = nonNegativeInteger(render?.currentItem);
  const totalItems = nonNegativeInteger(render?.totalItems);
  if (currentItem !== null && totalItems !== null) return Math.max(0, totalItems - currentItem);
  if (job.clips.length > 0) return job.clips.filter((clip) => clip.state !== "complete").length;
  if (project && preClipStages.has(job.stage)) return clampCount(project.requestedCount);
  return 0;
}

/**
 * Summarise live clip production for the shell navigation. This deliberately
 * uses only the server's project and job records, so it remains correct when
 * the workspace view is unmounted.
 */
export function workspaceActivity(projects: Project[], jobs: Job[]): WorkspaceActivity {
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const liveClipJobs = jobs.filter((job) => job.mode === "clip" && liveJobStates.has(job.state));
  if (liveClipJobs.length === 0) return null;
  return {
    liveJobCount: liveClipJobs.length,
    remainingClips: liveClipJobs.reduce((total, job) => total + remainingForJob(job, projectById.get(job.projectId)), 0),
  };
}

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
