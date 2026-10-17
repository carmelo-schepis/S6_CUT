import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent, type MouseEvent } from "react";
import { Archive, FileImage, Folder, FolderPlus, ImagePlus, Library, RefreshCw, Search, ShieldCheck, Sparkles, Trash2, Upload } from "lucide-react";
import { applyLibraryTitles, archiveFolder, createFolder, deleteAsset, deleteAssets, getHealth, listAssets, listFolders, moveAssets, moveFolder, readableError, removeFolder, renewAssetThumbnail, suggestLibraryTitles, updateAsset, updateFolder, uploadAsset } from "../api";
import { bindRevalidationOnFocus, createBoundedRevalidation, emitLibraryChanged, onLibraryChanged } from "../library-sync";
import type { AssetOrigin, Health, LibraryAsset, LibraryFolder, TitleApplyItem, TitleSuggestionResponse } from "../types";
import { Button, EmptyState, Field, FieldGroup, PageHeader, StatusBadge, formatAge } from "./common";
import { LazyVideoThumbnail } from "./lazy-video-thumbnail";
import { SeoTitleReviewDialog } from "./seo-title-review";
import { VideoPreviewDialog } from "./video-preview-dialog";

const originLabels = { "manual-import": "Manual", "project-source": "Source", "generated-clip": "Generated clip", "script-output": "Legacy output" } as const;
const sleep = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

// A full library mounted every card at once — 329 assets meant 332 concurrent
// <video> elements and a ~15,000px page. Render a page at a time instead.
const ASSET_PAGE = 60;

