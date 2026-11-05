import { useId, useState, type ReactNode } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Field } from "./common";

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

export function OpenRouterFields({ disabled, savedMasked, apiKey, onApiKeyChange, model, onModelChange }: {
  disabled: boolean;
  savedMasked: string | null;
  apiKey: string;
  onApiKeyChange: (value: string) => void;
  model: string;
  onModelChange: (value: string) => void;
}) {
  const [showKey, setShowKey] = useState(false);
  return <>
    <Field label="OpenRouter API key" hint={savedMasked ? `Saved value: ${savedMasked}. Leave blank to keep it.` : "The raw key is never returned after saving."}>
      <div className="secret-input">
        <input type={showKey ? "text" : "password"} autoComplete="new-password" value={apiKey} disabled={disabled} onChange={(event) => onApiKeyChange(event.target.value)} placeholder="sk-or-v1-…" />
        <button type="button" disabled={disabled} onClick={() => setShowKey(!showKey)} aria-label={`${showKey ? "Hide" : "Show"} OpenRouter API key`}>{showKey ? <EyeOff size={15} /> : <Eye size={15} />}</button>
      </div>
    </Field>
    <Field label="Text-generation model"><input value={model} disabled={disabled} onChange={(event) => onModelChange(event.target.value)} placeholder="openai/gpt-4.1-mini" /></Field>
  </>;
}

export function OllamaFields({ disabled, url, onUrlChange, model, onModelChange }: {
  disabled: boolean;
  url: string;
  onUrlChange: (value: string) => void;
  model: string;
  onModelChange: (value: string) => void;
}) {
  return <>
    <Field label="Ollama endpoint" hint="Use your Ollama server's address. localhost means the S6_cut container."><input value={url} disabled={disabled} onChange={(event) => onUrlChange(event.target.value)} placeholder="http://host.docker.internal:11434" /></Field>
    <Field label="Ollama model" hint="Leave blank to detect and test the smallest available chat model."><input value={model} disabled={disabled} onChange={(event) => onModelChange(event.target.value)} placeholder="Auto-detect available model" /></Field>
  </>;
}
