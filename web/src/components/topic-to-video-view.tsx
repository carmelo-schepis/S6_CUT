import { useState, type FormEvent } from "react";
import { createScriptJob, createTopicPlan, readableError } from "../api";
import type { ProviderProfile, TopicVideoPlan } from "../types";
import { Button } from "./common";

export function TopicToVideoView({ profiles, onConfigureProviders, onJobCreated }: { profiles: ProviderProfile[]; onConfigureProviders: () => void; onJobCreated: () => void }) {
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
  const selected = profiles.find((profile) => profile.selected);
  const connected = selected?.openrouterStatus === "connected" && selected.openrouterConfigured;
  const providerKey = selected ? `${selected.id}:${selected.modelId}:${selected.openrouterStatus}` : "none";

  const makePlan = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!topic.trim()) return setError("Topic or keyword is required.");
    if (!script.trim() && !connected) return setError("OpenRouter is not configured. Add and test a provider in Settings, or enter a custom script.");
    setBusy(true);
    setStatus(script.trim() ? "Building a local plan…" : "Planning with the selected OpenRouter profile…");
    try {
      const next = await createTopicPlan({ topic, audience, tone, language, callToAction: cta, instructions, durationSeconds: Number(duration), aspectRatio: aspect, variants: Number(variants), customScript: script });
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
  };

  const generate = async () => {
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
  };

  return <div className="page"><div className="page-header"><div><div className="eyebrow">AI-assisted, local-first</div><h1>Topic to Video</h1><p>Generate a reviewable script and storyboard plan, then render it through normal S6_cut jobs.</p></div></div>
    <form className="panel topic-video-form" onSubmit={makePlan}>
      <div className={`provider-status ${connected ? "connected" : "unavailable"}`} role="status"><div><strong>{connected ? `OpenRouter connected — ${selected.name} · ${selected.modelId}` : "OpenRouter is not configured."}</strong><span>{connected ? "The selected Settings profile will be used for this request." : "Add and test a provider in Settings, or enter a custom script."}</span></div>{!connected && <Button type="button" onClick={onConfigureProviders}>Configure OpenRouter</Button>}</div>
      {connected && !script.trim() && <p className="provider-charge-note">This request will use the selected OpenRouter model and may incur provider charges.</p>}
      <div className="field"><label className="field-label" htmlFor="topic">Topic or keyword</label><input id="topic" required value={topic} onChange={(event) => setTopic(event.target.value)} placeholder="e.g. How solar panels work" /></div>
      <div className="topic-three-grid"><div className="field"><label className="field-label" htmlFor="audience">Audience</label><input id="audience" value={audience} onChange={(event) => setAudience(event.target.value)} /></div><div className="field"><label className="field-label" htmlFor="tone">Tone</label><input id="tone" value={tone} onChange={(event) => setTone(event.target.value)} /></div><div className="field"><label className="field-label" htmlFor="language">Language</label><input id="language" value={language} onChange={(event) => setLanguage(event.target.value)} /></div></div>
      <div className="field"><label className="field-label" htmlFor="cta">Call to action</label><input id="cta" value={cta} onChange={(event) => setCta(event.target.value)} /></div>
      <div className="field"><label className="field-label" htmlFor="instructions">Additional instructions</label><textarea id="instructions" rows={3} value={instructions} onChange={(event) => setInstructions(event.target.value)} /></div>
      <div className="field"><label className="field-label" htmlFor="custom-script">Custom script (optional; skips OpenRouter)</label><textarea id="custom-script" rows={5} value={script} onChange={(event) => setScript(event.target.value)} placeholder="Enter your own script, or leave blank to generate one." /></div>
      <div className="topic-three-grid"><div className="field"><label className="field-label" htmlFor="duration">Target seconds</label><input id="duration" type="number" min="10" max="180" value={duration} onChange={(event) => setDuration(event.target.value)} /></div><div className="field"><label className="field-label" htmlFor="ai-aspect">Aspect ratio</label><select id="ai-aspect" value={aspect} onChange={(event) => setAspect(event.target.value as typeof aspect)}><option>9:16</option><option>16:9</option><option>1:1</option><option>4:5</option></select></div><div className="field"><label className="field-label" htmlFor="variants">Variants (1–3)</label><input id="variants" type="number" min="1" max="3" value={variants} onChange={(event) => setVariants(String(Math.max(1, Math.min(3, Number(event.target.value)))))} /></div></div>
      {plan && <section className="panel plan-review" aria-label="Reviewable script plan">{planProvider !== "local" && planProvider !== providerKey && <p className="form-error">Provider changed. Create a new plan for the selected profile before generating.</p>}<strong>{plan.title}</strong><p>{plan.hook}</p><p>{plan.narration}</p><small>{plan.beats.length} visual beats · estimated {plan.estimatedDuration.toFixed(0)} seconds · {plan.hashtags.join(" ")}</small></section>}
      {error && <div className="form-error" role="alert">{error}</div>}
      {status && <div className="mode-note" role="status">{status}</div>}
      <div className="form-actions"><button className="button" disabled={busy || (!script.trim() && !connected)} type="submit">{busy ? "Planning…" : "Create / refresh plan"}</button><button className="button button-primary" disabled={busy || !plan || (planProvider !== "local" && planProvider !== providerKey)} type="button" onClick={generate}>Generate reviewed video{Number(variants) > 1 ? "s" : ""}</button></div>
    </form>
  </div>;
}
