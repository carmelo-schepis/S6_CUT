import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emitLibraryChanged } from "../library-sync";
import type { LibraryAsset, LibraryFolder } from "../types";
import { LibraryView } from "./library-view";

const folders: LibraryFolder[] = [{ id: "unsorted", name: "Unsorted", parentId: null, description: "", color: null, archived: false, system: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" }, { id: "acme", name: "Acme", parentId: null, description: "", color: null, archived: false, system: false, createdAt: "2026-01-01", updatedAt: "2026-01-01" }];
const assets: LibraryAsset[] = [
  { id: "a1", title: "Acme launch", description: "", mediaType: "video/mp4", filename: "launch.mp4", tags: ["campaign"], triggers: [], aliases: [], negativeTriggers: [], policy: "neutral", protected: false, minSpacingSeconds: 0, maxUsesPerProject: 1, licence: "Owned", attribution: "", contentHash: "h1", folderId: "acme", origin: "generated-clip", blobId: "b1", brands: ["Acme"], people: [], createdAt: "2026-01-01" },
  { id: "a2", title: "Other logo", description: "", mediaType: "image/png", filename: "logo.png", tags: [], triggers: [], aliases: [], negativeTriggers: [], policy: "required", protected: false, minSpacingSeconds: 0, maxUsesPerProject: 1, licence: "Owned", attribution: "", contentHash: "h2", folderId: "unsorted", origin: "manual-import", blobId: "b2", brands: [], people: [], createdAt: "2026-01-01" },
];

vi.mock("../api", () => ({
  listAssets: vi.fn(async () => assets), listFolders: vi.fn(async () => folders), getHealth: vi.fn().mockRejectedValue(new Error("offline")), explainMatch: vi.fn(), updateAsset: vi.fn(), deleteAsset: vi.fn(), uploadAsset: vi.fn(), createFolder: vi.fn(), updateFolder: vi.fn(), archiveFolder: vi.fn(), removeFolder: vi.fn(), moveFolder: vi.fn(), moveAssets: vi.fn(), readableError: () => "Error",
}));

import { listAssets, listFolders } from "../api";
const mockListAssets = vi.mocked(listAssets);
const mockListFolders = vi.mocked(listFolders);

describe("LibraryView", () => {
  beforeEach(() => {
    mockListAssets.mockResolvedValue(assets);
    mockListFolders.mockResolvedValue(folders);
  });
  it("combines folder, search, and media filters and shows origins", async () => {
    render(<LibraryView />);
    expect(await screen.findByText("Acme launch")).toBeInTheDocument();
    expect(screen.getByText("Generated clip")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("treeitem", { name: /Acme/ }));
    fireEvent.change(screen.getByLabelText("Search media"), { target: { value: "launch" } });
    fireEvent.change(screen.getByLabelText("Media type"), { target: { value: "video" } });
    fireEvent.change(screen.getByLabelText("Asset origin"), { target: { value: "generated-clip" } });
    expect(screen.getByText("Acme launch")).toBeInTheDocument();
    expect(screen.queryByText("Other logo")).not.toBeInTheDocument();
  });

  it("preserves loaded media and offers retry after a transient engine failure", async () => {
    render(<LibraryView />);
    expect(await screen.findByText("Acme launch")).toBeInTheDocument();
    mockListAssets.mockRejectedValue(new TypeError("Failed to fetch"));
    fireEvent.click(screen.getByLabelText("Show archived"));
    expect(await screen.findByText("Could not reach the local S6 Cut media library.", {}, { timeout: 2500 })).toBeInTheDocument();
    expect(screen.getByText("Acme launch")).toBeInTheDocument();
    mockListAssets.mockResolvedValue(assets);
    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
    await waitFor(() => expect(screen.queryByText("Could not reach the local S6 Cut media library.")).not.toBeInTheDocument());
    expect(screen.getByText("Acme launch")).toBeInTheDocument();
  });
});

describe("LibraryView – bounded revalidation", () => {
  beforeEach(() => {
    mockListAssets.mockResolvedValue(assets);
    mockListFolders.mockResolvedValue(folders);
  });

  it("revalidates after a library-changed event without a manual refresh", async () => {
    render(<LibraryView />);
    expect(await screen.findByText("Acme launch")).toBeInTheDocument();
    const callsBefore = mockListAssets.mock.calls.length;
    emitLibraryChanged();
    await waitFor(() => expect(mockListAssets.mock.calls.length).toBeGreaterThan(callsBefore), { timeout: 2000 });
    expect(screen.getByText("Acme launch")).toBeInTheDocument();
  });

  it("revalidates on window focus with a debounced server reload", async () => {
    render(<LibraryView />);
    expect(await screen.findByText("Acme launch")).toBeInTheDocument();
    const callsBefore = mockListAssets.mock.calls.length;
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(mockListAssets.mock.calls.length).toBeGreaterThan(callsBefore), { timeout: 2000 });
  });

  it("collapses rapid bursts of signals into one revalidation", async () => {
    render(<LibraryView />);
    expect(await screen.findByText("Acme launch")).toBeInTheDocument();
    const callsBefore = mockListAssets.mock.calls.length;
    window.dispatchEvent(new Event("focus"));
    emitLibraryChanged();
    emitLibraryChanged();
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(mockListAssets.mock.calls.length).toBeGreaterThan(callsBefore), { timeout: 2000 });
    // The debounce window collapses the burst — at most one extra reload
    expect(mockListAssets.mock.calls.length - callsBefore).toBeLessThanOrEqual(2);
  });
});
