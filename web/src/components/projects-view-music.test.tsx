import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Health, Project } from "../types";
import { ProjectsView } from "./projects-view";

vi.mock("../api", () => ({
  readableError: (error: unknown) => error instanceof Error ? error.message : "Unexpected error",
  createClipJob: vi.fn(), createScriptJob: vi.fn(),
  listRecentClips: vi.fn(async () => ({ items: [], page: 1, pageSize: 12, hasMore: false, total: 0 })),
  listFolders: vi.fn(async () => []), createFolder: vi.fn(),
}));
import { createClipJob, createScriptJob } from "../api";

const health: Health = {
  status: "ready", version: "test", database: true, ffmpeg: true, ffprobe: true, whisper: true,
  ytdlp: true, localTts: true, dataPath: "Local mounted data directory", freeBytes: 1_000_000,
  activeWorkers: 0, queuedJobs: 0, fallbacks: { planning: "deterministic" },
};
const project: Project = {
  schemaVersion: 1, id: "created-project", name: "Music", mode: "clip", style: "educational", state: "queued",
  sourceName: "source.mp4", sourceKind: "upload", requestedCount: 2, latestJobId: "job",
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
};
const mode = (name: "Clip" | "Music" | "Script") => screen.getByRole("button", { name: new RegExp(name === "Clip" ? "^Clip(?: mode)?$" : name === "Music" ? "^Music(?: / sung vocals)?$" : "^Script(?: mode)?$", "i") });
const chooseFile = () => fireEvent.change(screen.getByLabelText("Choose video file"), { target: { files: [new File(["video"], "song.mp4", { type: "video/mp4" })] } });

beforeEach(() => { vi.mocked(createClipJob).mockReset(); vi.mocked(createScriptJob).mockReset(); });

describe("Music presentation creation controls", () => {
  it("keeps Clip as the initial mode, promotes Music, and preserves Script as a reachable workflow", () => {
    render(<ProjectsView health={health} onCreated={vi.fn()} />);
    expect(mode("Clip")).toHaveAttribute("aria-pressed", "true");
    expect(mode("Music")).toBeVisible();
    fireEvent.click(mode("Music"));
    expect(mode("Music")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Short form · 9:16/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: "Auto" })).not.toBeInTheDocument();
    fireEvent.click(mode("Script"));
    expect(screen.getByPlaceholderText(/Paste the exact script/i)).toBeVisible();
    expect(screen.getByRole("button", { name: /Create script video/i })).toBeEnabled();
    fireEvent.click(mode("Clip"));
    expect(mode("Clip")).toHaveAttribute("aria-pressed", "true");
  });

  it("offers all themes and preserves exact 100-character top text in Music creation only", async () => {
    vi.mocked(createClipJob).mockResolvedValue({ project: { ...project, sourceProfile: "music" }, job: undefined as never });
    render(<ProjectsView health={health} onCreated={vi.fn()} />);
    fireEvent.click(mode("Music"));
    const themeGroup = within(screen.getByRole("group", { name: "Lyrics subtitle theme" }));
    const themeLabels = ["Clean sans", "Warm highlight", "Soft serif", "Reference white sans", "Reference yellow sans", "Reference white serif"];
    for (const label of themeLabels) expect(themeGroup.getByRole("button", { name: new RegExp(`^${label}$`) })).toBeVisible();
    expect(themeGroup.getByRole("button", { name: /^Clean sans$/ })).toHaveAttribute("aria-pressed", "true");
    expect(themeGroup.getAllByRole("button").filter((button) => button.getAttribute("aria-pressed") === "true")).toHaveLength(1);
    fireEvent.click(themeGroup.getByRole("button", { name: /^Reference yellow sans$/ }));
    expect(themeGroup.getByRole("button", { name: /^Reference yellow sans$/ })).toHaveAttribute("aria-pressed", "true");
    expect(themeGroup.getAllByRole("button").filter((button) => button.getAttribute("aria-pressed") === "true")).toHaveLength(1);
    const topText = `  ${"L".repeat(96)}  `;
    expect(topText).toHaveLength(100);
    const title = screen.getByRole("textbox", { name: "Top text" });
    expect(title).toHaveAttribute("maxLength", "100");
    fireEvent.change(title, { target: { value: topText } });
    fireEvent.click(themeGroup.getByRole("button", { name: /^Warm highlight$/ }));
    chooseFile();
    fireEvent.click(screen.getByRole("button", { name: /Create 5 short clips/i }));
    await waitFor(() => expect(createClipJob).toHaveBeenCalled());
    const payload = vi.mocked(createClipJob).mock.calls[0][0];
    expect(payload).toMatchObject({ sourceProfile: "music", processingMode: "smart", contentFormat: "short", aspectRatio: "9:16", musicTopText: topText, musicPresentation: { version: 1, subtitleTheme: "warm" } });
  });

  it("forces short vertical music output and resets captions when switching from long-form Clip mode", () => {
    render(<ProjectsView health={health} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Long form · 16:9/i }));
    expect(screen.getByRole("button", { name: /Long form · 16:9/i })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(mode("Music"));
    expect(screen.getByRole("button", { name: /Short form · 9:16/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Long form · 16:9/i })).toBeDisabled();
    expect(screen.queryByRole("checkbox", { name: /Burn in subtitles/i })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Lyrics subtitle theme" })).toBeVisible();
  });

  it("omits Music-only settings from Clip and Script submissions and avoids stale setting leaks", async () => {
    vi.mocked(createClipJob).mockResolvedValue({ project, job: undefined as never });
    vi.mocked(createScriptJob).mockResolvedValue({ project: { ...project, mode: "script" }, job: undefined as never });
    render(<ProjectsView health={health} onCreated={vi.fn()} />);
    chooseFile();
    fireEvent.click(screen.getByRole("button", { name: /Create 5 short clips/i }));
    await waitFor(() => expect(createClipJob).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createClipJob).mock.calls[0][0]).not.toHaveProperty("musicPresentation");
    expect(vi.mocked(createClipJob).mock.calls[0][0]).not.toHaveProperty("musicTopText");

    fireEvent.click(mode("Music"));
    fireEvent.change(screen.getByRole("textbox", { name: "Top text" }), { target: { value: "Do not leak" } });
    fireEvent.click(mode("Script"));
    fireEvent.change(screen.getByPlaceholderText(/Paste the exact script/i), { target: { value: "This is a valid exact-source script for the submission." } });
    fireEvent.click(screen.getByRole("button", { name: /Create script video/i }));
    await waitFor(() => expect(createScriptJob).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createScriptJob).mock.calls[0][0]).not.toHaveProperty("musicPresentation");
    expect(vi.mocked(createScriptJob).mock.calls[0][0]).not.toHaveProperty("musicTopText");

    fireEvent.click(mode("Music"));
    chooseFile();
    fireEvent.click(screen.getByRole("button", { name: /Create 5 short clips/i }));
    await waitFor(() => expect(createClipJob).toHaveBeenCalledTimes(2));
    expect(vi.mocked(createClipJob).mock.calls[1][0]).toMatchObject({ musicTopText: "Do not leak", musicPresentation: { version: 1, subtitleTheme: "clean" } });
  });
});
