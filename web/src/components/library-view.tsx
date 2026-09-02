import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type KeyboardEvent, type MouseEvent } from "react";
import { Archive, FileImage, Folder, FolderPlus, ImagePlus, Library, RefreshCw, Search, ShieldCheck, Upload } from "lucide-react";
import { archiveFolder, createFolder, deleteAsset, getHealth, listAssets, listFolders, moveAssets, moveFolder, readableError, removeFolder, updateAsset, updateFolder, uploadAsset } from "../api";
import { bindRevalidationOnFocus, createBoundedRevalidation, onLibraryChanged } from "../library-sync";
import type { AssetOrigin, Health, LibraryAsset, LibraryFolder } from "../types";
import { Button, EmptyState, Field, PageHeader, StatusBadge, formatAge } from "./common";
import { VideoPreviewDialog } from "./video-preview-dialog";

const originLabels = { "manual-import": "Manual", "project-source": "Source", "generated-clip": "Generated clip", "script-output": "Script output" } as const;
const sleep = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

export function LibraryView() {
  const [assets, setAssets] = useState<LibraryAsset[]>([]);
  const [folders, setFolders] = useState<LibraryFolder[]>([]);
  const [selected, setSelected] = useState<LibraryAsset | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [mediaType, setMediaType] = useState("all");
  const [origin, setOrigin] = useState<AssetOrigin | "all">("all");
  const [policy, setPolicy] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(false);
  const [previewAsset, setPreviewAsset] = useState<LibraryAsset | null>(null);
  const [previewOpener, setPreviewOpener] = useState<HTMLButtonElement | null>(null);

  const load = useCallback(async (retry = true) => {
    setLoading(true);
    for (let attempt = 0; attempt < (retry ? 3 : 1); attempt += 1) {
      try {
        const [nextAssets, nextFolders] = await Promise.all([listAssets({ includeArchived: showArchived }), listFolders({ includeArchived: showArchived })]);
        setAssets(nextAssets); setFolders(nextFolders); setError(null);
        setSelected((current) => nextAssets.find((asset) => asset.id === current?.id) || nextAssets[0] || null);
        setLoading(false); return;
      } catch {
        if (attempt < 2 && retry) await sleep(300 * 2 ** attempt);
      }
    }
    setError("Could not reach the local S6 Cut media library.");
    void getHealth().then(setHealth).catch(() => setHealth(null));
    setLoading(false);
  }, [showArchived]);

  // Initial load on mount
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  // Set up bounded revalidation and cross-view event subscription
  useEffect(() => {
    const reval = createBoundedRevalidation(() => load(false));
    const unsubFocus = bindRevalidationOnFocus(() => reval.signal());
    const unsubEvent = onLibraryChanged(() => reval.signal());
    return () => {
      unsubFocus();
      unsubEvent();
      reval.dispose();
    };
  }, [load]);

  const visibleAssets = useMemo(() => assets.filter((asset) => {
    const terms = [asset.title, asset.filename, ...asset.tags, ...asset.brands, ...asset.people].join(" ").toLowerCase();
    return (!folderId || asset.folderId === folderId) && (!policy || asset.policy === policy) &&
      (origin === "all" || asset.origin === origin) &&
      (mediaType === "all" || asset.mediaType.startsWith(`${mediaType}/`)) && (!query.trim() || terms.includes(query.trim().toLowerCase()));
  }), [assets, folderId, mediaType, origin, policy, query]);

  const saveSelected = async (patch: Record<string, unknown>) => {
    if (!selected) return;
    try { const next = await updateAsset(selected.id, patch); setSelected(next); setAssets((current) => current.map((asset) => asset.id === next.id ? next : asset)); } catch (cause) { setError(readableError(cause)); }
  };
  const removeSelectedAsset = async () => {
    if (!selected || selected.protected || !window.confirm(`Remove “${selected.title}” from the Library? Project references and exports will remain usable.`)) return;
    try {
      await deleteAsset(selected.id);
      setAssets((current) => current.filter((asset) => asset.id !== selected.id));
      setSelected(null);
      setSelectedIds((current) => current.filter((id) => id !== selected.id));
    } catch (cause) { setError(readableError(cause)); }
  };
  const addFolder = async (parentId?: string) => {
    const name = window.prompt(parentId ? "Subfolder name" : "Business folder name");
    if (!name?.trim()) return;
    try { const next = await createFolder({ name: name.trim(), parentId }); setFolders((current) => [...current, next]); setFolderId(next.id); } catch (cause) { setError(readableError(cause)); }
  };
  const rename = async (folder: LibraryFolder) => {
    const name = window.prompt("Rename folder", folder.name);
    if (!name?.trim() || name === folder.name) return;
    try { const next = await updateFolder(folder.id, { name: name.trim() }); setFolders((current) => current.map((item) => item.id === next.id ? next : item)); } catch (cause) { setError(readableError(cause)); }
  };
  const move = async (folder: LibraryFolder) => {
    const destinationName = window.prompt("Move into which folder? Leave blank for top level.", "");
    if (destinationName === null) return;
    const destination = destinationName.trim() ? folders.find((item) => item.name.localeCompare(destinationName.trim(), undefined, { sensitivity: "accent" }) === 0) : null;
    if (destinationName.trim() && !destination) return setError("Destination folder not found.");
    try { const next = await moveFolder(folder.id, destination?.id || null); setFolders((current) => current.map((item) => item.id === next.id ? next : item)); } catch (cause) { setError(readableError(cause)); }
  };
  const archive = async (folder: LibraryFolder) => {
    try { await archiveFolder(folder.id, !folder.archived); await load(false); } catch (cause) { setError(readableError(cause)); }
  };
  const remove = async (folder: LibraryFolder) => {
    const destination = folders.find((item) => item.system || item.name === "Unsorted");
    if (!destination || !window.confirm(`Remove “${folder.name}”? Its assets and child folders will move to ${destination.name}; no media will be deleted.`)) return;
    try { await removeFolder(folder.id, destination.id); setFolderId(destination.id); await load(false); } catch (cause) { setError(readableError(cause)); }
  };
  const openPreview = (asset: LibraryAsset, opener: HTMLButtonElement) => {
    if (!asset.mediaType.startsWith("video/") || !asset.previewUrl) return;
    setPreviewOpener(opener);
    setPreviewAsset(asset);
  };
  const closePreview = () => setPreviewAsset(null);
  const moveSelected = async (destination: string) => {
    if (!selectedIds.length) return;
    try { await moveAssets(selectedIds, destination); setAssets((current) => current.map((asset) => selectedIds.includes(asset.id) ? { ...asset, folderId: destination } : asset)); setSelectedIds([]); } catch (cause) { setError(readableError(cause)); }
  };

  return <div className="page library-page">
    <PageHeader eyebrow="Tier 0 resolver" title="Personal Media Library" description="Organise reusable and project media in local business folders. Folders organise content; they are not access boundaries." actions={<Button variant="primary" onClick={() => setShowImport(!showImport)}><ImagePlus size={15} /> Import asset</Button>} />
    {error && <div className="library-error" role="alert"><div><strong>{error}</strong><span>{health ? `Engine: ${health.status}` : "Engine status unavailable"}</span></div><Button onClick={() => void load(false)}><RefreshCw size={14} /> Retry</Button></div>}
    {showImport && <ImportPanel folders={folders} defaultFolderId={folderId || undefined} onDone={() => { setShowImport(false); void load(false); }} />}

    <div className="library-layout">
      <aside className="library-sidebar panel"><strong>Folders</strong><button className={!folderId && !policy ? "active" : ""} onClick={() => { setFolderId(null); setPolicy(null); }}><Library size={15} /><span className="library-control-label">All media</span><span>{assets.length}</span></button>
        <FolderTree folders={folders} assets={assets} selectedId={folderId} onSelect={(id) => { setFolderId(id); setPolicy(null); }} onAdd={addFolder} onRename={rename} onMove={move} onArchive={archive} onRemove={remove} />
        <Button variant="ghost" onClick={() => addFolder()}><FolderPlus size={14} /> New business folder</Button>
        <label className="archived-toggle"><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} /> Show archived</label>
        <strong>Policy</strong>{["required", "prefer", "neutral", "never"].map((item) => <button key={item} className={policy === item ? "active" : ""} onClick={() => setPolicy(policy === item ? null : item)}><ShieldCheck size={14} /><span className="library-control-label">{item === "prefer" ? "Preferred" : item[0].toUpperCase() + item.slice(1)}</span><span>{assets.filter((asset) => asset.policy === item).length}</span></button>)}
      </aside>

      <section className="library-centre panel"><div className="library-toolbar"><div className="search-box"><Search size={15} /><input aria-label="Search media" placeholder="Search titles, tags, people, brands…" value={query} onChange={(event) => setQuery(event.target.value)} /></div><select aria-label="Media type" value={mediaType} onChange={(event) => setMediaType(event.target.value)}><option value="all">All media</option><option value="image">Images</option><option value="video">Video</option><option value="audio">Audio</option></select><select aria-label="Asset origin" value={origin} onChange={(event) => setOrigin(event.target.value as AssetOrigin | "all")}><option value="all">All origins</option><option value="project-source">Sources</option><option value="generated-clip">Generated clips</option><option value="script-output">Script outputs</option><option value="manual-import">Manual imports</option></select></div>
        {selectedIds.length > 0 && <div className="bulk-bar"><strong>{selectedIds.length} selected</strong><select aria-label="Move selected assets" defaultValue="" onChange={(event) => { if (event.target.value) void moveSelected(event.target.value); }}><option value="" disabled>Move to…</option>{folders.filter((folder) => !folder.archived).map((folder) => <option value={folder.id} key={folder.id}>{folder.name}</option>)}</select></div>}
        {visibleAssets.length ? <div className="asset-grid">{visibleAssets.map((asset) => <LibraryAssetCard key={asset.id} asset={asset} isSelected={selectedIds.includes(asset.id)} isInspected={selected?.id === asset.id} onPreview={openPreview} onInspect={setSelected} onToggleSelected={(assetId, checked) => setSelectedIds((current) => checked ? [...current, assetId] : current.filter((id) => id !== assetId))} />)}</div>
          : <EmptyState icon={<Library size={30} />} title={assets.length ? "No media matches these filters" : "Build your private resolver"} action={!assets.length ? <Button variant="primary" onClick={() => setShowImport(true)}><Upload size={15} /> Import first asset</Button> : undefined}>Try another folder, search, or media type. Existing media remains safely stored.</EmptyState>}
        {loading && <p className="loading-note" role="status">Refreshing local media…</p>}
      </section>

      <aside className="asset-inspector panel"><div className="panel-title"><strong>Rule Inspector</strong>{selected && <span>{formatAge(selected.createdAt)}</span>}</div>{selected ? <div className="asset-fields">
        <Field label="Title"><input value={selected.title} onChange={(event) => setSelected({ ...selected, title: event.target.value })} onBlur={() => saveSelected({ title: selected.title })} /></Field>
        <Field label="Policy"><select value={selected.policy} onChange={(event) => saveSelected({ policy: event.target.value })}><option value="required">Required</option><option value="prefer">Prefer</option><option value="neutral">Neutral</option><option value="never">Never</option></select></Field>
        <Field label="Trigger phrases"><input value={selected.triggers.join(", ")} onChange={(event) => setSelected({ ...selected, triggers: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })} onBlur={() => saveSelected({ triggers: selected.triggers })} /></Field>
        <Field label="Tags"><input value={selected.tags.join(", ")} onChange={(event) => setSelected({ ...selected, tags: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })} onBlur={() => saveSelected({ tags: selected.tags })} /></Field>
        <Field label="Brands"><input value={selected.brands.join(", ")} onChange={(event) => setSelected({ ...selected, brands: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })} onBlur={() => saveSelected({ brands: selected.brands })} /></Field>
        <Field label="People"><input value={selected.people.join(", ")} onChange={(event) => setSelected({ ...selected, people: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })} onBlur={() => saveSelected({ people: selected.people })} /></Field>
        <div className="rule-grid"><Field label="Minimum spacing"><input type="number" min={0} value={selected.minSpacingSeconds} onChange={(event) => saveSelected({ minSpacingSeconds: Number(event.target.value) })} /></Field><Field label="Max uses"><input type="number" min={1} value={selected.maxUsesPerProject} onChange={(event) => saveSelected({ maxUsesPerProject: Number(event.target.value) })} /></Field></div>
        <Field label="Licence"><input value={selected.licence} onChange={(event) => setSelected({ ...selected, licence: event.target.value })} onBlur={() => saveSelected({ licence: selected.licence })} /></Field>
        <label className="check-row"><input type="checkbox" checked={selected.protected} onChange={(event) => saveSelected({ protected: event.target.checked })} /><span><strong>Protected / pinned</strong><small>Prevents accidental removal and marks campaign media.</small></span></label>
        <Button variant="ghost" disabled={selected.protected} onClick={() => void removeSelectedAsset()}>Remove Library record</Button>
      </div> : <p className="muted inspector-empty">Select an asset to edit its deterministic matching rules.</p>}</aside>
    </div>

    {previewAsset && <VideoPreviewDialog asset={previewAsset} opener={previewOpener} onClose={closePreview} />}

  </div>;
}

