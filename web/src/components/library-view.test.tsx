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
  listAssets: vi.fn(async () => assets), listFolders: vi.fn(async () => folders), getHealth: vi.fn().mockRejectedValue(new Error("offline")), updateAsset: vi.fn(), deleteAsset: vi.fn(), deleteAssets: vi.fn(), uploadAsset: vi.fn(), createFolder: vi.fn(), updateFolder: vi.fn(), archiveFolder: vi.fn(), removeFolder: vi.fn(), moveFolder: vi.fn(), moveAssets: vi.fn(), renewAssetThumbnail: vi.fn(), suggestLibraryTitles: vi.fn(), applyLibraryTitles: vi.fn(), readableError: (cause: unknown) => cause instanceof Error ? cause.message : "Error",
}));

import { applyLibraryTitles, deleteAsset, deleteAssets, listAssets, listFolders, renewAssetThumbnail, suggestLibraryTitles, updateAsset } from "../api";
const mockDeleteAsset = vi.mocked(deleteAsset);
const mockDeleteAssets = vi.mocked(deleteAssets);
const mockListAssets = vi.mocked(listAssets);
const mockListFolders = vi.mocked(listFolders);
const mockRenewAssetThumbnail = vi.mocked(renewAssetThumbnail);
const mockSuggestTitles = vi.mocked(suggestLibraryTitles);
const mockApplyTitles = vi.mocked(applyLibraryTitles);
const mockUpdateAsset = vi.mocked(updateAsset);

