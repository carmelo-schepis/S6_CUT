import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { Archive, FileImage, Folder, FolderPlus, ImagePlus, Library, MoreHorizontal, RefreshCw, Search, ShieldCheck, Sparkles, Star, Trash2, Upload } from "lucide-react";
import { applyLibraryTitles, archiveFolder, createFolder, deleteAssets, getHealth, listAssets, listFolders, moveAssets, moveFolder, readableError, removeFolder, renewAssetThumbnail, suggestLibraryTitles, updateAsset, updateFolder, uploadAsset } from "../api";
import { bindRevalidationOnFocus, createBoundedRevalidation, emitLibraryChanged, onLibraryChanged } from "../library-sync";
import type { AssetOrigin, Health, LibraryAsset, LibraryFolder, TitleApplyItem, TitleSuggestionResponse } from "../types";
import { Button, EmptyState, Field, FieldGroup, PageHeader, StatusBadge, formatAge } from "./common";
import { LazyVideoThumbnail } from "./lazy-video-thumbnail";
import { SeoTitleReviewDialog } from "./seo-title-review";
import { VideoPreviewDialog } from "./video-preview-dialog";

const originLabels = { "manual-import": "Manual", "project-source": "Source", "generated-clip": "Generated clip", "script-output": "Legacy output" } as const;
const sleep = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));
const focusIsInAssetMenu = (target: EventTarget | null) => target instanceof Element && !!target.closest(".asset-actions, .library-asset-menu, .library-preview-actions");

// A full library mounted every card at once — 329 assets meant 332 concurrent
// <video> elements and a ~15,000px page. Render a page at a time instead.
const ASSET_PAGE = 60;

