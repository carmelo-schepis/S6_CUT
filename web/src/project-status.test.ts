import { describe, expect, it } from "vitest";
import type { Job, Project } from "./types";
import { authoritativeJob, projectStatus } from "./project-status";

const project: Project = {
  schemaVersion: 1,
  id: "project-1",
  name: "Status test",
  mode: "clip",
  style: "educational",
  state: "queued",
  sourceName: "source.mp4",
  sourceKind: "upload",
  requestedCount: 1,
  latestJobId: "latest",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const job = (overrides: Partial<Job>): Job => ({
  schemaVersion: 1,
  id: "latest",
  projectId: project.id,
  mode: "clip",
  state: "queued",
  stage: "queued",
  stageLabel: "Queued on this machine",
  progress: 0,
  currentItem: 0,
  totalItems: 1,
  style: "educational",
  processingMode: "fast",
  warnings: [],
  clips: [],
  beats: [],
  steps: [],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  ...overrides,
});

describe("project status derivation", () => {
  it.each([
    ["queued", "Queued on this machine", 0],
    ["active", "Rendering cut 1", 37],
    ["complete", "Project ready", 100],
    ["failed", "Project failed", 62],
    ["cancelled_kept", "Stopped; completed outputs kept", 42],
  ] as const)("uses the linked job for %s state and progress", (state, label, progress) => {
    const result = projectStatus({ ...project, state: "queued" }, [job({ state, stageLabel: label, progress })]);
    expect(result).toEqual({ state, label, progress });
  });

  it("never lets an older job override the project's linked latest job", () => {
    const older = job({ id: "older", state: "complete", stageLabel: "Project ready", progress: 100, updatedAt: "2026-01-02T00:00:00Z" });
    const latest = job({ id: "latest", state: "active", stageLabel: "Rendering cut 2", progress: 37, updatedAt: "2026-01-01T00:00:00Z" });
    expect(authoritativeJob(project, [older, latest])).toBe(latest);
    expect(projectStatus(project, [older, latest]).state).toBe("active");
  });

  it("selects a deterministic newest fallback when a legacy project has no link", () => {
    const legacy = { ...project, latestJobId: null };
    const first = job({ id: "a", state: "failed", updatedAt: "2026-01-03T00:00:00Z" });
    const second = job({ id: "b", state: "complete", progress: 100, updatedAt: "2026-01-03T00:00:00Z" });
    expect(authoritativeJob(legacy, [first, second])).toBe(second);
  });

  it("preserves a project terminal state when its historical job is unavailable", () => {
    expect(projectStatus({ ...project, state: "complete" }, []).progress).toBe(100);
    expect(projectStatus({ ...project, state: "queued" }, []).progress).toBeUndefined();
  });
});
