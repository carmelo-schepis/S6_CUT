import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Check, Copy, Cpu, Database, KeyRound, LockKeyhole, Network, Pencil, Plus, RefreshCw, Server, ShieldAlert, Trash2, X } from "lucide-react";
import { deleteProfile, duplicateProfile, listOpenRouterModels, listProfiles, purgeLibraryContent, readableError, saveProfile, scanProviderModels, testProfile } from "../api";
import { emitLibraryChanged } from "../library-sync";
import type { Health, LibraryPurgeResult, OpenRouterModel, ProviderProfile } from "../types";
import { isOllamaOn, isOpenRouterOn } from "../types";
import { Button, Field, PageHeader, StatusBadge } from "./common";
import { OllamaFields, OpenRouterFields, ProviderBox } from "./provider-boxes";

export function SettingsView({ health, onHealthRefresh, onProfilesChanged, onSkipSetup = () => undefined }: { health: Health | null; onHealthRefresh: () => Promise<void>; onProfilesChanged?: (profiles: ProviderProfile[]) => void; onSkipSetup?: () => void }) {
  const [profiles, setProfiles] = useState<ProviderProfile[]>([]);
  const [editing, setEditing] = useState<ProviderProfile | "new" | null>(null);
  const [setupDismissed, setSetupDismissed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [purgeDialogOpen, setPurgeDialogOpen] = useState(false);
  const [purgeConfirmation, setPurgeConfirmation] = useState("");
  const [purging, setPurging] = useState(false);
  const [purgeError, setPurgeError] = useState<string | null>(null);
  const [purgeResult, setPurgeResult] = useState<LibraryPurgeResult | null>(null);
  const [metadataModels, setMetadataModels] = useState<OpenRouterModel[]>([]);
  const [metadataModelsLoading, setMetadataModelsLoading] = useState(false);
  const [metadataModelError, setMetadataModelError] = useState<string | null>(null);
  const selectedProfile = profiles.find((profile) => profile.selected) || null;
  // Model lookups need a connected OpenRouter; a switched-off one is never called.
  const metadataAvailable = Boolean(selectedProfile && selectedProfile.textStatus === "connected" && isOpenRouterOn(selectedProfile));
  const purgeTriggerRef = useRef<HTMLButtonElement>(null);
  const purgeInputRef = useRef<HTMLInputElement>(null);
  const wasPurgeDialogOpen = useRef(false);
  const load = useCallback(() => listProfiles().then((next) => { setProfiles(next); onProfilesChanged?.(next); }).catch((cause) => setError(readableError(cause))), [onProfilesChanged]);
  useEffect(() => { void load(); }, [load]);
  const refreshMetadataModels = useCallback(async () => {
    setMetadataModelsLoading(true); setMetadataModelError(null);
    try { setMetadataModels(await listOpenRouterModels("text")); }
    catch (cause) { setMetadataModelError(readableError(cause)); }
    finally { setMetadataModelsLoading(false); }
  }, []);
  useEffect(() => {
    if (!metadataAvailable) return;
    let active = true;
    void listOpenRouterModels("text").then((models) => { if (active) setMetadataModels(models); }).catch((cause) => { if (active) setMetadataModelError(readableError(cause)); });
    return () => { active = false; };
  }, [selectedProfile?.id, selectedProfile?.textStatus, metadataAvailable]);
  const setMetadataModel = async (modelId: string) => {
    if (!selectedProfile) return;
    setError(null);
    try {
      await saveProfile({ name: selectedProfile.name, textModelId: selectedProfile.textModelId, youtubeMetadataModelId: modelId, persistence: selectedProfile.persistence, selected: true }, selectedProfile.id);
      await load();
    } catch (cause) { setError(readableError(cause)); }
  };
  const [savingAutoSeo, setSavingAutoSeo] = useState(false);
  const setAutoSeoTitles = async (autoSeoTitles: boolean) => {
    if (!selectedProfile) return;
    setError(null); setSavingAutoSeo(true);
    try {
      await saveProfile({ name: selectedProfile.name, textModelId: selectedProfile.textModelId, youtubeMetadataModelId: selectedProfile.youtubeMetadataModelId, autoSeoTitles, persistence: selectedProfile.persistence, selected: true }, selectedProfile.id);
      await load();
    } catch (cause) { setError(readableError(cause)); } finally { setSavingAutoSeo(false); }
  };
  useEffect(() => {
    if (purgeDialogOpen) {
      wasPurgeDialogOpen.current = true;
      purgeInputRef.current?.focus();
    } else if (wasPurgeDialogOpen.current) {
      wasPurgeDialogOpen.current = false;
      purgeTriggerRef.current?.focus();
    }
  }, [purgeDialogOpen]);
  const showSetupForm = Boolean(editing) || (!profiles.length && !setupDismissed);

  const remove = async (id: string) => {
    if (!window.confirm("Delete this OpenRouter profile? Its saved encrypted secret will also be removed.")) return;
    try { await deleteProfile(id); await load(); } catch (cause) { setError(readableError(cause)); }
  };
  const duplicate = async (id: string) => { try { await duplicateProfile(id); await load(); } catch (cause) { setError(readableError(cause)); } };
  const test = async (id: string) => {
    setTestingId(id); setError(null);
    try { await testProfile(id); await load(); } catch (cause) { setError(readableError(cause)); } finally { setTestingId(null); }
  };
  const select = async (profile: ProviderProfile) => {
    try { await saveProfile({ name: profile.name, textModelId: profile.textModelId, youtubeMetadataModelId: profile.youtubeMetadataModelId, persistence: profile.persistence, selected: true }, profile.id); await load(); }
    catch (cause) { setError(readableError(cause)); }
  };
  const openPurgeDialog = () => { setPurgeConfirmation(""); setPurgeError(null); setPurgeDialogOpen(true); };
  const closePurgeDialog = () => { if (!purging) setPurgeDialogOpen(false); };
  const purge = async () => {
    if (purgeConfirmation !== "DELETE ALL CONTENT") return;
    setPurging(true); setPurgeError(null);
    try { setPurgeResult(await purgeLibraryContent(purgeConfirmation)); emitLibraryChanged(); setPurgeDialogOpen(false); }
    catch (cause) { setPurgeError(readableError(cause)); }
    finally { setPurging(false); }
  };

  return <><div className="page settings-page"><PageHeader title="Settings" actions={<Button variant="primary" onClick={() => { setSetupDismissed(false); setEditing("new"); }}><Plus size={15} /> New profile</Button>} />
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="settings-grid"><div className="settings-column">
      <section className="settings-card profiles-card" id="provider-profiles"><div className="settings-card-head"><div><KeyRound size={18} /><div><h2>Text providers</h2><p>Configure OpenRouter or your own Ollama server. Choose a provider for each job on Projects.</p></div></div><div className="profile-head-actions"><StatusBadge state={profiles.some((profile) => profile.selected) ? "local" : "fallback"} label={profiles.length ? `${profiles.length} saved` : "Local modes only"} />{profiles.length > 0 && <Button onClick={() => { setSetupDismissed(false); setEditing("new"); }}><Plus size={13} /> Add profile</Button>}</div></div>
        {showSetupForm && <ProfileForm initial={editing === "new" || editing === null ? undefined : editing} onUseFastLocal={onSkipSetup} onCancel={() => { setEditing(null); if (!profiles.length) setSetupDismissed(true); }} onSaved={() => { setEditing(null); void load(); }} />}
        <div className="profile-list">{profiles.map((profile) => {
          return <article key={profile.id} className="profile-row">
            <header className="profile-row-header">
              <div className="profile-identity"><div className="profile-mark"><KeyRound size={17} /></div><div className="profile-info"><div className="profile-name"><strong>{profile.name}</strong>{profile.selected && <span className="selected-label"><Check size={11} /> Active</span>}</div><dl className="profile-storage"><div><dt>Credential storage:</dt><dd><LockKeyhole size={11} aria-hidden="true" /> {profile.persistence === "encrypted" ? "Encrypted" : "Session only"}</dd></div></dl></div></div>
              <div className="profile-actions">{!profile.selected && <Button onClick={() => select(profile)}>Use profile</Button>}<Button disabled={testingId === profile.id || (!isOpenRouterOn(profile) && !isOllamaOn(profile))} onClick={() => test(profile.id)}>{testingId === profile.id ? "Checking…" : "Test"}</Button><button title="Edit" aria-label={`Edit ${profile.name}`} onClick={() => setEditing(profile)}><Pencil size={14} /></button><button title="Duplicate" aria-label={`Duplicate ${profile.name}`} onClick={() => duplicate(profile.id)}><Copy size={14} /></button><button title="Delete" aria-label={`Delete ${profile.name}`} onClick={() => remove(profile.id)}><Trash2 size={14} /></button></div>
            </header>
            <ProfileProviderBoxes profile={profile} testing={testingId === profile.id} onChanged={load} onTest={test} />
          </article>;
        })}</div>
        {!profiles.length && !showSetupForm && <div className="settings-empty"><KeyRound size={22} /><div><strong>No text provider profile</strong><p>Local deterministic planning, captions, and text-card visuals remain available.</p></div>{onSkipSetup && <Button variant="ghost" onClick={onSkipSetup}>Continue with local cutting <ArrowRight size={13} /></Button>}</div>}
      </section>
      <section className="settings-card metadata-model-card" aria-labelledby="metadata-model-heading"><div className="settings-card-head"><div><KeyRound size={18} /><div><h2 id="metadata-model-heading">Title and description model</h2><p>Independent from the general planning model; uses the selected OpenRouter profile credentials.</p></div></div><Button disabled={metadataModelsLoading || !metadataAvailable} onClick={() => void refreshMetadataModels()}><RefreshCw size={14} /> {metadataModelsLoading ? "Refreshing…" : "Refresh models"}</Button></div>
        <Field label="YouTube title and description model" hint="Only models advertising structured output and priced at no more than $0.10/M input and $0.40/M output are eligible. No automatic paid-model substitution."><select aria-label="Title and description model" value={selectedProfile?.youtubeMetadataModelId || "google/gemini-2.5-flash-lite"} disabled={!metadataAvailable} onChange={(event) => void setMetadataModel(event.target.value)}>
          {selectedProfile && !metadataModels.some((model) => model.id === selectedProfile.youtubeMetadataModelId) && <option value={selectedProfile.youtubeMetadataModelId}>{selectedProfile.youtubeMetadataModelId} · unavailable or not refreshed</option>}
          {metadataModels.map((model) => {
            const input = Number(model.pricing?.prompt) * 1_000_000;
            const output = Number(model.pricing?.completion) * 1_000_000;
            const eligible = Number.isFinite(input) && Number.isFinite(output) && input <= 0.10 && output <= 0.40 && model.supportedParameters?.includes("response_format");
            return <option key={model.id} value={model.id} disabled={!eligible}>{model.name} · {model.id} — {eligible ? `$${input.toFixed(3)}/M in · $${output.toFixed(3)}/M out` : "unavailable, unsupported, or above price cap"}</option>;
          })}
        </select></Field>
        <label className="check-row auto-seo-titles-toggle"><input type="checkbox" data-testid="auto-seo-titles" checked={selectedProfile?.autoSeoTitles ?? true} disabled={!selectedProfile || savingAutoSeo} onChange={(event) => void setAutoSeoTitles(event.target.checked)} /><span><strong>Auto-write SEO titles for new clips</strong><small>Smart short clips get an AI title and description when OpenRouter is connected.</small></span></label>
        {!selectedProfile && <p className="form-hint">Select and connect an OpenRouter profile first.</p>}
        {selectedProfile && !isOpenRouterOn(selectedProfile) && <p className="form-hint">OpenRouter is off for this profile. Turn it on to change this model.</p>}
        {metadataModelError && <p className="form-error" role="alert">Could not refresh model availability: {metadataModelError}</p>}
        {selectedProfile && <p className="form-hint">Configured: {selectedProfile.youtubeMetadataModelId || "google/gemini-2.5-flash-lite"}. Generation is unavailable if the model is missing, unknown-priced, or above the hard cap.</p>}
      </section>
      <section className="settings-card about-card"><img src="/legal-logo.png" alt="S6_cut logo" /><div><h2>S6_cut</h2><p>Free, open-source, local-first video editing. No account, watermark, or artificial usage limit.</p><p className="muted">Process only media you own or are authorised to use. Code licences do not grant rights to downloaded media, fonts, models, voices, or logos.</p><span className="version">Engine {health?.version || "—"} · Schema v1</span></div></section>
    </div><div className="settings-column">
      <section className="settings-card"><div className="settings-card-head"><div><Cpu size={18} /><div><h2>Runtime capabilities</h2><p>Checked on this engine instance.</p></div></div><button onClick={() => onHealthRefresh()}>Refresh</button></div><div className="capability-list"><Capability icon={<Server />} name="FFmpeg / FFprobe" ready={Boolean(health?.ffmpeg && health.ffprobe)} fallback="Required for media renders" /><Capability icon={<Cpu />} name="Local Whisper" ready={Boolean(health?.whisper)} fallback="Install faster-whisper; no LLM timing fallback" /><Capability icon={<Network />} name="YouTube import" ready={Boolean(health?.ytdlp)} fallback="Local file upload remains available" /><Capability icon={<Database />} name="SQLite + mounted storage" ready={Boolean(health?.database)} fallback="Required for durable jobs" /></div></section>
      <section className="settings-card security-card"><div className="settings-card-head"><div><ShieldAlert size={18} /><div><h2>Network boundary</h2><p>No built-in multi-user authentication.</p></div></div></div><div className="security-callout"><LockKeyhole size={20} /><div><strong>Trusted LAN only by default</strong><p>Use an authenticated HTTPS reverse proxy or VPN for remote access. Do not expose the raw HTTP port to the public internet.</p></div></div><dl className="settings-dl"><dt>Browser API</dt><dd>Same-origin /api</dd><dt>Engine</dt><dd>Private Compose network</dd><dt>Secrets</dt><dd>Masked; encrypted at rest when persistent</dd><dt>Data</dt><dd>{health?.dataPath || "Mounted /app/data"}</dd></dl></section>
      <section className={`settings-card library-danger-card ${purgeResult ? "library-purged-card" : ""}`}><div className="settings-card-head"><div><Trash2 size={18} /><div><h2>Library data</h2><p>Permanently remove media without changing profiles, secrets, settings, or folders.</p></div></div></div>{purgeResult ? <div className="settings-empty library-purge-empty" role="status"><Check size={22} /><div><strong>Library is empty</strong><p>{purgeResult.assetsDeleted} media item{purgeResult.assetsDeleted === 1 ? "" : "s"}, {purgeResult.projectsDeleted} linked project{purgeResult.projectsDeleted === 1 ? "" : "s"}, and {purgeResult.blobsDeleted} file{purgeResult.blobsDeleted === 1 ? "" : "s"} removed ({formatBytes(purgeResult.bytesReclaimed)} reclaimed).</p>{purgeResult.warnings.length > 0 && <p className="form-error" role="alert">{purgeResult.warnings.join(" ")}</p>}</div></div> : <div className="library-danger-content"><p><strong>This cannot be undone.</strong> Archived and protected media, project outputs, and source media will be deleted. Active processing must finish first.</p><button ref={purgeTriggerRef} className="button library-danger-trigger" type="button" onClick={openPurgeDialog}><Trash2 size={14} /> Delete all Library content</button></div>}</section>
    </div></div>
  </div>{purgeDialogOpen && <div className="dialog-backdrop" role="presentation"><section className="confirmation-dialog purge-dialog" role="dialog" aria-modal="true" aria-labelledby="purge-dialog-title" aria-describedby="purge-dialog-description" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); closePurgeDialog(); return; } if (event.key === "Tab") { const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), [href], select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex=\"-1\"])")); const first = focusable[0]; const last = focusable.at(-1); if (first && last && event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (last && !event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } } }}><div className="purge-dialog-heading"><Trash2 size={20} aria-hidden="true" /><h2 id="purge-dialog-title">Delete all Library content?</h2></div><p id="purge-dialog-description">This permanently removes every Library asset, including archived and protected items, and cascades linked projects and generated media. Profiles, secrets, settings, database, and folder records are preserved.</p><p className="purge-warning"><strong>There is no undo.</strong> The action is unavailable while any job is queued or processing.</p><label className="field purge-confirmation-field" htmlFor="purge-confirmation">Type <code>DELETE ALL CONTENT</code> to confirm</label><input ref={purgeInputRef} id="purge-confirmation" value={purgeConfirmation} onChange={(event) => setPurgeConfirmation(event.target.value)} autoComplete="off" disabled={purging} aria-describedby={purgeError ? "purge-error" : undefined} />{purgeError && <p id="purge-error" className="form-error" role="alert">{purgeError}</p>}<div className="dialog-actions"><Button disabled={purging} onClick={closePurgeDialog}>Cancel</Button><button className="button button-danger" type="button" disabled={purging || purgeConfirmation !== "DELETE ALL CONTENT"} onClick={() => void purge()}>{purging ? "Deleting Library…" : "Delete permanently"}</button></div></section></div>}</>;
}

