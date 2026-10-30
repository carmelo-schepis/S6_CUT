import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Health, Project } from "../types";
import { CAPTION_PRESETS, musicEditingPresentation, speechEditingPresentation } from "../editing-presets";
import { ProjectsView } from "./projects-view";

vi.mock("../api", () => ({
  readableError: (error: unknown) => error instanceof Error ? error.message : "Unexpected error",
  createClipJob: vi.fn(),
  listRecentClips: vi.fn(async () => ({ items: [], page: 1, pageSize: 12, hasMore: false, total: 0 })),
  listFolders: vi.fn(async () => []), createFolder: vi.fn(),
}));
import { createClipJob } from "../api";

/** Opens every collapsed option row, as a customer would to reach its controls. */
const openOptions = () => screen.queryAllByRole("button").filter((button) => button.classList.contains("create-option-toggle") && button.getAttribute("aria-expanded") === "false").forEach((button) => fireEvent.click(button));

const health: Health = {
  status: "ready", version: "test", database: true, ffmpeg: true, ffprobe: true, whisper: true,
  ytdlp: true, dataPath: "Local mounted data directory", freeBytes: 1_000_000,
  activeWorkers: 0, queuedJobs: 0, fallbacks: { planning: "deterministic" },
};
const project: Project = {
  schemaVersion: 1, id: "created-project", name: "Style", mode: "clip", style: "educational", state: "queued",
  sourceName: "source.mp4", sourceKind: "upload", requestedCount: 5, latestJobId: "job",
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
};
const mode = (name: "Clip" | "Music") => screen.getByRole("button", { name: new RegExp(name === "Clip" ? "^Clip(?: mode)?$" : "^Music(?: / sung vocals)?$", "i") });
const chooseFile = () => fireEvent.change(screen.getByLabelText("Choose video file"), { target: { files: [new File(["video"], "talk.mp4", { type: "video/mp4" })] } });
const group = (name: string) => within(screen.getByRole("group", { name }));
const pressed = (name: string, option: string) => group(name).getByRole("button", { name: new RegExp(`^${option}$`) });
const submit = async () => {
  fireEvent.click(screen.getByRole("button", { name: /Create 5 short clips/i }));
  await waitFor(() => expect(createClipJob).toHaveBeenCalled());
  return vi.mocked(createClipJob).mock.calls.at(-1)![0];
};

beforeEach(() => { vi.mocked(createClipJob).mockReset(); vi.mocked(createClipJob).mockResolvedValue({ project, job: undefined as never }); });
afterEach(() => vi.useRealTimers());

