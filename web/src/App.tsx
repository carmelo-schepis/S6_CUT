import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronsLeft, ChevronsRight, CircleHelp, BriefcaseBusiness, Film, FolderKanban, Library, LoaderCircle, Scissors, Settings, SlidersHorizontal } from "lucide-react";
import { getHealth, listJobs, listProfiles, listProjects, readableError } from "./api";
import { JobsView } from "./components/jobs-view";
import { LibraryView } from "./components/library-view";
import { ProjectsView } from "./components/projects-view";
import { SettingsView } from "./components/settings-view";
import { StatusBadge } from "./components/common";
import { WorkspaceView } from "./components/workspace-view";
import { WorkspaceProgressIndicator } from "./components/workspace-progress-indicator";
import { ShortsEditorView } from "./components/shorts-editor-view";
import { HelpDialog } from "./components/help-dialog";
import { PwaStatus } from "./components/pwa-status";
import { hasLiveWork, jobPollInterval, workspaceActivity } from "./project-status";
import { onLibraryChanged } from "./library-sync";
import { usePoll } from "./use-poll";
import type { Health, Job, Project, ProviderProfile } from "./types";

type Page = "projects" | "library" | "workspace" | "shorts-editor" | "jobs" | "settings";

/**
 * Liveness cadence. The poll is self-scheduling, so this is the gap *after* a
 * read settles: a slow engine stretches the cadence instead of stacking reads.
 */
const HEALTH_POLL_MS = 5_000;

/** Per-browser convenience: whether the desktop sidebar is collapsed to icons.
 *  Collapsed by default; only an explicit "0" (pinned open via the toggle) expands it. */
const RAIL_COLLAPSED_KEY = "s6.rail.collapsed";

// `label` is the rail caption and must fit the rail without truncating;
// `name` is the full accessible/breadcrumb name.
const nav: { id: Page; label: string; name: string; icon: typeof Film }[] = [
  { id: "projects", label: "Projects", name: "Projects", icon: FolderKanban },
  { id: "library", label: "Library", name: "Library", icon: Library },
  { id: "workspace", label: "Workspace", name: "Workspace", icon: SlidersHorizontal },
  { id: "shorts-editor", label: "Editor", name: "Shorts Editor", icon: Scissors },
  { id: "jobs", label: "Jobs", name: "Jobs", icon: BriefcaseBusiness },
  { id: "settings", label: "Settings", name: "Settings", icon: Settings },
];