function ConnectionResult({ service, status, message, lastCheckedAt }: { service: string; status: ProviderProfile["textStatus"] | "checking"; message?: string | null; lastCheckedAt?: string | null }) {
  const ready = status === "connected"; const checking = status === "checking"; const idle = status === "not_configured" || status === "configured";
  const checked = checking ? "Checking now…" : lastCheckedAt ? `Checked ${formatCheckedAt(lastCheckedAt)}` : "Not checked yet";
  return <div className={`connection-result ${ready ? "ready" : checking ? "checking" : idle ? "idle" : "failed"}`}><span>{ready ? <Check size={11} /> : checking ? "…" : idle ? "·" : <X size={11} />}{service}</span><small title={`${message || status.replaceAll("_", " ")} · ${checked}`}>{message || status.replaceAll("_", " ")} · {checked}</small></div>;
}

function formatCheckedAt(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? "recently" : date.toLocaleString([], { dateStyle: "short", timeStyle: "short" }); }
function formatBytes(value: number) { if (value < 1024) return `${value} B`; const units = ["KB", "MB", "GB"]; let amount = value / 1024; for (const unit of units) { if (amount < 1024 || unit === units.at(-1)) return `${amount.toFixed(amount >= 10 ? 0 : 1)} ${unit}`; amount /= 1024; } return `${value} B`; }

