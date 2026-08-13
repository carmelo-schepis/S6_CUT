import { useEffect, useState } from "react";
import { FileImage, ImagePlus, Info, Library, Search, ShieldCheck, Sparkles, Upload } from "lucide-react";
import { explainMatch, listAssets, readableError, updateAsset, uploadAsset } from "../api";
import type { LibraryAsset, MatchExplanation } from "../types";
import { Button, EmptyState, Field, PageHeader, StatusBadge, formatAge } from "./common";

export function LibraryView() {
  const [assets, setAssets] = useState<LibraryAsset[]>([]);
  const [selected, setSelected] = useState<LibraryAsset | null>(null);
  const [query, setQuery] = useState("");
  const [explanation, setExplanation] = useState<MatchExplanation | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => listAssets().then((next) => { setAssets(next); setSelected((current) => next.find((asset) => asset.id === current?.id) || next[0] || null); }).catch((cause) => setError(readableError(cause)));
  useEffect(() => { void load(); }, []);

  const runMatch = async () => {
    if (!query.trim()) return;
    try { setExplanation(await explainMatch(query)); } catch (cause) { setError(readableError(cause)); }
  };

  const saveSelected = async (patch: Record<string, unknown>) => {
    if (!selected) return;
    try { const next = await updateAsset(selected.id, patch); setSelected(next); setAssets((current) => current.map((asset) => asset.id === next.id ? next : asset)); } catch (cause) { setError(readableError(cause)); }
  };

  return <div className="page library-page">
    <PageHeader eyebrow="Tier 0 resolver" title="Personal Media Library" description="Your own images, GIFs, videos, posters, ads, logos, and audio are matched before any web source." actions={<Button variant="primary" onClick={() => setShowImport(!showImport)}><ImagePlus size={15} /> Import asset</Button>} />
    {error && <p className="form-error" role="alert">{error}</p>}
    {showImport && <ImportPanel onDone={() => { setShowImport(false); load(); }} />}

    <div className="library-layout">
      <aside className="library-sidebar panel"><strong>Collections</strong><button className="active"><Library size={15} /> All assets <span>{assets.length}</span></button><button><ShieldCheck size={15} /> Required <span>{assets.filter((asset) => asset.policy === "required").length}</span></button><button><Sparkles size={15} /> Preferred <span>{assets.filter((asset) => asset.policy === "prefer").length}</span></button><div className="storage-note"><span>Mounted storage</span><strong>Snapshot with your S6 data</strong><small>Project deletion never deletes a referenced Library source.</small></div></aside>

      <section className="library-centre panel"><div className="library-toolbar"><div className="search-box"><Search size={15} /><input placeholder="Search titles, tags, people, brands…" /></div><select defaultValue="all"><option value="all">All media</option><option>Images</option><option>GIFs</option><option>Video</option><option>Audio</option></select></div>
        {assets.length ? <div className="asset-grid">{assets.map((asset) => <button key={asset.id} className={`asset-card ${selected?.id === asset.id ? "active" : ""}`} onClick={() => setSelected(asset)}><div className="asset-preview"><FileImage size={29} /><span>{asset.mediaType.split("/")[1]?.toUpperCase() || "MEDIA"}</span>{asset.protected && <ShieldCheck size={14} />}</div><div><strong>{asset.title}</strong><span>{asset.tags.slice(0, 3).join(" · ") || "No tags"}</span><StatusBadge state={asset.policy === "never" ? "failed" : asset.policy === "required" ? "fallback" : "local"} label={asset.policy} /></div></button>)}</div>
          : <EmptyState icon={<Library size={30} />} title="Build your private resolver" action={<Button variant="primary" onClick={() => setShowImport(true)}><Upload size={15} /> Import first asset</Button>}>Add reusable brand assets, reactions, posters, ads, images, and audio. Files remain in the mounted S6_cut data directory.</EmptyState>}
      </section>

      <aside className="asset-inspector panel"><div className="panel-title"><strong>Rule Inspector</strong>{selected && <span>{formatAge(selected.createdAt)}</span>}</div>{selected ? <div className="asset-fields">
        <Field label="Title"><input value={selected.title} onChange={(event) => setSelected({ ...selected, title: event.target.value })} onBlur={() => saveSelected({ title: selected.title })} /></Field>
        <Field label="Policy"><select value={selected.policy} onChange={(event) => saveSelected({ policy: event.target.value })}><option value="required">Required</option><option value="prefer">Prefer</option><option value="neutral">Neutral</option><option value="never">Never</option></select></Field>
        <Field label="Trigger phrases" hint="Comma separated; exact phrases rank above tags."><input value={selected.triggers.join(", ")} onChange={(event) => setSelected({ ...selected, triggers: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })} onBlur={() => saveSelected({ triggers: selected.triggers })} /></Field>
        <Field label="Tags"><input value={selected.tags.join(", ")} onChange={(event) => setSelected({ ...selected, tags: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })} onBlur={() => saveSelected({ tags: selected.tags })} /></Field>
        <div className="rule-grid"><Field label="Minimum spacing"><input type="number" min={0} value={selected.minSpacingSeconds} onChange={(event) => saveSelected({ minSpacingSeconds: Number(event.target.value) })} /></Field><Field label="Max uses"><input type="number" min={1} value={selected.maxUsesPerProject} onChange={(event) => saveSelected({ maxUsesPerProject: Number(event.target.value) })} /></Field></div>
        <Field label="Licence"><input value={selected.licence} onChange={(event) => setSelected({ ...selected, licence: event.target.value })} onBlur={() => saveSelected({ licence: selected.licence })} /></Field>
        <label className="check-row"><input type="checkbox" checked={selected.protected} onChange={(event) => saveSelected({ protected: event.target.checked })} /><span><strong>Protected / pinned</strong><small>Prevents accidental removal and marks campaign media.</small></span></label>
      </div> : <p className="muted inspector-empty">Select an asset to edit its deterministic matching rules.</p>}</aside>
    </div>

    <section className="match-bench panel"><div><span className="eyebrow">Why it matched</span><h2>Test the rule engine</h2><p>Paste sample narration to see the exact local decision before a project uses it.</p></div><div className="match-input"><textarea value={query} onChange={(event) => setQuery(event.target.value)} placeholder="e.g. The Beatles changed popular music…" rows={3} /><Button onClick={runMatch}><Sparkles size={15} /> Explain match</Button></div>{explanation && <div className="match-result"><div className="match-decision"><Info size={17} /><div><span>{explanation.selected ? "Selected local asset" : "No eligible local asset"}</span><strong>{explanation.selected?.title || "Continue to licensed source or text card"}</strong><p>{explanation.reason}</p></div><span className="score-box">{Math.round(explanation.score)}</span></div>{explanation.matchedTriggers.length > 0 && <p><strong>Matched:</strong> {explanation.matchedTriggers.join(", ")}</p>}{explanation.rejected.length > 0 && <details><summary>{explanation.rejected.length} rejected alternative(s)</summary>{explanation.rejected.map((item) => <div key={item.assetId}>{item.title}: {item.reason}</div>)}</details>}</div>}
    </section>
  </div>;
}

