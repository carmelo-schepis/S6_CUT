import { describe, expect, it } from "vitest";
import type { DownloadProgress, Job } from "./types";
import { downloadFacts, downloadPhaseLabel, formatEta, formatSeconds, groupWarnings, jobFacts, statesCount } from "./status-format";

const download: DownloadProgress = {
  downloadedBytes: 148_100_000,
  totalBytes: 148_100_000,
  percent: 100,
  phase: "downloading",
  speedBytesPerSecond: 2_400_000,
  etaSeconds: 125,
  lastProgressAt: "2026-08-13T00:00:00Z",
  message: null,
  resumable: true,
};

const job: Job = {
  schemaVersion: 1,
  id: "j1",
  projectId: "p1",
  mode: "clip",
  state: "active",
  stage: "transcribing",
  stageLabel: "Transcribing audio",
  progress: 37,
  currentItem: 2,
  totalItems: 5,
  style: "serious",
  processingMode: "auto",
  warnings: [],
  error: null,
  clips: [],
  beats: [],
  steps: [],
  createdAt: "2026-08-13T00:00:00Z",
  updatedAt: "2026-08-13T00:00:00Z",
};

describe("groupWarnings", () => {
  it("collapses the same warning repeated per clip into one row with a range", () => {
    const groups = groupWarnings([
      "Clip 1: No speech detected; exported without captions.",
      "Clip 2: No speech detected; exported without captions.",
      "Clip 3: No speech detected; exported without captions.",
      "Clip 4: No speech detected; exported without captions.",
      "Clip 5: No speech detected; exported without captions.",
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual({ message: "No speech detected; exported without captions.", scope: "Clips 1–5", count: 5 });
  });

  it("lists non-contiguous clips individually and keeps a single clip singular", () => {
    expect(groupWarnings(["Clip 1: Muted", "Clip 4: Muted"])[0].scope).toBe("Clips 1, 4");
    expect(groupWarnings(["Clip 3: Muted"])[0].scope).toBe("Clip 3");
  });

  it("keeps distinct messages separate and preserves engine order", () => {
    const groups = groupWarnings(["Planned 5 windows", "Clip 1: No speech", "3 recorded outputs missing"]);
    expect(groups.map((group) => group.message)).toEqual(["Planned 5 windows", "No speech", "3 recorded outputs missing"]);
    expect(groups[0].scope).toBeNull();
  });

  it("ignores blank warnings", () => {
    expect(groupWarnings(["", "   "])).toEqual([]);
  });
});

describe("downloadFacts", () => {
  it("returns discrete values rather than one concatenated sentence", () => {
    const facts = downloadFacts(download);
    expect(facts.transferred).toBe("141.2 MB of 141.2 MB");
    expect(facts.speed).toBe("2.3 MB/s");
    expect(facts.eta).toBe("about 3 min left");
    expect(facts.phase).toBe("Downloading");
  });

  it("omits the total when the engine does not know it", () => {
    expect(downloadFacts({ ...download, totalBytes: null, percent: null }).transferred).toBe("141.2 MB");
    expect(downloadFacts({ ...download, percent: null }).percent).toBeNull();
  });

  it("clamps an out-of-range percentage instead of rendering it", () => {
    expect(downloadFacts({ ...download, percent: 140 }).percent).toBe(100);
    expect(downloadFacts({ ...download, percent: -5 }).percent).toBe(0);
  });

  it("gives every phase a readable label", () => {
    expect(downloadPhaseLabel("stopped_partial")).toBe("Stopped — partial file kept");
    expect(downloadPhaseLabel("complete")).toBe("Downloaded");
  });
});

describe("jobFacts", () => {
  it("uses the job stage and item count when no download is live", () => {
    expect(jobFacts(job)).toEqual({ stage: "Transcribing audio", detail: "2 of 5", percent: 37, indeterminate: false });
  });

  it("prefers a live download over the job stage", () => {
    const facts = jobFacts({ ...job, downloadProgress: { ...download, percent: 42 } });
    expect(facts.stage).toBe("Downloading");
    expect(facts.detail).toBe("141.2 MB of 141.2 MB");
    expect(facts.percent).toBe(42);
  });

  it("falls back to the job stage once the download has completed", () => {
    expect(jobFacts({ ...job, downloadProgress: { ...download, phase: "complete" } }).stage).toBe("Transcribing audio");
  });

  it("never prints an item count larger than its total", () => {
    expect(jobFacts({ ...job, currentItem: 263, totalItems: 9 }).detail).toBeNull();
    expect(jobFacts({ ...job, currentItem: 9, totalItems: 9 }).detail).toBe("9 of 9");
  });

  it("marks a download with no percentage as indeterminate", () => {
    expect(jobFacts({ ...job, downloadProgress: { ...download, percent: null } }).indeterminate).toBe(true);
  });
});

describe("statesCount", () => {
  it("finds a count the text already states, with or without a unit", () => {
    expect(statesCount("Rendering clip 2 of 5", 2)).toBe(true);
    expect(statesCount("Transcribing music — 575s of 1161s", 575)).toBe(true);
    expect(statesCount("575 of 1162", 575)).toBe(true);
  });

  it("ignores other numbers and text without a count", () => {
    expect(statesCount("Rendering clip 12 of 15", 2)).toBe(false);
    expect(statesCount("Rendering output 3", 3)).toBe(false);
    expect(statesCount("Checked 856 words", 856)).toBe(false);
    expect(statesCount("Downloaded 1.575 of 4 GB", 575)).toBe(false);
    expect(statesCount(null, 5)).toBe(false);
    expect(statesCount("Rendering clip 2 of 5", null)).toBe(false);
  });
});

describe("time formatting", () => {
  it("formats seconds as m:ss and h:mm:ss", () => {
    expect(formatSeconds(5)).toBe("0:05");
    expect(formatSeconds(125)).toBe("2:05");
    expect(formatSeconds(3725)).toBe("1:02:05");
  });

  it("returns null for a missing or negative eta", () => {
    expect(formatEta(null)).toBeNull();
    expect(formatEta(-1)).toBeNull();
    expect(formatEta(30)).toBe("about 30s left");
  });
});
