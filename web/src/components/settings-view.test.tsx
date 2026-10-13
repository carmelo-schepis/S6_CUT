import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Health, ProviderProfile } from "../types";
import { onLibraryChanged } from "../library-sync";
import { SettingsView } from "./settings-view";

vi.mock("../api", () => {
  const readableError = (e: unknown) => e instanceof Error ? e.message : "Something went wrong. Try again.";
  return { readableError, listProfiles: vi.fn(), listOpenRouterModels: vi.fn(), saveProfile: vi.fn(), testProfile: vi.fn(), deleteProfile: vi.fn(), duplicateProfile: vi.fn(), purgeLibraryContent: vi.fn() };
});

import { deleteProfile, listOpenRouterModels, listProfiles, purgeLibraryContent, saveProfile, testProfile } from "../api";
const mockListProfiles = vi.mocked(listProfiles);
const mockListModels = vi.mocked(listOpenRouterModels);
const mockSaveProfile = vi.mocked(saveProfile);
const mockTestProfile = vi.mocked(testProfile);
const mockDeleteProfile = vi.mocked(deleteProfile);
const mockPurgeLibraryContent = vi.mocked(purgeLibraryContent);
let unsubscribeLibraryChange: ReturnType<typeof onLibraryChanged> = () => {};

const health: Health = { status: "ready", version: "test", database: true, ffmpeg: true, ffprobe: true, whisper: true, ytdlp: true, dataPath: "Local mounted data directory", freeBytes: 1_000_000, activeWorkers: 0, queuedJobs: 0, fallbacks: { planning: "deterministic" } };
const connectedProfile: ProviderProfile = {
  id: "p1", name: "Work profile", textModelId: "openai/gpt-4.1-mini", selected: true, persistence: "encrypted", openrouterConfigured: true, openrouterMasked: "sk-…abcd", textStatus: "connected", textMessage: "Connected", textLastCheckedAt: null, status: "connected", capabilities: ["OpenRouter text generation"], fallbacks: { planning: "deterministic" },
};
const baseProfile: ProviderProfile = { id: "p2", name: "Minimal", textModelId: "openai/gpt-4.1-mini", selected: false, persistence: "session", openrouterConfigured: false, openrouterMasked: null, textStatus: "not_configured", textMessage: null, textLastCheckedAt: null, status: "local only", capabilities: [], fallbacks: { planning: "deterministic" } };

function renderView() { return render(<SettingsView health={health} onHealthRefresh={vi.fn(async () => undefined)} onProfilesChanged={vi.fn()} />); }

