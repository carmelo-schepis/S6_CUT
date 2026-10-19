import { describe, expect, it } from "vitest";
import { downloadTask, finishedJob, overview, runningJob } from "./mobile-fixtures";
import { groupFinishedByDay, hasWorkInFlight, hashForTab, headline, jobSubtitle, tabFromHash, workFacts, workGroups } from "./mobile-model";

describe("tab routing", () => {
  it("reads the tab from the address and treats anything unknown as Home", () => {
    expect(tabFromHash("#/library")).toBe("library");
    expect(tabFromHash("#/jobs?x=1")).toBe("jobs");
    expect(tabFromHash("#jobs")).toBe("jobs");
    expect(tabFromHash("")).toBe("home");
    expect(tabFromHash("#/settings")).toBe("home");
  });
  it("round-trips every tab", () => {
    for (const tab of ["home", "library", "jobs"] as const) expect(tabFromHash(hashForTab(tab))).toBe(tab);
  });
});

describe("work groups", () => {
  const data = overview({
    running: [runningJob(), runningJob({ id: "job-queued", state: "queued", projectName: "Waiting", queuePosition: 1 })],
    recent: [finishedJob()],
    recentTotal: 30,
    downloads: [downloadTask(), downloadTask({ id: "q".repeat(32), state: "queued" }), downloadTask({ id: "c".repeat(32), state: "complete", updatedAt: new Date(Date.now() - 10_000).toISOString() }), downloadTask({ id: "f".repeat(32), state: "failed", error: "boom" })],
  });

  it("separates running, queued and finished work across jobs and downloads", () => {
    const groups = workGroups(data);
    expect(groups.running.map((item) => item.key)).toEqual(["job:job-running-1", `download:${"d".repeat(32)}`]);
    expect(groups.queued.map((item) => item.key)).toEqual(["job:job-queued", `download:${"q".repeat(32)}`]);
    expect(groups.finished).toHaveLength(3);
    // Newest first, whichever kind it is.
    expect(groups.finished[0].key).toBe(`download:${"f".repeat(32)}`);
  });
  it("polls fast only while something is moving", () => {
    expect(hasWorkInFlight(data)).toBe(true);
    expect(hasWorkInFlight(overview({ recent: [finishedJob()], recentTotal: 1 }))).toBe(false);
    expect(hasWorkInFlight(overview({ downloads: [downloadTask({ state: "complete" })] }))).toBe(false);
    expect(hasWorkInFlight(null)).toBe(false);
  });
  it("words the headline from the live counts", () => {
    expect(headline(workGroups(data)).title).toBe("2 jobs running");
    expect(headline(workGroups(overview({ running: [runningJob({ state: "queued" })] }))).title).toBe("1 job queued");
    expect(headline(workGroups(overview())).title).toBe("Nothing running");
  });
});

describe("work facts", () => {
  it("shows download bytes, speed and time left for a job that is still downloading", () => {
    const [item] = workGroups(overview({ running: [runningJob({
      stageLabel: "Downloading source", progress: 10,
      downloadProgress: { downloadedBytes: 1_572_864, totalBytes: 4_194_304, percent: 37.5, phase: "downloading", lastProgressAt: new Date().toISOString(), speedBytesPerSecond: 2_097_152, etaSeconds: 130, resumable: true },
    })] })).running;
    const facts = workFacts(item);
    expect(facts.stage).toBe("Downloading");
    expect(facts.detail).toBe("1.5 MB of 4.0 MB · 2.0 MB/s · about 3 min left");
    expect(facts.percent).toBe(37.5);
    expect(facts.indeterminate).toBe(false);
    expect(facts.poster).toContain("/thumbnail");
  });
  it("shows item counts for a job that is rendering", () => {
    const [item] = workGroups(overview({ running: [runningJob()] })).running;
    const facts = workFacts(item);
    expect(facts).toMatchObject({ title: "Studio session", stage: "Rendering clips", detail: "5 of 8", percent: 62, state: "active" });
    expect(jobSubtitle(item.kind === "job" ? item.job : (undefined as never))).toBe("A long talk about editing");
  });
  it("describes a download from its own title, bytes and percentage", () => {
    const [, item] = workGroups(overview({ downloads: [downloadTask(), downloadTask({ id: "x".repeat(32), percent: null, title: null, thumbnailUrl: null })] })).running;
    expect(workFacts(item)).toMatchObject({ title: "YouTube video", indeterminate: true, poster: null, detail: "1.5 MB of 4.0 MB" });
  });
});

describe("finished work by day", () => {
  it("uses the desktop Jobs page headings", () => {
    const now = new Date("2026-10-19T12:00:00");
    const items = workGroups(overview({ recent: [finishedJob({ updatedAt: "2026-10-19T09:00:00" }), finishedJob({ id: "b", updatedAt: "2026-10-18T09:00:00" }), finishedJob({ id: "c", updatedAt: "2026-10-18T08:00:00" })], recentTotal: 3 })).finished;
    expect(groupFinishedByDay(items, now).map(([label, group]) => [label, group.length])).toEqual([["Today", 1], ["Yesterday", 2]]);
  });
});
