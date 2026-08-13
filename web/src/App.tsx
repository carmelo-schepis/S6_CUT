import { useCallback, useEffect, useState } from "react";
import { BriefcaseBusiness, Film, FolderKanban, HardDrive, Library, Settings, SlidersHorizontal } from "lucide-react";
import { getHealth, listProjects, readableError } from "./api";
import { JobsView } from "./components/jobs-view";
import { LibraryView } from "./components/library-view";
import { ProjectsView } from "./components/projects-view";
import { SettingsView } from "./components/settings-view";
import { StatusBadge } from "./components/common";
import { WorkspaceView } from "./components/workspace-view";
import type { Health, Project } from "./types";

type Page = "projects" | "library" | "workspace" | "jobs" | "settings";

const nav: { id: Page; label: string; icon: typeof Film }[] = [
  { id: "projects", label: "Projects", icon: FolderKanban },
  { id: "library", label: "Library", icon: Library },
  { id: "workspace", label: "Workspace", icon: SlidersHorizontal },
  { id: "jobs", label: "Jobs", icon: BriefcaseBusiness },
  { id: "settings", label: "Settings", icon: Settings },
];

export function App() {
  const [page, setPage] = useState<Page>("projects");
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [nextProjects, nextHealth] = await Promise.all([listProjects(), getHealth()]);
    setProjects(nextProjects);
    setHealth(nextHealth);
    setSelectedProjectId((current) => current || nextProjects[0]?.id || null);
    setError(null);
  }, []);

  useEffect(() => {
    let active = true;
    Promise.resolve().then(refresh).catch((cause) => { if (active) setError(readableError(cause)); });
    return () => { active = false; };
  }, [refresh]);

  const openProject = (id: string) => {
    setSelectedProjectId(id);
    setPage("workspace");
  };

  const onCreated = (project: Project) => {
    setProjects((current) => [project, ...current.filter((item) => item.id !== project.id)]);
    openProject(project.id);
  };

  const selected = projects.find((project) => project.id === selectedProjectId) || null;

  return <div className="app-shell">
    <aside className="app-rail" aria-label="Primary navigation">
      <button className="brand-button" onClick={() => setPage("projects")} aria-label="S6_cut Projects">
        <img src="/app-icon.png" alt="" />
      </button>
      <nav>
        {nav.map((item) => {
          const Icon = item.icon;
          return <button key={item.id} className={page === item.id ? "nav-item active" : "nav-item"} onClick={() => setPage(item.id)} aria-current={page === item.id ? "page" : undefined}>
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
          {health ? <StatusBadge state={health.status === "ready" ? "local" : "fallback"} label={health.status === "ready" ? "Local engine" : "Fallbacks active"} /> : <StatusBadge state="offline" label="Engine offline" />}
          <span className="save-state"><HardDrive size={14} /> Saved on this machine</span>
        </div>
      </header>

      {error && <div className="global-alert" role="alert"><strong>Engine unavailable.</strong> {error} <button onClick={() => refresh()}>Retry</button></div>}

      <main id="main-content" tabIndex={-1}>
        {page === "projects" && <ProjectsView projects={projects} health={health} onCreated={onCreated} onOpen={openProject} onRefresh={refresh} />}
        {page === "library" && <LibraryView />}
        {page === "workspace" && <WorkspaceView key={selected?.id || "none"} project={selected} onProjectUpdated={refresh} onGoProjects={() => setPage("projects")} />}
        {page === "jobs" && <JobsView onOpenProject={openProject} />}
        {page === "settings" && <SettingsView health={health} onHealthRefresh={refresh} />}
      </main>
    </div>
  </div>;
}
