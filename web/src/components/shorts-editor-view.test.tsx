import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createShortsJob, createShortsSourceJob, listAssets } from "../api";
import type { LibraryAsset } from "../types";
import { ShortsEditorView } from "./shorts-editor-view";

vi.mock("../api", () => ({
  createShortsJob: vi.fn(), createShortsSourceJob: vi.fn(), listAssets: vi.fn(), listJobs: vi.fn().mockResolvedValue([]), readableError: (error: unknown) => error instanceof Error ? error.message : "Request failed",
}));

const asset: LibraryAsset = { id: "asset-1", title: "Library clip", description: "", mediaType: "video/mp4", filename: "clip.mp4", tags: [], triggers: [], aliases: [], negativeTriggers: [], policy: "neutral", protected: false, minSpacingSeconds: 0, maxUsesPerProject: 0, licence: "User", attribution: "", contentHash: "hash", brands: [], people: [], folderId: "folder", origin: "manual-import", blobId: "blob", createdAt: "2026-01-01T00:00:00Z" };

describe("ShortsEditorView", () => {
  beforeEach(() => { vi.mocked(listAssets).mockImplementation(async () => [asset]); vi.mocked(createShortsJob).mockResolvedValue({ project: {} as never, job: {} as never }); vi.mocked(createShortsSourceJob).mockResolvedValue({ project: {} as never, job: {} as never }); });
  it("renders all source tabs and accepts a blank end", async () => {
    render(<ShortsEditorView onJobCreated={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Library")).toBeInTheDocument());
    expect(screen.getByText("Local file")).toBeInTheDocument();
    expect(screen.getByText("YouTube")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Source remainder")).toBeInTheDocument();
  });
  it("shows a useful Library empty state when no videos exist", async () => {
    vi.mocked(listAssets).mockResolvedValue([]);
    render(<ShortsEditorView onJobCreated={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: /Library/ }));
    expect(await screen.findByText("No Library videos available")).toBeInTheDocument();
  });
  it("rejects invalid trim values and submits YouTube through multipart API", async () => {
    render(<ShortsEditorView onJobCreated={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("YouTube")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Start seconds"), { target: { value: "-1" } });
    fireEvent.submit(screen.getByRole("button", { name: "Queue short" }).closest("form")!);
    expect(await screen.findByRole("alert")).toHaveTextContent(/at least 0/);
    fireEvent.click(screen.getByRole("tab", { name: /YouTube/ }));
    await waitFor(() => expect(screen.getByLabelText("YouTube URL")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("YouTube URL"), { target: { value: "https://www.youtube.com/watch?v=test" } });
    fireEvent.change(screen.getByLabelText("Start seconds"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Queue short" }));
    await waitFor(() => expect(createShortsSourceJob).toHaveBeenCalledWith(expect.objectContaining({ url: "https://www.youtube.com/watch?v=test", end: undefined })));
  });
});
