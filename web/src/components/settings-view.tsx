import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Check, Copy, Cpu, Database, Eye, EyeOff, KeyRound, LockKeyhole, Network, Pencil, Plus, Server, ShieldAlert, Trash2, Wifi, X } from "lucide-react";
import { deleteProfile, duplicateProfile, listOpenRouterModels, listProfiles, purgeLibraryContent, readableError, saveProfile, testProfile } from "../api";
import type { Health, LibraryPurgeResult, OpenRouterModel, ProviderProfile } from "../types";
import { Button, Field, PageHeader, StatusBadge } from "./common";

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
  const purgeTriggerRef = useRef<HTMLButtonElement>(null);
  const purgeInputRef = useRef<HTMLInputElement>(null);
  const wasPurgeDialogOpen = useRef(false);
  const load = useCallback(() => listProfiles().then((next) => { setProfiles(next); onProfilesChanged?.(next); }).catch((cause) => setError(readableError(cause))), [onProfilesChanged]);
  useEffect(() => { void load(); }, [load]);
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
    try { await saveProfile({ name: profile.name, textModelId: profile.textModelId, ttsModelId: profile.ttsModelId, ttsVoice: profile.ttsVoice, ttsSpeed: profile.ttsSpeed, persistence: profile.persistence, selected: true }, profile.id); await load(); }
    catch (cause) { setError(readableError(cause)); }
  };
  const openPurgeDialog = () => { setPurgeConfirmation(""); setPurgeError(null); setPurgeDialogOpen(true); };
  const closePurgeDialog = () => { if (!purging) setPurgeDialogOpen(false); };
  const purge = async () => {
    if (purgeConfirmation !== "DELETE ALL CONTENT") return;
    setPurging(true); setPurgeError(null);
    try { setPurgeResult(await purgeLibraryContent(purgeConfirmation)); setPurgeDialogOpen(false); }
    catch (cause) { setPurgeError(readableError(cause)); }
    finally { setPurging(false); }
  };

  return <><div className="page settings-page"><PageHeader eyebrow="Local appliance" title="Settings" description="Configure OpenRouter for text generation and speech narration. Local cutting and silent rendering remain available without an API." actions={<Button variant="primary" onClick={() => { setSetupDismissed(false); setEditing("new"); }}><Plus size={15} /> New profile</Button>} />
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="settings-grid"><div className="settings-column">
      <section className="settings-card profiles-card" id="provider-profiles"><div className="settings-card-head"><div><KeyRound size={18} /><div><h2>OpenRouter</h2><p>One encrypted credential powers optional text planning and speech narration.</p></div></div><div className="profile-head-actions"><StatusBadge state={profiles.some((profile) => profile.selected) ? "local" : "fallback"} label={profiles.length ? `${profiles.length} saved` : "Local modes only"} />{profiles.length > 0 && <Button onClick={() => { setSetupDismissed(false); setEditing("new"); }}><Plus size={13} /> Add profile</Button>}</div></div>
        {showSetupForm && <ProfileForm initial={editing === "new" || editing === null ? undefined : editing} onUseFastLocal={onSkipSetup} onCancel={() => { setEditing(null); if (!profiles.length) setSetupDismissed(true); }} onSaved={() => { setEditing(null); void load(); }} />}
        <div className="profile-list">{profiles.map((profile) => <article key={profile.id} className="profile-row"><div className="profile-mark"><KeyRound size={17} /></div><div className="profile-info"><div><strong>{profile.name}</strong>{profile.selected && <span className="selected-label"><Check size={11} /> Active</span>}</div><p>{profile.textModelId || "Deterministic local planning"}</p><dl className="profile-secrets"><div><dt>OpenRouter key</dt><dd>{profile.openrouterMasked || "Not set"}</dd></div><div><dt>Text model</dt><dd>{profile.textModelId}</dd></div><div><dt>Speech</dt><dd>{profile.ttsModelId ? `${profile.ttsModelId} · ${profile.ttsVoice || "voice not set"}` : "Not configured"}</dd></div><div><dt>Storage</dt><dd><LockKeyhole size={11} aria-hidden="true" /> {profile.persistence === "encrypted" ? "Encrypted" : "Session only"}</dd></div></dl><div className="provider-results"><ConnectionResult service="Text generation" status={testingId === profile.id ? "checking" : profile.textStatus} message={profile.textMessage} lastCheckedAt={profile.textLastCheckedAt} /><ConnectionResult service="TTS narration" status={testingId === profile.id ? "checking" : profile.ttsStatus} message={profile.ttsMessage} lastCheckedAt={profile.ttsLastCheckedAt} /></div></div><StatusBadge state={testingId === profile.id ? "fallback" : profile.status === "connected" ? "ready" : profile.status === "partial" ? "partial" : "fallback"} label={testingId === profile.id ? "checking" : profile.status} /><div className="profile-actions">{!profile.selected && <Button onClick={() => select(profile)}>Use profile</Button>}<Button disabled={testingId === profile.id} onClick={() => test(profile.id)}>{testingId === profile.id ? "Checking…" : "Test"}</Button><button title="Edit" aria-label={`Edit ${profile.name}`} onClick={() => setEditing(profile)}><Pencil size={14} /></button><button title="Duplicate" aria-label={`Duplicate ${profile.name}`} onClick={() => duplicate(profile.id)}><Copy size={14} /></button><button title="Delete" aria-label={`Delete ${profile.name}`} onClick={() => remove(profile.id)}><Trash2 size={14} /></button></div></article>)}</div>
        {!profiles.length && !showSetupForm && <div className="settings-empty"><KeyRound size={22} /><div><strong>No OpenRouter profile</strong><p>Local deterministic planning, captions, and text-card visuals remain available.</p></div>{onSkipSetup && <Button variant="ghost" onClick={onSkipSetup}>Continue with local cutting <ArrowRight size={13} /></Button>}</div>}
      </section>
      <section className="settings-card about-card"><img src="/legal-logo.png" alt="S6_cut logo" /><div><span className="eyebrow">About & legal</span><h2>S6_cut</h2><p>Free, open-source, local-first video editing. No account, watermark, or artificial usage limit.</p><p className="muted">Process only media you own or are authorised to use. Code licences do not grant rights to downloaded media, fonts, models, voices, or logos.</p><span className="version">Engine {health?.version || "—"} · Schema v1</span></div></section>
    </div><div className="settings-column">
      <section className="settings-card"><div className="settings-card-head"><div><Cpu size={18} /><div><h2>Runtime capabilities</h2><p>Checked on this engine instance.</p></div></div><button onClick={() => onHealthRefresh()}>Refresh</button></div><div className="capability-list"><Capability icon={<Server />} name="FFmpeg / FFprobe" ready={Boolean(health?.ffmpeg && health.ffprobe)} fallback="Required for media renders" /><Capability icon={<Cpu />} name="Local Whisper" ready={Boolean(health?.whisper)} fallback="Install faster-whisper; no LLM timing fallback" /><Capability icon={<Network />} name="YouTube import" ready={Boolean(health?.ytdlp)} fallback="Local file upload remains available" /><Capability icon={<Wifi />} name="Local narration" ready={Boolean(health?.localTts)} fallback="Silent render remains available" /><Capability icon={<Database />} name="SQLite + mounted storage" ready={Boolean(health?.database)} fallback="Required for durable jobs" /></div></section>
      <section className="settings-card security-card"><div className="settings-card-head"><div><ShieldAlert size={18} /><div><h2>Network boundary</h2><p>No built-in multi-user authentication.</p></div></div></div><div className="security-callout"><LockKeyhole size={20} /><div><strong>Trusted LAN only by default</strong><p>Use an authenticated HTTPS reverse proxy or VPN for remote access. Do not expose the raw HTTP port to the public internet.</p></div></div><dl className="settings-dl"><dt>Browser API</dt><dd>Same-origin /api</dd><dt>Engine</dt><dd>Private Compose network</dd><dt>Secrets</dt><dd>Masked; encrypted at rest when persistent</dd><dt>Data</dt><dd>{health?.dataPath || "Mounted /app/data"}</dd></dl></section>
      <section className={`settings-card library-danger-card ${purgeResult ? "library-purged-card" : ""}`}><div className="settings-card-head"><div><Trash2 size={18} /><div><h2>Library data</h2><p>Permanently remove media without changing profiles, secrets, settings, or folders.</p></div></div></div>{purgeResult ? <div className="settings-empty library-purge-empty" role="status"><Check size={22} /><div><strong>Library is empty</strong><p>{purgeResult.assetsDeleted} media item{purgeResult.assetsDeleted === 1 ? "" : "s"}, {purgeResult.projectsDeleted} linked project{purgeResult.projectsDeleted === 1 ? "" : "s"}, and {purgeResult.blobsDeleted} file{purgeResult.blobsDeleted === 1 ? "" : "s"} removed ({formatBytes(purgeResult.bytesReclaimed)} reclaimed).</p>{purgeResult.warnings.length > 0 && <p className="form-error" role="alert">{purgeResult.warnings.join(" ")}</p>}</div></div> : <div className="library-danger-content"><p><strong>This cannot be undone.</strong> Archived and protected media, project outputs, and source media will be deleted. Active processing must finish first.</p><button ref={purgeTriggerRef} className="button button-danger" type="button" onClick={openPurgeDialog}><Trash2 size={14} /> Delete all Library content</button></div>}</section>
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

