import { useCallback, useEffect, useState } from "react";
import { ArrowRight, Check, Copy, Cpu, Database, Eye, EyeOff, KeyRound, LockKeyhole, Network, Pencil, Plus, Server, ShieldAlert, Trash2, Wifi, X } from "lucide-react";
import { deleteProfile, duplicateProfile, listProfiles, readableError, saveProfile, testProfile } from "../api";
import type { Health, ProviderProfile } from "../types";
import { Button, Field, PageHeader, StatusBadge } from "./common";

export function SettingsView({ health, onHealthRefresh, onProfilesChanged, onSkipSetup = () => undefined }: { health: Health | null; onHealthRefresh: () => Promise<void>; onProfilesChanged?: (profiles: ProviderProfile[]) => void; onSkipSetup?: () => void }) {
  const [profiles, setProfiles] = useState<ProviderProfile[]>([]);
  const [editing, setEditing] = useState<ProviderProfile | "new" | null>(null);
  const [setupDismissed, setSetupDismissed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => listProfiles().then((next) => { setProfiles(next); onProfilesChanged?.(next); }).catch((cause) => setError(readableError(cause))), [onProfilesChanged]);
  useEffect(() => { void load(); }, [load]);
  // Empty card shows the inline setup form by default so OpenRouter is visible.
  const showSetupForm = Boolean(editing) || (!profiles.length && !setupDismissed);

  const remove = async (id: string) => {
    if (!window.confirm("Delete this provider profile? Saved encrypted secrets for this profile will also be removed.")) return;
    try { await deleteProfile(id); await load(); } catch (cause) { setError(readableError(cause)); }
  };
  const duplicate = async (id: string) => { try { await duplicateProfile(id); await load(); } catch (cause) { setError(readableError(cause)); } };
  const test = async (id: string) => { try { await testProfile(id); await load(); } catch (cause) { setError(readableError(cause)); } };
  const select = async (profile: ProviderProfile) => {
    try {
      await saveProfile({ name: profile.name, modelId: profile.modelId, voiceId: profile.voiceId, persistence: profile.persistence, selected: true }, profile.id);
      await load();
    } catch (cause) { setError(readableError(cause)); }
  };

  return <div className="page settings-page"><PageHeader eyebrow="Local appliance" title="Settings" description="Optional providers can improve planning and voice. Every row names the no-key fallback." actions={<Button variant="primary" onClick={() => { setSetupDismissed(false); setEditing("new"); }}><Plus size={15} /> New profile</Button>} />
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="settings-grid">
      <section className="settings-card profiles-card" id="provider-profiles"><div className="settings-card-head"><div><KeyRound size={18} /><div><h2>Provider profiles</h2><p>OpenRouter enhances planning. ElevenLabs is an optional narration upgrade, never a requirement.</p></div></div><div className="profile-head-actions"><StatusBadge state={profiles.some((profile) => profile.selected) ? "local" : "fallback"} label={profiles.length ? `${profiles.length} saved` : "Local fallbacks only"} />{profiles.length > 0 && <Button onClick={() => { setSetupDismissed(false); setEditing("new"); }}><Plus size={13} /> Add or update provider</Button>}</div></div>
        {showSetupForm && <ProfileForm initial={editing === "new" || editing === null ? undefined : editing} onUseFastLocal={onSkipSetup} onCancel={() => { setEditing(null); if (!profiles.length) setSetupDismissed(true); }} onSaved={() => { setEditing(null); void load(); }} />}
        <div className="profile-list">{profiles.map((profile) => <article key={profile.id} className="profile-row"><div className="profile-mark"><KeyRound size={17} /></div><div className="profile-info"><div><strong>{profile.name}</strong>{profile.selected && <span className="selected-label"><Check size={11} /> Active</span>}</div><p>{profile.modelId || "Deterministic local planning"}</p><div><span>OpenRouter {profile.openrouterMasked || "not set"}</span><span>ElevenLabs {profile.elevenlabsMasked || "not set"}</span><span><LockKeyhole size={11} /> {profile.persistence}</span></div><div className="provider-results"><ConnectionResult service="OpenRouter" status={profile.openrouterStatus} message={profile.openrouterMessage} /><ConnectionResult service="ElevenLabs" status={profile.elevenlabsStatus} message={profile.elevenlabsMessage} /></div></div><StatusBadge state={profile.status === "connected" ? "ready" : profile.status === "attention" ? "partial" : "fallback"} label={profile.status} /><div className="profile-actions">{!profile.selected && <Button onClick={() => select(profile)}>Use profile</Button>}<Button onClick={() => test(profile.id)}>Test</Button><button title="Edit" aria-label={`Edit ${profile.name}`} onClick={() => setEditing(profile)}><Pencil size={14} /></button><button title="Duplicate" aria-label={`Duplicate ${profile.name}`} onClick={() => duplicate(profile.id)}><Copy size={14} /></button><button title="Delete" aria-label={`Delete ${profile.name}`} onClick={() => remove(profile.id)}><Trash2 size={14} /></button></div></article>)}</div>
        {!profiles.length && !showSetupForm && <div className="settings-empty"><KeyRound size={22} /><div><strong>No provider profile</strong><p>Clip transcription, selection, caption timing, and text-card visuals still use local deterministic engines.</p></div>{onSkipSetup && <Button variant="ghost" onClick={onSkipSetup}>Continue with Fast local cut <ArrowRight size={13} /></Button>}</div>}
      </section>

      <section className="settings-card"><div className="settings-card-head"><div><Cpu size={18} /><div><h2>Runtime capabilities</h2><p>Checked on this engine instance.</p></div></div><button onClick={() => onHealthRefresh()}>Refresh</button></div><div className="capability-list"><Capability icon={<Server />} name="FFmpeg / FFprobe" ready={Boolean(health?.ffmpeg && health.ffprobe)} fallback="Required for media renders" /><Capability icon={<Cpu />} name="Local Whisper" ready={Boolean(health?.whisper)} fallback="Install faster-whisper; no LLM timing fallback" /><Capability icon={<Network />} name="YouTube import" ready={Boolean(health?.ytdlp)} fallback="Local file upload remains available" /><Capability icon={<Wifi />} name="Local narration" ready={Boolean(health?.localTts)} fallback="Silent render remains available" /><Capability icon={<Database />} name="SQLite + mounted storage" ready={Boolean(health?.database)} fallback="Required for durable jobs" /></div></section>

      <section className="settings-card security-card"><div className="settings-card-head"><div><ShieldAlert size={18} /><div><h2>Network boundary</h2><p>No built-in multi-user authentication.</p></div></div></div><div className="security-callout"><LockKeyhole size={20} /><div><strong>Trusted LAN only by default</strong><p>Use an authenticated HTTPS reverse proxy or VPN for remote access. Do not expose the raw HTTP port to the public internet.</p></div></div><dl className="settings-dl"><dt>Browser API</dt><dd>Same-origin /api</dd><dt>Engine</dt><dd>Private Compose network</dd><dt>Secrets</dt><dd>Masked; encrypted at rest when persistent</dd><dt>Data</dt><dd>{health?.dataPath || "Mounted /app/data"}</dd></dl></section>

      <section className="settings-card about-card"><img src="/legal-logo.png" alt="S6_cut logo" /><div><span className="eyebrow">About & legal</span><h2>S6_cut</h2><p>Free, open-source, local-first video editing. No account, credits, watermark, or artificial usage limit.</p><p className="muted">Process only media you own or are authorised to use. Code licences do not grant rights to downloaded media, fonts, models, voices, or logos.</p><span className="version">Engine {health?.version || "—"} · Schema v1</span></div></section>
    </div>
  </div>;
}

