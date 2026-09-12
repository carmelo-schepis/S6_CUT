import { useCallback, useEffect, useState } from "react";
import { CircleHelp, BriefcaseBusiness, Film, FolderKanban, HardDrive, Library, LoaderCircle, Scissors, Settings, SlidersHorizontal, Sparkles } from "lucide-react";
import { getHealth, listJobs, listProfiles, listProjects, readableError } from "./api";
import { JobsView } from "./components/jobs-view";
import { LibraryView } from "./components/library-view";
import { ProjectsView } from "./components/projects-view";
import { SettingsView } from "./components/settings-view";
import { StatusBadge } from "./components/common";
import { WorkspaceView } from "./components/workspace-view";
import { ShortsEditorView } from "./components/shorts-editor-view";
import { TopicToVideoView } from "./components/topic-to-video-view";
import { HelpDialog } from "./components/help-dialog";
import { jobPollInterval } from "./project-status";
import { usePoll } from "./use-poll";
import type { Health, Job, Project, ProviderProfile } from "./types";

type Page = "projects" | "library" | "workspace" | "shorts-editor" | "ai-video" | "jobs" | "settings";

/**
 * Liveness cadence. The poll is self-scheduling, so this is the gap *after* a
 * read settles: a slow engine stretches the cadence instead of stacking reads.
 */
const HEALTH_POLL_MS = 5_000;

// `label` is the rail caption and must fit the rail without truncating;
// `name` is the full accessible/breadcrumb name.
const nav: { id: Page; label: string; name: string; icon: typeof Film }[] = [
  { id: "projects", label: "Projects", name: "Projects", icon: FolderKanban },
  { id: "library", label: "Library", name: "Library", icon: Library },
  { id: "workspace", label: "Workspace", name: "Workspace", icon: SlidersHorizontal },
  { id: "shorts-editor", label: "Editor", name: "Shorts Editor", icon: Scissors },
  { id: "ai-video", label: "AI Video", name: "AI Video", icon: Sparkles },
  { id: "jobs", label: "Jobs", name: "Jobs", icon: BriefcaseBusiness },
  { id: "settings", label: "Settings", name: "Settings", icon: Settings },
];

