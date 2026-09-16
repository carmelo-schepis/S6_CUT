import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Health, ProviderProfile } from "../types";
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

const health: Health = { status: "ready", version: "test", database: true, ffmpeg: true, ffprobe: true, whisper: true, ytdlp: true, localTts: true, dataPath: "Local mounted data directory", freeBytes: 1_000_000, activeWorkers: 0, queuedJobs: 0, fallbacks: { planning: "deterministic" } };
const connectedProfile: ProviderProfile = {
  id: "p1", name: "Work profile", textModelId: "openai/gpt-4.1-mini", ttsModelId: "openai/gpt-4o-mini-tts", ttsVoice: "alloy", ttsSpeed: 1, selected: true, persistence: "encrypted", openrouterConfigured: true, openrouterMasked: "sk-…abcd", textStatus: "connected", ttsStatus: "unsupported_model_or_voice", textMessage: "Connected", ttsMessage: "The selected voice is not supported by this speech model", textLastCheckedAt: null, ttsLastCheckedAt: null, status: "partial", capabilities: ["OpenRouter text generation"], fallbacks: { planning: "deterministic" },
};
const baseProfile: ProviderProfile = { id: "p2", name: "Minimal", textModelId: "openai/gpt-4.1-mini", ttsModelId: null, ttsVoice: null, ttsSpeed: 1, selected: false, persistence: "session", openrouterConfigured: false, openrouterMasked: null, textStatus: "not_configured", ttsStatus: "not_configured", textMessage: null, ttsMessage: null, textLastCheckedAt: null, ttsLastCheckedAt: null, status: "local only", capabilities: [], fallbacks: { planning: "deterministic" } };

function renderView() { return render(<SettingsView health={health} onHealthRefresh={vi.fn(async () => undefined)} onProfilesChanged={vi.fn()} />); }

describe("SettingsView", () => {
  beforeEach(() => { mockListProfiles.mockReset(); mockListModels.mockReset(); mockSaveProfile.mockReset(); mockTestProfile.mockReset(); mockDeleteProfile.mockReset(); mockPurgeLibraryContent.mockReset(); mockListModels.mockResolvedValue([]); });
  it("renders one OpenRouter section with separate capability states", async () => {
    mockListProfiles.mockResolvedValue([connectedProfile]); renderView();
    const article = await screen.findByRole("article");
    expect(within(article).getByText("OpenRouter key")).toBeInTheDocument();
    expect(within(article).getByText("Text generation")).toBeInTheDocument();
    expect(within(article).getByText("TTS narration")).toBeInTheDocument();
    expect(within(article).getByText(/selected voice is not supported/i)).toBeInTheDocument();
  });
  it("opens the single-provider form and keeps the key masked", async () => {
    mockListProfiles.mockResolvedValue([]); renderView();
    expect(await screen.findByText("New OpenRouter profile")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("sk-or-v1-…")).toHaveAttribute("type", "password");
  });
  it("saves separate text and speech selections, then tests the profile", async () => {
    mockListProfiles.mockResolvedValue([]);
    const saved = { ...baseProfile, id: "new", openrouterConfigured: true, openrouterMasked: "sk-…safe" };
    mockSaveProfile.mockResolvedValue(saved); mockTestProfile.mockResolvedValue({ ...saved, textStatus: "connected", ttsStatus: "connected", status: "connected" }); mockListProfiles.mockResolvedValueOnce([]).mockResolvedValue([{ ...saved, textStatus: "connected", ttsStatus: "connected", status: "connected" }]);
    renderView(); await screen.findByText("New OpenRouter profile");
    fireEvent.change(screen.getByPlaceholderText("Select or enter a speech model"), { target: { value: "openai/gpt-4o-mini-tts" } });
    fireEvent.change(screen.getByPlaceholderText("e.g. alloy"), { target: { value: "alloy" } });
    fireEvent.click(screen.getByRole("button", { name: /Save and test connection/i }));
    await waitFor(() => expect(mockSaveProfile).toHaveBeenCalledWith(expect.objectContaining({ textModelId: "openai/gpt-4.1-mini", ttsModelId: "openai/gpt-4o-mini-tts", ttsVoice: "alloy", persistence: "encrypted" }), undefined));
    await waitFor(() => expect(mockTestProfile).toHaveBeenCalledWith("new"));
  });
  it("retains an existing profile when editing with a blank key", async () => {
    mockListProfiles.mockResolvedValue([connectedProfile]); mockSaveProfile.mockResolvedValue(connectedProfile); mockTestProfile.mockResolvedValue(connectedProfile);
    renderView(); await screen.findByText("Work profile"); fireEvent.click(screen.getByRole("button", { name: "Edit Work profile" }));
    fireEvent.click(screen.getByRole("button", { name: /Save and test connection/i }));
    await waitFor(() => expect(mockSaveProfile).toHaveBeenCalledWith(expect.objectContaining({ openrouterKey: undefined }), "p1"));
  });
  it("refreshes discovered speech models for an existing connected profile", async () => {
    mockListProfiles.mockResolvedValue([connectedProfile]); mockListModels.mockResolvedValue([{ id: "free/speech", name: "Free speech", outputModalities: ["speech"], free: true, voices: ["alloy"] }]);
    renderView(); await screen.findByText("Work profile"); fireEvent.click(screen.getByRole("button", { name: "Edit Work profile" }));
    await waitFor(() => expect(mockListModels).toHaveBeenCalledWith("speech"));
  });
  it("requires the exact destructive confirmation phrase and shows the empty summary", async () => {
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
  });
  it("tests, deletes, and refreshes profiles", async () => {
    mockListProfiles.mockResolvedValue([baseProfile]); mockTestProfile.mockResolvedValue(baseProfile); mockDeleteProfile.mockResolvedValue(undefined); globalThis.confirm = vi.fn(() => true);
    renderView(); await screen.findByText("Minimal"); fireEvent.click(screen.getByRole("button", { name: "Test" })); await waitFor(() => expect(mockTestProfile).toHaveBeenCalledWith("p2"));
    fireEvent.click(screen.getByRole("button", { name: "Delete Minimal" })); await waitFor(() => expect(mockDeleteProfile).toHaveBeenCalledWith("p2"));
  });
});
