import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Health, ProviderProfile } from "../types";
import { SettingsView } from "./settings-view";

// ---------------------------------------------------------------
// Mock the API module so no real fetch is attempted.
// ---------------------------------------------------------------
vi.mock("../api", () => {
  const readableError = (e: unknown) =>
    e instanceof Error ? e.message : "Something went wrong. Try again.";
  return { readableError, listProfiles: vi.fn(), saveProfile: vi.fn(), testProfile: vi.fn(), deleteProfile: vi.fn(), duplicateProfile: vi.fn() };
});

import { deleteProfile, listProfiles, saveProfile, testProfile } from "../api";

const mockListProfiles = vi.mocked(listProfiles);
const mockSaveProfile = vi.mocked(saveProfile);
const mockTestProfile = vi.mocked(testProfile);
const mockDeleteProfile = vi.mocked(deleteProfile);

const health: Health = {
  status: "ready",
  version: "test",
  database: true,
  ffmpeg: true,
  ffprobe: true,
  whisper: true,
  ytdlp: true,
  localTts: true,
  dataPath: "Local mounted data directory",
  freeBytes: 1_000_000,
  activeWorkers: 0,
  queuedJobs: 0,
  fallbacks: { planning: "deterministic" },
};

const connectedProfile: ProviderProfile = {
  id: "p1",
  name: "Work profile",
  modelId: "openai/gpt-4.1-mini",
  voiceId: null,
  selected: true,
  persistence: "encrypted",
  openrouterConfigured: true,
  elevenlabsConfigured: true,
  openrouterMasked: "sk-…abcd",
  elevenlabsMasked: "el-…wxyz",
  openrouterStatus: "connected",
  elevenlabsStatus: "invalid_credentials",
  openrouterMessage: null,
  elevenlabsMessage: "Invalid API key — check your ElevenLabs key",
  status: "attention",
  capabilities: ["planning"],
  fallbacks: { planning: "deterministic", narration: "local" },
};

const baseProfile: ProviderProfile = {
  id: "p2",
  name: "Minimal",
  modelId: "openai/gpt-4.1-mini",
  voiceId: null,
  selected: false,
  persistence: "session",
  openrouterConfigured: false,
  elevenlabsConfigured: false,
  openrouterMasked: null,
  elevenlabsMasked: null,
  openrouterStatus: "not_configured",
  elevenlabsStatus: "not_configured",
  openrouterMessage: null,
  elevenlabsMessage: null,
  status: "fallback",
  capabilities: [],
  fallbacks: { planning: "deterministic" },
};

// ---------------------------------------------------------------
function renderView() {
  const onHealthRefresh = vi.fn(async () => undefined);
  const onProfilesChanged = vi.fn();
  const result = render(
    <SettingsView health={health} onHealthRefresh={onHealthRefresh} onProfilesChanged={onProfilesChanged} />,
  );
  return { onHealthRefresh, onProfilesChanged, ...result };
}