export function App() {
  const [page, setPage] = useState<Page>("projects");
  const [projects, setProjects] = useState<Project[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedLibraryAssetId, setSelectedLibraryAssetId] = useState<string | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [healthChecked, setHealthChecked] = useState(false);
  const [profiles, setProfiles] = useState<ProviderProfile[]>([]);
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(() => {
    try { return localStorage.getItem(RAIL_COLLAPSED_KEY) !== "0"; } catch { return true; }
  });
  const toggleRail = () => setRailCollapsed((collapsed) => {
    try { localStorage.setItem(RAIL_COLLAPSED_KEY, collapsed ? "0" : "1"); } catch { /* Storage can be unavailable in hardened browsers. */ }
    return !collapsed;
  });
  // A click inside the folded rail (navigating, or folding it) holds the hover
  // peek shut until the pointer leaves, so the overlay never covers the page
  // the user just opened while they move toward it.
  const [railPeekHeld, setRailPeekHeld] = useState(false);
  const refreshRevision = useRef(0);

  // `getHealth` aborts itself after HEALTH_TIMEOUT_MS, so a wedged engine
  // rejects here instead of leaving the promise pending forever — which used to
  // strand the shell on "Connecting to local engine…" with no way back.
  // `healthChecked` flips on settle either way, so the alert and its Retry
  // always appear.
  const pollHealth = useCallback(() => getHealth()
    .then((value) => { setHealth(value); setError(null); }, (cause) => { setHealth(null); setError(readableError(cause)); })
    .finally(() => setHealthChecked(true)), []);
  // Owns the first health read as well: routing every read through one poll is
  // what keeps a slow engine from accumulating parallel /health requests.
  const runHealth = usePoll(pollHealth, HEALTH_POLL_MS, true, true);

  const jobsPollMs = jobPollInterval(jobs);
  const latestJobsSnapshot = useRef<Job[]>([]);

  // Runs immediately on entering Projects: waiting a full interval let a
  // finished project keep showing its creation-time badge while its progress
  // bar already read 100%.
  const pollJobs = useCallback(() => listJobs()
    .then((value) => { latestJobsSnapshot.current = value; setJobs(value); })
    .catch((cause) => setError(readableError(cause))), []);
  const jobsPollingEnabled = page === "projects" || hasLiveWork(jobs);
  const runJobs = usePoll(pollJobs, jobsPollMs, jobsPollingEnabled);

  // Each read applies its own slice the moment it settles. Gating all four on a
  // single `allSettled` meant the engine badge kept saying "Connecting…" until
  // the heavy project and job reads returned — so a healthy engine still looked
  // unreachable for as long as the slowest list took.
  const refresh = useCallback(async () => {
    const revision = ++refreshRevision.current;
    const projectsDone = listProjects().then(
      (value) => {
        if (revision !== refreshRevision.current) return;
        setProjects(value);
        // Only *choose* a project when nothing is selected yet. A project can
        // legitimately leave this list while the customer is working in it —
        // its last Library asset was deleted, a folder move, an import stopped
        // before publishing output — and re-pointing the selection at the
        // newest project put a different project's live job behind the
        // Workspace controls, so a "Stop & keep" aimed at this import could
        // stop an unrelated one. Keep the selection instead: the Workspace
        // shows its own "No project selected" state, and the choice re-resolves
        // by itself if the project comes back (Retry import makes it live again).
        setSelectedProjectId((current) => current || value[0]?.id || null);
      },
      () => undefined,
    );

    // Health and jobs go through their polls so a manual Retry can never start
    // a second read alongside the one already in flight.
    const healthDone = runHealth();

    // Only a successful read tells us whether a provider is connected; a failed
    // one leaves provider availability genuinely unknown (see ProjectsView).
    const profilesDone = listProfiles().then((value) => { setProfiles(value); setProfilesLoaded(true); }, () => undefined);
    const jobsDone = runJobs();

    await Promise.allSettled([projectsDone, healthDone, profilesDone, jobsDone]);
  }, [runHealth, runJobs]);

  useEffect(() => {
    void Promise.resolve().then(refresh).catch((cause) => setError(readableError(cause)));
  }, [refresh]);

  useEffect(() => onLibraryChanged(() => {
    void refresh();
  }), [refresh]);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [page]);

  const openProject = (id: string) => {
    setSelectedProjectId(id);
    setPage("workspace");
  };
  const openLibraryAsset = (id: string) => {
    setSelectedLibraryAssetId(id);
    setPage("library");
  };

  const onCreated = (project: Project) => {
    // A refresh that started before creation can return a project list which
    // does not contain this project. Letting that stale response win would
    // replace the selection just set below with the first older project,
    // stranding the customer in the wrong Workspace (and hiding live job
    // controls such as YouTube import retry). Invalidate it before merging
    // the authoritative create response.
    refreshRevision.current += 1;
    setProjects((current) => [project, ...current.filter((item) => item.id !== project.id)]);
    // The guarded poll picks up the job immediately without racing the shell's
    // existing /jobs request. If that request began before creation and returns
    // an older snapshot, one guarded follow-up closes the gap without ever
    // putting two /jobs requests on the wire together.
    void runJobs().then(() => {
      const createdJobIsLive = project.mode === "clip" && latestJobsSnapshot.current.some((job) => job.projectId === project.id && job.mode === "clip" && hasLiveWork([job]));
      if (!createdJobIsLive) void runJobs();
    });
    openProject(project.id);
  };
  const selected = projects.find((project) => project.id === selectedProjectId) || null;
  const activity = workspaceActivity(projects, jobs);
  const activityDescription = activity
    ? `${activity.remainingClips} clip${activity.remainingClips === 1 ? "" : "s"} remaining across ${activity.liveJobCount} active job${activity.liveJobCount === 1 ? "" : "s"}`
    : "";
  const hasSelectedProvider = profiles.some((profile) => profile.selected && profile.openrouterConfigured && profile.textStatus === "connected");
  const openProviders = () => setPage("settings");

  return <div className="app-shell" data-rail={railCollapsed ? "collapsed" : "expanded"} data-rail-peek={railPeekHeld ? "held" : undefined}>
    {/* First tab stop: lets keyboard users bypass the seven rail destinations
        that otherwise precede page content on every screen. */}
    <a
      className="skip-link"
      href="#main-content"
      onClick={(event) => {
        // The rail is not a router, so the default hash jump would only change
        // the URL; move focus to the heading region explicitly instead.
        event.preventDefault();
        document.getElementById("main-content")?.focus();
      }}
    >Skip to main content</a>
    <aside className="app-rail" aria-label="Primary navigation" onClick={() => setRailPeekHeld(true)} onMouseLeave={() => setRailPeekHeld(false)}>
      <button className="brand-button" onClick={() => setPage("projects")} aria-label="S6_cut Projects">
        <img src="/app-icon.png" alt="" /><span><span className="brand-accent">S6</span>_cut</span>
      </button>
      <nav>
        {nav.map((item) => {
          const Icon = item.icon;
          const workspace = item.id === "workspace";
          return <button key={item.id} className={page === item.id ? "nav-item active" : "nav-item"} onClick={() => setPage(item.id)} aria-label={item.name} title={item.name} aria-current={page === item.id ? "page" : undefined} aria-describedby={workspace && activity ? "workspace-work-description" : undefined}>
            <span className="nav-icon-wrap">
              <Icon className={workspace ? "nav-main-icon" : undefined} data-testid={workspace ? "workspace-nav-icon" : undefined} size={19} aria-hidden="true" />
              {workspace && activity ? <WorkspaceProgressIndicator
                value={activity.remainingClips}
                isProcessing={activity.isProcessing}
                label={`Loading progress: ${activityDescription}`}
              /> : null}
            </span>
            <span className="nav-label">{item.label}</span>
          </button>;
        })}
      </nav>
      {activity && <span id="workspace-work-description" className="sr-only">Loading progress: {activityDescription}</span>}
      {/* Help sits at the foot of the rail, below the destinations. The engine
          reading is not here: startup is announced once by the engine-startup
          row, and the steady-state status lives in the topbar badge. */}
      <button className="help-launcher" onClick={() => setHelpOpen(true)} aria-label="Open S6 Cut Help">
        <CircleHelp size={18} aria-hidden="true" /><span>Help</span>
      </button>
      {/* The tab on the sidebar's edge pins it open or folds it to icons; while
          folded, hovering the icons peeks the full sidebar over the page. */}
      <button type="button" className="rail-toggle" onClick={toggleRail} aria-label={railCollapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!railCollapsed} title={railCollapsed ? "Expand sidebar" : "Collapse sidebar"}>
        {railCollapsed ? <ChevronsRight size={14} aria-hidden="true" /> : <ChevronsLeft size={14} aria-hidden="true" />}
      </button>
    </aside>

    <div className="app-main">
      <header className="topbar">
        <div className="topbar-context">
          <span className="mobile-brand"><img src="/app-icon.png" alt="" /> <span><span className="brand-accent">S6</span>_cut</span></span>
          {selected && page === "workspace" ? <><span className="muted">Workspace</span><span className="crumb">/</span><strong>{selected.name}</strong></> : <strong>{nav.find((item) => item.id === page)?.name}</strong>}
        </div>
        <div className="topbar-state">
          {/* Steady-state reading only. Startup is announced once, by the
              engine-startup row below, which stays visible at every width —
              this badge is hidden under 540px. */}
          {health ? <StatusBadge state={health.status === "ready" ? "local" : "fallback"} label={health.status === "ready" ? "Local engine" : "Fallbacks active"} /> : healthChecked ? <StatusBadge state="offline" label="Engine offline" /> : null}
        </div>
      </header>
      <PwaStatus />

      {/* One startup indicator for the whole shell, in the same slot the failure
          alert uses — so "connecting" either resolves or turns into an error
          the customer can act on, in one place, at every viewport. */}
      {!healthChecked && <div className="engine-startup" role="status"><LoaderCircle size={15} className="spin" aria-hidden="true" /> Connecting to the local engine…</div>}
      {error && <div className="global-alert" role="alert"><strong>Engine unavailable.</strong> {error} <button onClick={() => refresh()}>Retry</button></div>}

      <main id="main-content" tabIndex={-1}>
        {page === "projects" && <ProjectsView health={health} healthChecked={healthChecked} providersLoaded={profilesLoaded} hasSelectedProvider={hasSelectedProvider} onConfigureProviders={openProviders} onCreated={onCreated} onSelectLibraryAsset={openLibraryAsset} />}
        {page === "library" && <LibraryView selectedAssetId={selectedLibraryAssetId} />}
        {page === "workspace" && <WorkspaceView key={selected?.id || "none"} project={selected} providersLoaded={profilesLoaded} hasSelectedProvider={hasSelectedProvider} onConfigureProviders={openProviders} onProjectUpdated={refresh} onGoProjects={() => setPage("projects")} />}
        {page === "shorts-editor" && <ShortsEditorView onJobCreated={refresh} />}
        {page === "jobs" && <JobsView jobs={jobs} onRefresh={runJobs} onOpenProject={openProject} />}
        {page === "settings" && <SettingsView health={health} onHealthRefresh={refresh} onProfilesChanged={setProfiles} onSkipSetup={() => setPage("projects")} />}
      </main>
    </div>
    <HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
  </div>;
}