function ProfileForm({ initial, onUseFastLocal, onCancel, onSaved }: { initial?: ProviderProfile; onUseFastLocal?: () => void; onCancel: () => void; onSaved: () => void }) {
  const [name, setName] = useState(initial?.name || "My profile");
  const [textModelId, setTextModelId] = useState(initial?.textModelId || "openai/gpt-4.1-mini");
  const [ttsModelId, setTtsModelId] = useState(initial?.ttsModelId || "");
  const [ttsVoice, setTtsVoice] = useState(initial?.ttsVoice || "");
  const [ttsSpeed, setTtsSpeed] = useState(String(initial?.ttsSpeed || 1));
  const [openrouterKey, setOpenrouterKey] = useState("");
  const [persistence, setPersistence] = useState<"encrypted" | "session">(initial?.persistence || "encrypted");
  const [showKey, setShowKey] = useState(false);
  const [speechModels, setSpeechModels] = useState<OpenRouterModel[]>([]);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedSpeechModel = speechModels.find((model) => model.id === ttsModelId);
  useEffect(() => {
    if (initial?.textStatus !== "connected") return;
    void listOpenRouterModels("speech").then((models) => {
      setSpeechModels(models);
      if (!ttsModelId) {
        const free = models.filter((model) => model.free).sort((left, right) => left.id.localeCompare(right.id))[0];
        if (free) { setTtsModelId(free.id); if (!ttsVoice && free.voices?.length) setTtsVoice(free.voices[0]); }
      }
    }).catch((cause) => setSpeechError(readableError(cause)));
  }, [initial?.textStatus, ttsModelId, ttsVoice]);
  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const saved = await saveProfile({ name, textModelId, ttsModelId: ttsModelId || undefined, ttsVoice: ttsVoice || undefined, ttsSpeed: Number(ttsSpeed) || 1, openrouterKey: openrouterKey || undefined, persistence, selected: initial?.selected ?? true }, initial?.id);
      await testProfile(saved.id); onSaved();
    } catch (cause) { setError(readableError(cause)); } finally { setBusy(false); }
  };
  return <div className="profile-form"><div className="profile-form-title"><div><strong>{initial ? "Edit OpenRouter profile" : "New OpenRouter profile"}</strong><p>One backend-held credential supports text generation and speech narration.</p></div><button type="button" onClick={onCancel} aria-label="Close provider form"><X size={16} /></button></div><div className="profile-security-note"><LockKeyhole size={14} /><span>Saved secrets are never loaded back into this form.</span></div><div className="profile-form-grid">
    <Field label="Profile name"><input value={name} onChange={(event) => setName(event.target.value)} placeholder="My OpenRouter profile" /></Field>
    <Field label="Secret storage" hint="Encrypted persists across restarts. Session-only is cleared when the engine stops."><select value={persistence} onChange={(event) => setPersistence(event.target.value as typeof persistence)}><option value="encrypted">Encrypted persistent</option><option value="session">This engine session only</option></select></Field>
    <div className="provider-fieldset"><div><strong>OpenRouter</strong><span>Optional external provider for planning and narration. Local modes remain available without it.</span></div><Field label="OpenRouter API key" hint={initial?.openrouterMasked ? `Saved value: ${initial.openrouterMasked}. Leave blank to keep it.` : "The raw key is never returned after saving."}><div className="secret-input"><input type={showKey ? "text" : "password"} autoComplete="new-password" value={openrouterKey} onChange={(event) => setOpenrouterKey(event.target.value)} placeholder="sk-or-v1-…" /><button type="button" onClick={() => setShowKey(!showKey)} aria-label={`${showKey ? "Hide" : "Show"} OpenRouter API key`}>{showKey ? <EyeOff size={15} /> : <Eye size={15} />}</button></div></Field><Field label="Text-generation model"><input value={textModelId} onChange={(event) => setTextModelId(event.target.value)} placeholder="openai/gpt-4.1-mini" /></Field><Field label="TTS model" hint="Choose a speech model discovered from OpenRouter. Paid models are never selected automatically."><input list="speech-models" value={ttsModelId} onChange={(event) => setTtsModelId(event.target.value)} placeholder="Select or enter a speech model" /><datalist id="speech-models">{speechModels.map((model) => <option key={model.id} value={model.id}>{model.name}{model.free ? " (free)" : ""}</option>)}</datalist>{speechError && <small className="form-error">Speech model discovery unavailable: {speechError}</small>}<button type="button" onClick={() => { setSpeechError(null); void listOpenRouterModels("speech").then(setSpeechModels).catch((cause) => setSpeechError(readableError(cause))); }}>Refresh speech models</button></Field><Field label="TTS voice" hint="Use a voice supported by the selected speech model."><input list="tts-voices" value={ttsVoice} onChange={(event) => setTtsVoice(event.target.value)} placeholder="e.g. alloy" /><datalist id="tts-voices">{(selectedSpeechModel?.voices || []).map((voice) => <option key={voice} value={voice} />)}</datalist></Field><Field label="TTS speed"><input type="number" min="0.25" max="4" step="0.05" value={ttsSpeed} onChange={(event) => setTtsSpeed(event.target.value)} /></Field></div>
  </div>{error && <p className="form-error" role="alert">{error}</p>}<div className="form-actions">{onUseFastLocal && <Button variant="ghost" onClick={onUseFastLocal}>Use local cutting without API</Button>}<Button onClick={onCancel}>Cancel</Button><Button variant="primary" disabled={busy || !name.trim()} onClick={submit}>{busy ? "Saving and testing…" : "Save and test connection"}</Button></div></div>;
}

function Capability({ icon, name, ready, fallback }: { icon: React.ReactNode; name: string; ready: boolean; fallback: string }) {
  return <div><span className={ready ? "capability-icon ready" : "capability-icon missing"}>{ready ? <Check size={15} /> : <X size={15} />}</span>{icon}<div><strong>{name}</strong><span>{ready ? "Available on this engine" : fallback}</span></div><StatusBadge state={ready ? "ready" : "fallback"} label={ready ? "Ready" : "Unavailable"} /></div>;
}
