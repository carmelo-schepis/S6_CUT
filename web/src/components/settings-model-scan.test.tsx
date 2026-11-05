import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Health, OpenRouterModel, ProviderProfile } from "../types";
import { SettingsView } from "./settings-view";

vi.mock("../api", () => ({
  readableError: (e: unknown) => (e instanceof Error ? e.message : "Something went wrong. Try again."),
  listProfiles: vi.fn(),
  listOpenRouterModels: vi.fn(async () => []),
  scanProviderModels: vi.fn(async () => []),
  saveProfile: vi.fn(),
  testProfile: vi.fn(),
  deleteProfile: vi.fn(),
  duplicateProfile: vi.fn(),
  purgeLibraryContent: vi.fn(),
}));

import { listProfiles, saveProfile, scanProviderModels, testProfile } from "../api";

const mockListProfiles = vi.mocked(listProfiles);
const mockScan = vi.mocked(scanProviderModels);
const mockSave = vi.mocked(saveProfile);
const mockTest = vi.mocked(testProfile);

const health = { status: "ready", version: "test", database: true, ffmpeg: true, ffprobe: true, whisper: true, ytdlp: true, dataPath: "x", freeBytes: 1, activeWorkers: 0, queuedJobs: 0, fallbacks: {} } as unknown as Health;
const card: ProviderProfile = {
  id: "p1", name: "Work", textModelId: "openai/gpt-4.1-mini", selected: true, persistence: "encrypted",
  openrouterConfigured: true, openrouterMasked: "sk-…abcd", textStatus: "connected", textMessage: "Connected", textLastCheckedAt: null,
  ollamaUrl: "http://ollama.test:11434", ollamaModel: "llama3.2", ollamaStatus: "connected", ollamaMessage: "Connected", ollamaLastCheckedAt: null,
  status: "connected", capabilities: [], fallbacks: {},
} as ProviderProfile;
const liveModels: OpenRouterModel[] = [{ id: "vendor/fresh", name: "Fresh model" }];

function renderView() {
  return render(<SettingsView health={health} onHealthRefresh={vi.fn(async () => undefined)} onProfilesChanged={vi.fn()} />);
}

async function openCardBox(provider: "OpenRouter" | "Ollama", field: string) {
  const article = await screen.findByRole("article");
  const box = within(article).getByRole("region", { name: provider });
  const input = within(box).getByRole("combobox", { name: field });
  return { article, box, input };
}

beforeEach(() => {
  mockListProfiles.mockReset();
  mockScan.mockReset();
  mockScan.mockResolvedValue([]);
  mockSave.mockReset();
  mockTest.mockReset();
});