function LibraryAssetCard({ asset, isSelected, isInspected, onPreview, onInspect, onToggleSelected }: { asset: LibraryAsset; isSelected: boolean; isInspected: boolean; onPreview: (asset: LibraryAsset, opener: HTMLButtonElement) => void; onInspect: (asset: LibraryAsset) => void; onToggleSelected: (assetId: string, checked: boolean) => void }) {
  const canPreview = asset.mediaType.startsWith("video/") && !!asset.previewUrl;
  const handlePreview = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onPreview(asset, event.currentTarget);
  };
  const handleInspect = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onInspect(asset);
  };
  const handleToggleSelected = (event: ChangeEvent<HTMLInputElement>) => {
    event.stopPropagation();
    onToggleSelected(asset.id, event.currentTarget.checked);
  };
  const details = <div className="asset-card-details-content" aria-hidden="true"><strong>{asset.title}</strong><span>{asset.tags.slice(0, 3).join(" · ") || asset.filename}</span><span className="origin-badge">{originLabels[asset.origin]}</span><StatusBadge state={asset.policy === "never" ? "failed" : asset.policy === "required" ? "fallback" : "local"} label={asset.policy} /></div>;

  return <article className={`asset-card ${isInspected ? "active" : ""}`}>
    <label className="asset-select"><input aria-label={`Select ${asset.title}`} type="checkbox" checked={isSelected} onChange={handleToggleSelected} /></label>
    {canPreview ? <>
      <button className="asset-preview-trigger" aria-label={`Preview ${asset.title}`} type="button" onClick={handlePreview}><AssetPreview asset={asset} /></button>
      <button className="asset-card-details" aria-label={`Select ${asset.title} for Rule Inspector`} type="button" onClick={handleInspect}>{details}</button>
    </> : <button className="asset-card-details asset-card-details-full" aria-label={`Select ${asset.title} for Rule Inspector`} type="button" onClick={handleInspect}><AssetPreview asset={asset} />{details}</button>}
  </article>;
}

