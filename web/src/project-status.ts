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
