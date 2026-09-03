import { useCallback, useEffect, useState } from "react";
import { BriefcaseBusiness, Film, FolderKanban, HardDrive, Library, Scissors, Settings, SlidersHorizontal, Sparkles } from "lucide-react";
import { getHealth, listJobs, listProfiles, listProjects, readableError } from "./api";
import { JobsView } from "./components/jobs-view";
import { LibraryView } from "./components/library-view";
import { ProjectsView } from "./components/projects-view";
import { SettingsView } from "./components/settings-view";
import { StatusBadge } from "./components/common";
import { WorkspaceView } from "./components/workspace-view";
import { ShortsEditorView } from "./components/shorts-editor-view";
import { TopicToVideoView } from "./components/topic-to-video-view";
import type { Health, Job, Project, ProviderProfile } from "./types";

type Page = "projects" | "library" | "workspace" | "shorts-editor" | "ai-video" | "jobs" | "settings";

const nav: { id: Page; label: string; icon: typeof Film }[] = [
  { id: "projects", label: "Projects", icon: FolderKanban },
  { id: "library", label: "Library", icon: Library },
  { id: "workspace", label: "Workspace", icon: SlidersHorizontal },
  { id: "shorts-editor", label: "Shorts Editor", icon: Scissors },
  { id: "ai-video", label: "AI Video", icon: Sparkles },
  { id: "jobs", label: "Jobs", icon: BriefcaseBusiness },
  { id: "settings", label: "Settings", icon: Settings },
];

export function App() {
  const [page, setPage] = useState<Page>("projects");
  const [projects, setProjects] = useState<Project[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [healthChecked, setHealthChecked] = useState(false);
  const [profiles, setProfiles] = useState<ProviderProfile[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [projectsResult, healthResult, profilesResult, jobsResult] = await Promise.allSettled([listProjects(), getHealth(), listProfiles(), listJobs()]);
    if (projectsResult.status === "fulfilled") { setProjects(projectsResult.value); setSelectedProjectId((current) => current && projectsResult.value.some((project) => project.id === current) ? current : projectsResult.value[0]?.id || null); }
    if (profilesResult.status === "fulfilled") setProfiles(profilesResult.value);
    if (jobsResult.status === "fulfilled") setJobs(jobsResult.value);
    if (healthResult.status === "fulfilled") { setHealth(healthResult.value); setError(null); }
    else { setHealth(null); setError(readableError(healthResult.reason)); }
    setHealthChecked(true);
  }, []);

  useEffect(() => {
    void Promise.resolve().then(refresh).catch((cause) => setError(readableError(cause)));
  }, [refresh]);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [page]);

  useEffect(() => {
    let active = true;
    const refreshHealth = () => getHealth().then((value) => { if (active) { setHealth(value); setHealthChecked(true); setError(null); } }).catch((cause) => { if (active) { setHealth(null); setHealthChecked(true); setError(readableError(cause)); } });
    const timer = window.setInterval(() => void refreshHealth(), 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (page !== "projects") return;
    let active = true;
    const refreshProjectJobs = () => listJobs().then(setJobs).catch((cause) => { if (active) setError(readableError(cause)); });
    const timer = window.setInterval(() => void refreshProjectJobs(), 4000);
    return () => { active = false; window.clearInterval(timer); };
  }, [page]);

  const openProject = (id: string) => {
    setSelectedProjectId(id);
    setPage("workspace");
  };

  const onCreated = (project: Project) => {
    setProjects((current) => [project, ...current.filter((item) => item.id !== project.id)]);
    openProject(project.id);
  };

  const selected = projects.find((project) => project.id === selectedProjectId) || null;
  const hasSelectedProvider = profiles.some((profile) => profile.selected && profile.openrouterConfigured && profile.openrouterStatus === "connected");
  const openProviders = () => setPage("settings");

  return <div className="app-shell">
    <aside className="app-rail" aria-label="Primary navigation">
      <button className="brand-button" onClick={() => setPage("projects")} aria-label="S6_cut Projects">
        <img src="/app-icon.png" alt="" />
      </button>
      <nav>
        {nav.map((item) => {
          const Icon = item.icon;
          return <button key={item.id} className={page === item.id ? "nav-item active" : "nav-item"} onClick={() => setPage(item.id)} aria-label={item.label} aria-current={page === item.id ? "page" : undefined}>
            <Icon size={19} /><span>{item.label}</span>
          </button>;
        })}
      </nav>
      <div className="rail-foot">
        <span className={`engine-dot ${health?.status || "offline"}`} aria-hidden="true" />
        <span>{health?.status === "ready" ? "Engine ready" : health?.status === "degraded" ? "Engine degraded" : "Connecting"}</span>
      </div>
    </aside>

    <div className="app-main">
      <header className="topbar">
        <div className="topbar-context">
          <span className="mobile-brand"><img src="/app-icon.png" alt="" /> S6_cut</span>
          {selected && page === "workspace" ? <><span className="muted">Workspace</span><span className="crumb">/</span><strong>{selected.name}</strong></> : <strong>{nav.find((item) => item.id === page)?.label}</strong>}
        </div>
        <div className="topbar-state">
          {health ? <StatusBadge state={health.status === "ready" ? "local" : "fallback"} label={health.status === "ready" ? "Local engine" : "Fallbacks active"} /> : <StatusBadge state={healthChecked ? "offline" : "checking"} label={healthChecked ? "Engine offline" : "Connecting to local engine…"} />}
          <span className="save-state"><HardDrive size={14} /> Saved on this machine</span>
        </div>
      </header>

      {error && <div className="global-alert" role="alert"><strong>Engine unavailable.</strong> {error} <button onClick={() => refresh()}>Retry</button></div>}

      <main id="main-content" tabIndex={-1}>
        {page === "projects" && <ProjectsView projects={projects} jobs={jobs} health={health} hasSelectedProvider={hasSelectedProvider} onConfigureProviders={openProviders} onCreated={onCreated} onOpen={openProject} onRefresh={refresh} />}
        {page === "library" && <LibraryView />}
        {page === "workspace" && <WorkspaceView key={selected?.id || "none"} project={selected} health={health} hasSelectedProvider={hasSelectedProvider} onConfigureProviders={openProviders} onProjectUpdated={refresh} onGoProjects={() => setPage("projects")} />}
        {page === "shorts-editor" && <ShortsEditorView onJobCreated={refresh} />}
        {page === "ai-video" && <TopicToVideoView profiles={profiles} onConfigureProviders={openProviders} onJobCreated={refresh} />}
        {page === "jobs" && <JobsView onOpenProject={openProject} />}
        {page === "settings" && <SettingsView health={health} onHealthRefresh={refresh} onProfilesChanged={setProfiles} onSkipSetup={() => setPage("projects")} />}
      </main>
    </div>
  </div>;
}