describe("SettingsView", () => {
  afterEach(() => unsubscribeLibraryChange());
  beforeEach(() => { mockListProfiles.mockReset(); mockListModels.mockReset(); mockSaveProfile.mockReset(); mockTestProfile.mockReset(); mockDeleteProfile.mockReset(); mockPurgeLibraryContent.mockReset(); mockListModels.mockResolvedValue([]); });
  it("renders the retained OpenRouter text-provider status", async () => {
    mockListProfiles.mockResolvedValue([connectedProfile]); renderView();
    const article = await screen.findByRole("article");
    expect(within(article).getByText("OpenRouter key")).toBeInTheDocument();
    expect(within(article).getByText("Text generation")).toBeInTheDocument();
    expect(within(article).getAllByText(/OpenRouter key|Text generation/)).toHaveLength(2);
  });
  it("shows, refreshes, and persists the independent title and description model", async () => {
    mockListProfiles.mockResolvedValue([connectedProfile]);
    const current = { id: "google/gemini-2.5-flash-lite", name: "Gemini Flash Lite", pricing: { prompt: "0.0000001", completion: "0.0000004" }, supportedParameters: ["response_format"] };
    const cheaper = { id: "google/gemma-3-4b-it", name: "Gemma 3 4B", pricing: { prompt: "0.00000005", completion: "0.0000001" }, supportedParameters: ["response_format"] };
    mockListModels.mockResolvedValue([current, cheaper]);
    mockSaveProfile.mockResolvedValue({ ...connectedProfile, youtubeMetadataModelId: cheaper.id });
    renderView();
    const picker = await screen.findByRole("combobox", { name: "Title and description model" });
    await waitFor(() => expect(mockListModels).toHaveBeenCalledWith("text"));
    expect(picker).toHaveValue("google/gemini-2.5-flash-lite");
    expect(screen.getByRole("option", { name: /Gemini Flash Lite.*\$0\.100\/M in.*\$0\.400\/M out/ })).toBeInTheDocument();
    fireEvent.change(picker, { target: { value: cheaper.id } });
    await waitFor(() => expect(mockSaveProfile).toHaveBeenCalledWith(expect.objectContaining({ youtubeMetadataModelId: cheaper.id, textModelId: connectedProfile.textModelId, selected: true }), connectedProfile.id));
  });
  it("binds Auto-write SEO titles to the selected profile and saves changes", async () => {
    mockListProfiles.mockResolvedValue([connectedProfile]);
    mockSaveProfile.mockResolvedValue({ ...connectedProfile, autoSeoTitles: false });
    renderView();
    const toggle = await screen.findByTestId("auto-seo-titles");
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Auto-write SEO titles for new clips/ })).toBe(toggle);
    expect(screen.getByText("Smart short clips get an AI title and description when OpenRouter is connected.")).toBeInTheDocument();
    mockListProfiles.mockResolvedValue([{ ...connectedProfile, autoSeoTitles: false }]);
    fireEvent.click(toggle);
    await waitFor(() => expect(mockSaveProfile).toHaveBeenCalledWith(expect.objectContaining({ autoSeoTitles: false, textModelId: connectedProfile.textModelId, selected: true }), connectedProfile.id));
    await waitFor(() => expect(toggle).not.toBeChecked());
  });
  it("keeps Auto-write SEO titles off when the profile has it disabled", async () => {
    mockListProfiles.mockResolvedValue([{ ...connectedProfile, autoSeoTitles: false }]);
    renderView();
    const toggle = await screen.findByTestId("auto-seo-titles");
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).not.toBeChecked();
  });
  it("opens the single-provider form and keeps the key masked", async () => {
    mockListProfiles.mockResolvedValue([]); renderView();
    expect(await screen.findByText("New OpenRouter profile")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("sk-or-v1-…")).toHaveAttribute("type", "password");
  });
  it("saves the text-provider selection, then tests the profile", async () => {
    mockListProfiles.mockResolvedValue([]);
    const saved = { ...baseProfile, id: "new", openrouterConfigured: true, openrouterMasked: "sk-…safe" };
    mockSaveProfile.mockResolvedValue(saved); mockTestProfile.mockResolvedValue({ ...saved, textStatus: "connected", status: "connected" }); mockListProfiles.mockResolvedValueOnce([]).mockResolvedValue([{ ...saved, textStatus: "connected", status: "connected" }]);
    renderView(); await screen.findByText("New OpenRouter profile");
    fireEvent.click(screen.getByRole("button", { name: /Save and test connection/i }));
    await waitFor(() => expect(mockSaveProfile).toHaveBeenCalledWith(expect.objectContaining({ textModelId: "openai/gpt-4.1-mini", persistence: "encrypted" }), undefined));
    await waitFor(() => expect(mockTestProfile).toHaveBeenCalledWith("new"));
  });
  it("retains an existing profile when editing with a blank key", async () => {
    mockListProfiles.mockResolvedValue([connectedProfile]); mockSaveProfile.mockResolvedValue(connectedProfile); mockTestProfile.mockResolvedValue(connectedProfile);
    renderView(); await screen.findByText("Work profile"); fireEvent.click(screen.getByRole("button", { name: "Edit Work profile" }));
    fireEvent.click(screen.getByRole("button", { name: /Save and test connection/i }));
    await waitFor(() => expect(mockSaveProfile).toHaveBeenCalledWith(expect.objectContaining({ openrouterKey: undefined }), "p1"));
  });
  it("requires the exact destructive confirmation phrase and signals Library revalidation after purge", async () => {
    const libraryChanged = vi.fn();
    unsubscribeLibraryChange = onLibraryChanged(libraryChanged);
    mockListProfiles.mockResolvedValue([baseProfile]);
    mockPurgeLibraryContent.mockResolvedValue({ assetsDeleted: 4, projectsDeleted: 1, blobsDeleted: 4, bytesReclaimed: 42, warnings: [] });
    renderView(); await screen.findByText("Minimal");
    fireEvent.click(screen.getByRole("button", { name: /Delete all Library content/i }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Delete permanently" })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Type DELETE ALL CONTENT/i), { target: { value: "DELETE ALL CONTENT" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete permanently" }));
    await waitFor(() => expect(mockPurgeLibraryContent).toHaveBeenCalledWith("DELETE ALL CONTENT"));
    expect(await screen.findByText("Library is empty")).toBeInTheDocument();
    expect(screen.getByText(/4 media items, 1 linked project, and 4 files removed/)).toBeInTheDocument();
    expect(libraryChanged).toHaveBeenCalledTimes(1);
  });
  it("tests, deletes, and refreshes profiles", async () => {
    mockListProfiles.mockResolvedValue([baseProfile]); mockTestProfile.mockResolvedValue(baseProfile); mockDeleteProfile.mockResolvedValue(undefined); globalThis.confirm = vi.fn(() => true);
    renderView(); await screen.findByText("Minimal"); fireEvent.click(screen.getByRole("button", { name: "Test" })); await waitFor(() => expect(mockTestProfile).toHaveBeenCalledWith("p2"));
    fireEvent.click(screen.getByRole("button", { name: "Delete Minimal" })); await waitFor(() => expect(mockDeleteProfile).toHaveBeenCalledWith("p2"));
  });
});