export function LibraryView({ selectedAssetId }: { selectedAssetId?: string | null } = {}) {
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
  // The first read is queued from an effect, so start in the loading state:
  // otherwise the first paint claims an empty Library before anything is read.
  const [loading, setLoading] = useState(true);
  const [previewAsset, setPreviewAsset] = useState<LibraryAsset | null>(null);
  const [previewOpener, setPreviewOpener] = useState<HTMLButtonElement | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteFeedback, setDeleteFeedback] = useState<string | null>(null);
  const [assetLimit, setAssetLimit] = useState(ASSET_PAGE);
  const [titleSuggestions, setTitleSuggestions] = useState<TitleSuggestionResponse | null>(null);
  const [suggestingTitles, setSuggestingTitles] = useState(false);
  const [applyingTitles, setApplyingTitles] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [titleApplyError, setTitleApplyError] = useState<string | null>(null);
  const [titleFeedback, setTitleFeedback] = useState<{ message: string; reasons: string[] } | null>(null);
  const loadFlight = useRef<Promise<void> | null>(null);
  const initialLoadComplete = useRef(false);

  const load = useCallback((retry = true) => {
    if (loadFlight.current) return loadFlight.current;
    const request = async () => {
      setLoading(true);
      for (let attempt = 0; attempt < (retry ? 3 : 1); attempt += 1) {
        try {
          const [nextAssets, nextFolders] = await Promise.all([listAssets({ includeArchived: showArchived || Boolean(selectedAssetId) }), listFolders({ includeArchived: showArchived || Boolean(selectedAssetId) })]);
          // Keep the player URL stable for an unchanged blob, but accept newly
          // signed thumbnail URLs so an idle Library cannot retain expired links.
          setAssets((current) => {
            const previous = new Map(current.map((asset) => [asset.id, asset]));
            return nextAssets.map((asset) => {
              const existing = previous.get(asset.id);
              return existing?.blobId === asset.blobId ? { ...asset, previewUrl: existing.previewUrl || asset.previewUrl } : asset;
            });
          });
          setFolders(nextFolders); setError(null);
          const selectedIndex = nextAssets.findIndex((asset) => asset.id === selectedAssetId);
          if (selectedIndex >= 0) setAssetLimit((current) => Math.max(current, Math.ceil((selectedIndex + 1) / ASSET_PAGE) * ASSET_PAGE));
          setSelected((current) => nextAssets.find((asset) => asset.id === selectedAssetId) || nextAssets.find((asset) => asset.id === current?.id) || nextAssets[0] || null);
          return;
        } catch {
          if (attempt < 2 && retry) await sleep(300 * 2 ** attempt);
        }
      }
      // Keep the last successful cards on screen while a transient request fails.
      setError("Could not reach the local S6 Cut media library.");
      void getHealth().then(setHealth).catch(() => setHealth(null));
    };
    const flight = request().finally(() => { setLoading(false); initialLoadComplete.current = true; loadFlight.current = null; });
    loadFlight.current = flight;
    return flight;
  }, [showArchived, selectedAssetId]);

  // Initial load on mount
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  // Set up bounded revalidation and cross-view event subscription
  useEffect(() => {
    const reval = createBoundedRevalidation(() => load(false));
    // A focus event commonly accompanies the first paint. Ignore it until the
    // initial read has settled instead of scheduling a second full read.
    const signalRevalidation = () => {
      if (initialLoadComplete.current) reval.signal();
    };
    const unsubFocus = bindRevalidationOnFocus(signalRevalidation);
    const unsubEvent = onLibraryChanged(signalRevalidation);
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
  // Narrowing the filters should always start again from the first page.
  const filterKey = `${folderId}|${policy}|${origin}|${mediaType}|${query.trim()}`;
  const [prevFilterKey, setPrevFilterKey] = useState(filterKey);
  if (prevFilterKey !== filterKey) { setPrevFilterKey(filterKey); setAssetLimit(ASSET_PAGE); }
  const pagedAssets = visibleAssets.slice(0, assetLimit);
  const remainingAssets = visibleAssets.length - pagedAssets.length;

  useEffect(() => {
    if (!selectedAssetId) return;
    const card = [...document.querySelectorAll<HTMLElement>(".asset-card[data-asset-id]")]
      .find((item) => item.dataset.assetId === selectedAssetId);
    card?.scrollIntoView?.({ block: "center" });
  }, [selectedAssetId, assets, assetLimit]);

  // The Library list holds the last loaded or saved copy; the inspector edits a draft.
  const savedSelected = selected ? assets.find((asset) => asset.id === selected.id) : undefined;
  const saveIfChanged = (field: "title" | "description") => {
    if (!selected || (savedSelected && savedSelected[field] === selected[field])) return;
    void saveSelected({ [field]: selected[field] });
  };
  const saveSelected = async (patch: Record<string, unknown>) => {
    if (!selected) return;
    try { const next = await updateAsset(selected.id, patch); setSelected(next); setAssets((current) => current.map((asset) => asset.id === next.id ? next : asset)); emitLibraryChanged(); } catch (cause) { setError(readableError(cause)); }
  };
  const removeSelectedAsset = async () => {
    const projectLinked = selected?.sourceProjectId;
    const confirmation = projectLinked
      ? `Remove “${selected?.title}” from the Library? This removes the Library item only. Its project and job history will remain.`
      : `Remove “${selected?.title}” from the Library? This removes the Library item only.`;
    if (!selected || selected.protected || !window.confirm(confirmation)) return;
    try {
      await deleteAsset(selected.id);
      setAssets((current) => current.filter((asset) => asset.id !== selected.id));
      emitLibraryChanged();
      setSelected(null);
      setSelectedIds((current) => current.filter((id) => id !== selected.id));
    } catch (cause) { setError(readableError(cause)); }
  };
  const addFolder = async (parentId?: string) => {
    const name = window.prompt(parentId ? "Subfolder name" : "Business folder name");
    if (!name?.trim()) return;
    try { const next = await createFolder({ name: name.trim(), parentId }); setFolders((current) => [...current, next]); setFolderId(next.id); emitLibraryChanged(); } catch (cause) { setError(readableError(cause)); }
  };
  const rename = async (folder: LibraryFolder) => {
    const name = window.prompt("Rename folder", folder.name);
    if (!name?.trim() || name === folder.name) return;
    try { const next = await updateFolder(folder.id, { name: name.trim() }); setFolders((current) => current.map((item) => item.id === next.id ? next : item)); emitLibraryChanged(); } catch (cause) { setError(readableError(cause)); }
  };
  const move = async (folder: LibraryFolder) => {
    const destinationName = window.prompt("Move into which folder? Leave blank for top level.", "");
    if (destinationName === null) return;
    const destination = destinationName.trim() ? folders.find((item) => item.name.localeCompare(destinationName.trim(), undefined, { sensitivity: "accent" }) === 0) : null;
    if (destinationName.trim() && !destination) return setError("Destination folder not found.");
    try { const next = await moveFolder(folder.id, destination?.id || null); setFolders((current) => current.map((item) => item.id === next.id ? next : item)); emitLibraryChanged(); } catch (cause) { setError(readableError(cause)); }
  };
  const archive = async (folder: LibraryFolder) => {
    try { await archiveFolder(folder.id, !folder.archived); emitLibraryChanged(); await load(false); } catch (cause) { setError(readableError(cause)); }
  };
  const remove = async (folder: LibraryFolder) => {
    const destination = folders.find((item) => item.system || item.name === "Unsorted");
    if (!destination || !window.confirm(`Remove “${folder.name}”? Its assets and child folders will move to ${destination.name}; no media will be deleted.`)) return;
    try { await removeFolder(folder.id, destination.id); setFolderId(destination.id); emitLibraryChanged(); await load(false); } catch (cause) { setError(readableError(cause)); }
  };
  const openPreview = (asset: LibraryAsset, opener: HTMLButtonElement) => {
    if (!asset.mediaType.startsWith("video/") || !asset.previewUrl) return;
    setPreviewOpener(opener);
    setPreviewAsset(asset);
  };
  const closePreview = () => setPreviewAsset(null);
  const clearFilters = () => { setFolderId(null); setPolicy(null); setOrigin("all"); setMediaType("all"); setQuery(""); };
  const moveSelected = async (destination: string) => {
    if (!selectedIds.length) return;
    try { await moveAssets(selectedIds, destination); setAssets((current) => current.map((asset) => selectedIds.includes(asset.id) ? { ...asset, folderId: destination } : asset)); setSelectedIds([]); emitLibraryChanged(); } catch (cause) { setError(readableError(cause)); }
  };
  const suggestTitles = async () => {
    if (suggestingTitles) return;
    setSuggestingTitles(true); setTitleError(null); setTitleFeedback(null); setTitleApplyError(null);
    try { setTitleSuggestions(await suggestLibraryTitles(selectedIds.length ? { assetIds: [...selectedIds] } : { scope: "auto-titled" })); }
    catch (cause) { setTitleError(`Could not write SEO titles. ${readableError(cause)}`); }
    finally { setSuggestingTitles(false); }
  };
  const closeTitleReview = () => { setTitleSuggestions(null); setTitleApplyError(null); queueMicrotask(() => document.querySelector<HTMLButtonElement>('[data-testid="suggest-seo-titles"]')?.focus()); };
  const applyTitles = async (items: TitleApplyItem[]) => {
    setApplyingTitles(true); setTitleApplyError(null);
    try {
      const result = await applyLibraryTitles(items);
      const updated = result.applied.length;
      const conflicts = result.conflicts.length;
      setTitleFeedback({ message: `Updated ${updated} title${updated === 1 ? "" : "s"}${conflicts ? ` · ${conflicts} conflict${conflicts === 1 ? "" : "s"}` : ""}`, reasons: result.conflicts.map((item) => `${item.title}: ${item.reason || "Changed since the suggestion was written."}`) });
      closeTitleReview();
      emitLibraryChanged();
      await load(false);
    } catch (cause) { setTitleApplyError(`Could not apply titles. ${readableError(cause)}`); }
    finally { setApplyingTitles(false); }
  };
  const confirmDelete = async () => {
    if (deleting || !selectedIds.length) return;
    const ids = [...selectedIds];
    setDeleting(true); setDeleteFeedback(null);
    try {
      const result = await deleteAssets(ids);
      const deletedCount = result.deleted.length;
      setAssets((current) => current.filter((asset) => !result.deleted.includes(asset.id)));
      if (deletedCount) emitLibraryChanged();
      setSelectedIds((current) => current.filter((id) => !result.deleted.includes(id)));
      setSelected((current) => current && result.deleted.includes(current.id) ? null : current);
      if (result.failed && Object.keys(result.failed).length) {
        setDeleteFeedback(`${deletedCount} item${deletedCount === 1 ? "" : "s"} deleted. ${Object.keys(result.failed).length} could not be deleted. ${Object.values(result.failed)[0]}`);
      } else {
        setDeleteFeedback(`${deletedCount} media item${deletedCount === 1 ? "" : "s"} deleted`);
      }
      setDeleteDialogOpen(false);
    } catch (cause) {
      setDeleteFeedback(`Could not delete the selected media. ${readableError(cause)}`);
    } finally { setDeleting(false); }
  };

  return <div className="page library-page">
    <PageHeader title="Personal Media Library" description="Organise reusable and project media in local business folders. Folders group content; they are not access boundaries." actions={<Button variant="primary" onClick={() => setShowImport(!showImport)}><ImagePlus size={15} /> Import asset</Button>} />
    {error && <div className="library-error" role="alert"><div><strong>{error}</strong><span>{health ? `Engine: ${health.status}` : "Engine status unavailable"}</span></div><Button onClick={() => void load(false)}><RefreshCw size={14} /> Retry</Button></div>}
    {showImport && <ImportPanel folders={folders} defaultFolderId={folderId || undefined} onDone={() => { setShowImport(false); emitLibraryChanged(); void load(false); }} />}

    <div className="library-layout">
      <aside className="library-sidebar panel" aria-label="Folders and policy filters"><strong>Folders</strong><button className={!folderId && !policy ? "active" : ""} onClick={() => { setFolderId(null); setPolicy(null); }}><Library size={15} /><span className="library-control-label">All media</span><span>{assets.length}</span></button>
        <FolderTree folders={folders} assets={assets} selectedId={folderId} onSelect={(id) => { setFolderId(id); setPolicy(null); }} onAdd={addFolder} onRename={rename} onMove={move} onArchive={archive} onRemove={remove} />
        <Button variant="ghost" onClick={() => addFolder()}><FolderPlus size={14} /> New business folder</Button>
        <label className="archived-toggle"><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} /> Show archived</label>
        <strong>Policy</strong>{["required", "prefer", "neutral", "never"].map((item) => <button key={item} className={policy === item ? "active" : ""} onClick={() => setPolicy(policy === item ? null : item)}><ShieldCheck size={14} /><span className="library-control-label">{item === "prefer" ? "Preferred" : item[0].toUpperCase() + item.slice(1)}</span><span>{assets.filter((asset) => asset.policy === item).length}</span></button>)}
      </aside>

      <section className="library-centre panel"><div className="library-toolbar"><div className="search-box"><Search size={15} /><input aria-label="Search media" placeholder="Search titles, tags, people, brands…" value={query} onChange={(event) => setQuery(event.target.value)} /></div><select aria-label="Media type" value={mediaType} onChange={(event) => setMediaType(event.target.value)}><option value="all">All media</option><option value="image">Images</option><option value="video">Video</option><option value="audio">Audio</option></select><select aria-label="Asset origin" value={origin} onChange={(event) => setOrigin(event.target.value as AssetOrigin | "all")}><option value="all">All origins</option><option value="project-source">Sources</option><option value="generated-clip">Generated clips</option><option value="script-output">Legacy outputs</option><option value="manual-import">Manual imports</option></select><Button className="seo-titles-button" data-testid="suggest-seo-titles" disabled={suggestingTitles} aria-busy={suggestingTitles || undefined} onClick={() => void suggestTitles()}><Sparkles size={14} aria-hidden="true" /> {suggestingTitles ? "Writing titles…" : selectedIds.length ? `Suggest SEO titles (${selectedIds.length})` : "Suggest SEO titles"}</Button></div>
        {selectedIds.length > 0 && <div className="bulk-bar"><strong>{selectedIds.length} selected</strong><select aria-label="Move selected assets" defaultValue="" onChange={(event) => { if (event.target.value) void moveSelected(event.target.value); }}><option value="" disabled>Move to…</option>{folders.filter((folder) => !folder.archived).map((folder) => <option value={folder.id} key={folder.id}>{folder.name}</option>)}</select><Button variant="danger" data-delete-selected="true" disabled={deleting} onClick={() => setDeleteDialogOpen(true)}><Trash2 size={15} aria-hidden="true" /> Delete</Button></div>}
        {deleteFeedback && <div className="library-feedback" role="status">{deleteFeedback}</div>}
        {titleError && <p className="form-error library-title-error" role="alert">{titleError}</p>}
        {titleFeedback && <div className="library-feedback" role="status" data-testid="seo-title-feedback">{titleFeedback.message}{titleFeedback.reasons.length > 0 && <ul className="seo-title-conflicts">{titleFeedback.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}</div>}
        {visibleAssets.length ? <><div className="asset-grid">{pagedAssets.map((asset) => <LibraryAssetCard key={asset.id} asset={asset} isSelected={selectedIds.includes(asset.id)} isInspected={selected?.id === asset.id} onPreview={openPreview} onInspect={setSelected} onToggleSelected={(assetId, checked) => setSelectedIds((current) => checked ? [...current, assetId] : current.filter((id) => id !== assetId))} />)}</div>
          {remainingAssets > 0 && <button className="show-all-projects" onClick={() => setAssetLimit((value) => value + ASSET_PAGE)}>Show {Math.min(ASSET_PAGE, remainingAssets)} more of {visibleAssets.length}</button>}</>
          : loading && !assets.length ? <EmptyState icon={<Library size={30} />} title="Opening your Library">Reading local media from the engine…</EmptyState>
            : assets.length
              ? <EmptyState icon={<Search size={30} />} title="No media matches these filters" action={<Button onClick={clearFilters}>Clear filters</Button>}>No asset in this Library matches the current folder, search, and media-type filters. Existing media remains safely stored.</EmptyState>
              : <EmptyState icon={<Library size={30} />} title="Build your private resolver" action={<Button variant="primary" onClick={() => setShowImport(true)}><Upload size={15} /> Import first asset</Button>}>Your Library has no assets yet. Import a video, image, or audio file to start the private, local media set that deterministic matching draws on.</EmptyState>}
        <p className="loading-note" role="status">{loading ? "Refreshing local media…" : visibleAssets.length ? `Showing ${pagedAssets.length} of ${visibleAssets.length} assets` : ""}</p>
      </section>

      <aside className="asset-inspector panel" aria-label="Rule Inspector"><div className="panel-title"><strong>Rule Inspector</strong>{selected && <span>{formatAge(selected.createdAt)}</span>}</div>{selected ? <div className="asset-fields">
        <FieldGroup title="Identity" headingLevel={2}>
          <Field label="Title"><input value={selected.title} onChange={(event) => setSelected({ ...selected, title: event.target.value })} onBlur={() => saveIfChanged("title")} /></Field>
          <Field label="Filename"><input readOnly value={selected.filename} /></Field>
          <Field label="Description"><textarea value={selected.description} onChange={(event) => setSelected({ ...selected, description: event.target.value })} onBlur={() => saveIfChanged("description")} rows={4} aria-label="Full description" /></Field>
          <Field label="Policy" hint="Controls whether this asset may be chosen automatically."><select value={selected.policy} onChange={(event) => saveSelected({ policy: event.target.value })}><option value="required">Required</option><option value="prefer">Prefer</option><option value="neutral">Neutral</option><option value="never">Never</option></select></Field>
        </FieldGroup>
        <FieldGroup title="Matching" headingLevel={2}>
          <Field label="Trigger phrases"><input value={selected.triggers.join(", ")} onChange={(event) => setSelected({ ...selected, triggers: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })} onBlur={() => saveSelected({ triggers: selected.triggers })} /></Field>
          <Field label="Tags"><input value={selected.tags.join(", ")} onChange={(event) => setSelected({ ...selected, tags: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })} onBlur={() => saveSelected({ tags: selected.tags })} /></Field>
          <Field label="Brands"><input value={selected.brands.join(", ")} onChange={(event) => setSelected({ ...selected, brands: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })} onBlur={() => saveSelected({ brands: selected.brands })} /></Field>
          <Field label="People"><input value={selected.people.join(", ")} onChange={(event) => setSelected({ ...selected, people: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })} onBlur={() => saveSelected({ people: selected.people })} /></Field>
        </FieldGroup>
        <FieldGroup title="Usage limits" columns={2} headingLevel={2}>
          <Field label="Min spacing (s)"><input type="number" min={0} value={selected.minSpacingSeconds} onChange={(event) => saveSelected({ minSpacingSeconds: Number(event.target.value) })} /></Field>
          <Field label="Max uses"><input type="number" min={1} value={selected.maxUsesPerProject} onChange={(event) => saveSelected({ maxUsesPerProject: Number(event.target.value) })} /></Field>
        </FieldGroup>
        <FieldGroup title="Rights" headingLevel={2}>
          <Field label="Licence"><input value={selected.licence} onChange={(event) => setSelected({ ...selected, licence: event.target.value })} onBlur={() => saveSelected({ licence: selected.licence })} /></Field>
          <label className="check-row"><input type="checkbox" checked={selected.protected} onChange={(event) => saveSelected({ protected: event.target.checked })} /><span><strong>Protected / pinned</strong><small>Prevents accidental removal and marks campaign media.</small></span></label>
        </FieldGroup>
        <Button variant="ghost" className="asset-remove" disabled={selected.protected} onClick={() => void removeSelectedAsset()}>Remove Library record</Button>
      </div> : <p className="muted inspector-empty">Select an asset to edit its deterministic matching rules.</p>}</aside>
    </div>

    {titleSuggestions && <SeoTitleReviewDialog result={titleSuggestions} applying={applyingTitles} error={titleApplyError} onCancel={closeTitleReview} onApply={(items) => void applyTitles(items)} />}
    {previewAsset && <VideoPreviewDialog asset={previewAsset} opener={previewOpener} onClose={closePreview} />}
    {deleteDialogOpen && selectedIds.length > 0 && <DeleteConfirmationDialog count={selectedIds.length} projectLinked={selectedIds.some((assetId) => assets.find((asset) => asset.id === assetId)?.sourceProjectId)} deleting={deleting} onCancel={() => { setDeleteDialogOpen(false); queueMicrotask(() => document.querySelector<HTMLButtonElement>('[data-delete-selected="true"]')?.focus()); }} onConfirm={() => void confirmDelete()} />}

  </div>;
}

function DeleteConfirmationDialog({ count, projectLinked, deleting, onCancel, onConfirm }: { count: number; projectLinked: boolean; deleting: boolean; onCancel: () => void; onConfirm: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialogRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); if (!deleting) onCancel(); return; }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled])')];
      if (!focusable.length) return;
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [deleting, onCancel]);
  const title = count === 1 ? "Delete selected media?" : `Delete ${count} media items?`;
  const message = count === 1 ? "This will permanently delete the selected media item. This action cannot be undone." : `This will permanently delete these ${count} media items. This action cannot be undone.`;
  const projectHistoryNote = projectLinked ? " This removes the Library item only. Its project and job history will remain." : "";
  return <div className="dialog-backdrop"><div ref={dialogRef} className="confirmation-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-dialog-title" aria-describedby="delete-dialog-message">
    <h2 id="delete-dialog-title">{title}</h2><p id="delete-dialog-message">{message}{projectHistoryNote}</p>
    <div className="dialog-actions"><Button disabled={deleting} onClick={onCancel}>Cancel</Button><Button variant="danger" disabled={deleting} onClick={onConfirm}><Trash2 size={15} aria-hidden="true" />{deleting ? "Deleting…" : count === 1 ? "Delete media" : `Delete ${count} items`}</Button></div>
  </div></div>;
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
  const descriptionOnCard = asset.origin === "generated-clip" && asset.description.trim().length > 0;
  const secondaryLine = descriptionOnCard ? asset.description : asset.tags.slice(0, 3).join(" · ") || asset.filename;
  const details = <div className="asset-card-details-content" aria-hidden="true"><strong title={asset.title}>{asset.title}</strong><span className={descriptionOnCard ? "asset-card-description" : undefined} title={descriptionOnCard ? undefined : secondaryLine}>{secondaryLine}</span><span className="origin-badge">{originLabels[asset.origin]}</span><StatusBadge state={asset.policy === "never" ? "failed" : asset.policy === "required" ? "fallback" : "local"} label={asset.policy} /></div>;

  return <article className={`asset-card ${isInspected ? "active" : ""}`} data-asset-id={asset.id}>
    <label className="asset-select"><input aria-label={`Select ${asset.title}`} type="checkbox" checked={isSelected} onChange={handleToggleSelected} /></label>
    {canPreview ? <>
      <button className="asset-preview-trigger" aria-label={`Preview ${asset.title}`} type="button" onClick={handlePreview}><AssetPreview key={asset.blobId} asset={asset} /></button>
      <button className="asset-card-details" aria-label={`Select ${asset.title} for Rule Inspector`} type="button" onClick={handleInspect}>{details}</button>
    </> : <button className="asset-card-details asset-card-details-full" aria-label={`Select ${asset.title} for Rule Inspector`} type="button" onClick={handleInspect}><AssetPreview key={asset.blobId} asset={asset} />{details}</button>}
  </article>;
}