export function LibraryView({ selectedAssetId }: { selectedAssetId?: string | null } = {}) {
  const [assets, setAssets] = useState<LibraryAsset[]>([]);
  const [folders, setFolders] = useState<LibraryFolder[]>([]);
  const [inspectedAssetId, setInspectedAssetId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Record<string, unknown>>>({});
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
  const [previewActionError, setPreviewActionError] = useState<string | null>(null);
  const [previewOpener, setPreviewOpener] = useState<HTMLButtonElement | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteTargetIds, setDeleteTargetIds] = useState<string[]>([]);
  const [deleteOpener, setDeleteOpener] = useState<HTMLElement | null>(null);
  const [assetMenu, setAssetMenu] = useState<{ id: string; x: number; y: number; opener: HTMLElement } | null>(null);
  const assetMenuOpen = useRef(false);
  const contextPressPending = useRef(false);
  const menuFilterKey = useRef("");
  const pendingStarFocus = useRef<{ opener: HTMLElement; cardIndex: number; activeAtStart: Element | null } | null>(null);
  const [pendingStars, setPendingStars] = useState<string[]>([]);
  const [announcement, setAnnouncement] = useState("");
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
  const loadLatest = useRef<((retry?: boolean) => Promise<void>) | null>(null);
  const refreshAfterFlight = useRef(false);
  const mutationRevision = useRef(0);
  const initialLoadComplete = useRef(false);
  const appliedDeepLink = useRef<string | null>(null);

  const load = useCallback((retry = true) => {
    if (loadFlight.current) return loadFlight.current;
    const request = async () => {
      const startedAtRevision = mutationRevision.current;
      setLoading(true);
      for (let attempt = 0; attempt < (retry ? 3 : 1); attempt += 1) {
        try {
          const [nextAssets, nextFolders] = await Promise.all([listAssets({ includeArchived: showArchived || Boolean(selectedAssetId) }), listFolders({ includeArchived: showArchived || Boolean(selectedAssetId) })]);
          if (startedAtRevision !== mutationRevision.current) { refreshAfterFlight.current = true; return; }
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
          setSelectedIds((current) => current.filter((id) => nextAssets.some((asset) => asset.id === id)));
          setAssetMenu((current) => current && !nextAssets.some((asset) => asset.id === current.id) ? null : current);
          const selectedIndex = [...nextAssets.filter((asset) => asset.mediaType.startsWith("video/") && asset.starred), ...nextAssets.filter((asset) => !(asset.mediaType.startsWith("video/") && asset.starred))].findIndex((asset) => asset.id === selectedAssetId);
          if (selectedIndex >= 0) setAssetLimit((current) => Math.max(current, Math.ceil((selectedIndex + 1) / ASSET_PAGE) * ASSET_PAGE));
          setInspectedAssetId((current) => current && nextAssets.some((asset) => asset.id === current) ? current : current ? null : nextAssets[0]?.id || null);
          return;
        } catch {
          if (attempt < 2 && retry) await sleep(300 * 2 ** attempt);
        }
      }
      // Keep the last successful cards on screen while a transient request fails.
      setError("Could not reach the local S6 Cut media library.");
      void getHealth().then(setHealth).catch(() => setHealth(null));
    };
    const flight = request().finally(() => {
      setLoading(false); initialLoadComplete.current = true; loadFlight.current = null;
      if (refreshAfterFlight.current) { refreshAfterFlight.current = false; window.setTimeout(() => { if (loadLatest.current) void loadLatest.current(false); }, 0); }
    });
    loadFlight.current = flight;
    return flight;
  }, [showArchived, selectedAssetId]);

  useEffect(() => { loadLatest.current = load; }, [load]);
  useEffect(() => {
    if (!selectedAssetId) { appliedDeepLink.current = null; return; }
    if (appliedDeepLink.current === selectedAssetId || !assets.some((asset) => asset.id === selectedAssetId)) return;
    appliedDeepLink.current = selectedAssetId;
    setInspectedAssetId(selectedAssetId);
  }, [selectedAssetId, assets]);
  useEffect(() => { if (!assetMenu) assetMenuOpen.current = false; }, [assetMenu]);

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

  const visibleAssets = useMemo(() => {
    const filtered = assets.filter((asset) => {
      const terms = [asset.title, asset.filename, ...asset.tags, ...asset.brands, ...asset.people].join(" ").toLowerCase();
      return (!folderId || asset.folderId === folderId) && (!policy || asset.policy === policy) &&
        (origin === "all" || asset.origin === origin) &&
        (mediaType === "all" || asset.mediaType.startsWith(`${mediaType}/`)) && (!query.trim() || terms.includes(query.trim().toLowerCase()));
    });
    return [...filtered.filter((asset) => asset.mediaType.startsWith("video/") && asset.starred), ...filtered.filter((asset) => !(asset.mediaType.startsWith("video/") && asset.starred))];
  }, [assets, folderId, mediaType, origin, policy, query]);
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

  const selected = assets.find((asset) => asset.id === inspectedAssetId) || null;
  const inspector = selected ? { ...selected, ...(drafts[selected.id] || {}) } as LibraryAsset : null;
  const previewCurrent = previewAsset ? assets.find((asset) => asset.id === previewAsset.id) || previewAsset : null;
  const previewActionPending = previewCurrent ? pendingStars.includes(previewCurrent.id) : false;
  const updateDraft = (field: string, value: unknown) => {
    if (!inspectedAssetId) return;
    setDrafts((current) => ({ ...current, [inspectedAssetId]: { ...current[inspectedAssetId], [field]: value } }));
  };
  const saveSelectedField = async (field: string) => {
    if (!selected || !Object.hasOwn(drafts[selected.id] || {}, field)) return;
    const id = selected.id;
    const submitted = drafts[id][field];
    try {
      const next = await updateAsset(id, { [field]: submitted });
      mutationRevision.current += 1;
      setAssets((current) => current.map((asset) => asset.id === id ? { ...asset, ...next } : asset));
      setDrafts((current) => {
        const draft = current[id];
        if (!draft || !Object.is(draft[field], submitted)) return current;
        const remaining = { ...draft }; delete remaining[field];
        const result = { ...current };
        if (Object.keys(remaining).length) result[id] = remaining; else delete result[id];
        return result;
      });
      emitLibraryChanged();
    } catch (cause) { setError(readableError(cause)); }
  };
  const removeSelectedAsset = (asset: LibraryAsset, opener: HTMLElement) => {
    if (asset.protected) return;
    setDeleteTargetIds([asset.id]); setDeleteOpener(opener); setDeleteFeedback(null); setDeleteDialogOpen(true);
  };
  const openAssetMenu = (asset: LibraryAsset, x: number, y: number, opener: HTMLElement) => {
    if (!asset.mediaType.startsWith("video/")) return;
    assetMenuOpen.current = true;
    setAssetMenu({ id: asset.id, x, y, opener });
  };
  const closeAssetMenu = useCallback((restore = true) => {
    const opener = assetMenu?.opener;
    assetMenuOpen.current = false; setAssetMenu(null);
    if (restore) queueMicrotask(() => opener?.focus());
  }, [assetMenu]);
  const menuAsset = assetMenu ? assets.find((asset) => asset.id === assetMenu.id) : undefined;
  const starAsset = async (asset: LibraryAsset) => {
    if (pendingStars.includes(asset.id)) return;
    const opener = assetMenu?.opener;
    const card = opener?.closest<HTMLElement>(".asset-card");
    pendingStarFocus.current = opener && card ? { opener, cardIndex: [...document.querySelectorAll(".asset-card")].indexOf(card), activeAtStart: document.activeElement } : null;
    setPreviewActionError(null);
    setPendingStars((current) => [...current, asset.id]); closeAssetMenu(false);
    try {
      const next = await updateAsset(asset.id, { starred: !asset.starred });
      mutationRevision.current += 1;
      setAssets((current) => current.map((item) => item.id === next.id ? { ...item, ...next, previewUrl: item.blobId === next.blobId ? item.previewUrl || next.previewUrl : next.previewUrl } : item));
      setAnnouncement(next.starred ? `${next.title} starred` : `${next.title} unstarred`);
      emitLibraryChanged();
    } catch (cause) {
      pendingStarFocus.current = null;
      const message = `Could not update star. ${readableError(cause)}`;
      if (previewAsset?.id === asset.id) setPreviewActionError(message); else setError(message);
    }
    finally { setPendingStars((current) => current.filter((id) => id !== asset.id)); }
  };
  useEffect(() => {
    const pending = pendingStarFocus.current;
    if (!pending) return;
    pendingStarFocus.current = null;
    requestAnimationFrame(() => {
      if (pending.activeAtStart !== document.activeElement && document.activeElement !== document.body && !document.activeElement?.closest(".library-asset-menu")) return;
      if (pending.opener.isConnected) { pending.opener.focus(); return; }
      const cards = [...document.querySelectorAll<HTMLElement>(".asset-card")];
      const neighbor = cards[Math.min(pending.cardIndex, cards.length - 1)] || cards[Math.max(0, pending.cardIndex - 1)];
      const action = neighbor?.querySelector<HTMLElement>(".asset-actions");
      if (action) action.focus(); else document.querySelector<HTMLInputElement>('[aria-label="Search media"]')?.focus();
    });
  }, [assets, pagedAssets]);
  const beginContextDelete = (asset: LibraryAsset) => {
    closeAssetMenu(false); setDeleteTargetIds([asset.id]); setDeleteOpener(assetMenu?.opener || null); setDeleteFeedback(null); setDeleteDialogOpen(true);
  };
  useEffect(() => {
    if (!assetMenu) return;
    const dismiss = () => closeAssetMenu(false);
    const outside = (event: globalThis.PointerEvent) => { if (!(event.target as Element | null)?.closest(".library-asset-menu")) dismiss(); };
    window.addEventListener("scroll", dismiss, true); window.addEventListener("resize", dismiss); document.addEventListener("pointerdown", outside);
    return () => { window.removeEventListener("scroll", dismiss, true); window.removeEventListener("resize", dismiss); document.removeEventListener("pointerdown", outside); };
  }, [assetMenu, closeAssetMenu]);
  useEffect(() => { if (menuFilterKey.current && menuFilterKey.current !== filterKey) closeAssetMenu(false); menuFilterKey.current = filterKey; }, [filterKey, closeAssetMenu]);
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
    setInspectedAssetId(asset.id);
    setPreviewActionError(null);
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
    if (deleting || !deleteTargetIds.length) return;
    const ids = [...deleteTargetIds];
    setDeleting(true); setDeleteFeedback(null);
    try {
      const result = await deleteAssets(ids);
      const deletedCount = result.deleted.length;
      setAssets((current) => current.filter((asset) => !result.deleted.includes(asset.id)));
      if (deletedCount) emitLibraryChanged();
      setSelectedIds((current) => current.filter((id) => !result.deleted.includes(id)));
      setInspectedAssetId((current) => current && result.deleted.includes(current) ? null : current);
      if (previewAsset && result.deleted.includes(previewAsset.id)) setPreviewAsset(null);
      if (result.failed && Object.keys(result.failed).length) {
        setDeleteFeedback(`${deletedCount} item${deletedCount === 1 ? "" : "s"} deleted. ${Object.keys(result.failed).length} could not be deleted. ${Object.values(result.failed)[0]}`);
      } else {
        setDeleteFeedback(`${deletedCount} media item${deletedCount === 1 ? "" : "s"} deleted`);
      }
      setDeleteDialogOpen(false); setDeleteTargetIds([]);
      if (deletedCount) void load(false);
    } catch (cause) {
      setDeleteFeedback(`Could not delete the selected media. ${readableError(cause)}`);
      void load(false);
    } finally { setDeleting(false); }
  };

  return <div className="page library-page">
    <PageHeader title="Library" actions={<Button variant="primary" onClick={() => setShowImport(!showImport)}><ImagePlus size={15} /> Import asset</Button>} />
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
        {selectedIds.length > 0 && <div className="bulk-bar"><strong>{selectedIds.length} selected</strong><select aria-label="Move selected assets" defaultValue="" onChange={(event) => { if (event.target.value) void moveSelected(event.target.value); }}><option value="" disabled>Move to…</option>{folders.filter((folder) => !folder.archived).map((folder) => <option value={folder.id} key={folder.id}>{folder.name}</option>)}</select><Button variant="danger" data-delete-selected="true" disabled={deleting} onClick={(event) => { setDeleteTargetIds([...selectedIds]); setDeleteOpener(event.currentTarget); setDeleteFeedback(null); setDeleteDialogOpen(true); }}><Trash2 size={15} aria-hidden="true" /> Delete</Button></div>}
        {deleteFeedback && <div className="library-feedback" role="status">{deleteFeedback}</div>}
        {titleError && <p className="form-error library-title-error" role="alert">{titleError}</p>}
        {titleFeedback && <div className="library-feedback" role="status" data-testid="seo-title-feedback">{titleFeedback.message}{titleFeedback.reasons.length > 0 && <ul className="seo-title-conflicts">{titleFeedback.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}</div>}
        {announcement && <span className="sr-only" role="status">{announcement}</span>}
        {visibleAssets.length ? <><div className="asset-grid">{pagedAssets.map((asset) => <LibraryAssetCard key={asset.id} asset={asset} isSelected={selectedIds.includes(asset.id)} isInspected={inspectedAssetId === asset.id} onPreview={openPreview} onInspect={openPreview} onToggleSelected={(assetId, checked) => setSelectedIds((current) => checked ? [...current, assetId] : current.filter((id) => id !== assetId))} onRightMouseDown={(event) => {
          if (!asset.mediaType.startsWith("video/") || event.button !== 2) return;
          assetMenuOpen.current = true; contextPressPending.current = true;
          window.setTimeout(() => { if (!contextPressPending.current) return; contextPressPending.current = false; if (!document.querySelector(".library-asset-menu")) assetMenuOpen.current = false; }, 0);
        }} onContextMenu={(event) => { contextPressPending.current = false; if (!asset.mediaType.startsWith("video/")) return; event.preventDefault(); openAssetMenu(asset, event.clientX, event.clientY, event.currentTarget); }} onActions={(event) => { const rect = event.currentTarget.getBoundingClientRect(); openAssetMenu(asset, rect.left, rect.bottom, event.currentTarget); }} />)}</div>
          {remainingAssets > 0 && <button className="show-all-projects" onClick={() => setAssetLimit((value) => value + ASSET_PAGE)}>Show {Math.min(ASSET_PAGE, remainingAssets)} more of {visibleAssets.length}</button>}</>
          : loading && !assets.length ? <EmptyState icon={<Library size={30} />} title="Opening your Library">Reading local media from the engine…</EmptyState>
            : assets.length
              ? <EmptyState icon={<Search size={30} />} title="No media matches these filters" action={<Button onClick={clearFilters}>Clear filters</Button>}>No asset in this Library matches the current folder, search, and media-type filters. Existing media remains safely stored.</EmptyState>
              : <EmptyState icon={<Library size={30} />} title="Build your private resolver" action={<Button variant="primary" onClick={() => setShowImport(true)}><Upload size={15} /> Import first asset</Button>}>Your Library has no assets yet. Import a video, image, or audio file to start the private, local media set that deterministic matching draws on.</EmptyState>}
        <p className="loading-note" role="status">{loading ? "Refreshing local media…" : visibleAssets.length ? `Showing ${pagedAssets.length} of ${visibleAssets.length} assets` : ""}</p>
      </section>
    </div>

    {titleSuggestions && <SeoTitleReviewDialog result={titleSuggestions} applying={applyingTitles} error={titleApplyError} onCancel={closeTitleReview} onApply={(items) => void applyTitles(items)} />}
    {previewAsset && previewCurrent && <VideoPreviewDialog asset={previewCurrent} opener={previewOpener} onClose={closePreview}>
      <aside className="asset-inspector panel" aria-label="Rule Inspector"><div className="library-inspector-header"><div className="panel-title"><strong>Rule Inspector</strong>{inspector && <span>{formatAge(inspector.createdAt)}</span>}</div><div className="library-preview-actions" aria-label="Video actions">
        {previewCurrent.mediaType.startsWith("video/") && <Button variant="ghost" aria-disabled={previewActionPending || undefined} aria-busy={previewActionPending || undefined} aria-label={previewCurrent.starred ? "Undo star" : "Star"} onClick={() => void starAsset(previewCurrent)}><Star size={15} aria-hidden="true" fill={previewCurrent.starred ? "currentColor" : "none"} />{previewActionPending ? "Saving…" : previewCurrent.starred ? "Undo star" : "Star"}</Button>}
        <Button variant="danger" disabled={previewCurrent.protected} aria-label={previewCurrent.protected ? "Remove Library record (protected media cannot be removed)" : "Remove Library record"} title={previewCurrent.protected ? "Protected media cannot be removed" : undefined} onClick={(event) => removeSelectedAsset(previewCurrent, event.currentTarget)}><Trash2 size={15} aria-hidden="true" />Remove</Button>
      </div></div>{previewActionError && <p className="library-preview-action-error" role="alert">{previewActionError}</p>}{inspector ? <div className="asset-fields">
        <FieldGroup title="Identity" headingLevel={2}>
          <Field label="Title"><input value={inspector.title} onChange={(event) => updateDraft("title", event.target.value)} onBlur={(event) => { if (!assetMenuOpen.current && !focusIsInAssetMenu(event.relatedTarget)) void saveSelectedField("title"); }} /></Field>
          <Field label="Filename"><input readOnly value={inspector.filename} /></Field>
          <Field label="Description"><textarea value={inspector.description} onChange={(event) => updateDraft("description", event.target.value)} onBlur={(event) => { if (!assetMenuOpen.current && !focusIsInAssetMenu(event.relatedTarget)) void saveSelectedField("description"); }} rows={4} aria-label="Full description" /></Field>
          <Field label="Policy" hint="Controls whether this asset may be chosen automatically."><select value={inspector.policy} onChange={(event) => updateDraft("policy", event.target.value)} onBlur={(event) => { if (!focusIsInAssetMenu(event.relatedTarget)) void saveSelectedField("policy"); }}><option value="required">Required</option><option value="prefer">Prefer</option><option value="neutral">Neutral</option><option value="never">Never</option></select></Field>
        </FieldGroup>
        <FieldGroup title="Matching" headingLevel={2}>
          <Field label="Trigger phrases"><input value={inspector.triggers.join(", ")} onChange={(event) => updateDraft("triggers", event.target.value.split(",").map((item) => item.trim()).filter(Boolean))} onBlur={(event) => { if (!assetMenuOpen.current && !focusIsInAssetMenu(event.relatedTarget)) void saveSelectedField("triggers"); }} /></Field>
          <Field label="Tags"><input value={inspector.tags.join(", ")} onChange={(event) => updateDraft("tags", event.target.value.split(",").map((item) => item.trim()).filter(Boolean))} onBlur={(event) => { if (!assetMenuOpen.current && !focusIsInAssetMenu(event.relatedTarget)) void saveSelectedField("tags"); }} /></Field>
          <Field label="Brands"><input value={inspector.brands.join(", ")} onChange={(event) => updateDraft("brands", event.target.value.split(",").map((item) => item.trim()).filter(Boolean))} onBlur={(event) => { if (!assetMenuOpen.current && !focusIsInAssetMenu(event.relatedTarget)) void saveSelectedField("brands"); }} /></Field>
          <Field label="People"><input value={inspector.people.join(", ")} onChange={(event) => updateDraft("people", event.target.value.split(",").map((item) => item.trim()).filter(Boolean))} onBlur={(event) => { if (!assetMenuOpen.current && !focusIsInAssetMenu(event.relatedTarget)) void saveSelectedField("people"); }} /></Field>
        </FieldGroup>
        <FieldGroup title="Usage limits" columns={2} headingLevel={2}>
          <Field label="Min spacing (s)"><input type="number" min={0} value={inspector.minSpacingSeconds} onChange={(event) => updateDraft("minSpacingSeconds", Number(event.target.value))} onBlur={(event) => { if (!focusIsInAssetMenu(event.relatedTarget)) void saveSelectedField("minSpacingSeconds"); }} /></Field>
          <Field label="Max uses"><input type="number" min={1} value={inspector.maxUsesPerProject} onChange={(event) => updateDraft("maxUsesPerProject", Number(event.target.value))} onBlur={(event) => { if (!focusIsInAssetMenu(event.relatedTarget)) void saveSelectedField("maxUsesPerProject"); }} /></Field>
        </FieldGroup>
        <FieldGroup title="Rights" headingLevel={2}>
          <Field label="Licence"><input value={inspector.licence} onChange={(event) => updateDraft("licence", event.target.value)} onBlur={(event) => { if (!assetMenuOpen.current && !focusIsInAssetMenu(event.relatedTarget)) void saveSelectedField("licence"); }} /></Field>
          <label className="check-row"><input type="checkbox" checked={inspector.protected} onChange={(event) => updateDraft("protected", event.target.checked)} onBlur={(event) => { if (!focusIsInAssetMenu(event.relatedTarget)) void saveSelectedField("protected"); }} /><span><strong>Protected / pinned</strong><small>Prevents accidental removal and marks campaign media.</small></span></label>
          {inspector.origin === "manual-import" && /^(image|video)\//i.test(inspector.mediaType) && <label className="check-row"><input type="checkbox" aria-label="Eligible for automatic B-roll" checked={Boolean(inspector.videoOverlayEligible)} onChange={(event) => updateDraft("videoOverlayEligible", event.target.checked)} onBlur={(event) => { if (!focusIsInAssetMenu(event.relatedTarget)) void saveSelectedField("videoOverlayEligible"); }} /><span><strong>Eligible for automatic B-roll</strong><small>Required in addition to enabling Library B-roll in a new job.</small></span></label>}
        </FieldGroup>
        {!previewAsset && <Button variant="ghost" className="asset-remove" disabled={inspector.protected} onClick={(event) => removeSelectedAsset(inspector, event.currentTarget)}>Remove Library record</Button>}
      </div> : <p className="muted inspector-empty">Select an asset to edit its deterministic matching rules.</p>}</aside>
    </VideoPreviewDialog>}
    {assetMenu && menuAsset && createPortal(<AssetContextMenu asset={menuAsset} x={assetMenu.x} y={assetMenu.y} pending={pendingStars.includes(menuAsset.id)} onStar={() => void starAsset(menuAsset)} onDelete={() => beginContextDelete(menuAsset)} onClose={(restore) => closeAssetMenu(restore)} />, document.body)}
    {deleteDialogOpen && deleteTargetIds.length > 0 && <DeleteConfirmationDialog layered={Boolean(previewAsset)} count={deleteTargetIds.length} title={deleteTargetIds.length === 1 ? assets.find((asset) => asset.id === deleteTargetIds[0])?.title : undefined} projectSource={deleteTargetIds.some((id) => assets.find((asset) => asset.id === id)?.origin === "project-source" && assets.find((asset) => asset.id === id)?.sourceProjectId)} deleting={deleting} feedback={deleteFeedback} onCancel={() => { setDeleteDialogOpen(false); setDeleteTargetIds([]); requestAnimationFrame(() => deleteOpener?.focus()); }} onConfirm={() => void confirmDelete()} />}

  </div>;
}

function DeleteConfirmationDialog({ count, title, projectSource, deleting, feedback, layered, onCancel, onConfirm }: { count: number; title?: string; projectSource: boolean; deleting: boolean; feedback: string | null; layered?: boolean; onCancel: () => void; onConfirm: () => void }) {
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
  const dialogTitle = count === 1 ? `Delete “${title || "selected media"}”?` : `Delete ${count} media items?`;
  const message = projectSource
    ? "This project source video is required by its project. Deleting it also deletes the project, its job history, and generated media. This action cannot be undone."
    : count === 1 ? "This removes the Library item. Referenced project media and history are retained where applicable." : `This removes these ${count} Library items. Referenced project media and history are retained where applicable.`;
  return <div className={`dialog-backdrop${layered ? " library-delete-backdrop" : ""}`}><div ref={dialogRef} className="confirmation-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-dialog-title" aria-describedby="delete-dialog-message">
    <h2 id="delete-dialog-title">{dialogTitle}</h2><p id="delete-dialog-message">{message}</p>{feedback && <p className="form-error" role="alert">{feedback}</p>}
    <div className="dialog-actions"><Button disabled={deleting} onClick={onCancel}>Cancel</Button><Button variant="danger" disabled={deleting} onClick={onConfirm}><Trash2 size={15} aria-hidden="true" />{deleting ? "Deleting…" : count === 1 ? "Delete media" : `Delete ${count} items`}</Button></div>
  </div></div>;
}

function LibraryAssetCard({ asset, isSelected, isInspected, onPreview, onInspect, onToggleSelected, onRightMouseDown, onContextMenu, onActions }: { asset: LibraryAsset; isSelected: boolean; isInspected: boolean; onPreview: (asset: LibraryAsset, opener: HTMLButtonElement) => void; onInspect: (asset: LibraryAsset, opener: HTMLButtonElement) => void; onToggleSelected: (assetId: string, checked: boolean) => void; onRightMouseDown: (event: MouseEvent<HTMLElement>) => void; onContextMenu: (event: MouseEvent<HTMLElement>) => void; onActions: (event: MouseEvent<HTMLButtonElement>) => void }) {
  const canPreview = asset.mediaType.startsWith("video/") && !!asset.previewUrl;
  const handlePreview = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onPreview(asset, event.currentTarget);
  };
  const handleInspect = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onInspect(asset, event.currentTarget);
  };
  const handleToggleSelected = (event: ChangeEvent<HTMLInputElement>) => {
    event.stopPropagation();
    onToggleSelected(asset.id, event.currentTarget.checked);
  };
  const descriptionOnCard = asset.origin === "generated-clip" && asset.description.trim().length > 0;
  const secondaryLine = descriptionOnCard ? asset.description : asset.tags.slice(0, 3).join(" · ") || asset.filename;
  const details = <div className="asset-card-details-content" aria-hidden="true"><strong title={asset.title}>{asset.title}</strong><span className={descriptionOnCard ? "asset-card-description" : undefined} title={descriptionOnCard ? undefined : secondaryLine}>{secondaryLine}</span><span className="origin-badge">{originLabels[asset.origin]}</span><StatusBadge state={asset.policy === "never" ? "failed" : asset.policy === "required" ? "fallback" : "local"} label={asset.policy} /></div>;

  return <article tabIndex={-1} className={`asset-card ${isInspected ? "active" : ""}`} data-asset-id={asset.id} onMouseDown={onRightMouseDown} onContextMenu={onContextMenu} onKeyDown={(event) => { if (asset.mediaType.startsWith("video/") && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) { event.preventDefault(); event.currentTarget.querySelector<HTMLButtonElement>(".asset-actions")?.click(); } }}>
    <label className="asset-select"><input aria-label={`Select ${asset.title}`} type="checkbox" checked={isSelected} onChange={handleToggleSelected} /></label>
    {asset.mediaType.startsWith("video/") && <button className="asset-actions" type="button" aria-label={`Actions for ${asset.title}`} onClick={onActions}><MoreHorizontal size={16} /></button>}
    {asset.mediaType.startsWith("video/") && asset.starred && <span className="library-star-badge" aria-label="Starred"><Star size={15} fill="currentColor" /></span>}
    {canPreview ? <>
      <button className="asset-preview-trigger" aria-label={`Preview ${asset.title}`} type="button" onClick={handlePreview}><AssetPreview key={asset.blobId} asset={asset} /></button>
      <button className="asset-card-details" aria-label={`Select ${asset.title} for Rule Inspector`} type="button" onClick={handleInspect}>{details}</button>
    </> : <button className="asset-card-details asset-card-details-full" aria-label={`Select ${asset.title} for Rule Inspector`} type="button" onClick={handleInspect}><AssetPreview key={asset.blobId} asset={asset} />{details}</button>}
  </article>;
}