export function App() {
  const [page, setPage] = useState<Page>("projects");
  const [projects, setProjects] = useState<Project[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [healthChecked, setHealthChecked] = useState(false);
  const [profiles, setProfiles] = useState<ProviderProfile[]>([]);
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

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

  // Runs immediately on entering Projects: waiting a full interval let a
  // finished project keep showing its creation-time badge while its progress
  // bar already read 100%.
  const pollJobs = useCallback(() => listJobs()
    .then(setJobs)
    .catch((cause) => setError(readableError(cause))), []);
  const runJobs = usePoll(pollJobs, jobsPollMs, page === "projects");

  // Each read applies its own slice the moment it settles. Gating all four on a
  // single `allSettled` meant the engine badge kept saying "Connecting…" until
  // the heavy project and job reads returned — so a healthy engine still looked
  // unreachable for as long as the slowest list took.
  const refresh = useCallback(async () => {
    const projectsDone = listProjects().then(
      (value) => { setProjects(value); setSelectedProjectId((current) => current && value.some((project) => project.id === current) ? current : value[0]?.id || null); },
      () => undefined,
    ).finally(() => setLoaded(true));

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

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [page]);

  const openProject = (id: string) => {
    setSelectedProjectId(id);
    setPage("workspace");
  };

  const onCreated = (project: Project) => {
    setProjects((current) => [project, ...current.filter((item) => item.id !== project.id)]);
    openProject(project.id);
  };
  const onDeleted = (projectId: string) => {
    setProjects((current) => current.filter((project) => project.id !== projectId));
    setJobs((current) => current.filter((job) => job.projectId !== projectId));
    setSelectedProjectId((current) => current === projectId ? null : current);
  };

  const selected = projects.find((project) => project.id === selectedProjectId) || null;
  const hasSelectedProvider = profiles.some((profile) => profile.selected && profile.openrouterConfigured && profile.textStatus === "connected");
  const openProviders = () => setPage("settings");

  return <div className="app-shell">
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
    <aside className="app-rail" aria-label="Primary navigation">
      <button className="brand-button" onClick={() => setPage("projects")} aria-label="S6_cut Projects">
        <img src="/app-icon.png" alt="" />
      </button>
      <nav>
        {nav.map((item) => {
          const Icon = item.icon;
          return <button key={item.id} className={page === item.id ? "nav-item active" : "nav-item"} onClick={() => setPage(item.id)} aria-label={item.name} title={item.name} aria-current={page === item.id ? "page" : undefined}>
            <Icon size={19} /><span>{item.label}</span>
          </button>;
        })}
      </nav>
      {/* Help sits at the foot of the rail, below the destinations. The engine
          reading is not here: startup is announced once by the engine-startup
          row, and the steady-state status lives in the topbar badge. */}
      <button className="help-launcher" onClick={() => setHelpOpen(true)} aria-label="Open S6 Cut Help">
        <CircleHelp size={18} aria-hidden="true" /><span>Help</span>
      </button>
    </aside>

    <div className="app-main">
      <header className="topbar">
        <div className="topbar-context">
          <span className="mobile-brand"><img src="/app-icon.png" alt="" /> S6_cut</span>
          {selected && page === "workspace" ? <><span className="muted">Workspace</span><span className="crumb">/</span><strong>{selected.name}</strong></> : <strong>{nav.find((item) => item.id === page)?.name}</strong>}
        </div>
        <div className="topbar-state">
          {/* Steady-state reading only. Startup is announced once, by the
              engine-startup row below, which stays visible at every width —
              this badge is hidden under 540px. */}
          {health ? <StatusBadge state={health.status === "ready" ? "local" : "fallback"} label={health.status === "ready" ? "Local engine" : "Fallbacks active"} /> : healthChecked ? <StatusBadge state="offline" label="Engine offline" /> : null}
          <span className="save-state"><HardDrive size={14} /> Saved on this machine</span>
        </div>
      </header>

      {/* One startup indicator for the whole shell, in the same slot the failure
          alert uses — so "connecting" either resolves or turns into an error
          the customer can act on, in one place, at every viewport. */}
      {!healthChecked && <div className="engine-startup" role="status"><LoaderCircle size={15} className="spin" aria-hidden="true" /> Connecting to the local engine…</div>}
      {error && <div className="global-alert" role="alert"><strong>Engine unavailable.</strong> {error} <button onClick={() => refresh()}>Retry</button></div>}

      <main id="main-content" tabIndex={-1}>
        {page === "projects" && <ProjectsView projects={projects} jobs={jobs} health={health} healthChecked={healthChecked} loaded={loaded} providersLoaded={profilesLoaded} hasSelectedProvider={hasSelectedProvider} onConfigureProviders={openProviders} onCreated={onCreated} onOpen={openProject} onDeleted={onDeleted} onRefresh={refresh} />}
        {page === "library" && <LibraryView />}
        {page === "workspace" && <WorkspaceView key={selected?.id || "none"} project={selected} health={health} providersLoaded={profilesLoaded} hasSelectedProvider={hasSelectedProvider} onConfigureProviders={openProviders} onProjectUpdated={refresh} onGoProjects={() => setPage("projects")} />}
        {page === "shorts-editor" && <ShortsEditorView onJobCreated={refresh} />}
        {page === "ai-video" && <TopicToVideoView profiles={profiles} profilesLoaded={profilesLoaded} onConfigureProviders={openProviders} onJobCreated={refresh} />}
        {page === "jobs" && <JobsView onOpenProject={openProject} />}
        {page === "settings" && <SettingsView health={health} onHealthRefresh={refresh} onProfilesChanged={setProfiles} onSkipSetup={() => setPage("projects")} />}
      </main>
    </div>
    <HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
  </div>;
}
