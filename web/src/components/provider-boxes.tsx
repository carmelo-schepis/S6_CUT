import { useId, useState, type ReactNode } from "react";
import { Eye, EyeOff } from "lucide-react";
import type { OpenRouterModel } from "../types";
import { Field } from "./common";
import { ModelPicker } from "./model-picker";

export type ProviderName = "OpenRouter" | "Ollama";

/** One provider's own box: its name, an on/off switch, its fields, and its status or footer. */
export function ProviderBox({ provider, enabled, busy = false, error = null, onEnabledChange, children }: {
  provider: ProviderName;
  enabled: boolean;
  busy?: boolean;
  error?: string | null;
  onEnabledChange: (enabled: boolean) => void;
  children: ReactNode;
}) {
  const headingId = `provider-box-${provider.toLowerCase()}-${useId()}`;
  return <section className={`provider-box${enabled ? "" : " is-off"}`} aria-labelledby={headingId}>
    <header className="provider-box-head">
      <h3 id={headingId}>{provider}</h3>
      <label className="provider-switch">
        {/* Not disabled while saving: a disabled control drops keyboard focus. Changes are ignored until the save returns. */}
        <input type="checkbox" role="switch" aria-label={`Use ${provider}`} checked={enabled} aria-busy={busy || undefined} onChange={(event) => { if (!busy) onEnabledChange(event.target.checked); }} />
        <span className="provider-switch-track" aria-hidden="true" />
        <span className="provider-switch-word">{enabled ? "On" : "Off"}</span>
      </label>
    </header>
    {error && <p className="form-error" role="alert">{error}</p>}
    {children}
  </section>;
}

/** Second line for an OpenRouter row: id, price, and a warning when structured output may be missing. */
export function describeOpenRouterModel(model: OpenRouterModel): string {
  const input = Number(model.pricing?.prompt) * 1_000_000;
  const output = Number(model.pricing?.completion) * 1_000_000;
  const price = model.free || (input === 0 && output === 0) ? "Free"
    : Number.isFinite(input) && Number.isFinite(output) ? `$${input.toFixed(3)}/M in · $${output.toFixed(3)}/M out` : null;
  const structured = model.supportedParameters && model.supportedParameters.length > 0 && !model.supportedParameters.includes("response_format") ? "May not support structured output" : null;
  return [model.id, price, structured].filter(Boolean).join(" · ");
}

export function OpenRouterFields({ disabled, savedMasked, apiKey, onApiKeyChange, model, onModelChange, savedModel = null, scan, scanBlocked = null }: {
  disabled: boolean;
  savedMasked: string | null;
  apiKey: string;
  onApiKeyChange: (value: string) => void;
  model: string;
  onModelChange: (value: string) => void;
  savedModel?: string | null;
  scan: (signal: AbortSignal) => Promise<OpenRouterModel[]>;
  scanBlocked?: string | null;
}) {
  const [showKey, setShowKey] = useState(false);
  const modelFieldId = `openrouter-model-${useId()}`;
  return <>
    <Field label="OpenRouter API key" hint={savedMasked ? `Saved value: ${savedMasked}. Leave blank to keep it.` : "The raw key is never returned after saving."}>
      <div className="secret-input">
        <input type={showKey ? "text" : "password"} autoComplete="new-password" value={apiKey} disabled={disabled} onChange={(event) => onApiKeyChange(event.target.value)} placeholder="sk-or-v1-…" />
        <button type="button" disabled={disabled} onClick={() => setShowKey(!showKey)} aria-label={`${showKey ? "Hide" : "Show"} OpenRouter API key`}>{showKey ? <EyeOff size={15} /> : <Eye size={15} />}</button>
      </div>
    </Field>
    <ModelPicker id={modelFieldId} label="Text-generation model" hint="Scanned from OpenRouter each time you open this list. You can also type a model ID." value={model} onChange={onModelChange} disabled={disabled}
      placeholder="openai/gpt-4.1-mini" scan={scan} scanBlocked={scanBlocked} savedValue={savedModel} describe={describeOpenRouterModel} emptyMessage="No text models found on OpenRouter." />
  </>;
}

export function OllamaFields({ disabled, url, onUrlChange, model, onModelChange, savedModel = null, scan, scanBlocked = null }: {
  disabled: boolean;
  url: string;
  onUrlChange: (value: string) => void;
  model: string;
  onModelChange: (value: string) => void;
  savedModel?: string | null;
  scan: (signal: AbortSignal) => Promise<OpenRouterModel[]>;
  scanBlocked?: string | null;
}) {
  const modelFieldId = `ollama-model-${useId()}`;
  return <>
    <Field label="Ollama endpoint" hint="Use your Ollama server's address. localhost means the S6_cut container."><input value={url} disabled={disabled} onChange={(event) => onUrlChange(event.target.value)} placeholder="http://host.docker.internal:11434" /></Field>
    <ModelPicker id={modelFieldId} label="Ollama model" hint="Leave blank to detect and test the smallest available chat model." value={model} onChange={onModelChange} disabled={disabled}
      placeholder="Auto-detect available model" scan={scan} scanBlocked={scanBlocked} savedValue={savedModel} autoOption="Auto-detect smallest model" emptyMessage="No chat models found on this Ollama server. Pull one with ollama pull, then open this list again." />
  </>;
}
