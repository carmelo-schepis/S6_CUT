import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Health, Project } from "../types";
import { ProjectsView } from "./projects-view";

vi.mock("../api", () => ({
  readableError: (error: unknown) => error instanceof Error ? error.message : "Unexpected error",
  createClipJob: vi.fn(),
  listRecentClips: vi.fn(async () => ({ items: [], page: 1, pageSize: 12, hasMore: false, total: 0 })),
  listFolders: vi.fn(async () => []), createFolder: vi.fn(),
}));
import { createClipJob } from "../api";

const health: Health = {
  status: "ready", version: "test", database: true, ffmpeg: true, ffprobe: true, whisper: true,
  ytdlp: true, dataPath: "Local mounted data directory", freeBytes: 1_000_000,
  activeWorkers: 0, queuedJobs: 0, fallbacks: { planning: "deterministic" },
};
const project: Project = {
  schemaVersion: 1, id: "created-project", name: "Music", mode: "clip", style: "educational", state: "queued",
  sourceName: "source.mp4", sourceKind: "upload", requestedCount: 2, latestJobId: "job",
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
};
const mode = (name: "Clip" | "Music") => screen.getByRole("button", { name: new RegExp(name === "Clip" ? "^Clip(?: mode)?$" : "^Music(?: / sung vocals)?$", "i") });
const chooseFile = () => fireEvent.change(screen.getByLabelText("Choose video file"), { target: { files: [new File(["video"], "song.mp4", { type: "video/mp4" })] } });

beforeEach(() => { vi.mocked(createClipJob).mockReset(); });