// ---------------------------------------------------------------
describe("SettingsView – provider profile list", () => {
  it("renders page heading and New profile button", async () => {
    mockListProfiles.mockResolvedValue([]);
    renderView();
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New profile" })).toBeInTheDocument();
  });

  it("shows independent OpenRouter and ElevenLabs connection results per profile", async () => {
    mockListProfiles.mockResolvedValue([connectedProfile]);
    renderView();

    // Wait for the profile row to appear
    const article = await screen.findByRole("article");
    expect(within(article).getByText("Work profile")).toBeInTheDocument();
    expect(within(article).getByText("OpenRouter", { selector: ".connection-result span" })).toBeInTheDocument();
    expect(within(article).getByText(/connected/i)).toBeInTheDocument();
    expect(within(article).getByText("ElevenLabs", { selector: ".connection-result span" })).toBeInTheDocument();
    // Masked keys are labelled values, not a run-together sentence.
    expect(within(article).getByText("sk-…abcd")).toBeInTheDocument();
    expect(within(article).getByText("el-…wxyz")).toBeInTheDocument();
    expect(within(article).getByText(/Invalid API key — check your ElevenLabs key/)).toBeInTheDocument();
  });

  it("shows the inline setup form by default on an empty card, and the empty state after dismissing it", async () => {
    mockListProfiles.mockResolvedValue([]);
    renderView();
    // Inline form is open by default so OpenRouter is visible.
    expect(await screen.findByText("New provider profile")).toBeInTheDocument();
    expect(screen.getByText("OpenRouter", { selector: ".provider-fieldset strong" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("sk-or-v1-…")).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "Use fast local cutting without APIs" })).toBeInTheDocument();
    // Dismissing the form reveals the empty-state copy.
    fireEvent.click(screen.getByRole("button", { name: "Close provider form" }));
    expect(await screen.findByText("No provider profile")).toBeInTheDocument();
  });

  it("shows an in-card Add provider button once profiles exist", async () => {
    mockListProfiles.mockResolvedValue([baseProfile]);
    renderView();
    await screen.findByText("Minimal");
    const addButton = await screen.findByRole("button", { name: "Add or update provider" });
    fireEvent.click(addButton);
    expect(screen.getByText("New provider profile")).toBeInTheDocument();
  });

  it("calls onSkipSetup from the fast-local action on the empty card", async () => {
    mockListProfiles.mockResolvedValue([]);
    const onSkipSetup = vi.fn();
    render(<SettingsView health={health} onHealthRefresh={vi.fn(async () => undefined)} onSkipSetup={onSkipSetup} />);
    await screen.findByText("New provider profile");
    fireEvent.click(screen.getByRole("button", { name: "Close provider form" }));
    fireEvent.click(await screen.findByRole("button", { name: /Continue with fast local cut/i }));
    expect(onSkipSetup).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------
describe("SettingsView – provider setup form (ProfileForm)", () => {
  beforeEach(() => {
    mockListProfiles.mockResolvedValue([]);
    mockSaveProfile.mockReset();
    mockTestProfile.mockReset();
  });

  const openForm = async () => {
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: "New profile" }));
    return {
      nameInput: screen.getByDisplayValue("My profile") as HTMLInputElement,
      modelInput: screen.getByDisplayValue("openai/gpt-4.1-mini") as HTMLInputElement,
      // The Field label text includes its hint; the show/hide button also has an
      // aria-label with the key name, so narrow the query to actual inputs.
      orKeyInput: screen.getByLabelText(/OpenRouter API key/i, { selector: "input" }) as HTMLInputElement,
      elKeyInput: screen.getByLabelText(/ElevenLabs API key/i, { selector: "input" }) as HTMLInputElement,
      saveButton: screen.getByRole("button", { name: /Save and test connection/i }),
      cancelButton: screen.getByRole("button", { name: /Cancel/i }),
      formTitle: screen.getByText("New provider profile"),
    };
  };

  it("opens the form when clicking New profile", async () => {
    const { formTitle, saveButton, cancelButton } = await openForm();
    expect(formTitle).toBeInTheDocument();
    expect(saveButton).toBeInTheDocument();
    expect(cancelButton).toBeInTheDocument();
  });

  it("renders OpenRouter and ElevenLabs keys as password fields", async () => {
    const { orKeyInput, elKeyInput } = await openForm();
    expect(orKeyInput).toHaveAttribute("type", "password");
    expect(elKeyInput).toHaveAttribute("type", "password");
  });

  it("toggles OpenRouter key visibility on show/hide click", async () => {
    const { orKeyInput } = await openForm();
    // Find the show/hide toggle button (sibling of the input)
    const showBtn = orKeyInput!.parentElement!.querySelector("button")!;
    expect(showBtn).toHaveAttribute("aria-label", "Show OpenRouter API key");
    fireEvent.click(showBtn);
    expect(orKeyInput).toHaveAttribute("type", "text");
    expect(showBtn).toHaveAttribute("aria-label", "Hide OpenRouter API key");
    fireEvent.click(showBtn);
    expect(orKeyInput).toHaveAttribute("type", "password");
  });

  it("toggles ElevenLabs key visibility on show/hide click", async () => {
    const { elKeyInput } = await openForm();
    const showBtn = elKeyInput!.parentElement!.querySelector("button")!;
    expect(showBtn).toHaveAttribute("aria-label", "Show ElevenLabs API key");
    fireEvent.click(showBtn);
    expect(elKeyInput).toHaveAttribute("type", "text");
    expect(showBtn).toHaveAttribute("aria-label", "Hide ElevenLabs API key");
  });

  it("disables Save button when name is empty", async () => {
    const { nameInput, saveButton } = await openForm();
    expect(saveButton).toBeEnabled();
    fireEvent.change(nameInput, { target: { value: "" } });
    expect(saveButton).toBeDisabled();
  });

  it("closes form on Cancel", async () => {
    const { cancelButton } = await openForm();
    fireEvent.click(cancelButton);
    expect(screen.queryByText("New provider profile")).not.toBeInTheDocument();
  });

  it("calls saveProfile and testProfile on Save, then refreshes the list", async () => {
    const saved: ProviderProfile = {
      id: "new-1",
      name: "My profile",
      modelId: "openai/gpt-4.1-mini",
      voiceId: null,
      selected: true,
      persistence: "encrypted",
      openrouterConfigured: false,
      elevenlabsConfigured: false,
      openrouterMasked: null,
      elevenlabsMasked: null,
      openrouterStatus: "not_configured",
      elevenlabsStatus: "not_configured",
      openrouterMessage: null,
      elevenlabsMessage: null,
      status: "fallback",
      capabilities: [],
      fallbacks: { planning: "deterministic" },
    };
    const tested: ProviderProfile = { ...saved, openrouterStatus: "connected", status: "connected" };
    mockSaveProfile.mockResolvedValue(saved);
    mockTestProfile.mockResolvedValue(tested);
    // After save, listProfiles will be called again — return the tested profile
    mockListProfiles.mockResolvedValue([tested]);

    const { saveButton } = await openForm();
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(mockSaveProfile).toHaveBeenCalledOnce();
    });
    // Verify the payload shape
    const callArgs = mockSaveProfile.mock.calls[0];
    expect(callArgs[0]).toMatchObject({ name: "My profile", modelId: "openai/gpt-4.1-mini", persistence: "encrypted" });
    // id is undefined for new profile
    expect(callArgs[1]).toBeUndefined();

    // testProfile should have been called with the saved id
    await waitFor(() => {
      expect(mockTestProfile).toHaveBeenCalledWith("new-1");
    });

    // The form should close and the list refresh should show the tested profile
    await waitFor(() => {
      expect(screen.queryByText("New provider profile")).not.toBeInTheDocument();
    });
    expect(await screen.findByText("My profile")).toBeInTheDocument();
  });

  it("shows 'Saving and testing…' while the request is in flight", async () => {
    // Keep the promise pending so we can observe the busy state
    mockSaveProfile.mockReturnValue(new Promise<ProviderProfile>(() => {}));
    const { saveButton } = await openForm();
    fireEvent.click(saveButton);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Saving and testing/i })).toBeDisabled();
    });
  });

  it("displays API error when saveProfile fails", async () => {
    mockSaveProfile.mockRejectedValue(new Error("Engine is not running"));
    const { saveButton } = await openForm();
    fireEvent.click(saveButton);
    expect(await screen.findByRole("alert")).toHaveTextContent("Engine is not running");
  });

  it("allows editing an existing profile name and model ID", async () => {
    mockListProfiles.mockResolvedValue([baseProfile]);
    // Reset spies so listProfiles results are used
    mockSaveProfile.mockReset();
    mockSaveProfile.mockResolvedValue(baseProfile);
    mockTestProfile.mockReset();
    mockTestProfile.mockResolvedValue(baseProfile);

    renderView();
    await screen.findByText("Minimal");
    // Click edit button on the profile row
    fireEvent.click(screen.getByRole("button", { name: "Edit Minimal" }));
    expect(await screen.findByText("Edit provider profile")).toBeInTheDocument();

    const nameInput = screen.getByDisplayValue("Minimal") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Edited" } });
    fireEvent.click(screen.getByRole("button", { name: /Save and test connection/i }));

    await waitFor(() => {
      expect(mockSaveProfile).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Edited" }),
        baseProfile.id,
      );
    });
  });
});