function AssetPreview({ asset }: { asset: LibraryAsset }) {
  const [unavailable, setUnavailable] = useState(false);
  if (asset.mediaType.startsWith("video/") && asset.thumbnailUrl && !unavailable) {
    return <LazyVideoThumbnail key={asset.blobId} className="asset-preview" thumbnailSrc={asset.thumbnailUrl} label={`${asset.title} thumbnail`} onRenew={() => renewAssetThumbnail(asset.id)} onError={() => setUnavailable(true)} />;
  }
  return <div className="asset-preview" role={unavailable ? "status" : undefined}><FileImage size={29} /><span>{unavailable || asset.mediaType.startsWith("video/") ? "Thumbnail unavailable" : asset.mediaType.split("/")[1]?.toUpperCase() || "MEDIA"}</span>{asset.protected && <ShieldCheck size={14} />}</div>;
}

function FolderTree({ folders, assets, selectedId, onSelect, onAdd, onRename, onMove, onArchive, onRemove }: { folders: LibraryFolder[]; assets: LibraryAsset[]; selectedId: string | null; onSelect: (id: string) => void; onAdd: (parentId: string) => void; onRename: (folder: LibraryFolder) => void; onMove: (folder: LibraryFolder) => void; onArchive: (folder: LibraryFolder) => void; onRemove: (folder: LibraryFolder) => void }) {
  const render = (parentId: string | null, depth = 0) => folders.filter((folder) => (folder.parentId || null) === parentId).map((folder) => {
    const hasChildren = folders.some((item) => item.parentId === folder.id);
    return <div key={folder.id} className="folder-node"><button role="treeitem" aria-selected={selectedId === folder.id} aria-level={depth + 1} aria-expanded={hasChildren ? true : undefined} tabIndex={selectedId === folder.id || (!selectedId && folder.system) ? 0 : -1} className={selectedId === folder.id ? "active" : ""} onClick={() => onSelect(folder.id)}><Folder size={14} /><span className="folder-name">{folder.name}</span><span>{assets.filter((asset) => asset.folderId === folder.id).length}</span></button>{!folder.system && <div className="folder-actions"><button aria-label={`Add subfolder to ${folder.name}`} onClick={() => onAdd(folder.id)}>+</button><button aria-label={`Rename ${folder.name}`} onClick={() => onRename(folder)}>Rename</button><button aria-label={`Move ${folder.name}`} onClick={() => onMove(folder)}>Move</button><button aria-label={`${folder.archived ? "Restore" : "Archive"} ${folder.name}`} onClick={() => onArchive(folder)}><Archive size={11} /></button><button aria-label={`Remove ${folder.name}`} onClick={() => onRemove(folder)}>×</button></div>}{hasChildren && <div role="group">{render(folder.id, depth + 1)}</div>}</div>;
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