function AssetContextMenu({ asset, x, y, pending, onStar, onDelete, onClose }: { asset: LibraryAsset; x: number; y: number; pending: boolean; onStar: () => void; onDelete: () => void; onClose: (restore?: boolean) => void }) {
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => { const node = menuRef.current; if (!node) return; const rect = node.getBoundingClientRect(); node.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`; node.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`; node.querySelector<HTMLElement>("[role=menuitem]")?.focus(); }, [x, y]);
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>("[role=menuitem]:not([aria-disabled=true]):not([disabled])") || [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
    if (event.key === "Tab") { onClose(false); return; }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) { event.preventDefault(); const target = event.key === "Home" ? items[0] : event.key === "End" ? items.at(-1) : items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]; target?.focus(); }
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); (document.activeElement as HTMLElement)?.click(); }
  };
  return <div ref={menuRef} className="library-asset-menu" role="menu" aria-label={`${asset.title} actions`} onKeyDown={keyDown} style={{ left: x, top: y }}>
    <button role="menuitem" type="button" className="destructive" aria-disabled={asset.protected} aria-label={asset.protected ? "Delete; this asset is protected and cannot be deleted" : "Delete"} title={asset.protected ? "This asset is protected" : undefined} onClick={() => { if (!asset.protected) onDelete(); }}>Delete</button>
    <button role="menuitem" type="button" disabled={pending} onClick={onStar}>{asset.starred ? "Undo star" : "Star"}</button>
  </div>;
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
