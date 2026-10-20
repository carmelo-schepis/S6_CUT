import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { asset, downloadTask, finishedJob, overview, runningJob } from "./mobile-fixtures";
import { MobileApp } from "./mobile-app";

const api = vi.hoisted(() => ({
  getMobileOverview: vi.fn(),
  listRecentClips: vi.fn(),
  listAssetsPage: vi.fn(),
  listFolders: vi.fn(),
  readableError: (error: unknown) => error instanceof Error ? error.message : "Unavailable",
}));
vi.mock("../../api", () => api);

const busy = () => overview({
  running: [runningJob()],
  recent: [finishedJob()],
  recentTotal: 1,
  downloads: [downloadTask()],
  clipsLastDay: 14,
  failedLastDay: 1,
});

describe("iPhone/iPad status view", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = "";
    window.scrollTo = vi.fn();
    api.getMobileOverview.mockResolvedValue(busy());
    api.listRecentClips.mockResolvedValue({ items: [asset()], page: 1, pageSize: 12, hasMore: false, total: 103 });
    api.listAssetsPage.mockResolvedValue({ items: [asset(), asset({ id: "asset-2", title: "Source video", origin: "project-source" })], page: 1, pageSize: 24, hasMore: false });
    api.listFolders.mockResolvedValue([{ id: "unsorted", name: "Unsorted", parentId: null, description: "", color: null, archived: false, system: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" }]);
  });

  it("opens on Home with the wallpaper, a live headline and quick links, and has no search field", async () => {
    const { container } = render(<MobileApp />);
    expect(await screen.findByRole("heading", { level: 1, name: "2 jobs running" })).toBeInTheDocument();
    expect(container.querySelector<HTMLElement>(".m-app")).toHaveAttribute("data-tab", "home");
    expect(screen.getByRole("button", { name: /2 running/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /14 new clips/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /1 failed/ })).toBeInTheDocument();
    expect(screen.getByText("Local engine")).toBeInTheDocument();
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    // Running work with its progress, then recent clips, then recent runs.
    expect(screen.getByRole("heading", { name: "Running now" })).toBeInTheDocument();
    expect(within(container.querySelector<HTMLElement>(".m-home")!).getByText("Studio session")).toBeInTheDocument();
    expect(within(container.querySelector<HTMLElement>(".m-home")!).getByText("How I edit Shorts")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Preview Scene 12 – Hal Jordan" })).toBeInTheDocument();
    expect(within(container.querySelector<HTMLElement>(".m-home")!).getByText("Podcast ep 12")).toBeInTheDocument();
    // Recent clips close the page, under Recent runs, so they get the remaining space.
    const order = ["Running now", "Recent runs", "Recent clips"].map((name) => screen.getByRole("heading", { level: 2, name }));
    expect(order[0].compareDocumentPosition(order[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(order[1].compareDocumentPosition(order[2]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("switches tabs from the navigation, keeps the tab in the address, and only Home carries the wallpaper", async () => {
    const { container } = render(<MobileApp />);
    await screen.findByRole("heading", { level: 1, name: "2 jobs running" });
    const nav = screen.getByRole("navigation");
    fireEvent.click(within(nav).getByRole("button", { name: /Library/ }));
    expect(await screen.findByRole("heading", { level: 1, name: "Library" })).toBeInTheDocument();
    expect(window.location.hash).toBe("#/library");
    expect(container.querySelector<HTMLElement>(".m-app")).toHaveAttribute("data-tab", "library");
    expect(within(nav).getByRole("button", { name: /Library/ })).toHaveAttribute("aria-current", "page");
    fireEvent.click(within(nav).getByRole("button", { name: /Jobs/ }));
    expect(await screen.findByRole("heading", { level: 1, name: "Jobs" })).toBeInTheDocument();
    expect(container.querySelector<HTMLElement>(".m-app")).toHaveAttribute("data-tab", "jobs");
    // The badge counts work in progress (two running, none queued).
    expect(within(nav).getByRole("button", { name: "Jobs, 2 in progress" })).toBeInTheDocument();
    fireEvent.click(within(nav).getByRole("button", { name: /Home/ }));
    expect(await screen.findByRole("heading", { level: 1, name: "2 jobs running" })).toBeInTheDocument();
  });

  it("prepares all tabs once and retains their images, filters and data on revisit", async () => {
    const { container } = render(<MobileApp />);
    await screen.findByRole("heading", { name: "2 jobs running" });
    await waitFor(() => expect(api.listAssetsPage).toHaveBeenCalled());
    const home = container.querySelector<HTMLElement>(".m-home");
    const logo = container.querySelector<HTMLElement>(".m-hero-mark");
    const library = container.querySelector<HTMLElement>(".m-library");
    const jobs = container.querySelector<HTMLElement>(".m-jobs");
    const nav = screen.getByRole("navigation");
    fireEvent.click(within(nav).getByRole("button", { name: "Library" }));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "hal" } });
    await waitFor(() => expect(api.listAssetsPage).toHaveBeenLastCalledWith(expect.objectContaining({ search: "hal" })));
    const calls = api.listAssetsPage.mock.calls.length;
    fireEvent.click(within(nav).getByRole("button", { name: /Jobs/ }));
    expect(await screen.findByRole("heading", { name: "Jobs" })).toBeVisible();
    fireEvent.click(within(nav).getByRole("button", { name: "Home" }));
    expect(container.querySelector<HTMLElement>(".m-home")).toBe(home);
    expect(container.querySelector<HTMLElement>(".m-hero-mark")).toBe(logo);
    fireEvent.click(within(nav).getByRole("button", { name: "Library" }));
    expect(container.querySelector<HTMLElement>(".m-library")).toBe(library);
    expect(container.querySelector<HTMLElement>(".m-jobs")).toBe(jobs);
    expect(screen.getByRole("searchbox")).toHaveValue("hal");
    expect(api.listAssetsPage).toHaveBeenCalledTimes(calls);
    expect(api.listRecentClips).toHaveBeenCalledTimes(1);
  });

  it("updates tabs immediately through history state and follows Back/Forward events", async () => {
    render(<MobileApp />);
    await screen.findByRole("heading", { name: "2 jobs running" });
    fireEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name: "Library" }));
    expect(screen.getByRole("heading", { name: "Library" })).toBeVisible();
    act(() => {
      window.history.replaceState(null, "", "#/jobs");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.getByRole("heading", { name: "Jobs" })).toBeVisible();
  });

  it("follows the address on Back and on first load", async () => {
    window.location.hash = "#/jobs";
    const { container } = render(<MobileApp />);
    expect(await screen.findByRole("heading", { level: 1, name: "Jobs" })).toBeInTheDocument();
    act(() => { window.location.hash = "#/library"; });
    await waitFor(() => expect(container.querySelector<HTMLElement>(".m-app")).toHaveAttribute("data-tab", "library"));
  });

  it("quick links jump to the tab that explains them", async () => {
    render(<MobileApp />);
    fireEvent.click(await screen.findByRole("button", { name: /14 new clips/ }));
    expect(await screen.findByRole("heading", { level: 1, name: "Library" })).toBeInTheDocument();
  });

  it("shows running work on Jobs with progress, byte detail, live steps and finished clips, then previews one in a single player", async () => {
    window.location.hash = "#/jobs";
    render(<MobileApp />);
    expect(await screen.findByRole("heading", { level: 2, name: "Running" })).toBeInTheDocument();
    const work = screen.getAllByRole("article");
    const job = work.find((node) => node.textContent?.includes("Studio session"))!;
    expect(within(job).getByText(/Rendering clips · 5 of 8/)).toBeInTheDocument();
    expect(within(job).getByLabelText("Rendering clips: 62%")).toBeInTheDocument();
    expect(within(job).getByText("Render clips")).toBeInTheDocument();
    expect(within(job).getByText("2 clips ready so far")).toBeInTheDocument();
    expect(within(job).getByText("1 of 2 done")).toBeInTheDocument();
    const download = work.find((node) => node.textContent?.includes("How I edit Shorts"))!;
    expect(within(download).getByText(/1\.5 MB of 4\.0 MB/)).toBeInTheDocument();
    expect(within(download).getByLabelText("Downloading: 38%")).toBeInTheDocument();
    // Previews are stills until a customer taps one: no video element exists yet.
    expect(document.querySelectorAll("video")).toHaveLength(0);
    fireEvent.click(within(job).getByRole("button", { name: "Preview Cold open" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.querySelectorAll("video")).toHaveLength(1);
    expect(dialog.querySelector("video")).toHaveAttribute("src", "/preview/clip-a.mp4?sig=1");
    fireEvent.click(screen.getByRole("button", { name: "Close video preview" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("groups finished work by day, expands a run into its clips, and can load older jobs", async () => {
    window.location.hash = "#/jobs";
    api.getMobileOverview.mockResolvedValue(overview({ recent: [finishedJob()], recentTotal: 45 }));
    render(<MobileApp />);
    expect(await screen.findByRole("heading", { level: 2, name: "Today" })).toBeInTheDocument();
    const run = within(document.querySelector<HTMLElement>(".m-jobs")!).getByText("Podcast ep 12").closest("article")!;
    expect(within(run).getByText(/Serious · .* · 8 outputs ready/)).toBeInTheDocument();
    fireEvent.click(within(run).getByRole("button", { expanded: false }));
    expect(within(run).getByRole("button", { name: "Preview Best moment" })).toBeInTheDocument();
    api.getMobileOverview.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /Show older jobs \(44 more\)/ }));
    await waitFor(() => expect(api.getMobileOverview).toHaveBeenCalledWith(40));
  });

  it("lists the Library with the desktop's filters, debounced search and an explicit video preview", async () => {
    window.location.hash = "#/library";
    render(<MobileApp />);
    expect(await screen.findByRole("button", { name: "Preview Scene 12 – Hal Jordan" })).toBeInTheDocument();
    expect(api.listAssetsPage).toHaveBeenLastCalledWith({ search: undefined, mediaType: undefined, origin: undefined, folderId: undefined, page: 1, pageSize: 24 });
    fireEvent.change(screen.getByLabelText("Media type"), { target: { value: "video" } });
    fireEvent.change(screen.getByLabelText("Asset origin"), { target: { value: "generated-clip" } });
    fireEvent.change(screen.getByLabelText("Folder"), { target: { value: "unsorted" } });
    fireEvent.change(screen.getByLabelText("Search media"), { target: { value: "hal" } });
    await waitFor(() => expect(api.listAssetsPage).toHaveBeenLastCalledWith({ search: "hal", mediaType: "video", origin: "generated-clip", folderId: "unsorted", page: 1, pageSize: 24 }));
    expect(document.querySelectorAll("video")).toHaveLength(0);
    fireEvent.click(await screen.findByRole("button", { name: "Preview Scene 12 – Hal Jordan" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("pages the Library in 24s as more is asked for", async () => {
    window.location.hash = "#/library";
    api.listAssetsPage
      .mockResolvedValueOnce({ items: [asset()], page: 1, pageSize: 24, hasMore: true })
      .mockResolvedValue({ items: [asset({ id: "asset-9", title: "Older clip" })], page: 2, pageSize: 24, hasMore: false });
    render(<MobileApp />);
    expect(await screen.findByText("Older clip")).toBeInTheDocument();
    expect(api.listAssetsPage).toHaveBeenCalledWith(expect.objectContaining({ page: 2 }));
    expect(within(document.querySelector<HTMLElement>(".m-library")!).getByText("Scene 12 – Hal Jordan")).toBeInTheDocument();
  });

  it("says so plainly when the engine cannot be reached, and retries on request", async () => {
    api.getMobileOverview.mockRejectedValueOnce(new Error("The local engine did not respond within 20s.")).mockResolvedValue(busy());
    render(<MobileApp />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Engine unavailable. The local engine did not respond within 20s.");
    expect(screen.getByText("Engine offline")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { level: 1, name: "2 jobs running" })).toBeInTheDocument();
  });

  it("shows an empty state when there is no work and no clips, and offers no controls that change anything", async () => {
    api.getMobileOverview.mockResolvedValue(overview());
    api.listRecentClips.mockResolvedValue({ items: [], page: 1, pageSize: 12, hasMore: false, total: 0 });
    render(<MobileApp />);
    expect(await screen.findByRole("heading", { level: 1, name: "Nothing running" })).toBeInTheDocument();
    expect(screen.getByText(/Nothing to show yet/)).toBeInTheDocument();
    for (const label of [/pause/i, /resume/i, /retry import/i, /delete/i, /stop/i]) expect(screen.queryByRole("button", { name: label })).toBeNull();
  });

  it("stops zoom-on-focus for this view only, and restores the viewport on exit", async () => {
    const meta = document.createElement("meta");
    meta.name = "viewport";
    meta.content = "width=device-width, initial-scale=1, viewport-fit=cover";
    document.head.appendChild(meta);
    const { unmount } = render(<MobileApp />);
    await screen.findByRole("heading", { level: 1, name: "2 jobs running" });
    expect(meta.content).toContain("maximum-scale=1");
    unmount();
    expect(meta.content).toBe("width=device-width, initial-scale=1, viewport-fit=cover");
    meta.remove();
  });
});
