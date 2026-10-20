import { useCallback, useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { listAssetsPage, listFolders, readableError } from "../../api";
import type { AssetOrigin, LibraryAsset, LibraryFolder } from "../../types";
import { Button, formatDuration } from "../common";
import { Poster, type OpenPreview } from "./mobile-parts";

// Same wording as the desktop Library, so a filter or origin reads identically on both.
const originLabels: Record<AssetOrigin, string> = { "manual-import": "Manual", "project-source": "Source", "generated-clip": "Generated clip", "script-output": "Legacy output" };
const PAGE_SIZE = 24;
const SEARCH_DEBOUNCE_MS = 300;

function secondaryLine(asset: LibraryAsset): string {
  const duration = asset.durationSeconds ? formatDuration(asset.durationSeconds) : null;
  return [originLabels[asset.origin], duration].filter(Boolean).join(" · ");
}

export function MobileLibrary({ onPreview, onReady, refreshKey = "" }: { onPreview: OpenPreview; onReady?: () => void; refreshKey?: string }) {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [mediaType, setMediaType] = useState("all");
  const [origin, setOrigin] = useState<AssetOrigin | "all">("all");
  const [folderId, setFolderId] = useState("all");
  const [folders, setFolders] = useState<LibraryFolder[]>([]);
  const [items, setItems] = useState<LibraryAsset[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const page = useRef(0);
  const request = useRef(0);
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    void listFolders().then((value) => { if (!cancelled) setFolders(value.filter((folder) => !folder.archived)); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  // A newer request (filters changed, or the next page) always wins over a slower older one.
  const fetchPage = useCallback(async (next: number, keepItems = false) => {
    const id = ++request.current;
    setLoading(true);
    setError(null);
    if (next === 1 && !keepItems) setItems([]);
    try {
      const result = await listAssetsPage({
        search: search || undefined,
        mediaType: mediaType === "all" ? undefined : mediaType,
        origin: origin === "all" ? undefined : origin,
        folderId: folderId === "all" ? undefined : folderId,
        page: next,
        pageSize: PAGE_SIZE,
      });
      if (id !== request.current) return;
      page.current = next;
      setHasMore(result.hasMore);
      setItems((current) => next === 1 ? result.items : [...current, ...result.items.filter((item) => !current.some((existing) => existing.id === item.id))]);
    } catch (cause) {
      if (id === request.current) setError(readableError(cause));
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [search, mediaType, origin, folderId]);

  useEffect(() => {
    page.current = 0;
    void Promise.resolve().then(() => fetchPage(1));
  }, [fetchPage]);

  useEffect(() => { if (!loading) onReady?.(); }, [loading, onReady]);

  // Keep the prepared tab fresh when the overview reports a new publication,
  // without discarding visible items just because a background refresh starts.
  const previousRefreshKey = useRef(refreshKey);
  useEffect(() => {
    if (previousRefreshKey.current === refreshKey) return;
    previousRefreshKey.current = refreshKey;
    void fetchPage(1, true);
  }, [refreshKey, fetchPage]);

  const canObserve = typeof window !== "undefined" && "IntersectionObserver" in window;
  useEffect(() => {
    const node = sentinel.current;
    if (!canObserve || !node || !hasMore || loading || error) return;
    const observer = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) void fetchPage(page.current + 1); }, { rootMargin: "600px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [canObserve, hasMore, loading, error, fetchPage, items.length]);

  return <div className="m-page m-library">
    <div className="m-page-head"><h1>Library</h1></div>
    <div className="m-toolbar">
      <div className="search-box m-search"><Search size={15} aria-hidden="true" /><input type="search" aria-label="Search media" placeholder="Search titles, tags, people, brands…" value={query}
        enterKeyHint="search" autoCapitalize="none" autoCorrect="off" onChange={(event) => setQuery(event.target.value)} /></div>
      <div className="m-filters">
        <select aria-label="Media type" value={mediaType} onChange={(event) => setMediaType(event.target.value)}><option value="all">All media</option><option value="image">Images</option><option value="video">Video</option><option value="audio">Audio</option></select>
        <select aria-label="Asset origin" value={origin} onChange={(event) => setOrigin(event.target.value as AssetOrigin | "all")}><option value="all">All origins</option><option value="project-source">Sources</option><option value="generated-clip">Generated clips</option><option value="script-output">Legacy outputs</option><option value="manual-import">Manual imports</option></select>
        <select aria-label="Folder" value={folderId} onChange={(event) => setFolderId(event.target.value)}><option value="all">All folders</option>{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select>
      </div>
    </div>

    {error && <div className="form-error" role="alert"><span>{error}</span> <Button onClick={() => void fetchPage(Math.max(1, page.current + (items.length ? 1 : 0)))}>Retry</Button></div>}

    {items.length > 0 && <ul className="m-grid" aria-label="Library media">
      {items.map((asset) => {
        const isVideo = asset.mediaType.startsWith("video/");
        const isImage = asset.mediaType.startsWith("image/");
        const poster = isVideo ? asset.thumbnailUrl : isImage ? asset.previewUrl : null;
        const body = <>
          <Poster src={poster} className="m-grid-poster" />
          <strong className="m-clamp">{asset.title}</strong>
          <span className="m-muted m-clamp-1">{secondaryLine(asset)}</span>
        </>;
        return <li key={asset.id}>
          {isVideo && asset.previewUrl
            ? <button type="button" className="m-grid-item" aria-label={`Preview ${asset.title}`} onClick={(event) => onPreview(asset, event.currentTarget)}>{body}</button>
            : <div className="m-grid-item">{body}</div>}
        </li>;
      })}
    </ul>}

    {loading && <p className="m-status m-muted" role="status">{items.length ? "Loading more…" : "Loading Library…"}</p>}
    {!loading && !error && items.length === 0 && <p className="m-empty m-muted">{search || mediaType !== "all" || origin !== "all" || folderId !== "all" ? "Nothing matches these filters." : "Your Library is empty."}</p>}
    {hasMore && !loading && !error && (canObserve ? <div ref={sentinel} className="m-sentinel" aria-hidden="true" /> : <div className="m-more"><Button onClick={() => void fetchPage(page.current + 1)}>Show more</Button></div>)}
  </div>;
}
