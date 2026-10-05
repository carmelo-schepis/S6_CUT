import { useCallback, useEffect, useRef, useState } from "react";
import { Film, FolderOpen, RefreshCw, Search } from "lucide-react";
import { listFolders, listRecentClips, readableError } from "../api";
import { bindRevalidationOnFocus, createBoundedRevalidation, onLibraryChanged } from "../library-sync";
import type { LibraryAsset, LibraryFolder } from "../types";
import { Button, EmptyState } from "./common";
import { LazyVideoThumbnail } from "./lazy-video-thumbnail";
import { VideoPreviewDialog } from "./video-preview-dialog";

const PAGE_SIZE = 12;

function durationLabel(seconds?: number | null) {
  if (seconds == null || !Number.isFinite(seconds)) return "Duration unavailable";
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return minutes ? `${minutes}:${String(remainder).padStart(2, "0")}` : `${remainder}s`;
}

export function RecentClips({ onSelectAsset }: { onSelectAsset: (id: string) => void }) {
  const [items, setItems] = useState<LibraryAsset[]>([]);
  const [folders, setFolders] = useState<LibraryFolder[]>([]);
  const [search, setSearch] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<LibraryAsset | null>(null);
  const [previewOpener, setPreviewOpener] = useState<HTMLButtonElement | null>(null);
  const revision = useRef(0);
  const mounted = useRef(true);
  const searchInitialized = useRef(false);
  const signalRefresh = useRef<() => void>(() => undefined);

  const load = useCallback(async (targetPage = page, query = submittedSearch, refreshSignedUrls = false) => {
    const current = ++revision.current;
    setLoading(true);
    try {
      const [firstResult, nextFolders] = await Promise.all([
        listRecentClips({ search: query, page: targetPage, pageSize: PAGE_SIZE }),
        listFolders({ includeArchived: true }),
      ]);
      if (!mounted.current || current !== revision.current) return;
      let result = firstResult;
      if (!result.items.length && targetPage > 1 && result.total > 0) {
        const lastPage = Math.ceil(result.total / PAGE_SIZE);
        if (lastPage < targetPage) {
          result = await listRecentClips({ search: query, page: lastPage, pageSize: PAGE_SIZE });
          if (!mounted.current || current !== revision.current) return;
        }
      }
      setItems((existing) => {
        const previous = new Map(existing.map((asset) => [asset.id, asset]));
        return result.items.map((asset) => {
          const old = previous.get(asset.id);
          return !refreshSignedUrls && old?.blobId === asset.blobId ? { ...asset, previewUrl: old.previewUrl || asset.previewUrl } : asset;
        });
      });
      setFolders(nextFolders);
      setPage(result.page);
      setTotal(result.total);
      setHasMore(result.hasMore);
      setError(null);
      setPreview((currentPreview) => currentPreview && result.items.some((asset) => asset.id === currentPreview.id) ? currentPreview : null);
    } catch (cause) {
      if (mounted.current && current === revision.current) setError(readableError(cause));
    } finally {
      if (mounted.current && current === revision.current) setLoading(false);
    }
  }, [page, submittedSearch]);
  const latestLoad = useRef(load);
  useEffect(() => { latestLoad.current = load; }, [load]);

  useEffect(() => {
    mounted.current = true;
    const timer = window.setTimeout(() => void latestLoad.current(1, ""), 0);
    return () => { window.clearTimeout(timer); mounted.current = false; revision.current += 1; };
  }, []); // Initial load is intentionally independent of later search/page state.

  useEffect(() => {
    if (!searchInitialized.current) { searchInitialized.current = true; return; }
    const timer = window.setTimeout(() => {
      const next = search.trim();
      setSubmittedSearch(next);
      setPage(1);
      void latestLoad.current(1, next);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const revalidation = createBoundedRevalidation(() => load());
    const signal = () => {
      // Invalidate any in-flight response immediately. The debounced server
      // read must not let a stale page repaint after a publication/deletion.
      revision.current += 1;
      revalidation.signal();
    };
    const unsubscribeFocus = bindRevalidationOnFocus(signal);
    const unsubscribeLibrary = onLibraryChanged(signal);
    signalRefresh.current = signal;
    return () => { signalRefresh.current = () => undefined; unsubscribeFocus(); unsubscribeLibrary(); revalidation.dispose(); };
  }, [load]);

  const openPreview = async (asset: LibraryAsset, opener: HTMLButtonElement) => {
    const requestedRevision = ++revision.current;
    try {
      const result = await listRecentClips({ search: submittedSearch, page, pageSize: PAGE_SIZE });
      if (!mounted.current || requestedRevision !== revision.current) return;
      const fresh = result.items.find((item) => item.id === asset.id);
      if (!fresh || !fresh.previewUrl) {
        setPreview(null);
        await load(page, submittedSearch);
        return;
      }
      setItems((current) => current.map((item) => item.id === fresh.id ? { ...fresh } : item));
      setPreviewOpener(opener);
      setPreview(fresh);
    } catch (cause) {
      if (mounted.current && requestedRevision === revision.current) setError(readableError(cause));
    }
  };

  const refreshPreview = async (asset: LibraryAsset) => {
    const requestedRevision = ++revision.current;
    try {
      const result = await listRecentClips({ search: submittedSearch, page, pageSize: PAGE_SIZE });
      if (!mounted.current || requestedRevision !== revision.current) return;
      const fresh = result.items.find((item) => item.id === asset.id);
      if (!fresh) { setPreview(null); await load(page, submittedSearch); return; }
      if (fresh.previewUrl && fresh.previewUrl !== asset.previewUrl) setPreview(fresh);
    } catch (cause) {
      if (mounted.current && requestedRevision === revision.current) setError(readableError(cause));
    }
  };

  const folderName = (asset: LibraryAsset) => folders.find((folder) => folder.id === asset.folderId)?.name || "Folder unavailable";

  return <section className="recent-clips-section" aria-labelledby="recent-clips-title">
    <div className="section-heading">
      <div><h2 id="recent-clips-title">Recent clips</h2><span className="section-count" aria-live="polite">{total}</span></div>
      <div className="section-tools">
        <div className="section-search"><Search size={14} aria-hidden="true" /><input type="search" aria-label="Search recent clips" placeholder="Search clips…" value={search} onChange={(event) => { revision.current += 1; setSearch(event.target.value); }} /></div>
        <button type="button" onClick={() => signalRefresh.current()} disabled={loading}>Refresh</button>
      </div>
    </div>
    {error && <div className="library-error" role="alert"><strong>{error}</strong><Button onClick={() => void load()}><RefreshCw size={14} /> Retry</Button></div>}
    {items.length ? <>
      <div className="recent-clip-grid">
        {items.map((asset) => <article className="recent-clip-card" data-asset-id={asset.id} key={asset.id}>
          <button className="recent-clip-preview" type="button" aria-label={`Preview ${asset.title}`} onClick={(event) => void openPreview(asset, event.currentTarget)}>
            {asset.mediaType.startsWith("video/") && asset.previewUrl
              ? <LazyVideoThumbnail key={`${asset.id}:${asset.previewUrl}`} className="recent-clip-thumb" src={asset.previewUrl} onError={() => void latestLoad.current(page, submittedSearch, true)}><span><Film size={24} /></span></LazyVideoThumbnail>
              : <div className="recent-clip-thumb recent-clip-placeholder"><Film size={24} /></div>}
          </button>
          <div className="recent-clip-content">
            <strong title={asset.title}>{asset.title}</strong>
            <span>{durationLabel(asset.durationSeconds)} · {asset.width && asset.height ? `${asset.width} × ${asset.height}` : "Dimensions unavailable"}</span>
            <span className="recent-clip-folder"><FolderOpen size={13} aria-hidden="true" />{folderName(asset)}</span>
            <button type="button" className="recent-clip-library-link" onClick={() => onSelectAsset(asset.id)}>View in Library</button>
          </div>
        </article>)}
      </div>
      {(page > 1 || hasMore) && <div className="recent-clip-pagination">
        <Button disabled={loading || page <= 1} onClick={() => void load(page - 1)}>Previous</Button>
        <span>Page {page}{total ? ` · ${total} clips` : ""}</span>
        <Button disabled={loading || !hasMore} onClick={() => void load(page + 1)}>Next</Button>
      </div>}
    </> : !loading && !error
      ? submittedSearch ? <EmptyState icon={<Search size={24} />} title="No clips match your search">Try another search.</EmptyState> : <EmptyState icon={<Film size={24} />} title="No clips in your Library yet." />
      : loading && !items.length ? <div className="inline-empty" role="status">Loading recent clips…</div> : null}
    {preview && <VideoPreviewDialog key={`${preview.id}:${preview.previewUrl}`} asset={preview} opener={previewOpener} onMediaError={() => void refreshPreview(preview)} onClose={() => setPreview(null)} />}
  </section>;
}