describe("LibraryView", () => {
  beforeEach(() => {
    mockListAssets.mockResolvedValue(assets);
    mockListFolders.mockResolvedValue(folders);
    mockDeleteAssets.mockReset();
    mockUpdateAsset.mockReset();
    mockRenewAssetThumbnail.mockReset();
  });
  it("renews a failed card still once without breaking selection or explicit video preview", async () => {
    const stillAsset = { ...assets[0], thumbnailUrl: "/signed/still-expired.jpg" };
    mockListAssets.mockResolvedValueOnce([stillAsset, assets[1]]);
    mockRenewAssetThumbnail.mockResolvedValueOnce("/signed/still-renewed.jpg");
    render(<LibraryView />);
    await screen.findByRole("button", { name: "Preview Acme launch" }, { timeout: 5000 });
    const image = await screen.findByRole("img", { name: "Acme launch thumbnail" }, { timeout: 5000 });
    fireEvent.error(image);
    await waitFor(() => expect(image).toHaveAttribute("src", "/signed/still-renewed.jpg"));
    expect(mockRenewAssetThumbnail).toHaveBeenCalledWith("a1");
    expect(screen.queryByText("Thumbnail unavailable")).not.toBeInTheDocument();
    expect(document.querySelector(".asset-card video")).toBeNull();

    fireEvent.click(screen.getByLabelText("Select Acme launch"));
    expect(screen.getByLabelText("Select Acme launch")).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Preview Acme launch" }));
    expect(screen.getByRole("dialog", { name: "Acme launch video preview" }).querySelector("video")).toHaveAttribute("src", assets[0].previewUrl);
  });

  it("shows generated descriptions on cards while keeping full metadata in the inspector", async () => {
    const generated = { ...assets[0], description: "A short summary of the specific transcript-grounded clip, with useful topic context." };
    mockListAssets.mockResolvedValueOnce([generated, assets[1]]);
    render(<LibraryView />);
    expect(await screen.findAllByText(generated.description)).toHaveLength(1);
    expect(screen.queryByText("campaign")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Select Acme launch for Rule Inspector" }));
    expect(screen.getByLabelText("Full description")).toHaveValue(generated.description);
    expect(screen.getByDisplayValue("launch.mp4")).toBeInTheDocument();
    expect(screen.getByLabelText("Tags")).toHaveValue("campaign");
  });
  it("selects the exact requested Library asset ID, including archived-folder assets", async () => {
    const archivedAsset = { ...assets[0], id: "archived-duplicate", title: assets[0].title, folderId: "archived-folder" };
    mockListAssets.mockResolvedValueOnce([...assets, archivedAsset]);
    render(<LibraryView selectedAssetId="archived-duplicate" />);
    expect(await screen.findAllByText("Acme launch")).toHaveLength(2);
    fireEvent.click(document.querySelector('[data-asset-id="archived-duplicate"] .asset-card-details')!);
    expect(screen.getByDisplayValue("Acme launch")).toBeInTheDocument();
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

  it("stars the context-menu target without saving or replacing an inspector draft", async () => {
    mockUpdateAsset.mockResolvedValueOnce({ ...assets[0], starred: true });
    const refreshed = [{ ...assets[0], starred: true }, assets[1]];
    mockListAssets.mockResolvedValueOnce(assets).mockResolvedValue(refreshed);
    render(<LibraryView />);
    await screen.findByText("Acme launch");
    fireEvent.click(screen.getByRole("button", { name: "Select Acme launch for Rule Inspector" }));
    const title = screen.getByLabelText("Title");
    fireEvent.focus(title);
    fireEvent.change(title, { target: { value: "Unsaved inspector draft" } });
    const card = document.querySelector<HTMLElement>('[data-asset-id="a1"]');
    expect(card).toBeInTheDocument();
    fireEvent.contextMenu(card!);
    expect(mockUpdateAsset).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Star" }));
    await waitFor(() => expect(mockUpdateAsset).toHaveBeenCalledWith("a1", { starred: true }));
    await waitFor(() => expect(mockListAssets.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 3000 });
    await waitFor(() => expect(title).toHaveValue("Unsaved inspector draft"));
    expect(screen.getAllByLabelText("Starred")).toHaveLength(1);
  });

  it("refreshes clean inspector fields from the latest saved asset", async () => {
    const refreshed = [{ ...assets[0], title: "Fresh title", protected: true }, assets[1]];
    mockListAssets.mockResolvedValueOnce(assets).mockResolvedValue(refreshed);
    render(<LibraryView />);
    await screen.findByText("Acme launch");
    fireEvent.click(screen.getByRole("button", { name: "Select Acme launch for Rule Inspector" }));
    emitLibraryChanged();
    await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue("Fresh title"), { timeout: 3000 });
    expect(screen.getByRole("checkbox", { name: /Protected \/ pinned/ })).toBeChecked();
  });

  it("keeps an edit made while its earlier save is pending", async () => {
    let finishSave!: (asset: LibraryAsset) => void;
    mockUpdateAsset.mockImplementationOnce(() => new Promise((resolve) => { finishSave = resolve; }));
    render(<LibraryView />);
    await screen.findByText("Acme launch");
    fireEvent.click(screen.getByRole("button", { name: "Select Acme launch for Rule Inspector" }));
    const title = screen.getByLabelText("Title");
    fireEvent.change(title, { target: { value: "First edit" } });
    fireEvent.blur(title);
    await waitFor(() => expect(mockUpdateAsset).toHaveBeenCalledWith("a1", { title: "First edit" }));
    fireEvent.focus(title);
    fireEvent.change(title, { target: { value: "Later edit" } });
    finishSave({ ...assets[0], title: "First edit" });
    await waitFor(() => expect(title).toHaveValue("Later edit"));
  });

  it("does not change the inspected asset when a save finishes after selection changes", async () => {
    let finishSave!: (asset: LibraryAsset) => void;
    mockUpdateAsset.mockImplementationOnce(() => new Promise((resolve) => { finishSave = resolve; }));
    render(<LibraryView />);
    await screen.findByText("Acme launch");
    fireEvent.click(screen.getByRole("button", { name: "Select Acme launch for Rule Inspector" }));
    const title = screen.getByLabelText("Title");
    fireEvent.change(title, { target: { value: "Saved title" } });
    fireEvent.blur(title);
    await waitFor(() => expect(mockUpdateAsset).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Select Other logo for Rule Inspector" }));
    finishSave({ ...assets[0], title: "Saved title" });
    await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue("Other logo"));
  });

  it("restores keyboard focus when Undo star moves the card past result 60", async () => {
    const starred = { ...assets[0], starred: true };
    const ordinary = Array.from({ length: 60 }, (_, index) => ({ ...assets[0], id: `video-${index}`, title: `Video ${index}`, blobId: `blob-${index}` }));
    mockListAssets.mockResolvedValueOnce([...ordinary, starred]).mockResolvedValue([...ordinary, { ...starred, starred: false }]);
    mockUpdateAsset.mockResolvedValueOnce({ ...starred, starred: false });
    render(<LibraryView />);
    await screen.findByRole("button", { name: "Actions for Acme launch" });
    fireEvent.click(screen.getByRole("button", { name: "Actions for Acme launch" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Undo star" }));
    await waitFor(() => expect(mockUpdateAsset).toHaveBeenCalledWith("a1", { starred: false }));
    await waitFor(() => expect(document.querySelectorAll(".asset-card")).toHaveLength(60));
    await waitFor(() => expect(document.querySelector('[data-asset-id="a1"]')).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toHaveAttribute("aria-label", "Actions for Video 0"));
  });

  it("sorts starred videos before other filtered assets while keeping order within each group", async () => {
    const secondVideo = { ...assets[0], id: "a3", title: "Second video", blobId: "b3", starred: true };
    const firstStarred = { ...assets[0], id: "a4", title: "First starred", blobId: "b4", starred: true };
    mockListAssets.mockResolvedValueOnce([assets[0], secondVideo, assets[1], firstStarred]);
    render(<LibraryView />);
    await screen.findByText("First starred");
    expect([...document.querySelectorAll<HTMLElement>(".asset-card")].map((card) => card.dataset.assetId)).toEqual(["a3", "a4", "a1", "a2"]);
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
    expect(names).toEqual(["Folders and policy filters"]);
    fireEvent.click(screen.getByRole("button", { name: "Preview Acme launch" }));
    expect(within(screen.getByRole("dialog")).getByRole("complementary", { name: "Rule Inspector" })).toBeInTheDocument();
    expect(new Set(names).size).toBe(names.length);
  });

  it("does not expose a standalone matching-test panel", async () => {
    render(<LibraryView />);
    expect(await screen.findByText("Acme launch")).toBeInTheDocument();
    expect(screen.queryByText("Why it matched")).not.toBeInTheDocument();
    expect(screen.queryByText("Test the rule engine")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Explain match" })).not.toBeInTheDocument();
  });

  it("warns in the shared dialog that deleting a source removes its project history", async () => {
    mockListAssets.mockResolvedValueOnce([{ ...assets[0], origin: "project-source", sourceProjectId: "project-a" }, assets[1]]);
    render(<LibraryView />);
    await screen.findByText("Acme launch");
    fireEvent.click(screen.getByRole("button", { name: "Select Acme launch for Rule Inspector" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Library record" }));
    expect(screen.getAllByRole("dialog").at(-1)).toHaveTextContent("Deleting it also deletes the project, its job history, and generated media.");
    expect(mockDeleteAssets).not.toHaveBeenCalled();
  });

  it("keeps bulk deletion of project-linked media explicitly Library-only", async () => {
    render(<LibraryView />);
    await screen.findByText("Acme launch");
    fireEvent.click(screen.getByLabelText("Select Acme launch"));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("This removes the Library item. Referenced project media and history are retained where applicable.");
    expect(screen.getByRole("dialog")).not.toHaveTextContent("deletes the project, its job history");
  });

  it("shows delete failures inside the confirmation dialog", async () => {
    mockDeleteAssets.mockRejectedValueOnce(new Error("blocked"));
    render(<LibraryView />);
    await screen.findByText("Acme launch");
    fireEvent.click(screen.getByLabelText("Select Acme launch"));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete media" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not delete the selected media. blocked");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("clears selection for sibling cards removed by a source deletion cascade", async () => {
    const source = { ...assets[0], origin: "project-source" as const };
    const sibling = { ...assets[0], id: "a3", title: "Generated sibling", blobId: "b3" };
    mockListAssets.mockResolvedValueOnce([source, sibling, assets[1]]).mockResolvedValueOnce([assets[1]]);
    mockDeleteAssets.mockResolvedValueOnce({ deleted: [source.id], failed: {} });
    render(<LibraryView />);
    await screen.findByText("Generated sibling");
    fireEvent.click(screen.getByLabelText("Select Acme launch"));
    fireEvent.click(screen.getByLabelText("Select Generated sibling"));
    fireEvent.contextMenu(document.querySelector<HTMLElement>('[data-asset-id="a1"]')!);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("deletes the project, its job history, and generated media");
    fireEvent.click(screen.getByRole("button", { name: "Delete media" }));
    await waitFor(() => expect(document.querySelector('[data-asset-id="a3"]')).not.toBeInTheDocument());
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
  });

  it("opens matching details with the player and removes both on close", async () => {
    render(<LibraryView />);
    await screen.findByText("Acme launch");
    expect(screen.queryByRole("complementary", { name: "Rule Inspector" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview Acme launch" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByDisplayValue("Acme launch")).toBeInTheDocument();
    expect(dialog.querySelector("video")).toHaveAttribute("src", assets[0].previewUrl);
    fireEvent.click(screen.getByRole("button", { name: "Close video preview" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Rule Inspector" })).not.toBeInTheDocument();
  });

  it("keeps bulk selection separate and opens the same view from card details", async () => {
    render(<LibraryView />);
    await screen.findByText("Acme launch");
    fireEvent.click(screen.getByLabelText("Select Acme launch"));
    expect(screen.getByLabelText("Select Acme launch")).toBeChecked();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Select Acme launch for Rule Inspector" }));
    expect(within(screen.getByRole("dialog")).getByDisplayValue("Acme launch")).toBeInTheDocument();
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.click(screen.getByRole("button", { name: "Close video preview" }));
    expect(document.body.style.overflow).toBe("");
  });

  it("renders isolated card controls without nested buttons or article activation", async () => {
    render(<LibraryView />);
    expect(await screen.findByText("Acme launch")).toBeInTheDocument();
    const article = screen.getByRole("button", { name: "Select Acme launch for Rule Inspector" }).closest("article");
    expect(article).toBeInTheDocument();
    expect(article).not.toHaveAttribute("role");
    expect(article?.querySelectorAll("button")).toHaveLength(3);
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
    expect(within(screen.getByRole("dialog")).getByDisplayValue("Other logo")).toBeInTheDocument();
    expect(screen.getByRole("dialog").querySelector("video")).toBeNull();
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

  it("accepts refreshed signed still URLs while keeping the same source player URL", async () => {
    const expired = { ...assets[0], thumbnailUrl: "/signed/still-expired.jpg" };
    const refreshed = { ...assets[0], thumbnailUrl: "/signed/still-refreshed.jpg" };
    mockListAssets.mockResolvedValueOnce([expired, assets[1]]).mockResolvedValueOnce([refreshed, assets[1]]);
    render(<LibraryView />);
    const image = await screen.findByRole("img", { name: "Acme launch thumbnail" });
    expect(image).toHaveAttribute("src", expired.thumbnailUrl);
    emitLibraryChanged();
    await waitFor(() => expect(image).toHaveAttribute("src", refreshed.thumbnailUrl));
    fireEvent.click(screen.getByRole("button", { name: "Preview Acme launch" }));
    expect(screen.getByRole("dialog", { name: "Acme launch video preview" }).querySelector("video")).toHaveAttribute("src", assets[0].previewUrl);
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

describe("LibraryView – SEO titles", () => {
  const suggestion = { suggestions: [{ kind: "clip" as const, assetId: "a1", projectId: null, currentTitle: "Acme launch", suggestedTitle: "Acme Launch Day Highlights", suggestedDescription: "Launch recap.", revision: 1 }], skipped: [], costUsd: 0.0004, costKind: "estimated" as const, model: "m", requests: 1, aiAvailable: true, warning: null };
  beforeEach(() => {
    mockListAssets.mockResolvedValue(assets);
    mockListFolders.mockResolvedValue(folders);
    mockSuggestTitles.mockReset(); mockApplyTitles.mockReset(); mockUpdateAsset.mockReset();
  });

  it("suggests auto-titled items, shows progress, applies the reviewed rows, and reloads the Library", async () => {
    let resolveSuggest: (value: typeof suggestion) => void = () => undefined;
    mockSuggestTitles.mockReturnValue(new Promise((resolve) => { resolveSuggest = resolve; }));
    mockApplyTitles.mockResolvedValue({ applied: [{ kind: "clip", assetId: "a1", projectId: null, title: "Acme Launch Day Highlights", reason: null }], conflicts: [{ kind: "project", assetId: null, projectId: "p", title: "Old project", reason: "Renamed since suggestion" }] });
    render(<LibraryView />);
    await screen.findByText("Acme launch");
    const button = screen.getByTestId("suggest-seo-titles");
    expect(button).toHaveTextContent("Suggest SEO titles");
    fireEvent.click(button);
    expect(mockSuggestTitles).toHaveBeenCalledWith({ scope: "auto-titled" });
    expect(button).toHaveTextContent("Writing titles…");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    resolveSuggest(suggestion);
    const dialog = await screen.findByTestId("seo-title-review");
    const loadsBefore = mockListAssets.mock.calls.length;
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply selected (1)" }));
    await waitFor(() => expect(screen.queryByTestId("seo-title-review")).not.toBeInTheDocument());
    expect(mockApplyTitles).toHaveBeenCalledWith([{ kind: "clip", assetId: "a1", projectId: null, currentTitle: "Acme launch", title: "Acme Launch Day Highlights", description: "Launch recap.", revision: 1, edited: false }]);
    const feedback = await screen.findByTestId("seo-title-feedback");
    expect(feedback).toHaveTextContent("Updated 1 title · 1 conflict");
    expect(feedback).toHaveTextContent("Old project: Renamed since suggestion");
    await waitFor(() => expect(mockListAssets.mock.calls.length).toBeGreaterThan(loadsBefore));
  });

  it("sends checkbox-selected asset IDs, keeps the selection, and reports request errors", async () => {
    mockSuggestTitles.mockRejectedValue(new Error("A title job is already running."));
    render(<LibraryView />);
    await screen.findByText("Acme launch");
    fireEvent.click(screen.getByLabelText("Select Acme launch"));
    const button = screen.getByTestId("suggest-seo-titles");
    expect(button).toHaveTextContent("Suggest SEO titles (1)");
    fireEvent.click(button);
    expect(mockSuggestTitles).toHaveBeenCalledWith({ assetIds: ["a1"] });
    expect(await screen.findByRole("alert")).toHaveTextContent("A title job is already running.");
    expect(screen.queryByTestId("seo-title-review")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Select Acme launch")).toBeChecked();
  });

  it("closes the review on Cancel without writing anything", async () => {
    mockSuggestTitles.mockResolvedValue(suggestion);
    render(<LibraryView />);
    await screen.findByText("Acme launch");
    fireEvent.click(screen.getByTestId("suggest-seo-titles"));
    fireEvent.click(within(await screen.findByTestId("seo-title-review")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("seo-title-review")).not.toBeInTheDocument();
    expect(mockApplyTitles).not.toHaveBeenCalled();
  });

  it("saves inspector title and description only when they changed", async () => {
    mockUpdateAsset.mockImplementation(async (_id, patch) => ({ ...assets[0], ...patch }));
    render(<LibraryView />);
    await screen.findByText("Acme launch");
    fireEvent.click(screen.getByRole("button", { name: "Select Acme launch for Rule Inspector" }));
    const title = screen.getByDisplayValue("Acme launch");
    fireEvent.focus(title); fireEvent.blur(title);
    const description = screen.getByLabelText("Full description");
    fireEvent.focus(description); fireEvent.blur(description);
    expect(mockUpdateAsset).not.toHaveBeenCalled();
    fireEvent.change(title, { target: { value: "Acme launch recap" } });
    fireEvent.blur(title);
    await waitFor(() => expect(mockUpdateAsset).toHaveBeenCalledWith("a1", { title: "Acme launch recap" }));
    fireEvent.blur(screen.getByDisplayValue("Acme launch recap"));
    fireEvent.blur(screen.getByLabelText("Full description"));
    await waitFor(() => expect(mockUpdateAsset).toHaveBeenCalledTimes(1));
  });
});
