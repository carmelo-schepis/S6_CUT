import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emitLibraryChanged } from "../library-sync";
import type { LibraryAsset, LibraryFolder } from "../types";
import { LibraryView } from "./library-view";

const folders: LibraryFolder[] = [{ id: "unsorted", name: "Unsorted", parentId: null, description: "", color: null, archived: false, system: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" }, { id: "acme", name: "Acme", parentId: null, description: "", color: null, archived: false, system: false, createdAt: "2026-01-01", updatedAt: "2026-01-01" }];
const assets: LibraryAsset[] = [
  { id: "a1", title: "Acme launch", description: "", mediaType: "video/mp4", filename: "launch.mp4", previewUrl: "/api/v1/library/assets/a1/preview?expires=123&signature=signed",  tags: ["campaign"], triggers: [], aliases: [], negativeTriggers: [], policy: "neutral", protected: false, minSpacingSeconds: 0, maxUsesPerProject: 1, licence: "Owned", attribution: "", contentHash: "h1", folderId: "acme", origin: "generated-clip", blobId: "b1", sourceProjectId: "project-a", brands: ["Acme"], people: [], createdAt: "2026-01-01" },
  { id: "a2", title: "Other logo", description: "", mediaType: "image/png", filename: "logo.png", tags: [], triggers: [], aliases: [], negativeTriggers: [], policy: "required", protected: false, minSpacingSeconds: 0, maxUsesPerProject: 1, licence: "Owned", attribution: "", contentHash: "h2", folderId: "unsorted", origin: "manual-import", blobId: "b2", brands: [], people: [], createdAt: "2026-01-01" },
];

vi.mock("../api", () => ({
  listAssets: vi.fn(async () => assets), listFolders: vi.fn(async () => folders), getHealth: vi.fn().mockRejectedValue(new Error("offline")), updateAsset: vi.fn(), deleteAsset: vi.fn(), uploadAsset: vi.fn(), createFolder: vi.fn(), updateFolder: vi.fn(), archiveFolder: vi.fn(), removeFolder: vi.fn(), moveFolder: vi.fn(), moveAssets: vi.fn(), readableError: () => "Error",
}));

import { deleteAsset, listAssets, listFolders } from "../api";
const mockDeleteAsset = vi.mocked(deleteAsset);
const mockListAssets = vi.mocked(listAssets);
const mockListFolders = vi.mocked(listFolders);

describe("LibraryView", () => {
  beforeEach(() => {
    mockListAssets.mockResolvedValue(assets);
    mockListFolders.mockResolvedValue(folders);
  });
  it("selects the exact requested Library asset ID, including archived-folder assets", async () => {
    const archivedAsset = { ...assets[0], id: "archived-duplicate", title: assets[0].title, folderId: "archived-folder" };
    mockListAssets.mockResolvedValueOnce([...assets, archivedAsset]);
    render(<LibraryView selectedAssetId="archived-duplicate" />);
    expect(await screen.findByDisplayValue("Acme launch")).toBeInTheDocument();
    expect(mockListAssets).toHaveBeenCalledWith({ includeArchived: true });
    expect(mockListFolders).toHaveBeenCalledWith({ includeArchived: true });
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

  it("tells a genuinely empty Library to import, not to change its filters", async () => {
    mockListAssets.mockResolvedValue([]);
    render(<LibraryView />);
    expect(await screen.findByRole("heading", { name: "Build your private resolver" })).toBeInTheDocument();
    const empty = document.querySelector(".empty-state")!;
    expect(empty).toHaveTextContent(/no assets yet/i);
    // The filter advice is meaningless when there is nothing to filter.
    expect(empty).not.toHaveTextContent(/another folder/i);
    expect(empty).not.toHaveTextContent(/media type/i);
    expect(within(empty as HTMLElement).getByRole("button", { name: /Import first asset/i })).toBeInTheDocument();
  });

  it("tells a filtered-to-zero Library to change its filters, not to import", async () => {
    render(<LibraryView />);
    expect(await screen.findByText("Acme launch")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search media"), { target: { value: "no-such-asset" } });

    expect(await screen.findByRole("heading", { name: "No media matches these filters" })).toBeInTheDocument();
    const empty = document.querySelector(".empty-state")!;
    expect(empty).toHaveTextContent(/filters/i);
    expect(empty).not.toHaveTextContent(/no assets yet/i);
    expect(within(empty as HTMLElement).queryByRole("button", { name: /Import first asset/i })).toBeNull();

    fireEvent.click(within(empty as HTMLElement).getByRole("button", { name: /Clear filters/i }));
    expect(await screen.findByText("Acme launch")).toBeInTheDocument();
  });

  it("names both complementary landmarks so they are distinguishable", async () => {
    render(<LibraryView />);
    expect(await screen.findByText("Acme launch")).toBeInTheDocument();
    const asides = [...document.querySelectorAll("aside")];
    const names = asides.map((aside) => aside.getAttribute("aria-label"));
    expect(names).toEqual(["Folders and policy filters", "Rule Inspector"]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("does not expose a standalone matching-test panel", async () => {
    render(<LibraryView />);
    expect(await screen.findByText("Acme launch")).toBeInTheDocument();
    expect(screen.queryByText("Why it matched")).not.toBeInTheDocument();
    expect(screen.queryByText("Test the rule engine")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Explain match" })).not.toBeInTheDocument();
  });

  it("states that deleting project-linked media removes only its Library record", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<LibraryView />);
    await screen.findByText("Acme launch");
    fireEvent.click(screen.getByRole("button", { name: "Select Acme launch for Rule Inspector" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Library record" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("This removes the Library item only. Its project and job history will remain."));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Delete project everywhere"));
    expect(mockDeleteAsset).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it("keeps bulk deletion of project-linked media explicitly Library-only", async () => {
    render(<LibraryView />);
    await screen.findByText("Acme launch");
    fireEvent.click(screen.getByLabelText("Select Acme launch"));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("This removes the Library item only. Its project and job history will remain.");
    expect(screen.getByRole("dialog")).toHaveTextContent("Delete project everywhere");
  });

  it("opens a preview without changing the existing Rule Inspector selection", async () => {
    render(<LibraryView />);
    expect(await screen.findByText("Acme launch")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Select Other logo for Rule Inspector" }));
    expect(screen.getByDisplayValue("Other logo")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search media"), { target: { value: "launch" } });
    fireEvent.change(screen.getByLabelText("Media type"), { target: { value: "video" } });
    fireEvent.change(screen.getByLabelText("Asset origin"), { target: { value: "generated-clip" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview Acme launch" }));
    const dialog = screen.getByRole("dialog", { name: "Acme launch video preview" });
    expect(dialog.querySelector("video")).toHaveAttribute("src", assets[0].previewUrl);
    expect(screen.getByDisplayValue("Other logo")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close video preview" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("Other logo")).toBeInTheDocument();
    expect(screen.getByLabelText("Search media")).toHaveValue("launch");
    expect(screen.getByLabelText("Media type")).toHaveValue("video");
    expect(screen.getByLabelText("Asset origin")).toHaveValue("generated-clip");
  });

  it("keeps the video details button and checkbox independent from preview", async () => {
    render(<LibraryView />);
    expect(await screen.findByText("Acme launch")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Select Other logo for Rule Inspector" }));
    fireEvent.click(screen.getByLabelText("Select Acme launch"));
    expect(screen.getByLabelText("Select Acme launch")).toBeChecked();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("Other logo")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Select Acme launch for Rule Inspector" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("Acme launch")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview Acme launch" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Preview Acme launch" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Select Acme launch for Rule Inspector" })).toHaveLength(1);
    expect(screen.getAllByLabelText("Select Acme launch")).toHaveLength(1);
    expect(document.body.style.overflow).toBe("");
  });

  it("isolates realistic details pointer sequences and nested content from preview", async () => {
    render(<LibraryView />);
    expect(await screen.findByText("Acme launch")).toBeInTheDocument();
    const details = screen.getByRole("button", { name: "Select Acme launch for Rule Inspector" });
    fireEvent.pointerDown(details);
    fireEvent.mouseDown(details);
    fireEvent.pointerUp(details);
    fireEvent.mouseUp(details);
    fireEvent.click(details);
    expect(screen.getByDisplayValue("Acme launch")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("");

    const nestedDetails = screen.getByRole("button", { name: "Select Acme launch for Rule Inspector" });
    fireEvent.click(within(nestedDetails).getByText("Acme launch", { selector: "strong" }));
    fireEvent.click(within(nestedDetails).getByText("campaign"));
    fireEvent.click(within(nestedDetails).getByText("Generated clip"));
    fireEvent.click(within(nestedDetails).getByText("neutral"));
    expect(screen.getByDisplayValue("Acme launch")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps preview, details, and checkbox actions independent across keyboard and rapid use", async () => {
    render(<LibraryView />);
    expect(await screen.findByText("Acme launch")).toBeInTheDocument();
    const details = screen.getByRole("button", { name: "Select Acme launch for Rule Inspector" });
    const checkbox = screen.getByLabelText("Select Acme launch");
    fireEvent.click(screen.getByRole("button", { name: "Select Other logo for Rule Inspector" }));
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();
    expect(screen.getByDisplayValue("Other logo")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Preview Acme launch" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close video preview" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.keyDown(details, { key: "Enter" });
    fireEvent.click(details);
    expect(screen.getByDisplayValue("Acme launch")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.keyDown(details, { key: " " });
    fireEvent.click(details);
    expect(screen.getByDisplayValue("Acme launch")).toBeInTheDocument();
    const preview = screen.getByRole("button", { name: "Preview Acme launch" });
    fireEvent.keyDown(preview, { key: "Enter" });
    fireEvent.click(preview);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Acme launch")).toBeInTheDocument();
  });

  it("renders isolated card controls without nested buttons or article activation", async () => {
    render(<LibraryView />);
    expect(await screen.findByText("Acme launch")).toBeInTheDocument();
    const article = screen.getByRole("button", { name: "Select Acme launch for Rule Inspector" }).closest("article");
    expect(article).toBeInTheDocument();
    expect(article).not.toHaveAttribute("role");
    expect(article?.querySelectorAll("button")).toHaveLength(2);
    expect(article?.querySelectorAll("input[type=checkbox]")).toHaveLength(1);
    expect(article?.querySelector(".asset-preview-trigger .asset-card-details")).toBeNull();
    expect(article?.querySelector(".asset-card-details .asset-preview-trigger")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Preview Acme launch" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Select Acme launch for Rule Inspector" })).toHaveLength(1);
  });

  it("does not offer preview activation for a video without a preview URL or for images", async () => {
    mockListAssets.mockResolvedValueOnce([{ ...assets[0], previewUrl: undefined }, assets[1]]);
    render(<LibraryView />);
    expect(await screen.findByText("Acme launch")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Preview Acme launch" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Select Acme launch for Rule Inspector" }));
    fireEvent.click(screen.getByRole("button", { name: "Select Other logo for Rule Inspector" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
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