function AssetPreview({ asset }: { asset: LibraryAsset }) {
  if (asset.mediaType.startsWith("video/") && asset.previewUrl) return <div className="asset-preview"><video src={asset.previewUrl} muted preload="metadata" aria-hidden="true" tabIndex={-1} /></div>;
  return <div className="asset-preview"><FileImage size={29} /><span>{asset.mediaType.split("/")[1]?.toUpperCase() || "MEDIA"}</span>{asset.protected && <ShieldCheck size={14} />}</div>;
}

function FolderTree({ folders, assets, selectedId, onSelect, onAdd, onRename, onMove, onArchive, onRemove }: { folders: LibraryFolder[]; assets: LibraryAsset[]; selectedId: string | null; onSelect: (id: string) => void; onAdd: (parentId: string) => void; onRename: (folder: LibraryFolder) => void; onMove: (folder: LibraryFolder) => void; onArchive: (folder: LibraryFolder) => void; onRemove: (folder: LibraryFolder) => void }) {
  const render = (parentId: string | null, depth = 0) => folders.filter((folder) => (folder.parentId || null) === parentId).map((folder) => {
    const hasChildren = folders.some((item) => item.parentId === folder.id);
    return <div key={folder.id} className="folder-node" style={{ paddingLeft: depth * 10 }}><button role="treeitem" aria-selected={selectedId === folder.id} aria-level={depth + 1} aria-expanded={hasChildren ? true : undefined} tabIndex={selectedId === folder.id || (!selectedId && folder.system) ? 0 : -1} className={selectedId === folder.id ? "active" : ""} onClick={() => onSelect(folder.id)}><Folder size={14} /><span className="folder-name">{folder.name}</span><span>{assets.filter((asset) => asset.folderId === folder.id).length}</span></button>{!folder.system && <div className="folder-actions"><button aria-label={`Add subfolder to ${folder.name}`} onClick={() => onAdd(folder.id)}>+</button><button aria-label={`Rename ${folder.name}`} onClick={() => onRename(folder)}>Rename</button><button aria-label={`Move ${folder.name}`} onClick={() => onMove(folder)}>Move</button><button aria-label={`${folder.archived ? "Restore" : "Archive"} ${folder.name}`} onClick={() => onArchive(folder)}><Archive size={11} /></button><button aria-label={`Remove ${folder.name}`} onClick={() => onRemove(folder)}>×</button></div>}{hasChildren && <div role="group">{render(folder.id, depth + 1)}</div>}</div>;
  });
  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    const target = event.key === "ArrowDown" ? items[index + 1] : event.key === "ArrowUp" ? items[index - 1] : event.key === "Home" ? items[0] : event.key === "End" ? items.at(-1) : undefined;
    if (target) { event.preventDefault(); target.focus(); }
  };
  return <div className="folder-tree" role="tree" aria-label="Media folders" onKeyDown={navigate}>{render(null)}</div>;
}

