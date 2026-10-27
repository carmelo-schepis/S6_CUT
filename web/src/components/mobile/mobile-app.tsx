import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BriefcaseBusiness, House, Library, LoaderCircle } from "lucide-react";
import { getMobileOverview, readableError } from "../../api";
import { revealApp, revealWhenReady } from "../../startup";
import type { MobileOverview } from "../../types";
import { usePoll } from "../../use-poll";
import { Button, StatusBadge } from "../common";
import { VideoPreviewDialog } from "../video-preview-dialog";
import { MobileHome } from "./mobile-home";
import { MobileJobs } from "./mobile-jobs";
import { MobileLibrary } from "./mobile-library";
import { hasWorkInFlight, hashForTab, tabFromHash, workGroups, type MobileTab } from "./mobile-model";
import type { PreviewTarget } from "./mobile-parts";
import "./mobile.css";

const BUSY_POLL_MS = 3_000;
const IDLE_POLL_MS = 15_000;
const HISTORY_STEP = 20;
const HISTORY_MAX = 100;

const tabs: { id: MobileTab; label: string; icon: typeof House }[] = [
  { id: "home", label: "Home", icon: House },
  { id: "library", label: "Library", icon: Library },
  { id: "jobs", label: "Jobs", icon: BriefcaseBusiness },
];

function useTab(): [MobileTab, (tab: MobileTab) => void] {
  const [tab, setTab] = useState<MobileTab>(() => tabFromHash(window.location.hash));
  useEffect(() => {
    const sync = () => setTab(tabFromHash(window.location.hash));
    window.addEventListener("hashchange", sync);
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener("hashchange", sync);
      window.removeEventListener("popstate", sync);
    };
  }, []);
  // The address carries the tab, so Back and a refresh keep the customer where they were.
  const open = useCallback((next: MobileTab) => {
    // Update React and the address together, without native fragment navigation
    // repainting Safari's old page snapshot between already prepared tabs.
    if (tabFromHash(window.location.hash) !== next) window.history.pushState(window.history.state, "", hashForTab(next));
    setTab(next);
  }, []);
  return [tab, open];
}

/** Stop polling while the page is in the background, and read again the moment it returns. */
function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  useEffect(() => {
    const sync = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);
  return visible;
}

/**
 * iOS Safari zooms the whole page when a field smaller than 16px takes focus.
 * The shared type scale is 13px and must not grow a mobile-only size, so the
 * zoom is suppressed here instead, for this view only (pinching still works).
 */
function useNoFocusZoom() {
  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (!meta) return;
    const original = meta.content;
    if (!/maximum-scale/.test(original)) meta.content = `${original}, maximum-scale=1`;
    return () => { meta.content = original; };
  }, []);
}

