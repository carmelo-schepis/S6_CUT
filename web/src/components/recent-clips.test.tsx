import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryAsset } from "../types";
import { emitLibraryChanged } from "../library-sync";
import { RecentClips } from "./recent-clips";

vi.mock("../api", () => ({
  listRecentClips: vi.fn(),
  listFolders: vi.fn(async () => [{ id: "folder", name: "Campaign", createdAt: "2026-01-01", updatedAt: "2026-01-01" }]),
  readableError: (error: unknown) => error instanceof Error ? error.message : "error",
}));

import { listRecentClips } from "../api";
const recent = vi.mocked(listRecentClips);
const makeAsset = (id: string, title = "Same title"): LibraryAsset => ({
  id, title, description: "", mediaType: "video/mp4", filename: `${id}.mp4`, tags: [], triggers: [], aliases: [], negativeTriggers: [],
  policy: "neutral", protected: false, minSpacingSeconds: 0, maxUsesPerProject: 1, licence: "User supplied", attribution: "",
  contentHash: id, folderId: "folder", origin: "generated-clip", blobId: `${id}-blob`, durationSeconds: 12.4, width: 1080, height: 1920,
  previewUrl: `/signed/${id}`, brands: [], people: [], createdAt: "2026-01-01T00:00:00Z",
});
const page = (items: LibraryAsset[], total = items.length) => ({ items, page: 1, pageSize: 12, hasMore: false, total });

beforeEach(() => {
  recent.mockReset();
  recent.mockResolvedValue(page([]));
});

describe("Recent clips", () => {
  it("renders Library assets and selects a duplicate title by stable asset ID", async () => {
    const first = makeAsset("asset-first");
    const second = makeAsset("asset-second");
    recent.mockResolvedValue(page([first, second], 2));
    const select = vi.fn();
    const { container } = render(<RecentClips onSelectAsset={select} />);
    const cards = await screen.findAllByText("Same title");
    expect(cards).toHaveLength(2);
    expect(container.querySelectorAll(".recent-clip-card")).toHaveLength(2);
    const secondCard = container.querySelector('.recent-clip-card[data-asset-id="asset-second"]');
    expect(secondCard).not.toBeNull();
    const articles = container.querySelectorAll(".recent-clip-card");
    fireEvent.click(within(articles[1] as HTMLElement).getByRole("button", { name: "View in Library" }));
    expect(select).toHaveBeenCalledWith("asset-second");
    expect(articles[1]).toHaveTextContent("12s · 1080 × 1920");
    expect(articles[1]).toHaveTextContent("Campaign");
  });

  it("revalidates after an output-publication Library change event", async () => {
    const before = makeAsset("before", "Previously published");
    const after = makeAsset("after", "Newly published");
    recent.mockResolvedValueOnce(page([before])).mockResolvedValueOnce(page([after]));
    render(<RecentClips onSelectAsset={vi.fn()} />);
    expect(await screen.findByText("Previously published")).toBeInTheDocument();
    emitLibraryChanged();
    expect(await screen.findByText("Newly published", {}, { timeout: 2_000 })).toBeInTheDocument();
    expect(screen.queryByText("Previously published")).not.toBeInTheDocument();
  });

  it("fetches a fresh signed preview URL before opening and closes when the asset disappears", async () => {
    const asset = makeAsset("clip-a");
    recent.mockResolvedValueOnce(page([asset]));
    const refreshed = { ...asset, previewUrl: "/signed/clip-a-fresh" };
    recent.mockResolvedValueOnce(page([refreshed]));
    const { container } = render(<RecentClips onSelectAsset={vi.fn()} />);
    const card = (await screen.findByText("Same title")).closest("article")!;
    fireEvent.click(within(card).getByRole("button", { name: "Preview Same title" }));
    const dialog = await screen.findByRole("dialog", { name: "Same title video preview" });
    expect(dialog.querySelector("video")).toHaveAttribute("src", "/signed/clip-a-fresh");
    expect(recent).toHaveBeenLastCalledWith({ search: "", page: 1, pageSize: 12 });

    recent.mockResolvedValueOnce(page([]));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(container.querySelectorAll(".recent-clip-card")).toHaveLength(0);
  });

  it("does not let a delayed old search response replace the newest result", async () => {
    const currentAsset = makeAsset("current", "Current result");
    const staleAsset = makeAsset("stale", "Stale result");
    let resolveStale!: (value: ReturnType<typeof page>) => void;
    const staleResponse = new Promise<ReturnType<typeof page>>((resolve) => { resolveStale = resolve; });
    recent.mockResolvedValueOnce(page([currentAsset]));
    recent.mockImplementation((options) => options?.search === "slow query" ? staleResponse : Promise.resolve(options?.search ? page([]) : page([currentAsset])));
    render(<RecentClips onSelectAsset={vi.fn()} />);
    expect(await screen.findByText("Current result")).toBeInTheDocument();
    const search = screen.getByRole("searchbox", { name: "Search recent clips" });
    fireEvent.change(search, { target: { value: "slow query" } });
    await waitFor(() => expect(recent).toHaveBeenCalledWith({ search: "slow query", page: 1, pageSize: 12 }));
    fireEvent.change(search, { target: { value: "" } });
    await waitFor(() => expect(recent.mock.calls.at(-1)?.[0]).toEqual({ search: "", page: 1, pageSize: 12 }));
    resolveStale(page([staleAsset]));
    await waitFor(() => expect(screen.getByText("Current result")).toBeInTheDocument());
    expect(screen.queryByText("Stale result")).not.toBeInTheDocument();
  });

  it("shows the exact empty copy and offers retry after a failed read", async () => {
    recent.mockRejectedValueOnce(new Error("offline"));
    render(<RecentClips onSelectAsset={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("offline");
    recent.mockResolvedValueOnce(page([]));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No clips in your Library yet.")).toBeInTheDocument();
  });
});
