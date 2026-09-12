import { useEffect, useState, type FormEvent } from "react";
import { createScriptJob, createTopicPlan, listOpenRouterModels, readableError } from "../api";
import type { OpenRouterModel, ProviderProfile, TopicVideoPlan } from "../types";
import { Button, FieldGroup, useSingleFlight } from "./common";

export function TopicToVideoView({ profiles, profilesLoaded = true, onConfigureProviders, onJobCreated }: { profiles: ProviderProfile[]; profilesLoaded?: boolean; onConfigureProviders: () => void; onJobCreated: () => void }) {
  const [topic, setTopic] = useState("");
  const [script, setScript] = useState("");
  const [audience, setAudience] = useState("");
  const [tone, setTone] = useState("educational");
  const [language, setLanguage] = useState("English");
  const [cta, setCta] = useState("");
  const [instructions, setInstructions] = useState("");
  const [duration, setDuration] = useState("45");
  const [aspect, setAspect] = useState<"9:16" | "16:9" | "1:1" | "4:5">("9:16");
  const [variants, setVariants] = useState("1");
  const [plan, setPlan] = useState<TopicVideoPlan | null>(null);
  const [planProvider, setPlanProvider] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [models, setModels] = useState<OpenRouterModel[]>([]);
  const [selectedModelId, setSelectedModelId] = useState("");
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsLoadedProfile, setModelsLoadedProfile] = useState<string | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelsRefresh, setModelsRefresh] = useState(0);
  const selected = profiles.find((profile) => profile.selected);
  const connected = selected?.textStatus === "connected" && selected.openrouterConfigured;
  const profileKey = connected ? selected?.id || null : null;
  const loadingModels = Boolean(connected && (modelsLoading || modelsLoadedProfile !== profileKey));
  const refreshModels = () => { setModelsLoading(true); setModelsError(null); setModelsRefresh((value) => value + 1); };
  const providerKey = connected ? `${selected.id}:${selectedModelId}` : "none";

  useEffect(() => {
    let active = true;
    if (!connected) return () => { active = false; };
    void listOpenRouterModels("text").then((next) => {
      if (!active) return;
      setModelsError(null);
      setModelsLoadedProfile(profileKey);
      setModels(next);
      setSelectedModelId((current) => {
        if (current) return next.some((model) => model.id === current) ? current : "";
        return next.some((model) => model.id === selected?.textModelId) ? selected?.textModelId || "" : "";
      });
    }).catch((cause) => {
      if (!active) return;
      setModels([]);
      setSelectedModelId("");
      setModelsLoadedProfile(profileKey);
      setModelsError(readableError(cause));
    }).finally(() => {
      if (active) setModelsLoading(false);
    });
    return () => { active = false; };
  }, [connected, selected?.id, selected?.textModelId, modelsRefresh, profileKey]);

  const singleFlight = useSingleFlight();

  const makePlan = (event: FormEvent) => {
    event.preventDefault();
    return singleFlight(async () => {
    setError(null);
    if (!topic.trim()) return setError("Topic or keyword is required.");
    if (!script.trim() && !connected) return setError("OpenRouter is not configured. Add and test a provider in Settings, or enter a custom script.");
    if (!script.trim() && (!selectedModelId || !models.length || modelsLoading)) return setError("Choose an available OpenRouter model before planning.");
    setBusy(true);
    setStatus(script.trim() ? "Building a local plan…" : `Planning with OpenRouter model ${selectedModelId}…`);
    try {
      const next = await createTopicPlan({ topic, audience, tone, language, callToAction: cta, instructions, durationSeconds: Number(duration), aspectRatio: aspect, variants: Number(variants), customScript: script, modelId: script.trim() ? undefined : selectedModelId });
      setPlan(next);
      setPlanProvider(script.trim() ? "local" : providerKey);
      setScript(next.narration);
      setStatus("Plan ready for review.");
    } catch (cause) {
      setError(readableError(cause));
      setStatus("");
    } finally {
      setBusy(false);
    }
    });
  };

  const generate = () => singleFlight(async () => {
    if (!plan || (planProvider !== "local" && planProvider !== providerKey) || script.trim().length < 10) return setError("Review a current plan with at least 10 characters first.");
    setBusy(true);
    setError(null);
    try {
      for (let index = 0; index < Number(variants); index += 1) {
        setStatus(`Queueing variant ${index + 1} of ${variants}…`);
        await createScriptJob({ script, name: `${plan.title} — Variant ${index + 1}`, style: "educational", aspectRatio: aspect, narration: "auto" });
      }
      setStatus(`${variants} variant job${Number(variants) > 1 ? "s" : ""} queued.`);
      onJobCreated();
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusy(false);
    }
  });

  return <div className="page"><div className="page-header"><div><div className="eyebrow">AI-assisted, local-first</div><h1>Topic to Video</h1><p>Turn a topic — or your own script — into a reviewable plan, then queue the videos for rendering. A supplied script is planned locally, with no provider needed.</p></div></div>
    <form className="panel topic-video-form" onSubmit={makePlan}>
      {/* Until /profiles answers, provider availability is unknown — saying it
          is not configured would be a claim we cannot yet support. */}
      <div className={`provider-status ${!profilesLoaded ? "checking" : connected ? "connected" : "unavailable"}`} role="status"><div><strong>{!profilesLoaded ? "Checking connected providers…" : connected ? `OpenRouter connected — ${selected.name} · ${selected.textModelId}` : "OpenRouter is not configured."}</strong><span>{!profilesLoaded ? "Reading saved provider profiles from the local engine." : connected ? "The selected Settings profile will be used for this request." : "Add and test a provider in Settings, or enter a custom script."}</span></div>{profilesLoaded && !connected && <Button type="button" onClick={onConfigureProviders}>Configure OpenRouter</Button>}</div>
      {connected && <div className="model-picker-row"><div className="field"><label className="field-label" htmlFor="openrouter-model">OpenRouter model</label><select id="openrouter-model" aria-label="OpenRouter model" value={selectedModelId} disabled={loadingModels || !!modelsError || !models.length} onChange={(event) => setSelectedModelId(event.target.value)}><option value="">Choose a model</option>{models.map((model) => <option key={model.id} value={model.id}>{model.name} — {model.id}</option>)}</select></div><Button type="button" onClick={refreshModels} disabled={loadingModels}>Refresh models</Button></div>}
      {connected && loadingModels && <p className="mode-note" role="status">Loading available OpenRouter models…</p>}
      {connected && modelsError && <div className="form-error" role="alert">Unable to load OpenRouter models: {modelsError} <Button type="button" onClick={refreshModels}>Retry</Button></div>}
      {connected && !loadingModels && !modelsError && !models.length && <p className="form-error" role="status">No OpenRouter models are currently available. Refresh models or use a custom script.</p>}
      {connected && !script.trim() && selectedModelId && <p className="provider-charge-note">This request will use OpenRouter model <strong>{selectedModelId}</strong> and may incur provider charges.</p>}
      <div className="topic-video-grid">
        <FieldGroup title="Brief" headingLevel={2}>
          <div className="field"><label className="field-label" htmlFor="topic">Topic or keyword</label><input id="topic" value={topic} onChange={(event) => setTopic(event.target.value)} placeholder="e.g. How solar panels work" /></div>
          <div className="topic-three-grid"><div className="field"><label className="field-label" htmlFor="audience">Audience</label><input id="audience" value={audience} onChange={(event) => setAudience(event.target.value)} /></div><div className="field"><label className="field-label" htmlFor="tone">Tone</label><input id="tone" value={tone} onChange={(event) => setTone(event.target.value)} /></div><div className="field"><label className="field-label" htmlFor="language">Language</label><input id="language" value={language} onChange={(event) => setLanguage(event.target.value)} /></div></div>
          <div className="field"><label className="field-label" htmlFor="cta">Call to action</label><input id="cta" value={cta} onChange={(event) => setCta(event.target.value)} /></div>
          <div className="field"><label className="field-label" htmlFor="instructions">Additional instructions</label><textarea id="instructions" rows={3} value={instructions} onChange={(event) => setInstructions(event.target.value)} /></div>
        </FieldGroup>
        <div className="topic-video-column">
          <FieldGroup title="Output" columns={2} headingLevel={2}>
            <div className="field"><label className="field-label" htmlFor="duration">Target seconds</label><input id="duration" type="number" min="10" max="180" value={duration} onChange={(event) => setDuration(event.target.value)} /></div>
            <div className="field"><label className="field-label" htmlFor="ai-aspect">Aspect ratio</label><select id="ai-aspect" value={aspect} onChange={(event) => setAspect(event.target.value as typeof aspect)}><option>9:16</option><option>16:9</option><option>1:1</option><option>4:5</option></select></div>
            <div className="field"><label className="field-label" htmlFor="variants">Variants (1–3)</label><input id="variants" type="number" min="1" max="3" value={variants} onChange={(event) => setVariants(String(Math.max(1, Math.min(3, Number(event.target.value)))))} /></div>
          </FieldGroup>
          <FieldGroup title="Your own script" hint="Optional. Supplying a script skips OpenRouter and plans locally." headingLevel={2}>
            <div className="field"><label className="sr-only" htmlFor="custom-script">Custom script</label><textarea id="custom-script" rows={7} value={script} onChange={(event) => setScript(event.target.value)} placeholder="Enter your own script, or leave blank to generate one." /></div>
          </FieldGroup>
        </div>
      </div>
      {plan && <section className="panel plan-review" aria-label="Reviewable script plan">{planProvider !== "local" && planProvider !== providerKey && <p className="form-error">Provider or model changed. Create a new plan for the selected model before generating.</p>}<strong>{plan.title}</strong><p>{plan.hook}</p><p>{plan.narration}</p><small>{plan.beats.length} visual beats · estimated {plan.estimatedDuration.toFixed(0)} seconds · {plan.hashtags.join(" ")}</small></section>}
      {error && <div className="form-error" role="alert">{error}</div>}
      {status && <div className="mode-note" role="status">{status}</div>}
      <div className="form-actions"><button className="button" disabled={busy || (!script.trim() && (!connected || loadingModels || !models.length || !selectedModelId))} type="submit">{busy ? "Planning…" : "Create / refresh plan"}</button><button className="button button-primary" disabled={busy || !plan || (planProvider !== "local" && planProvider !== providerKey)} type="button" onClick={generate}>Generate reviewed video{Number(variants) > 1 ? "s" : ""}</button></div>
    </form>
  </div>;
}
