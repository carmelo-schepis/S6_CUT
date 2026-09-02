import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTopicPlan, listOpenRouterModels } from "../api";
import { openRouterModelSchema } from "../types";
import type { ProviderProfile, TopicVideoPlan } from "../types";
import { TopicToVideoView } from "./topic-to-video-view";

vi.mock("../api", () => ({
  createScriptJob: vi.fn(),
  createTopicPlan: vi.fn(),
  listOpenRouterModels: vi.fn(),
  readableError: (error: unknown) => error instanceof Error ? error.message : "Unable to load models",
}));

const connected: ProviderProfile = {
  id: "profile-1", name: "Connected profile", modelId: "saved/model", selected: true,
  persistence: "encrypted", openrouterConfigured: true, elevenlabsConfigured: false,
  openrouterMasked: "sk-…safe", elevenlabsMasked: null, openrouterStatus: "connected",
  elevenlabsStatus: "not_configured", openrouterMessage: null, elevenlabsMessage: null,
  status: "connected", capabilities: ["structured planning"], fallbacks: { planning: "local" },
};
const disconnected: ProviderProfile = { ...connected, id: "profile-2", selected: true, openrouterConfigured: false, openrouterStatus: "not_configured" };
const models = [
  { id: "vendor/first-arbitrary", name: "First arbitrary", contextLength: 32000 },
  { id: "vendor/second-arbitrary", name: "Second arbitrary", contextLength: null },
];
const plan: TopicVideoPlan = {
  title: "A plan", hook: "A hook", narration: "A generated narration.",
  beats: [{ narration: "A beat", seconds: 10, keywords: ["topic"] }], estimatedDuration: 10,
  description: "Description", hashtags: ["topic"],
};

const mockModels = vi.mocked(listOpenRouterModels);
const mockPlan = vi.mocked(createTopicPlan);

function renderView(profiles: ProviderProfile[] = [connected]) {
  return render(<TopicToVideoView profiles={profiles} onConfigureProviders={vi.fn()} onJobCreated={vi.fn()} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockModels.mockResolvedValue(models);
  mockPlan.mockResolvedValue(plan);
});

describe("TopicToVideoView OpenRouter model picker", () => {
  it("explains the plan review and local custom-script path", () => {
    renderView();
    expect(screen.getByText("Turn a topic or your own script into a reviewable video plan. Choose the audience, tone, language, length, format, and number of versions, review the script and visual beats, then queue the videos for rendering; your own script can be planned locally without an AI provider.")).toBeInTheDocument();
  });

  it("renders exactly the dynamic models and preselects only a returned saved model", async () => {
    renderView();
    const select = await screen.findByLabelText("OpenRouter model");
    expect(within(select).getAllByRole("option").map((option) => (option as HTMLOptionElement).value)).toEqual(["", "vendor/first-arbitrary", "vendor/second-arbitrary"]);
    expect(screen.queryByRole("option", { name: /gpt-4\.1/i })).not.toBeInTheDocument();
    expect(select).toHaveValue("");

    mockModels.mockResolvedValueOnce([{ id: "saved/model", name: "Saved model" }]);
    fireEvent.click(screen.getByRole("button", { name: "Refresh models" }));
    await waitFor(() => expect(select).toHaveValue("saved/model"));
  });

  it("leaves the placeholder selected when the saved model is missing", async () => {
    renderView();
    const select = await screen.findByLabelText("OpenRouter model");
    expect(select).toHaveValue("");
    expect((screen.getByRole("option", { name: "Choose a model" }) as HTMLOptionElement).selected).toBe(true);
  });

  it("handles loading, empty, failure, and refresh removal/addition states", async () => {
    let resolveModels!: (value: typeof models) => void;
    mockModels.mockReturnValueOnce(new Promise((resolve) => { resolveModels = resolve; }));
    renderView();
    expect(screen.getByText("Loading available OpenRouter models…")).toBeVisible();
    expect(screen.getByLabelText("OpenRouter model")).toBeDisabled();
    resolveModels([]);
    await waitFor(() => expect(screen.getByText(/No OpenRouter models/)).toBeVisible());
    expect(screen.getByRole("button", { name: "Create / refresh plan" })).toBeDisabled();

    mockModels.mockRejectedValueOnce(new Error("Model service unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh models" }));
    await waitFor(() => expect(screen.getByText(/Unable to load OpenRouter models: Model service unavailable/)).toBeVisible());
    mockModels.mockResolvedValueOnce([{ id: "vendor/new", name: "New model" }]);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("option", { name: /New model/ })).toBeInTheDocument());
    expect(screen.getByLabelText("OpenRouter model")).toHaveValue("");
    expect(screen.queryByRole("option", { name: /First arbitrary/ })).not.toBeInTheDocument();
  });

  it("sends the exact selected model and makes a changed model plan stale", async () => {
    renderView();
    const select = await screen.findByLabelText("OpenRouter model");
    fireEvent.change(select, { target: { value: "vendor/second-arbitrary" } });
    fireEvent.change(screen.getByLabelText("Topic or keyword"), { target: { value: "Model selection" } });
    fireEvent.click(screen.getByRole("button", { name: "Create / refresh plan" }));
    await waitFor(() => expect(mockPlan).toHaveBeenCalledWith(expect.objectContaining({ modelId: "vendor/second-arbitrary" })));
    await screen.findByRole("region", { name: "Reviewable script plan" });
    fireEvent.change(select, { target: { value: "vendor/first-arbitrary" } });
    expect(screen.getByText(/Provider or model changed/)).toBeVisible();
    expect(screen.getByRole("button", { name: /Generate reviewed video/ })).toBeDisabled();
  });

  it("allows custom-script planning without a provider or model request", async () => {
    renderView([disconnected]);
    expect(screen.queryByLabelText("OpenRouter model")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Topic or keyword"), { target: { value: "Local script" } });
    fireEvent.change(screen.getByLabelText(/Custom script/), { target: { value: "This custom script is long enough for local planning." } });
    const submit = screen.getByRole("button", { name: "Create / refresh plan" });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() => expect(mockPlan).toHaveBeenCalledWith(expect.objectContaining({ modelId: undefined, customScript: "This custom script is long enough for local planning." })));
    expect(mockModels).not.toHaveBeenCalled();
  });

  it("validates the model response through the API schema boundary", async () => {
    expect(() => openRouterModelSchema.parse({ id: "", name: "Invalid" })).toThrow();
    mockModels.mockResolvedValueOnce([{ id: "validated/id", name: "Validated" }]);
    renderView();
    expect(await screen.findByRole("option", { name: /Validated — validated\/id/ })).toBeInTheDocument();
  });
});
