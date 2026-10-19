import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "../types";
import { ProcessingState } from "./processing-state";

// ---------------------------------------------------------------
const activeJob: Job = {
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

// Make every test use deterministic fake time.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-13T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------
describe("ProcessingState – stage, progress & items", () => {
  it("renders stage label (in heading strong), progress percentage, and item count", () => {
    render(<ProcessingState job={activeJob} />);
    const headingStrong = document.querySelector(".processing-heading strong")!;
    expect(headingStrong).toHaveTextContent("Transcribing audio");
    expect(screen.getByText("37%")).toBeInTheDocument();
    expect(screen.getByText("2 of 5 items")).toBeInTheDocument();
  });

  it("omits the detail line when item count is zero", () => {
    const zeroItem: Job = { ...activeJob, currentItem: 0, totalItems: 0 };
    render(<ProcessingState job={zeroItem} />);
    expect(document.querySelector(".processing-heading small")).toBeNull();
    expect(screen.queryByText("0 of 0 items")).not.toBeInTheDocument();
  });

  it("renders the reassurance paragraph", () => {
    render(<ProcessingState job={activeJob} />);
    expect(
      screen.getByText("Processing continues if you leave this screen."),
    ).toBeInTheDocument();
  });

  it("clamps progress to 100% when over", () => {
    const over: Job = { ...activeJob, progress: 130 };
    render(<ProcessingState job={over} />);
    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
  });

  it("clamps progress to 0% when negative", () => {
    const under: Job = { ...activeJob, progress: -5 };
    render(<ProcessingState job={under} />);
    expect(screen.getByText("0%")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
  });
});

// ---------------------------------------------------------------
describe("ProcessingState – progress bar", () => {
  it("fills the single progress bar to the job progress", () => {
    const { container } = render(<ProcessingState job={activeJob} />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "37");
    expect((container.querySelector(".processing-progress-bar span") as HTMLElement).style.width).toBe("37%");
  });
});

// ---------------------------------------------------------------
describe("ProcessingState – waitingForEngine", () => {
  it("shows engine-waiting label and hides job stage label", () => {
    render(<ProcessingState job={activeJob} waitingForEngine />);
    const headingStrong = document.querySelector(".processing-heading strong")!;
    expect(headingStrong).toHaveTextContent("Waiting for the local engine");
    expect(screen.queryByText("Transcribing audio")).not.toBeInTheDocument();
  });

  it("still shows progress and items when waiting for engine", () => {
    render(<ProcessingState job={activeJob} waitingForEngine />);
    expect(screen.getByText("37%")).toBeInTheDocument();
    expect(screen.getByText("2 of 5 items")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------
describe("ProcessingState – state-dependent labels", () => {
  it("paused state shows 'Processing paused'", () => {
    const paused: Job = { ...activeJob, state: "paused" };
    render(<ProcessingState job={paused} />);
    const headingStrong = document.querySelector(".processing-heading strong")!;
    expect(headingStrong).toHaveTextContent("Processing paused");
  });

  it("recovered state shows 'Recovering checkpointed work'", () => {
    const recovered: Job = { ...activeJob, state: "recovered" };
    render(<ProcessingState job={recovered} />);
    const headingStrong = document.querySelector(".processing-heading strong")!;
    expect(headingStrong).toHaveTextContent("Recovering checkpointed work");
  });

  it("complete state uses job.stageLabel without override", () => {
    const complete: Job = { ...activeJob, state: "complete", stageLabel: "Finished" };
    render(<ProcessingState job={complete} />);
    const headingStrong = document.querySelector(".processing-heading strong")!;
    expect(headingStrong).toHaveTextContent("Finished");
  });

  it("queued state uses job.stageLabel", () => {
    const queued: Job = { ...activeJob, state: "queued", stageLabel: "Queued for processing" };
    render(<ProcessingState job={queued} />);
    const headingStrong = document.querySelector(".processing-heading strong")!;
    expect(headingStrong).toHaveTextContent("Queued for processing");
  });
});

// ---------------------------------------------------------------
describe("ProcessingState – elapsed time", () => {
  it("displays elapsed time, starting at 0:00", () => {
    render(<ProcessingState job={activeJob} />);
    expect(document.querySelector(".processing-meta")).toHaveTextContent(/Elapsed\s*0:00/);
  });

  it("updates elapsed time after advancing fake timers", () => {
    render(<ProcessingState job={activeJob} />);
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(document.querySelector(".processing-meta")).toHaveTextContent(/Elapsed\s*0:05/);
  });

  it("does not tick when job is terminal (complete)", () => {
    const complete: Job = { ...activeJob, state: "complete" };
    render(<ProcessingState job={complete} />);
    expect(document.querySelector(".processing-meta")).toHaveTextContent(/Elapsed\s*0:00/);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    // Should still be 0:00 — no interval runs
    expect(document.querySelector(".processing-meta")).toHaveTextContent(/Elapsed\s*0:00/);
  });

  it("does not tick when job is paused", () => {
    const paused: Job = { ...activeJob, state: "paused" };
    render(<ProcessingState job={paused} />);
    expect(document.querySelector(".processing-meta")).toHaveTextContent(/Elapsed\s*0:00/);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(document.querySelector(".processing-meta")).toHaveTextContent(/Elapsed\s*0:00/);
  });
});

// ---------------------------------------------------------------
describe("ProcessingState – accessibility", () => {
  it("announces stage label via aria-live polite region", () => {
    render(<ProcessingState job={activeJob} />);
    const live = document.querySelector(".processing-live");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveTextContent("Transcribing audio");
    // Should also be in the sr-only class
    expect(live!.className).toContain("sr-only");
  });

});

// ---------------------------------------------------------------
describe("ProcessingState – meta row", () => {
  it("renders elapsed time once, with the item count only in the heading", () => {
    render(<ProcessingState job={activeJob} />);
    const meta = document.querySelector(".processing-meta");
    expect(meta).toHaveTextContent(/Elapsed\s*0:00/);
    expect(meta).not.toHaveTextContent(/2 of 5/);
  });
});

// ---------------------------------------------------------------
describe("ProcessingState – download", () => {
  const download = {
    downloadedBytes: 7_340_032, totalBytes: 50_000_000, percent: 14.68, phase: "downloading" as const,
    lastProgressAt: "2026-08-13T00:00:00Z", speedBytesPerSecond: 1_200_000, etaSeconds: 36,
    message: "Receiving the source", resumable: true,
  };

  it("shows a download panel while the download is live", () => {
    render(<ProcessingState job={{ ...activeJob, downloadProgress: download }} />);
    const panel = screen.getByRole("region", { name: "Download status" });
    expect(panel).toHaveTextContent("15%");
    expect(panel).toHaveTextContent("Receiving the source");
  });

  it("collapses a finished download into one Source fact", () => {
    const done = { ...download, downloadedBytes: 50_000_000, percent: 100, phase: "complete" as const, message: null };
    render(<ProcessingState job={{ ...activeJob, downloadProgress: done }} />);
    expect(screen.queryByRole("region", { name: "Download status" })).not.toBeInTheDocument();
    expect(document.querySelector(".processing-meta")).toHaveTextContent(/Source/);
  });
});