describe("live model scan on profile cards", () => {
  it("OpenRouter scans with the profile id and no typed key, so the saved key is used", async () => {
    mockListProfiles.mockResolvedValue([card]);
    renderView();
    const { input } = await openCardBox("OpenRouter", "Text-generation model");
    fireEvent.click(input);
    await waitFor(() => expect(mockScan).toHaveBeenCalledTimes(1));
    const [payload] = mockScan.mock.calls[0];
    expect(payload).toMatchObject({ provider: "openrouter", profileId: "p1" });
    expect(payload.openrouterKey).toBeUndefined();
    expect(payload.ollamaUrl).toBeUndefined();
  });

  it("a typed key is sent for the scan, and the field stays cleared", async () => {
    mockListProfiles.mockResolvedValue([card]);
    renderView();
    const { box, input } = await openCardBox("OpenRouter", "Text-generation model");
    fireEvent.change(within(box).getByLabelText(/^OpenRouter API key/), { target: { value: "sk-or-typed-key" } });
    fireEvent.click(input);
    await waitFor(() => expect(mockScan).toHaveBeenCalledTimes(1));
    expect(mockScan.mock.calls[0][0]).toMatchObject({ provider: "openrouter", profileId: "p1", openrouterKey: "sk-or-typed-key" });
    expect(within(box).getByLabelText(/^OpenRouter API key/)).toHaveValue("sk-or-typed-key");
  });

  it("Ollama scans with the profile id and the endpoint currently in the box", async () => {
    mockListProfiles.mockResolvedValue([card]);
    renderView();
    const { input } = await openCardBox("Ollama", "Ollama model");
    fireEvent.click(input);
    await waitFor(() => expect(mockScan).toHaveBeenCalledTimes(1));
    expect(mockScan.mock.calls[0][0]).toMatchObject({ provider: "ollama", profileId: "p1", ollamaUrl: "http://ollama.test:11434" });
  });

  it("a switched-off provider cannot open or scan", async () => {
    mockListProfiles.mockResolvedValue([{ ...card, openrouterEnabled: false }]);
    renderView();
    const { input } = await openCardBox("OpenRouter", "Text-generation model");
    expect(input).toBeDisabled();
    fireEvent.click(input);
    expect(mockScan).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("explains what is missing instead of scanning when there is no key or endpoint", async () => {
    mockListProfiles.mockResolvedValue([{ ...card, openrouterConfigured: false, openrouterMasked: null, textStatus: "not_configured", ollamaUrl: null, ollamaModel: null, ollamaStatus: "not_configured" } as ProviderProfile]);
    renderView();
    const or = await openCardBox("OpenRouter", "Text-generation model");
    fireEvent.click(or.input);
    expect(await screen.findByText("Add your OpenRouter API key to scan its models.")).toBeInTheDocument();
    fireEvent.keyDown(or.input, { key: "Escape" });
    const ol = await openCardBox("Ollama", "Ollama model");
    fireEvent.click(ol.input);
    expect(await screen.findByText("Add your Ollama endpoint to scan its models.")).toBeInTheDocument();
    expect(mockScan).not.toHaveBeenCalled();
  });

  it("choosing a live model enables this box's Save and test but saves nothing", async () => {
    mockListProfiles.mockResolvedValue([card]);
    mockScan.mockResolvedValue(liveModels);
    renderView();
    const { box, input } = await openCardBox("OpenRouter", "Text-generation model");
    fireEvent.click(input);
    fireEvent.click(await screen.findByRole("option", { name: /Fresh model/ }));
    expect(input).toHaveValue("vendor/fresh");
    expect(within(box).getByRole("button", { name: "Save and test" })).toBeEnabled();
    expect(mockSave).not.toHaveBeenCalled();
    expect(mockTest).not.toHaveBeenCalled();
  });
});

describe("live model scan in the New profile form", () => {
  it("sends the typed endpoint with no profile id, so nothing is looked up", async () => {
    mockListProfiles.mockResolvedValue([]);
    renderView();
    await screen.findByText("New OpenRouter profile");
    const form = document.querySelector(".profile-form") as HTMLElement;
    fireEvent.change(within(form).getByLabelText(/Ollama endpoint/), { target: { value: "http://new.test:11434" } });
    fireEvent.click(within(form).getByRole("combobox", { name: "Ollama model" }));
    await waitFor(() => expect(mockScan).toHaveBeenCalledTimes(1));
    const [payload] = mockScan.mock.calls[0];
    expect(payload).toMatchObject({ provider: "ollama", ollamaUrl: "http://new.test:11434" });
    expect(payload.profileId).toBeUndefined();
  });

  it("asks for a key before scanning OpenRouter on a new profile", async () => {
    mockListProfiles.mockResolvedValue([]);
    renderView();
    await screen.findByText("New OpenRouter profile");
    const form = document.querySelector(".profile-form") as HTMLElement;
    fireEvent.click(within(form).getByRole("combobox", { name: "Text-generation model" }));
    expect(await screen.findByText("Add your OpenRouter API key to scan its models.")).toBeInTheDocument();
    expect(mockScan).not.toHaveBeenCalled();
  });
});
