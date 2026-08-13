import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Health, Project } from "../types";
import { ProjectsView } from "./projects-view";

const health: Health = {
  status: "ready", version: "test", database: true, ffmpeg: true, ffprobe: true,
  whisper: true, ytdlp: true, localTts: true, dataPath: "Local mounted data directory",
  freeBytes: 1_000_000, activeWorkers: 0, queuedJobs: 0,
  fallbacks: { planning: "deterministic" },
};

const project: Project = {
  schemaVersion: 1, id: "project-id", name: "Interview", mode: "clip", style: "serious",
  state: "complete", sourceName: "interview.mp4", sourceKind: "upload", requestedCount: 3,
  latestJobId: "job-id", createdAt: "2026-08-13T00:00:00Z", updatedAt: "2026-08-13T00:00:00Z",
};

describe("Projects create flow", () => {
  it("keeps the three-step path and real project card accessible", () => {
    const open = vi.fn();
    render(<ProjectsView projects={[project]} health={health} onCreated={vi.fn()} onOpen={open} onRefresh={vi.fn(async () => undefined)} />);
    expect(screen.getByRole("heading", { name: "Create a project" })).toBeInTheDocument();
    expect(screen.getByText("Pick style")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Create 5 clips/i })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /Interview/i }));
    expect(open).toHaveBeenCalledWith("project-id");
  });

  it("switches to exact-source Script mode without a setup gate", () => {
    render(<ProjectsView projects={[]} health={health} onCreated={vi.fn()} onOpen={vi.fn()} onRefresh={vi.fn(async () => undefined)} />);
    fireEvent.click(screen.getByRole("button", { name: /Script mode/i }));
    expect(screen.getByPlaceholderText(/Paste the exact script/i)).toBeInTheDocument();
    expect(screen.getByText(/Upload .txt or .md/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Create script video/i })).toBeEnabled();
  });
});