function ImportPanel({ onDone }: { onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState("");
  const [triggers, setTriggers] = useState("");
  const [policy, setPolicy] = useState("neutral");
  const [licence, setLicence] = useState("User supplied");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!file) return setError("Choose a media file.");
    const form = new FormData(); form.set("file", file); form.set("title", title || file.name.replace(/\.[^.]+$/, "")); form.set("tags", tags); form.set("triggers", triggers); form.set("policy", policy); form.set("licence", licence);
    setBusy(true); try { await uploadAsset(form); onDone(); } catch (cause) { setError(readableError(cause)); } finally { setBusy(false); }
  };
  return <section className="import-panel panel"><div><span className="eyebrow">New Library asset</span><h2>Import once, reuse deliberately</h2></div><div className="import-fields"><Field label="File"><input type="file" accept="image/*,video/*,audio/*" onChange={(event) => setFile(event.target.files?.[0] || null)} /></Field><Field label="Title"><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Spring campaign poster" /></Field><Field label="Tags"><input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="product, launch, copper" /></Field><Field label="Trigger phrases"><input value={triggers} onChange={(event) => setTriggers(event.target.value)} placeholder="new release, product name" /></Field><Field label="Policy"><select value={policy} onChange={(event) => setPolicy(event.target.value)}><option value="neutral">Neutral</option><option value="prefer">Prefer</option><option value="required">Required</option><option value="never">Never</option></select></Field><Field label="Licence"><input value={licence} onChange={(event) => setLicence(event.target.value)} /></Field></div>{error && <p className="form-error">{error}</p>}<Button variant="primary" disabled={busy} onClick={submit}>{busy ? "Importing…" : "Import asset"}</Button></section>;
}