describe("regular subtitle styles", () => {
  it("shows the twelve cards under the unchanged editorial intents and submits nothing by default", async () => {
    render(<ProjectsView health={health} onCreated={vi.fn()} />);
    openOptions();
    const cards = group("Subtitle style").getAllByRole("button");
    expect(cards.map((card) => card.getAttribute("aria-label"))).toEqual(CAPTION_PRESETS.map((item) => item.label));
    expect(cards).toHaveLength(12);
    expect(cards.filter((card) => card.getAttribute("aria-pressed") === "true")).toHaveLength(1);
    expect(pressed("Subtitle style", "Editorial default")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByRole("button", { name: /^(Funny|Serious|Educational|Hype)/ })).toHaveLength(4);
    // Same sample words on every card, and the editorial heading stays above the visual choices.
    for (const card of cards) expect(card.textContent).toMatch(/Small|changes|make|clear|difference/);
    chooseFile();
    const payload = await submit();
    expect(payload).not.toHaveProperty("editingPresentation");
    expect(payload.style).toBe("educational");
  });

  it("keeps the editorial intent separate from the visual preset and sends only the changed choices", async () => {
    render(<ProjectsView health={health} onCreated={vi.fn()} />);
    openOptions();
    fireEvent.click(screen.getByRole("button", { name: /^Hype/ }));
    for (const card of CAPTION_PRESETS) {
      fireEvent.click(pressed("Subtitle style", card.label));
      expect(pressed("Subtitle style", card.label)).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByText(card.font === "By Editorial style" ? "Montserrat ExtraBold Italic" : card.font, { selector: "dd" })).toBeVisible();
    }
    fireEvent.click(pressed("Subtitle style", "Word pop"));
    fireEvent.click(pressed("Video filter", "Warm"));
    expect(screen.getByRole("button", { name: /^Hype/ })).toHaveAttribute("aria-pressed", "true");
    chooseFile();
    const payload = await submit();
    expect(payload.style).toBe("hype");
    expect(payload.editingPresentation).toEqual({ version: 1, captionPreset: "word_pop", videoFilter: "warm" });
  });

  it("matches Editorial default phrase size and emphasis to the selected intent", () => {
    render(<ProjectsView health={health} onCreated={vi.fn()} />);
    openOptions();
    const selectedSample = () => document.querySelector(".speech-frame-caption .caption-sample")!;

    fireEvent.click(screen.getByRole("button", { name: /^Serious/ }));
    expect(selectedSample()).toHaveAttribute("data-editorial", "serious");
    expect(selectedSample()).toHaveAttribute("data-editorial-emphasis", "none");
    expect(selectedSample().querySelectorAll(".cap-phrase .cap-word")).toHaveLength(6);
    expect(screen.getByText("None; stable colour", { selector: "dd" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /^Educational/ }));
    expect(selectedSample()).toHaveAttribute("data-editorial", "educational");
    expect(selectedSample().querySelectorAll(".cap-phrase .cap-word")).toHaveLength(4);
    expect(screen.getByText("Lower third, 4-word phrases", { selector: "dd" })).toBeVisible();
  });

  it("plays the selected sample, replays it, and starts still under reduced motion", () => {
    vi.useFakeTimers();
    const matchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({ matches: query.includes("reduce"), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })) as unknown as typeof window.matchMedia;
    try {
      render(<ProjectsView health={health} onCreated={vi.fn()} />);
      openOptions();
      const sample = () => document.querySelector(".speech-frame-caption .caption-sample")!;
      expect(screen.getByRole("button", { name: "Play sample" })).toBeVisible();
      expect(sample()).toHaveAttribute("data-play", "false");
      fireEvent.click(screen.getByRole("button", { name: "Play sample" }));
      expect(sample()).toHaveAttribute("data-play", "true");
      expect(screen.getByRole("button", { name: "Replay sample" })).toBeVisible();
      expect(sample().querySelector('[data-state="active"]')).toHaveTextContent("Small");
      for (let tick = 0; tick < 2; tick += 1) act(() => { vi.advanceTimersByTime(520); });
      expect(sample().querySelector('[data-state="active"]')).toHaveTextContent("make");
      for (let tick = 0; tick < 6; tick += 1) act(() => { vi.advanceTimersByTime(520); });
      expect(sample()).toHaveAttribute("data-play", "false");
    } finally { window.matchMedia = matchMedia; }
  });

  it("reflects the heading, filter and sparse emoji in the sample without enabling the heading", async () => {
    render(<ProjectsView health={health} onCreated={vi.fn()} />);
    openOptions();
    const hook = screen.getByRole("checkbox", { name: "Hook text" });
    fireEvent.click(pressed("Heading appearance", "Dark box"));
    expect(hook).not.toBeChecked();
    expect(document.querySelector(".speech-frame .heading-sample")).toBeNull();
    fireEvent.click(pressed("Emoji reactions", "Sparse"));
    expect(document.querySelector(".speech-frame .reaction-sample")).not.toBeNull();
    fireEvent.click(pressed("Video filter", "Black & white"));
    expect(document.querySelector('.speech-frame .style-footage[data-filter="black_white"]')).not.toBeNull();
    fireEvent.click(hook);
    expect(document.querySelector(".speech-frame .heading-dark_box")).toHaveTextContent("Your heading here");
    fireEvent.click(hook);
    chooseFile();
    const payload = await submit();
    expect(payload).not.toHaveProperty("hookText");
    expect(payload.editingPresentation).toEqual({ version: 1, videoFilter: "black_white", headingStyle: "dark_box", emojiMode: "sparse" });
  });

  it("disables captions and emoji in Fast and with subtitles off but keeps the picture filter", async () => {
    render(<ProjectsView health={health} onCreated={vi.fn()} />);
    openOptions();
    fireEvent.click(pressed("Subtitle style", "Karaoke line"));
    fireEvent.click(pressed("Video filter", "Vintage"));
    fireEvent.click(screen.getByRole("button", { name: "Fast" }));
    expect(screen.queryByRole("group", { name: "Subtitle style" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Emoji reactions" })).toBeNull();
    expect(screen.getAllByText(/skips transcription/i).length).toBeGreaterThan(0);
    expect(screen.queryByRole("group", { name: "Heading appearance" })).toBeNull();
    chooseFile();
    expect((await submit()).editingPresentation).toEqual({ version: 1, videoFilter: "vintage" });
    // Leaving Fast keeps subtitles off until they are ticked again.
    fireEvent.click(screen.getByRole("button", { name: "Auto" }));
    expect(screen.queryByRole("group", { name: "Subtitle style" })).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: /Burn in subtitles/ }));
    expect(screen.getByRole("group", { name: "Subtitle style" })).toBeVisible();
    fireEvent.click(screen.getByRole("checkbox", { name: /Burn in subtitles/ }));
    expect(screen.queryByRole("group", { name: "Subtitle style" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Create 5 short clips/i }));
    await waitFor(() => expect(createClipJob).toHaveBeenCalledTimes(2));
    expect(vi.mocked(createClipJob).mock.calls[1][0].editingPresentation).toEqual({ version: 1, videoFilter: "vintage" });
  });
});