// ---------------------------------------------------------------
describe("SettingsView – profile actions (test, duplicate, delete)", () => {
  beforeEach(() => {
    mockListProfiles.mockResolvedValue([baseProfile]);
    globalThis.confirm = vi.fn(() => true);
  });

  it("calls testProfile when Test button is clicked", async () => {
    mockTestProfile.mockResolvedValue(baseProfile);
    renderView();
    await screen.findByText("Minimal");

    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    await waitFor(() => {
      expect(mockTestProfile).toHaveBeenCalledWith(baseProfile.id);
    });
  });

  it("calls deleteProfile and refreshes when Delete is confirmed", async () => {
    mockDeleteProfile.mockResolvedValue(undefined);
    // First load returns the profile; the post-delete refresh returns an empty list.
    mockListProfiles.mockReset().mockResolvedValueOnce([baseProfile]).mockResolvedValue([]);

    renderView();
    await screen.findByText("Minimal");
    fireEvent.click(screen.getByRole("button", { name: "Delete Minimal" }));

    await waitFor(() => {
      expect(mockDeleteProfile).toHaveBeenCalledWith(baseProfile.id);
    });
    // With no profiles left, the inline setup form opens again by default.
    expect(await screen.findByText("New provider profile")).toBeInTheDocument();
  });
});