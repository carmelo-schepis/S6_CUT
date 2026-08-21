import { useEffect, useState, type FormEvent } from "react";
import { createShortsJob, createShortsSourceJob, listAssets, readableError } from "../api";
import type { LibraryAsset } from "../types";
import { VideoSourcePicker, type VideoSourceMode } from "./video-source-picker";

const aspects = ["9:16", "16:9", "1:1", "4:5"] as const;
type AspectRatio = typeof aspects[number];

export function ShortsEditorView({ onJobCreated }: { onJobCreated: () => void }) {
  const [assets, setAssets] = useState<LibraryAsset[]>([]);
  const [assetId, setAssetId] = useState("");
  const [mode, setMode] = useState<VideoSourceMode>("file");
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [start, setStart] = useState("0");
  const [end, setEnd] = useState("");
  const [aspect, setAspect] = useState<AspectRatio>("9:16");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  const refreshAssets = () => listAssets().then((items) => {
    const videos = items.filter((item) => item.mediaType.toLowerCase().startsWith("video/"));
    setAssets(videos);
    setAssetId((current) => videos.some((item) => item.id === current) ? current : videos[0]?.id || "");
  }).catch((cause) => setError(readableError(cause)));

  useEffect(() => { void refreshAssets(); }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setStatus("");
    const from = Number(start);
    const to = end.trim() === "" ? undefined : Number(end);
    if (!Number.isFinite(from) || from < 0) return setError("Start seconds must be a finite number at least 0.");
    if (to !== undefined && (!Number.isFinite(to) || to <= from)) return setError("End seconds must be blank or a finite number greater than start.");
    if (mode === "file" && !file) return setError("Choose a local video first.");
    if (mode === "url" && !url.trim()) return setError("Paste a supported YouTube URL first.");
    if (mode === "library" && !assetId) return setError(assets.length ? "Choose a Library video first." : "No Library videos are available. Add a video to Library first.");
    setBusy(true);
    try {
      setStatus(mode === "file" ? "Uploading and validating source…" : mode === "url" ? "Importing and validating YouTube source…" : "Validating Library source…");
      if (mode === "library") await createShortsJob({ assetId, start: from, end: to, aspectRatio: aspect });
      else await createShortsSourceJob({ file: mode === "file" ? file || undefined : undefined, url: mode === "url" ? url.trim() : undefined, start: from, end: to, aspectRatio: aspect });
      setStatus("Short queued successfully.");
      await refreshAssets();
      onJobCreated();
    } catch (cause) {
      setError(readableError(cause));
      setStatus("");
    } finally {
      setBusy(false);
    }
  };

  return <div className="page shorts-editor-page">
    <div className="page-header"><div><div className="eyebrow">Native editing workflow</div><h1>Shorts Editor</h1><p>Create a durable short from an authorised local, YouTube, or Library video.</p></div></div>
    <form className="panel shorts-editor-form" onSubmit={submit}>
      <section aria-labelledby="shorts-source-title"><h2 id="shorts-source-title">Source video</h2><VideoSourcePicker mode={mode} onModeChange={setMode} file={file} onFile={(next, pickerError) => { setFile(next); setError(pickerError || null); }} url={url} onUrl={setUrl}>
        <div className="field"><label className="field-label" htmlFor="shorts-source">Library video</label><select id="shorts-source" value={assetId} onChange={(event) => setAssetId(event.target.value)} disabled={!assets.length}><option value="">{assets.length ? "Select Library video" : "No Library videos available"}</option>{assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.title}</option>)}</select>{!assets.length && <small>Add a video in Library before using this mode.</small>}</div>
      </VideoSourcePicker></section>
      <div className="shorts-trim-grid"><div className="field"><label className="field-label" htmlFor="shorts-start">Start seconds</label><input id="shorts-start" type="number" min="0" step=".1" value={start} onChange={(event) => setStart(event.target.value)} /></div><div className="field"><label className="field-label" htmlFor="shorts-end">End seconds</label><input id="shorts-end" type="number" min="0" step=".1" value={end} onChange={(event) => setEnd(event.target.value)} placeholder="Source remainder" /><small>Leave blank to use the remainder of the source.</small></div><div className="field"><label className="field-label" htmlFor="shorts-aspect">Aspect ratio</label><select id="shorts-aspect" value={aspect} onChange={(event) => setAspect(event.target.value as AspectRatio)}>{aspects.map((value) => <option key={value}>{value}</option>)}</select></div></div>
      {error && <div className="form-error" role="alert">{error}</div>}
      {status && <div className="mode-note" role="status">{status}</div>}
      <button className="button button-primary" disabled={busy} type="submit">{busy ? "Working…" : "Queue short"}</button>
      <p className="rights-copy">Only process content you own or are authorised to use.</p>
    </form>
  </div>;
}