function ConnectionResult({ service, status, message }: { service: string; status: ProviderProfile["openrouterStatus"]; message?: string | null }) {
  const ready = status === "connected";
  const idle = status === "not_configured" || status === "configured";
  return <div className={`connection-result ${ready ? "ready" : idle ? "idle" : "failed"}`}><span>{ready ? <Check size={11} /> : idle ? "·" : <X size={11} />}{service}</span><small>{message || status.replaceAll("_", " ")}</small></div>;
}

function ProfileForm({ initial, onUseFastLocal, onCancel, onSaved }: { initial?: ProviderProfile; onUseFastLocal?: () => void; onCancel: () => void; onSaved: () => void }) {
  const [name, setName] = useState(initial?.name || "My profile");
  const [modelId, setModelId] = useState(initial?.modelId || "openai/gpt-4.1-mini");
  const [openrouterKey, setOpenrouterKey] = useState("");
  const [elevenlabsKey, setElevenlabsKey] = useState("");
  const [voiceId, setVoiceId] = useState(initial?.voiceId || "");
  const [persistence, setPersistence] = useState<"encrypted" | "session">(initial?.persistence || "encrypted");
  const [showOpenRouter, setShowOpenRouter] = useState(false);
  const [showElevenLabs, setShowElevenLabs] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const saved = await saveProfile({ name, modelId, openrouterKey: openrouterKey || undefined, elevenlabsKey: elevenlabsKey || undefined, voiceId: voiceId || undefined, persistence, selected: initial?.selected ?? true }, initial?.id);
      await testProfile(saved.id);
      onSaved();
    } catch (cause) { setError(readableError(cause)); } finally { setBusy(false); }
  };
  return <div className="profile-form"><div className="profile-form-title"><div><strong>{initial ? "Edit provider profile" : "New provider profile"}</strong><span>Saved secrets are never loaded back into this form.</span></div><button onClick={onCancel} aria-label="Close provider form"><X size={16} /></button></div><div className="profile-form-grid">
    <Field label="Profile name"><input value={name} onChange={(event) => setName(event.target.value)} placeholder="My provider profile" /></Field>
    <Field label="Secret storage" hint="Encrypted persists across restarts. Session-only is cleared when the engine stops."><select value={persistence} onChange={(event) => setPersistence(event.target.value as typeof persistence)}><option value="encrypted">Encrypted persistent</option><option value="session">This engine session only</option></select></Field>
    <div className="provider-fieldset"><div><strong>OpenRouter</strong><span>Optional general-purpose planning provider. Without it, deterministic local planning is used.</span></div><Field label="OpenRouter API key" hint={initial?.openrouterMasked ? `Saved value: ${initial.openrouterMasked}. Leave blank to keep it.` : "Optional. The raw key is never returned after saving."}><div className="secret-input"><input type={showOpenRouter ? "text" : "password"} autoComplete="new-password" value={openrouterKey} onChange={(event) => setOpenrouterKey(event.target.value)} placeholder="sk-or-v1-…" /><button type="button" onClick={() => setShowOpenRouter(!showOpenRouter)} aria-label={`${showOpenRouter ? "Hide" : "Show"} OpenRouter API key`}>{showOpenRouter ? <EyeOff size={15} /> : <Eye size={15} />}</button></div></Field><Field label="OpenRouter model ID" hint="Editable model used for optional enhanced planning."><input value={modelId} onChange={(event) => setModelId(event.target.value)} placeholder="openai/gpt-4.1-mini" /></Field></div>
    <div className="provider-fieldset"><div><strong>ElevenLabs</strong><span>Optional premium narration upgrade. Local TTS, then an explicit silent render, remains available.</span></div><Field label="ElevenLabs API key" hint={initial?.elevenlabsMasked ? `Saved value: ${initial.elevenlabsMasked}. Leave blank to keep it.` : "Optional. You can use OpenRouter without ElevenLabs."}><div className="secret-input"><input type={showElevenLabs ? "text" : "password"} autoComplete="new-password" value={elevenlabsKey} onChange={(event) => setElevenlabsKey(event.target.value)} placeholder="Enter ElevenLabs API key" /><button type="button" onClick={() => setShowElevenLabs(!showElevenLabs)} aria-label={`${showElevenLabs ? "Hide" : "Show"} ElevenLabs API key`}>{showElevenLabs ? <EyeOff size={15} /> : <Eye size={15} />}</button></div></Field><Field label="ElevenLabs voice ID" hint="Required only when using ElevenLabs narration."><input value={voiceId} onChange={(event) => setVoiceId(event.target.value)} placeholder="e.g. 21m00Tcm4TlvDq8ikWAM" /></Field></div>
  </div>{error && <p className="form-error" role="alert">{error}</p>}<div className="form-actions">{onUseFastLocal && <Button variant="ghost" onClick={onUseFastLocal}>Use fast local cutting without APIs</Button>}<Button onClick={onCancel}>Cancel</Button><Button variant="primary" disabled={busy || !name.trim()} onClick={submit}>{busy ? "Saving and testing…" : "Save and test connection"}</Button></div></div>;
}

function Capability({ icon, name, ready, fallback }: { icon: React.ReactNode; name: string; ready: boolean; fallback: string }) {
  return <div><span className={ready ? "capability-icon ready" : "capability-icon missing"}>{ready ? <Check size={15} /> : <X size={15} />}</span>{icon}<div><strong>{name}</strong><span>{ready ? "Available on this engine" : fallback}</span></div><StatusBadge state={ready ? "ready" : "fallback"} label={ready ? "Ready" : "Unavailable"} /></div>;
}
