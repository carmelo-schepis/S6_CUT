import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Health, ProviderProfile } from "../types";
import { onLibraryChanged } from "../library-sync";
import { SettingsView } from "./settings-view";

vi.mock("../api", () => {
  const readableError = (e: unknown) => e instanceof Error ? e.message : "Something went wrong. Try again.";
  return { readableError, listProfiles: vi.fn(), listOpenRouterModels: vi.fn(), scanProviderModels: vi.fn(async () => []), saveProfile: vi.fn(), testProfile: vi.fn(), deleteProfile: vi.fn(), duplicateProfile: vi.fn(), purgeLibraryContent: vi.fn() };
});

import { deleteProfile, duplicateProfile, listOpenRouterModels, listProfiles, purgeLibraryContent, saveProfile, testProfile } from "../api";
const mockListProfiles = vi.mocked(listProfiles);
const mockListModels = vi.mocked(listOpenRouterModels);
const mockSaveProfile = vi.mocked(saveProfile);
const mockTestProfile = vi.mocked(testProfile);
const mockDeleteProfile = vi.mocked(deleteProfile);
const mockDuplicateProfile = vi.mocked(duplicateProfile);
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
  beforeEach(() => { mockListProfiles.mockReset(); mockListModels.mockReset(); mockSaveProfile.mockReset(); mockTestProfile.mockReset(); mockDeleteProfile.mockReset(); mockDuplicateProfile.mockReset(); mockPurgeLibraryContent.mockReset(); mockListModels.mockResolvedValue([]); });
  it("renders one box per provider with its own switch and saved status", async () => {
    mockListProfiles.mockResolvedValue([connectedProfile]); renderView();
    const article = await screen.findByRole("article");
    expect(screen.getByRole("heading", { name: "Text providers" })).toBeInTheDocument();
    expect(screen.getByText("Configure OpenRouter or your own Ollama server. Choose a provider for each job on Projects.")).toBeInTheDocument();
    const openRouter = within(article).getByRole("region", { name: "OpenRouter" });
    expect(within(openRouter).getByRole("switch", { name: "Use OpenRouter" })).toBeChecked();
    expect(within(openRouter).getByLabelText(/^OpenRouter API key/)).toHaveAttribute("type", "password");
    expect(within(openRouter).getByLabelText(/^OpenRouter API key/)).toHaveValue("");
    expect(within(openRouter).getByText(/Saved value: sk-…abcd/)).toBeInTheDocument();
    expect(within(openRouter).getByText("OpenRouter", { selector: ".connection-result span" })).toBeInTheDocument();
    expect(within(article).getByText("Credential storage:")).toBeInTheDocument();
    expect(within(article).getByText("Encrypted")).toBeInTheDocument();
    const ollama = within(article).getByRole("region", { name: "Ollama" });
    expect(within(ollama).getByRole("switch", { name: "Use Ollama" })).toBeChecked();
    expect(ollama).toHaveTextContent("No endpoint saved.");
    expect(ollama.querySelector(".connection-result")).toBeNull();
    expect(article.querySelector(":scope > .status")).toBeNull();
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
  it("never sends Ollama fields from Use profile, so the saved endpoint is kept", async () => {
    mockListProfiles.mockResolvedValue([{ ...baseProfile, ollamaUrl: "http://ollama.test:11434", ollamaModel: "llama3.2", ollamaStatus: "connected" }]);
    mockSaveProfile.mockResolvedValue(baseProfile);
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: "Use profile" }));
    await waitFor(() => expect(mockSaveProfile).toHaveBeenCalled());
    const [payload] = mockSaveProfile.mock.calls[0];
    expect(payload).not.toHaveProperty("ollamaUrl");
    expect(payload).not.toHaveProperty("ollamaModel");
  });

  it("shows the Ollama result only for a profile with an endpoint, and an empty box clears it", async () => {
    const withOllama: ProviderProfile = { ...connectedProfile, ollamaUrl: "http://ollama.test:11434", ollamaModel: "llama3.2", ollamaStatus: "timeout_offline", ollamaMessage: "Could not reach Ollama at this address." };
    mockListProfiles.mockResolvedValue([withOllama, baseProfile]);
    mockSaveProfile.mockResolvedValue(withOllama);
    mockTestProfile.mockResolvedValue(withOllama);
    renderView();
    const rows = await screen.findAllByRole("article");
    const ollama = within(rows[0]).getByRole("region", { name: "Ollama" });
    expect(within(ollama).getByDisplayValue("http://ollama.test:11434")).toBeInTheDocument();
    expect(within(ollama).getByDisplayValue("llama3.2")).toBeInTheDocument();
    expect(rows[0].querySelectorAll(".connection-result")).toHaveLength(2);
    expect(rows[1].querySelectorAll(".connection-result")).toHaveLength(1);
    fireEvent.change(within(ollama).getByRole("textbox", { name: /Ollama endpoint/ }), { target: { value: "" } });
    fireEvent.click(within(ollama).getByRole("button", { name: "Save and test" }));
    await waitFor(() => expect(mockSaveProfile).toHaveBeenCalledWith(expect.objectContaining({ ollamaUrl: "", textModelId: withOllama.textModelId, selected: true }), withOllama.id));
    expect(mockSaveProfile.mock.calls[0][0]).not.toHaveProperty("openrouterKey");
  });
  it("keeps Ollama-only profiles visually separate from the unused OpenRouter key", async () => {
    const ollamaOnly: ProviderProfile = { ...baseProfile, selected: true, ollamaUrl: "http://ollama.test:11434", ollamaModel: "gemma3:1b", ollamaStatus: "connected", ollamaMessage: "Connected; Ollama text generation succeeded" };
    mockListProfiles.mockResolvedValue([ollamaOnly]);
    renderView();
    const article = await screen.findByRole("article");
    const openRouterSection = within(article).getByRole("region", { name: "OpenRouter" });
    const ollamaSection = within(article).getByRole("region", { name: "Ollama" });
    expect(within(openRouterSection).getByText(/No API key saved\./)).toBeInTheDocument();
    expect(within(openRouterSection).getByLabelText(/^OpenRouter API key/)).toHaveValue("");
    expect(within(ollamaSection).getByDisplayValue("http://ollama.test:11434")).toBeInTheDocument();
    expect(within(ollamaSection).getByDisplayValue("gemma3:1b")).toBeInTheDocument();
    expect(within(ollamaSection).getByText(/Connected; Ollama text generation succeeded/)).toBeInTheDocument();
    expect(article.querySelectorAll(".connection-result")).toHaveLength(2);
  });
  it("does not show Checking for an unconfigured provider while testing a profile", async () => {
    const ollamaOnly: ProviderProfile = { ...baseProfile, ollamaUrl: "http://ollama.test:11434", ollamaModel: "gemma3:1b", ollamaStatus: "configured" };
    mockListProfiles.mockResolvedValue([ollamaOnly]);
    let finishTest: ((value: ProviderProfile) => void) | undefined;
    mockTestProfile.mockReturnValue(new Promise((resolve) => { finishTest = resolve; }));
    renderView();
    const article = await screen.findByRole("article");
    fireEvent.click(within(article).getByRole("button", { name: "Test" }));
    await screen.findByRole("button", { name: "Checking…" });
    const openRouterSection = within(article).getByRole("region", { name: "OpenRouter" });
    const ollamaSection = within(article).getByRole("region", { name: "Ollama" });
    expect(openRouterSection).not.toHaveTextContent("Checking now…");
    expect(ollamaSection).toHaveTextContent("Checking now…");
    finishTest?.(ollamaOnly);
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
  it("retains an existing profile when editing: the edit form sends only name and storage", async () => {
    mockListProfiles.mockResolvedValue([connectedProfile]); mockSaveProfile.mockResolvedValue(connectedProfile); mockTestProfile.mockResolvedValue(connectedProfile);
    renderView(); await screen.findByText("Work profile"); fireEvent.click(screen.getByRole("button", { name: "Edit Work profile" }));
    const form = document.querySelector(".profile-form") as HTMLElement;
    expect(within(form).queryByRole("switch")).toBeNull();
    expect(within(form).queryByPlaceholderText("sk-or-v1-…")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Save and test connection/i }));
    await waitFor(() => expect(mockSaveProfile).toHaveBeenCalledWith({ name: "Work profile", textModelId: "openai/gpt-4.1-mini", persistence: "encrypted", selected: true }, "p1"));
  });

  it("switches a provider off without a provider call and keeps the other provider's fields", async () => {
    mockListProfiles.mockResolvedValueOnce([connectedProfile]).mockResolvedValue([{ ...connectedProfile, openrouterEnabled: false }]);
    mockSaveProfile.mockResolvedValue({ ...connectedProfile, openrouterEnabled: false });
    renderView();
    const article = await screen.findByRole("article");
    fireEvent.click(within(article).getByRole("switch", { name: "Use OpenRouter" }));
    await waitFor(() => expect(mockSaveProfile).toHaveBeenCalledWith({ name: "Work profile", textModelId: "openai/gpt-4.1-mini", youtubeMetadataModelId: undefined, persistence: "encrypted", selected: true, openrouterEnabled: false }, "p1"));
    const [payload] = mockSaveProfile.mock.calls[0];
    expect(payload).not.toHaveProperty("openrouterKey");
    expect(payload).not.toHaveProperty("ollamaUrl");
    expect(payload).not.toHaveProperty("ollamaModel");
    expect(mockTestProfile).not.toHaveBeenCalled();
    const openRouter = within(article).getByRole("region", { name: "OpenRouter" });
    await waitFor(() => expect(within(openRouter).getByRole("switch", { name: "Use OpenRouter" })).not.toBeChecked());
    expect(within(openRouter).getByText("Off. Not used for new jobs. Saved settings are kept.")).toBeInTheDocument();
    expect(within(openRouter).getByLabelText(/Text-generation model/)).toBeDisabled();
    expect(within(openRouter).getByRole("button", { name: "Save and test" })).toBeDisabled();
    expect(within(openRouter).queryByText("Checking now…")).toBeNull();
  });

  it("saves one box at a time and keeps typing in the other box", async () => {
    mockListProfiles.mockResolvedValue([connectedProfile]);
    mockSaveProfile.mockResolvedValue(connectedProfile); mockTestProfile.mockResolvedValue(connectedProfile);
    renderView();
    const article = await screen.findByRole("article");
    const ollama = within(article).getByRole("region", { name: "Ollama" });
    const openRouter = within(article).getByRole("region", { name: "OpenRouter" });
    fireEvent.change(within(ollama).getByRole("textbox", { name: /Ollama endpoint/ }), { target: { value: "http://typed.test:11434" } });
    fireEvent.change(within(openRouter).getByLabelText(/^OpenRouter API key/), { target: { value: "sk-or-new-secret" } });
    fireEvent.click(within(openRouter).getByRole("button", { name: "Save and test" }));
    await waitFor(() => expect(mockSaveProfile).toHaveBeenCalledWith(expect.objectContaining({ openrouterKey: "sk-or-new-secret", textModelId: "openai/gpt-4.1-mini" }), "p1"));
    const [payload] = mockSaveProfile.mock.calls[0];
    expect(payload).not.toHaveProperty("ollamaUrl");
    expect(payload).not.toHaveProperty("ollamaModel");
    await waitFor(() => expect(mockTestProfile).toHaveBeenCalledWith("p1"));
    expect(within(ollama).getByRole("textbox", { name: /Ollama endpoint/ })).toHaveValue("http://typed.test:11434");
  });

  it("never shows the saved OpenRouter key and keeps the metadata picker still when OpenRouter is off", async () => {
    mockListProfiles.mockResolvedValue([{ ...connectedProfile, openrouterEnabled: false, textStatus: "connected" }]);
    renderView();
    const article = await screen.findByRole("article");
    expect(within(article).getByLabelText(/^OpenRouter API key/)).toHaveValue("");
    expect(await screen.findByText("OpenRouter is off for this profile. Turn it on to change this model.")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Title and description model" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Refresh models/ })).toBeDisabled();
    expect(mockListModels).not.toHaveBeenCalled();
  });

  it("new profile sends both switches and every field in one save", async () => {
    mockListProfiles.mockResolvedValue([]);
    mockSaveProfile.mockResolvedValue({ ...baseProfile, id: "new" }); mockTestProfile.mockResolvedValue({ ...baseProfile, id: "new" });
    renderView(); await screen.findByText("New OpenRouter profile");
    fireEvent.click(screen.getByRole("switch", { name: "Use Ollama" }));
    fireEvent.change(screen.getByRole("textbox", { name: /Ollama endpoint/ }), { target: { value: "http://new.test:11434" } });
    fireEvent.click(screen.getByRole("button", { name: /Save and test connection/i }));
    await waitFor(() => expect(mockSaveProfile).toHaveBeenCalledWith(expect.objectContaining({ openrouterEnabled: true, ollamaEnabled: false, ollamaUrl: "http://new.test:11434", textModelId: "openai/gpt-4.1-mini" }), undefined));
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
    mockListProfiles.mockResolvedValue([baseProfile]); mockTestProfile.mockResolvedValue(baseProfile); mockDeleteProfile.mockResolvedValue(undefined); mockDuplicateProfile.mockResolvedValue(baseProfile); globalThis.confirm = vi.fn(() => true);
    renderView(); const article = await screen.findByRole("article"); fireEvent.click(within(article).getByRole("button", { name: "Test" })); await waitFor(() => expect(mockTestProfile).toHaveBeenCalledWith("p2"));
    fireEvent.click(within(article).getByRole("button", { name: "Duplicate Minimal" })); await waitFor(() => expect(mockDuplicateProfile).toHaveBeenCalledWith("p2"));
    fireEvent.click(screen.getByRole("button", { name: "Delete Minimal" })); await waitFor(() => expect(mockDeleteProfile).toHaveBeenCalledWith("p2"));
  });
});
