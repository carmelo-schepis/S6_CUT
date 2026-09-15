import { describe, expect, it } from "vitest";
import type { Clip, Job, Project } from "./types";
import { authoritativeJob, projectStatus, workspaceActivity } from "./project-status";

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

const clip = (state: Clip["state"], index = 1): Clip => ({
  id: `clip-${index}`, index, state, start: 0, end: 1, duration: 1, openingLine: "",
  score: null, selected: true, fallbackUsed: false, provenance: [],
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

describe("workspace activity derivation", () => {
  it("returns null when there are no jobs", () => {
    expect(workspaceActivity([project], [])).toBeNull();
  });

  it.each(["complete", "failed", "cancelled_kept"] as const)("ignores terminal jobs (%s)", (state) => {
    expect(workspaceActivity([project], [job({ state })])).toBeNull();
  });

  it("does not produce activity for script-mode jobs", () => {
    expect(workspaceActivity([project], [job({ mode: "script" })])).toBeNull();
  });

  it("falls back to the requested count for a queued job with no clips", () => {
    expect(workspaceActivity([{ ...project, requestedCount: 5 }], [job({ stage: "queued", clips: [] })]))
      .toEqual({ liveJobCount: 1, remainingClips: 5 });
  });

  it("uses render-step item progress", () => {
    expect(workspaceActivity([project], [job({ steps: [{ id: "render", label: "Render", status: "active", currentItem: 1, totalItems: 5 }] })]))
      .toEqual({ liveJobCount: 1, remainingClips: 4 });
  });

  it("prefers render-step progress over the clip array", () => {
    expect(workspaceActivity([project], [job({
      steps: [{ id: "render", label: "Render", status: "active", currentItem: 1, totalItems: 5 }],
      clips: [clip("queued"), clip("complete", 2)],
    })])).toEqual({ liveJobCount: 1, remainingClips: 4 });
  });

  it("counts every incomplete clip in the clip-array fallback", () => {
    expect(workspaceActivity([project], [job({
      stage: "verify",
      clips: [clip("queued"), clip("rendering", 2), clip("failed", 3), clip("complete", 4)],
    })])).toEqual({ liveJobCount: 1, remainingClips: 3 });
  });

  it("keeps a live verification job visible with zero remaining clips", () => {
    expect(workspaceActivity([project], [job({ stage: "verify", clips: [clip("complete")] })]))
      .toEqual({ liveJobCount: 1, remainingClips: 0 });
  });

  it("clamps negative derived values to zero", () => {
    expect(workspaceActivity([project], [job({
      steps: [{ id: "render", label: "Render", status: "active", currentItem: 5, totalItems: 2 }],
    })])).toEqual({ liveJobCount: 1, remainingClips: 0 });
  });

  it("aggregates multiple live clip jobs and ignores historical jobs", () => {
    const secondProject = { ...project, id: "project-2", requestedCount: 3 };
    expect(workspaceActivity([project, secondProject], [
      job({ id: "live-1", projectId: project.id, steps: [{ id: "render", label: "Render", status: "active", currentItem: 2, totalItems: 5 }] }),
      job({ id: "live-2", projectId: secondProject.id, state: "paused", stage: "queued", clips: [] }),
      job({ id: "old", state: "complete", clips: [clip("queued")] }),
    ])).toEqual({ liveJobCount: 2, remainingClips: 6 });
  });

  it("does not include terminal historical jobs in the count", () => {
    expect(workspaceActivity([project], [
      job({ id: "live", state: "active", steps: [{ id: "render", label: "Render", status: "active", currentItem: 3, totalItems: 5 }] }),
      job({ id: "history", state: "complete", clips: [clip("queued"), clip("queued", 2)] }),
    ])).toEqual({ liveJobCount: 1, remainingClips: 2 });
  });
});