export function MobileApp() {
  const [tab, openTab] = useTab();
  const visible = usePageVisible();
  const [overview, setOverview] = useState<MobileOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [preview, setPreview] = useState<{ asset: PreviewTarget; opener: HTMLButtonElement | null } | null>(null);
  const historyRef = useRef(HISTORY_STEP);

  const [initialTab] = useState(tab);
  const [homeReady, setHomeReady] = useState(false);
  const [libraryReady, setLibraryReady] = useState(false);
  const onHomeReady = useCallback(() => setHomeReady(true), []);
  const onLibraryReady = useCallback(() => setLibraryReady(true), []);

  useNoFocusZoom();
  // Reveal the populated first screen after its images have settled, so mounting
  // the mobile chunk and decoding its wallpaper cannot consume the exit fade.
  const overviewReady = overview !== null || error !== null;
  const startupReady = overviewReady && (homeReady || error !== null) && libraryReady;
  useEffect(() => {
    if (!startupReady || !document.getElementById("startup-screen")) return;
    let cancelled = false;
    let scheduled = false;
    let dispose: (() => void) | undefined;
    const reveal = () => {
      if (cancelled || scheduled) return;
      scheduled = true;
      window.clearTimeout(timeout);
      if (initialTab !== "home") revealApp(false);
      else dispose = revealWhenReady("/mobile-wallpaper.jpg");
    };
    // Prepare the first batch in every tab once, including currently hidden
    // thumbnails. Later tab changes retain these decoded image elements.
    const timeout = window.setTimeout(reveal, 5_000);
    const images = Array.from(document.querySelectorAll<HTMLImageElement>(".m-app img"));
    for (const image of images) image.loading = "eager";
    void Promise.allSettled(images.map((image) =>
      typeof image.decode === "function" ? image.decode() : Promise.resolve(),
    )).then(reveal);
    return () => { cancelled = true; window.clearTimeout(timeout); dispose?.(); };
  }, [startupReady, initialTab]);

  const refresh = useCallback(async () => {
    try {
      const value = await getMobileOverview(historyRef.current);
      setOverview(value);
      setError(null);
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setLoadingOlder(false);
    }
  }, []);
  const groups = useMemo(() => overview ? workGroups(overview) : null, [overview]);
  const libraryRefreshKey = overview ? `${overview.clipsLastDay}:${overview.recent[0]?.id ?? ""}:${overview.recent[0]?.updatedAt ?? ""}` : "";
  const runRefresh = usePoll(refresh, hasWorkInFlight(overview) ? BUSY_POLL_MS : IDLE_POLL_MS, visible, true);

  const showOlder = useCallback(() => {
    historyRef.current = Math.min(HISTORY_MAX, historyRef.current + HISTORY_STEP);
    setLoadingOlder(true);
    void runRefresh();
  }, [runRefresh]);

  useEffect(() => { window.scrollTo({ top: 0, behavior: "auto" }); }, [tab]);

  const openPreview = useCallback((asset: PreviewTarget, opener: HTMLButtonElement) => setPreview({ asset, opener }), []);
  const runningCount = groups ? groups.running.length + groups.queued.length : 0;
  const activeTab = tabs.find((item) => item.id === tab) ?? tabs[0];

  return <div className="m-app" data-tab={tab}>
    <a className="skip-link" href="#m-content" onClick={(event) => { event.preventDefault(); document.getElementById("m-content")?.focus(); }}>Skip to main content</a>
    <div className="m-wallpaper" aria-hidden="true" />

    <aside className="m-rail" aria-label="Primary navigation">
      <span className="m-brand"><img src="/app-icon.png" alt="" /><span><span className="brand-accent">S6</span>_cut</span></span>
      <nav className="m-nav">
        {tabs.map((item) => {
          const Icon = item.icon;
          const current = item.id === tab;
          const progress = item.id === "jobs" && runningCount > 0 ? `${runningCount} in progress` : null;
          // Named explicitly: on tablets the visible label is hidden (icons only), and a hidden label gives a button no name.
          return <button key={item.id} type="button" className={current ? "m-nav-item active" : "m-nav-item"} aria-label={progress ? `${item.label}, ${progress}` : item.label} title={item.label} aria-current={current ? "page" : undefined} onClick={() => openTab(item.id)}>
            <Icon size={19} aria-hidden="true" />
            <span className="m-nav-label">{item.label}</span>
            {progress && <span className="m-badge" aria-hidden="true">{runningCount}</span>}
          </button>;
        })}
      </nav>
    </aside>

    <div className="m-main">
      <header className="m-topbar">
        <strong className="m-topbar-title">{activeTab.label}</strong>
        <span className="m-engine">
          {error ? <StatusBadge state="offline" label="Engine offline" /> : overview ? <StatusBadge state="local" label="Local engine" /> : null}
        </span>
      </header>

      {!overview && !error && <div className="m-banner" role="status"><LoaderCircle size={15} className="spin" aria-hidden="true" /> Connecting to the local engine…</div>}
      {error && <div className="m-banner m-banner-error" role="alert"><span><strong>Engine unavailable.</strong> {error}</span> <Button onClick={() => void runRefresh()}>Retry</Button></div>}

      <main id="m-content" className="m-content" tabIndex={-1}>
        <div className="m-tab-panel" hidden={tab !== "home"}>
          {overview && groups && <MobileHome overview={overview} groups={groups} onOpenTab={openTab} onPreview={openPreview} onReady={onHomeReady} />}
        </div>
        <div className="m-tab-panel" hidden={tab !== "library"}>
          {overviewReady && <MobileLibrary onPreview={openPreview} onReady={onLibraryReady} refreshKey={libraryRefreshKey} />}
        </div>
        <div className="m-tab-panel" hidden={tab !== "jobs"}>
          {overview && groups && <MobileJobs overview={overview} groups={groups} onPreview={openPreview} onShowOlder={showOlder} loadingOlder={loadingOlder} />}
        </div>
      </main>
    </div>

    {preview && <VideoPreviewDialog asset={preview.asset} opener={preview.opener} onClose={() => setPreview(null)} />}
  </div>;
}

export default MobileApp;