describe("Music additions and mode isolation", () => {
  it("adds three themes to the existing grid and keeps theme, animation and filter independent", async () => {
    render(<ProjectsView health={health} onCreated={vi.fn()} />);
    openOptions();
    fireEvent.click(mode("Music"));
    openOptions();
    expect(screen.queryByRole("group", { name: "Subtitle style" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Heading appearance" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Emoji reactions" })).toBeNull();
    expect(group("Lyrics subtitle theme").getAllByRole("button")).toHaveLength(12);
    for (const label of ["Karaoke focus", "Soft glow", "Lyric plate"]) expect(pressed("Lyrics subtitle theme", label)).toBeVisible();
    fireEvent.click(pressed("Lyrics subtitle theme", "Lyric plate"));
    fireEvent.click(pressed("Lyric animation", "Word build"));
    fireEvent.click(pressed("Music video filter", "Cool"));
    expect(pressed("Lyrics subtitle theme", "Lyric plate")).toHaveAttribute("aria-pressed", "true");
    chooseFile();
    const payload = await submit();
    expect(payload.musicPresentation).toEqual({ version: 1, subtitleTheme: "lyric_plate", lyricAnimation: "word_build" });
    expect(payload.editingPresentation).toEqual({ version: 1, videoFilter: "cool" });
  });

  it("never submits hidden settings from the other mode", async () => {
    render(<ProjectsView health={health} onCreated={vi.fn()} />);
    openOptions();
    fireEvent.click(pressed("Subtitle style", "Bold outline"));
    fireEvent.click(pressed("Video filter", "Warm"));
    fireEvent.click(pressed("Emoji reactions", "Off"));
    fireEvent.click(mode("Music"));
    openOptions();
    fireEvent.click(pressed("Lyrics subtitle theme", "Soft glow"));
    chooseFile();
    const music = await submit();
    expect(music.editingPresentation).toBeUndefined();
    expect(music.musicPresentation).toMatchObject({ subtitleTheme: "soft_glow" });
    fireEvent.click(mode("Clip"));
    openOptions();
    fireEvent.click(screen.getByRole("button", { name: /Create 5 short clips/i }));
    await waitFor(() => expect(createClipJob).toHaveBeenCalledTimes(2));
    const speech = vi.mocked(createClipJob).mock.calls[1][0];
    expect(speech.editingPresentation).toEqual({ version: 1, captionPreset: "bold_outline", videoFilter: "warm", emojiMode: "off" });
    expect(speech).not.toHaveProperty("musicPresentation");
  });
});

describe("editing presentation payload builders", () => {
  const base = { captionPreset: "editorial_default", videoFilter: "existing", headingStyle: "plain", emojiMode: "existing", captionsAvailable: true, headingAvailable: true } as const;
  it("omits everything at defaults and drops choices a path cannot honour", () => {
    expect(speechEditingPresentation(base)).toBeUndefined();
    expect(speechEditingPresentation({ ...base, captionPreset: "yellow_focus", emojiMode: "sparse", headingStyle: "white_banner", videoFilter: "vibrant", captionsAvailable: false, headingAvailable: false })).toEqual({ version: 1, videoFilter: "vibrant" });
    expect(musicEditingPresentation("existing")).toBeUndefined();
    expect(musicEditingPresentation("black_white")).toEqual({ version: 1, videoFilter: "black_white" });
  });
});

describe("option rows", () => {
  it("starts every row closed and shows each current value on its line", () => {
    render(<ProjectsView health={health} onCreated={vi.fn()} />);
    const subtitle = screen.getByRole("button", { name: "Subtitle style", exact: true });
    expect(subtitle).toHaveAttribute("aria-expanded", "false");
    expect(subtitle).toHaveAccessibleDescription("Editorial default");
    expect(screen.getByRole("button", { name: "Advanced controls", exact: true })).toHaveAccessibleDescription("9:16 · 20–60 s");
    expect(screen.queryByRole("group", { name: "Subtitle style" })).not.toBeInTheDocument();
  });

  it("keeps a choice made in a row after the row is collapsed, and still submits it", async () => {
    render(<ProjectsView health={health} onCreated={vi.fn()} />);
    const subtitle = screen.getByRole("button", { name: "Subtitle style", exact: true });
    fireEvent.click(subtitle);
    fireEvent.click(pressed("Subtitle style", "Word pop"));
    fireEvent.click(subtitle);
    expect(subtitle).toHaveAttribute("aria-expanded", "false");
    expect(subtitle).toHaveAccessibleDescription("Word pop");
    chooseFile();
    const payload = await submit();
    expect(payload.editingPresentation).toEqual({ version: 1, captionPreset: "word_pop" });
  });
});