describe("Music presentation creation controls", () => {
  it("defaults Music to English and preserves explicit automatic detection", async () => {
    vi.mocked(createClipJob).mockResolvedValue({ project, job: undefined as never });
    render(<ProjectsView health={health} onCreated={vi.fn()} />);
    expect(screen.queryByRole("combobox", { name: "Lyrics language" })).not.toBeInTheDocument();
    fireEvent.click(mode("Music"));
    const language = screen.getByRole("combobox", { name: "Lyrics language" });
    expect(language).toHaveValue("en");
    chooseFile();
    fireEvent.click(screen.getByRole("button", { name: /Create 5 short clips/i }));
    await waitFor(() => expect(createClipJob).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createClipJob).mock.calls[0][0]).toMatchObject({ sourceProfile: "music", musicLyricsLanguage: "en" });
    fireEvent.change(language, { target: { value: "auto" } });
    fireEvent.click(screen.getByRole("button", { name: /Create 5 short clips/i }));
    await waitFor(() => expect(createClipJob).toHaveBeenCalledTimes(2));
    expect(vi.mocked(createClipJob).mock.calls[1][0]).toMatchObject({ sourceProfile: "music", musicLyricsLanguage: "auto" });
    fireEvent.click(mode("Clip"));
    fireEvent.click(screen.getByRole("button", { name: /Create 5 short clips/i }));
    await waitFor(() => expect(createClipJob).toHaveBeenCalledTimes(3));
    expect(vi.mocked(createClipJob).mock.calls[2][0]).not.toHaveProperty("musicLyricsLanguage");
  });

  it("keeps Clip as the initial mode and promotes Music", () => {
    render(<ProjectsView health={health} onCreated={vi.fn()} />);
    expect(mode("Clip")).toHaveAttribute("aria-pressed", "true");
    expect(mode("Music")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Script mode/i })).not.toBeInTheDocument();
    fireEvent.click(mode("Music"));
    expect(mode("Music")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Short form · 9:16/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: "Auto" })).not.toBeInTheDocument();
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
    expect(screen.queryByRole("textbox", { name: "Top text" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Hook text" }));
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

  it("offers the typography themes, an independent lyric animation selector and a still preview under reduced motion", async () => {
    const matchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({ matches: query.includes("reduce"), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })) as unknown as typeof window.matchMedia;
    try {
      vi.mocked(createClipJob).mockResolvedValue({ project: { ...project, sourceProfile: "music" }, job: undefined as never });
      render(<ProjectsView health={health} onCreated={vi.fn()} />);
      fireEvent.click(mode("Music"));
      const themeGroup = within(screen.getByRole("group", { name: "Lyrics subtitle theme" }));
      for (const label of ["Condensed black", "Condensed white", "Handwritten stack"]) expect(themeGroup.getByRole("button", { name: new RegExp(`^${label}$`) })).toBeVisible();
      const animations = within(screen.getByRole("group", { name: "Lyric animation" }));
      expect(animations.getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Original", "Slow fade", "Line crossfade", "Word build"]);
      expect(animations.getByRole("button", { name: "Original" })).toHaveAttribute("aria-pressed", "true");
      // Reduced motion: the sample starts still and only animates after an explicit Play.
      const preview = document.querySelector(".lyric-preview")!;
      expect(preview).toHaveAttribute("data-state", "still");
      fireEvent.click(animations.getByRole("button", { name: "Word build" }));
      expect(animations.getByRole("button", { name: "Word build" })).toHaveAttribute("aria-pressed", "true");
      expect(animations.getByRole("button", { name: "Original" })).toHaveAttribute("aria-pressed", "false");
      expect(document.querySelector(".lyric-preview")).toHaveAttribute("data-animation", "word_build");
      expect(document.querySelector(".lyric-preview")).toHaveAttribute("data-state", "still");
      fireEvent.click(screen.getByRole("button", { name: "Play preview" }));
      expect(document.querySelector(".lyric-preview")).toHaveAttribute("data-state", "playing");
      // Theme and animation are independent: choosing a theme keeps the animation.
      fireEvent.click(themeGroup.getByRole("button", { name: /^Handwritten stack$/ }));
      expect(animations.getByRole("button", { name: "Word build" })).toHaveAttribute("aria-pressed", "true");
      chooseFile();
      fireEvent.click(screen.getByRole("button", { name: /Create 5 short clips/i }));
      await waitFor(() => expect(createClipJob).toHaveBeenCalledTimes(1));
      expect(vi.mocked(createClipJob).mock.calls[0][0].musicPresentation).toEqual({ version: 1, subtitleTheme: "handwritten_stack", lyricAnimation: "word_build" });
    } finally {
      window.matchMedia = matchMedia;
    }
  });

  it("autoplays the sample when motion is allowed and replays on request", () => {
    render(<ProjectsView health={health} onCreated={vi.fn()} />);
    fireEvent.click(mode("Music"));
    expect(document.querySelector(".lyric-preview")).toHaveAttribute("data-state", "playing");
    fireEvent.click(within(screen.getByRole("group", { name: "Lyric animation" })).getByRole("button", { name: "Slow fade" }));
    expect(screen.getByRole("button", { name: "Replay preview" })).toBeVisible();
    expect(screen.getByRole("img", { name: /Slow fade lyric animation/ })).toBeVisible();
  });

  it("offers a hook text format only inside the checked Hook text section and keeps plain as the default", async () => {
    vi.mocked(createClipJob).mockResolvedValue({ project: { ...project, sourceProfile: "music" }, job: undefined as never });
    render(<ProjectsView health={health} onCreated={vi.fn()} />);
    fireEvent.click(mode("Music"));
    expect(screen.getByRole("checkbox", { name: "Hook text" })).not.toBeChecked();
    expect(screen.queryByRole("group", { name: "Hook text format" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Hook text" }));
    const format = within(screen.getByRole("group", { name: "Hook text format" }));
    expect(format.getByRole("button", { name: "Plain" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("img", { name: /plain hook text/i })).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "Top text" }), { target: { value: "Exact hook" } });
    chooseFile();
    fireEvent.click(screen.getByRole("button", { name: /Create 5 short clips/i }));
    await waitFor(() => expect(createClipJob).toHaveBeenCalledTimes(1));
    // Plain/Original defaults are omitted, so the config keeps its historical shape.
    expect(vi.mocked(createClipJob).mock.calls[0][0].musicPresentation).toEqual({ version: 1, subtitleTheme: "clean" });
    fireEvent.click(format.getByRole("button", { name: "White banner" }));
    expect(format.getByRole("button", { name: "White banner" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("img", { name: /white banner above the footage/i })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Create 5 short clips/i }));
    await waitFor(() => expect(createClipJob).toHaveBeenCalledTimes(2));
    expect(vi.mocked(createClipJob).mock.calls[1][0]).toMatchObject({ musicTopText: "Exact hook", musicPresentation: { version: 1, subtitleTheme: "clean", hookTextFormat: "white_banner" } });
  });

  it("does not send the banner format when Hook text is unchecked and never leaks Music options into Clip submissions", async () => {
    vi.mocked(createClipJob).mockResolvedValue({ project, job: undefined as never });
    render(<ProjectsView health={health} onCreated={vi.fn()} />);
    fireEvent.click(mode("Music"));
    fireEvent.click(within(screen.getByRole("group", { name: "Lyric animation" })).getByRole("button", { name: "Line crossfade" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Hook text" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Hook text format" })).getByRole("button", { name: "White banner" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Hook text" }));
    chooseFile();
    fireEvent.click(screen.getByRole("button", { name: /Create 5 short clips/i }));
    await waitFor(() => expect(createClipJob).toHaveBeenCalledTimes(1));
    const music = vi.mocked(createClipJob).mock.calls[0][0];
    expect(music.musicPresentation).toEqual({ version: 1, subtitleTheme: "clean", lyricAnimation: "line_crossfade" });
    expect(music.musicTopText).toBe("");
    fireEvent.click(mode("Clip"));
    fireEvent.click(screen.getByRole("button", { name: /Create 5 short clips/i }));
    await waitFor(() => expect(createClipJob).toHaveBeenCalledTimes(2));
    const clip = vi.mocked(createClipJob).mock.calls[1][0];
    for (const field of ["musicPresentation", "musicTopText", "musicAudioMode"]) expect(clip).not.toHaveProperty(field);
    expect(JSON.stringify(clip)).not.toMatch(/lyricAnimation|hookTextFormat|white_banner|line_crossfade/);
  });

  it("offers audio combination only after a song is selected and submits the choice", async () => {
    vi.mocked(createClipJob).mockResolvedValue({ project: { ...project, sourceProfile: "music" }, job: undefined as never });
    render(<ProjectsView health={health} onCreated={vi.fn()} />);
    fireEvent.click(mode("Music"));
    const only = screen.getByRole("button", { name: "Song only" });
    const mix = screen.getByRole("button", { name: "Original audio + song" });
    expect(only).toBeDisabled();
    expect(mix).toBeDisabled();
    expect(screen.getByText("Add a song to choose how audio is combined.")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Background song MP3"), { target: { files: [new File(["song"], "song.mp3", { type: "audio/mpeg" })] } });
    expect(only).toBeEnabled();
    expect(mix).toBeEnabled();
    expect(only).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(mix);
    expect(mix).toHaveAttribute("aria-pressed", "true");
    const volume = screen.getByRole("slider", { name: "Background song volume" });
    expect(volume).toHaveValue("25");
    fireEvent.change(volume, { target: { value: "10" } });
    expect(screen.getByText("Original audio at full volume · song at 10% volume")).toBeVisible();
    fireEvent.click(only);
    expect(screen.queryByRole("slider", { name: "Background song volume" })).not.toBeInTheDocument();
    fireEvent.click(mix);
    expect(screen.getByRole("slider", { name: "Background song volume" })).toHaveValue("10");
    chooseFile();
    fireEvent.click(screen.getByRole("button", { name: /Create 5 short clips/i }));
    await waitFor(() => expect(createClipJob).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createClipJob).mock.calls[0][0]).toMatchObject({ sourceProfile: "music", musicAudioMode: "mix_original", musicSongGain: 0.1 });
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

  it("omits Music-only settings from Clip submissions and avoids stale setting leaks", async () => {
    vi.mocked(createClipJob).mockResolvedValue({ project, job: undefined as never });
    render(<ProjectsView health={health} onCreated={vi.fn()} />);
    chooseFile();
    fireEvent.click(screen.getByRole("button", { name: /Create 5 short clips/i }));
    await waitFor(() => expect(createClipJob).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createClipJob).mock.calls[0][0]).not.toHaveProperty("musicPresentation");
    expect(vi.mocked(createClipJob).mock.calls[0][0]).not.toHaveProperty("musicTopText");
    expect(vi.mocked(createClipJob).mock.calls[0][0]).not.toHaveProperty("musicAudioMode");

    fireEvent.click(mode("Music"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Hook text" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Top text" }), { target: { value: "Do not leak" } });
    fireEvent.click(mode("Music"));
    chooseFile();
    fireEvent.click(screen.getByRole("button", { name: /Create 5 short clips/i }));
    await waitFor(() => expect(createClipJob).toHaveBeenCalledTimes(2));
    expect(vi.mocked(createClipJob).mock.calls[1][0]).toMatchObject({ musicTopText: "Do not leak", musicPresentation: { version: 1, subtitleTheme: "clean" } });
  });
});