function ImportPanel({ folders, defaultFolderId, onDone }: { folders: LibraryFolder[]; defaultFolderId?: string; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null); const [title, setTitle] = useState(""); const [tags, setTags] = useState(""); const [triggers, setTriggers] = useState(""); const [policy, setPolicy] = useState("neutral"); const [licence, setLicence] = useState("User supplied"); const [folderId, setFolderId] = useState(defaultFolderId || folders.find((folder) => folder.system)?.id || ""); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const submit = async () => { if (!file) return setError("Choose a media file."); const form = new FormData(); form.set("file", file); form.set("title", title || file.name.replace(/\.[^.]+$/, "")); form.set("tags", tags); form.set("triggers", triggers); form.set("policy", policy); form.set("licence", licence); if (folderId) form.set("folder_id", folderId); setBusy(true); try { await uploadAsset(form); onDone(); } catch (cause) { setError(readableError(cause)); } finally { setBusy(false); } };
  return <section className="import-panel panel"><div><span className="eyebrow">New Library asset</span><h2>Import once, reuse deliberately</h2></div><div className="import-fields"><Field label="File"><input type="file" accept="image/*,video/*,audio/*" onChange={(event) => setFile(event.target.files?.[0] || null)} /></Field><Field label="Title"><input value={title} onChange={(event) => setTitle(event.target.value)} /></Field><Field label="Business folder"><select value={folderId} onChange={(event) => setFolderId(event.target.value)}>{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></Field><Field label="Tags"><input value={tags} onChange={(event) => setTags(event.target.value)} /></Field><Field label="Trigger phrases"><input value={triggers} onChange={(event) => setTriggers(event.target.value)} /></Field><Field label="Policy"><select value={policy} onChange={(event) => setPolicy(event.target.value)}><option value="neutral">Neutral</option><option value="prefer">Prefer</option><option value="required">Required</option><option value="never">Never</option></select></Field><Field label="Licence"><input value={licence} onChange={(event) => setLicence(event.target.value)} /></Field></div>{error && <p className="form-error">{error}</p>}<Button variant="primary" disabled={busy} onClick={submit}>{busy ? "Importing…" : "Import asset"}</Button></section>;
}
