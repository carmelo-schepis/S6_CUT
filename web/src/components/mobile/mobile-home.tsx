import { useEffect, useState } from "react";
import { CircleX, Film, LoaderCircle } from "lucide-react";
import { listRecentClips } from "../../api";
import type { LibraryAsset, MobileOverview } from "../../types";
import { Button, StatusBadge, formatAge } from "../common";
import { headline, workFacts, type MobileTab, type WorkGroups } from "./mobile-model";
import { Poster, RunningRow, type OpenPreview } from "./mobile-parts";

const HOME_RUNNING_LIMIT = 3;
const HOME_RUNS_LIMIT = 4;

type Chip = { key: string; tab: MobileTab; icon: typeof Film; text: string; hint?: string; spin?: boolean };

export function MobileHome({ overview, groups, onOpenTab, onPreview, onReady }: { overview: MobileOverview; groups: WorkGroups; onOpenTab: (tab: MobileTab) => void; onPreview: OpenPreview; onReady?: () => void }) {
  const [clips, setClips] = useState<{ items: LibraryAsset[]; total: number } | null>(null);
  const lastFinished = overview.recent[0];
  // The strip is refetched when a run finishes or a clip is published, not on every poll.
  const refreshKey = `${lastFinished?.id ?? ""}:${lastFinished?.updatedAt ?? ""}:${overview.clipsLastDay}`;
  useEffect(() => {
    let cancelled = false;
    void listRecentClips({ pageSize: 12 })
      .then((page) => { if (!cancelled) setClips({ items: page.items, total: page.total }); })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) onReady?.(); });
    return () => { cancelled = true; };
  }, [refreshKey, onReady]);

  const { title, detail } = headline(groups);
  const chips: Chip[] = [];
  if (groups.running.length) chips.push({ key: "running", tab: "jobs", icon: LoaderCircle, text: `${groups.running.length} running`, spin: true });
  if (overview.clipsLastDay) chips.push({ key: "clips", tab: "library", icon: Film, text: `${overview.clipsLastDay} new clip${overview.clipsLastDay === 1 ? "" : "s"}`, hint: " in the last 24 hours" });
  if (overview.failedLastDay) chips.push({ key: "failed", tab: "jobs", icon: CircleX, text: `${overview.failedLastDay} failed`, hint: " in the last 24 hours" });

  const running = groups.running.slice(0, HOME_RUNNING_LIMIT);
  const runs = groups.finished.slice(0, HOME_RUNS_LIMIT);
  const hasContent = running.length > 0 || runs.length > 0 || Boolean(clips?.items.length);

  return <div className="m-page m-home">
    <section className="m-hero" aria-labelledby="m-home-title">
      <img className="m-hero-mark" src="/app-icon.png" alt="" />
      <h1 id="m-home-title">{title}</h1>
      <p className="m-muted">{detail}</p>
      {chips.length > 0 && <div className="m-chips">
        {chips.map((chip) => {
          const Icon = chip.icon;
          return <Button key={chip.key} className="m-chip" onClick={() => onOpenTab(chip.tab)}>
            <Icon size={14} className={chip.spin ? "spin" : undefined} aria-hidden="true" />
            <span>{chip.text}{chip.hint && <span className="sr-only">{chip.hint}</span>}</span>
          </Button>;
        })}
      </div>}
    </section>

    {running.length > 0 && <section className="m-section m-running" aria-labelledby="m-home-running">
      <div className="m-section-head"><h2 id="m-home-running">Running now</h2><button type="button" className="m-link" onClick={() => onOpenTab("jobs")}>Jobs ›</button></div>
      <div className="m-list">{running.map((item) => <RunningRow key={item.key} item={item} onOpen={() => onOpenTab("jobs")} />)}</div>
    </section>}

    {runs.length > 0 && <section className="m-section m-runs" aria-labelledby="m-home-runs">
      <div className="m-section-head"><h2 id="m-home-runs">Recent runs</h2><button type="button" className="m-link" onClick={() => onOpenTab("jobs")}>All jobs ›</button></div>
      <div className="m-list">
        {runs.map((item) => {
          const facts = workFacts(item);
          return <button key={item.key} type="button" className="m-run" onClick={() => onOpenTab("jobs")}>
            <strong className="m-clamp-1">{facts.title}</strong>
            <StatusBadge state={facts.state} />
            <span className="m-muted m-age">{formatAge(item.at)}</span>
          </button>;
        })}
      </div>
    </section>}

    {clips && clips.items.length > 0 && <section className="m-section m-clips" aria-labelledby="m-home-clips">
      <div className="m-section-head"><h2 id="m-home-clips">Recent clips</h2><span className="m-count">{clips.total}</span><button type="button" className="m-link" onClick={() => onOpenTab("library")}>Library ›</button></div>
      <ul className="m-shelf">
        {clips.items.map((asset) => <li key={asset.id}>
          <button type="button" className="m-shelf-item" aria-label={`Preview ${asset.title}`} disabled={!asset.previewUrl}
            onClick={(event) => onPreview(asset, event.currentTarget)}>
            <Poster src={asset.thumbnailUrl} />
            <strong className="m-clamp">{asset.title}</strong>
            <span className="m-muted">Generated clip</span>
          </button>
        </li>)}
      </ul>
    </section>}

    {!hasContent && <p className="m-empty m-muted">Nothing to show yet. Start a project in the desktop app and its progress and clips will appear here.</p>}
  </div>;
}