function ProfileProviderBoxes({ profile, testing, onChanged, onTest }: { profile: ProviderProfile; testing: boolean; onChanged: () => Promise<void>; onTest: (id: string) => Promise<void> }) {
  const [openRouterKey, setOpenRouterKey] = useState("");
  const [openRouterModel, setOpenRouterModel] = useState<string | null>(null);
  const [ollamaUrl, setOllamaUrl] = useState<string | null>(null);
  const [ollamaModel, setOllamaModel] = useState<string | null>(null);
  const [saving, setSaving] = useState<"openrouter" | "ollama" | null>(null);
  const [switching, setSwitching] = useState<"openrouter" | "ollama" | null>(null);
  const [errors, setErrors] = useState<Partial<Record<"openrouter" | "ollama" | "openrouterSwitch" | "ollamaSwitch", string>>>({});
  const openRouterOn = isOpenRouterOn(profile);
  const ollamaOn = isOllamaOn(profile);
  const openRouterConfigured = profile.openrouterConfigured || Boolean(profile.openrouterMasked);
  // Drafts are null until typed, so a saved value keeps showing and a save in one box never touches the other.
  const modelDraft = openRouterModel ?? profile.textModelId;
  const urlDraft = ollamaUrl ?? profile.ollamaUrl ?? "";
  const ollamaModelDraft = ollamaModel ?? profile.ollamaModel ?? "";
  const openRouterDirty = openRouterKey !== "" || openRouterModel !== null;
  const ollamaDirty = ollamaUrl !== null || ollamaModel !== null;
  const setError = (key: keyof typeof errors, message: string | undefined) => setErrors((current) => ({ ...current, [key]: message }));
  // Sends the identity fields every save needs, so a partial save never resets them.
  const identity = { name: profile.name, youtubeMetadataModelId: profile.youtubeMetadataModelId, persistence: profile.persistence, selected: profile.selected };
  // Each scan uses what the box holds now: a typed key or endpoint, otherwise the saved one.
  const scanOpenRouter = (signal: AbortSignal) => scanProviderModels({ provider: "openrouter", profileId: profile.id, openrouterKey: openRouterKey.trim() || undefined }, signal);
  const scanOllama = (signal: AbortSignal) => scanProviderModels({ provider: "ollama", profileId: profile.id, ollamaUrl: urlDraft.trim() }, signal);
  const openRouterScanBlocked = !openRouterKey.trim() && !openRouterConfigured ? "Add your OpenRouter API key to scan its models." : null;
  const ollamaScanBlocked = !urlDraft.trim() && !profile.ollamaUrl ? "Add your Ollama endpoint to scan its models." : null;

  const saveOpenRouter = async () => {
    setSaving("openrouter"); setError("openrouter", undefined);
    try {
      await saveProfile({ ...identity, textModelId: modelDraft.trim(), openrouterKey: openRouterKey || undefined }, profile.id);
      setOpenRouterKey(""); setOpenRouterModel(null);
      await onChanged();
      await onTest(profile.id);
    } catch (cause) { setError("openrouter", readableError(cause)); }
    finally { setSaving(null); }
  };
  const saveOllama = async () => {
    setSaving("ollama"); setError("ollama", undefined);
    try {
      await saveProfile({ ...identity, textModelId: profile.textModelId, ollamaUrl: urlDraft.trim(), ollamaModel: ollamaModelDraft.trim() }, profile.id);
      setOllamaUrl(null); setOllamaModel(null);
      await onChanged();
      await onTest(profile.id);
    } catch (cause) { setError("ollama", readableError(cause)); }
    finally { setSaving(null); }
  };
  // The switch saves on its own and makes no provider call. The reload after it shows the saved state on failure too.
  const setSwitch = async (provider: "openrouter" | "ollama", enabled: boolean) => {
    setSwitching(provider); setError(`${provider}Switch`, undefined);
    try {
      await saveProfile({ ...identity, textModelId: profile.textModelId, ...(provider === "openrouter" ? { openrouterEnabled: enabled } : { ollamaEnabled: enabled }) }, profile.id);
    } catch (cause) { setError(`${provider}Switch`, readableError(cause)); }
    finally { setSwitching(null); await onChanged(); }
  };

  return <div className="provider-boxes">
    <ProviderBox provider="OpenRouter" enabled={openRouterOn} busy={switching === "openrouter"} error={errors.openrouterSwitch ?? null} onEnabledChange={(enabled) => void setSwitch("openrouter", enabled)}>
      <OpenRouterFields disabled={!openRouterOn || saving === "openrouter"} savedMasked={profile.openrouterMasked ?? null} apiKey={openRouterKey} onApiKeyChange={setOpenRouterKey} model={modelDraft} onModelChange={setOpenRouterModel} savedModel={profile.textModelId} scan={scanOpenRouter} scanBlocked={openRouterScanBlocked} />
      {!openRouterOn
        ? <p className="provider-off">Off. Not used for new jobs. Saved settings are kept.</p>
        : <div className="provider-results"><ConnectionResult service="OpenRouter" status={testing && openRouterConfigured ? "checking" : openRouterConfigured ? profile.textStatus : "not_configured"} message={openRouterConfigured ? profile.textMessage : "No API key saved."} lastCheckedAt={openRouterConfigured ? profile.textLastCheckedAt : null} /></div>}
      {errors.openrouter && <p className="form-error" role="alert">{errors.openrouter}</p>}
      <div className="provider-box-actions"><Button variant="primary" disabled={!openRouterOn || !openRouterDirty || !modelDraft.trim() || saving !== null || switching !== null} onClick={() => void saveOpenRouter()}>{saving === "openrouter" ? "Saving and testing…" : "Save and test"}</Button></div>
    </ProviderBox>
    <ProviderBox provider="Ollama" enabled={ollamaOn} busy={switching === "ollama"} error={errors.ollamaSwitch ?? null} onEnabledChange={(enabled) => void setSwitch("ollama", enabled)}>
      <OllamaFields disabled={!ollamaOn || saving === "ollama"} url={urlDraft} onUrlChange={setOllamaUrl} model={ollamaModelDraft} onModelChange={setOllamaModel} savedModel={profile.ollamaModel ?? null} scan={scanOllama} scanBlocked={ollamaScanBlocked} />
      {!ollamaOn
        ? <p className="provider-off">Off. Not used for new jobs. Saved settings are kept.</p>
        : profile.ollamaUrl
          ? <div className="provider-results"><ConnectionResult service="Ollama" status={testing ? "checking" : profile.ollamaStatus ?? "not_configured"} message={profile.ollamaMessage} lastCheckedAt={profile.ollamaLastCheckedAt} /></div>
          : <p className="provider-note">No endpoint saved.</p>}
      {errors.ollama && <p className="form-error" role="alert">{errors.ollama}</p>}
      <div className="provider-box-actions"><Button variant="primary" disabled={!ollamaOn || !ollamaDirty || saving !== null || switching !== null} onClick={() => void saveOllama()}>{saving === "ollama" ? "Saving and testing…" : "Save and test"}</Button></div>
    </ProviderBox>
  </div>;
}

