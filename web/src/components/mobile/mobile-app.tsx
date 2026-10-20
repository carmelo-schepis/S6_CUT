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
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  // The address carries the tab, so Back and a refresh keep the customer where they were.
  const open = useCallback((next: MobileTab) => {
    if (tabFromHash(window.location.hash) !== next) window.location.hash = hashForTab(next);
    else setTab(next);
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

  useNoFocusZoom();
  // Reveal the populated first screen after its images have settled, so mounting
  // the mobile chunk and decoding its wallpaper cannot consume the exit fade.
  const startupReady = overview !== null || error !== null;
  useEffect(() => {
    // Only the initial Home visit gets the startup fade. Direct links and
    // subsequent tab navigation use the shell's existing loading indicators.
    if (tab !== "home") { revealApp(false); return; }
    if (startupReady) return revealWhenReady("/mobile-wallpaper.jpg");
  }, [startupReady, tab]);

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
        {overview && groups && tab === "home" && <MobileHome overview={overview} groups={groups} onOpenTab={openTab} onPreview={openPreview} />}
        {tab === "library" && <MobileLibrary onPreview={openPreview} />}
        {overview && groups && tab === "jobs" && <MobileJobs overview={overview} groups={groups} onPreview={openPreview} onShowOlder={showOlder} loadingOlder={loadingOlder} />}
      </main>
    </div>

    {preview && <VideoPreviewDialog asset={preview.asset} opener={preview.opener} onClose={() => setPreview(null)} />}
  </div>;
}

export default MobileApp;