function ProfileForm({ initial, onUseFastLocal, onCancel, onSaved }: { initial?: ProviderProfile; onUseFastLocal?: () => void; onCancel: () => void; onSaved: () => void }) {
  const [name, setName] = useState(initial?.name || "My profile");
  const [persistence, setPersistence] = useState<"encrypted" | "session">(initial?.persistence || "encrypted");
  const [textModelId, setTextModelId] = useState("openai/gpt-4.1-mini");
  const [openrouterKey, setOpenrouterKey] = useState("");
  const [openrouterOn, setOpenrouterOn] = useState(true);
  const [ollamaUrl, setOllamaUrl] = useState("");
  const [ollamaModel, setOllamaModel] = useState("");
  const [ollamaOn, setOllamaOn] = useState(true);
  // Nothing is saved yet on a new profile, so a scan here uses only the typed key or endpoint.
  const scanOpenRouter = (signal: AbortSignal) => scanProviderModels({ provider: "openrouter", openrouterKey: openrouterKey.trim() || undefined }, signal);
  const scanOllama = (signal: AbortSignal) => scanProviderModels({ provider: "ollama", ollamaUrl: ollamaUrl.trim() }, signal);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const shared = { name, persistence, selected: initial?.selected ?? true };
      // Editing sends only name and storage; omitted fields keep the saved key, endpoint, switches and model.
      const payload = initial
        ? { ...shared, textModelId: initial.textModelId }
        : { ...shared, textModelId, youtubeMetadataModelId: "google/gemini-2.5-flash-lite", openrouterKey: openrouterKey || undefined, openrouterEnabled: openrouterOn, ollamaUrl: ollamaUrl.trim(), ollamaModel: ollamaModel.trim(), ollamaEnabled: ollamaOn };
      const saved = await saveProfile(payload, initial?.id);
      await testProfile(saved.id); onSaved();
    } catch (cause) { setError(readableError(cause)); } finally { setBusy(false); }
  };
  return <div className="profile-form"><div className="profile-form-title"><div><strong>{initial ? "Edit OpenRouter profile" : "New OpenRouter profile"}</strong><p>{initial ? "Rename this profile or change how its secrets are stored. Keys and endpoints are edited in each provider box." : "One profile can hold an OpenRouter key, an Ollama endpoint, or both."}</p></div><button type="button" onClick={onCancel} aria-label="Close provider form"><X size={16} /></button></div><div className="profile-security-note"><LockKeyhole size={14} /><span>Saved secrets are never loaded back into this form.</span></div><div className="profile-form-grid">
    <Field label="Profile name"><input value={name} onChange={(event) => setName(event.target.value)} placeholder="My OpenRouter profile" /></Field>
    <Field label="Secret storage" hint="Encrypted persists across restarts. Session-only is cleared when the engine stops."><select value={persistence} onChange={(event) => setPersistence(event.target.value as typeof persistence)}><option value="encrypted">Encrypted persistent</option><option value="session">This engine session only</option></select></Field>
  </div>{!initial && <div className="provider-boxes">
    <ProviderBox provider="OpenRouter" enabled={openrouterOn} onEnabledChange={setOpenrouterOn}><OpenRouterFields disabled={!openrouterOn} savedMasked={null} apiKey={openrouterKey} onApiKeyChange={setOpenrouterKey} model={textModelId} onModelChange={setTextModelId} scan={scanOpenRouter} scanBlocked={openrouterKey.trim() ? null : "Add your OpenRouter API key to scan its models."} /></ProviderBox>
    <ProviderBox provider="Ollama" enabled={ollamaOn} onEnabledChange={setOllamaOn}><OllamaFields disabled={!ollamaOn} url={ollamaUrl} onUrlChange={setOllamaUrl} model={ollamaModel} onModelChange={setOllamaModel} scan={scanOllama} scanBlocked={ollamaUrl.trim() ? null : "Add your Ollama endpoint to scan its models."} /></ProviderBox>
  </div>}{error && <p className="form-error" role="alert">{error}</p>}<div className="form-actions">{onUseFastLocal && <Button variant="ghost" onClick={onUseFastLocal}>Use local cutting without API</Button>}<Button onClick={onCancel}>Cancel</Button><Button variant="primary" disabled={busy || !name.trim() || (!initial && openrouterOn && !textModelId.trim())} onClick={submit}>{busy ? "Saving and testing…" : "Save and test connection"}</Button></div></div>;
}

function Capability({ icon, name, ready, fallback }: { icon: React.ReactNode; name: string; ready: boolean; fallback: string }) {
  return <div><span className={ready ? "capability-icon ready" : "capability-icon missing"}>{ready ? <Check size={15} /> : <X size={15} />}</span>{icon}<div><strong>{name}</strong><span>{ready ? "Available on this engine" : fallback}</span></div><StatusBadge state={ready ? "ready" : "fallback"} label={ready ? "Ready" : "Unavailable"} /></div>;
}
