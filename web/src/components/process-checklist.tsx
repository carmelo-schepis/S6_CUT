import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { formatSeconds, statesCount } from "../status-format";
import type { JobState, ProcessingStep } from "../types";

function formatElapsed(startedAt: string, now: number) {
  return formatSeconds(Math.max(0, (now - new Date(startedAt).getTime()) / 1000));
}

/**
 * One drawing per step: the ring and its mark share a single 16px box, so no
 * status ever sits inside a second ring. Each state is one SVG with the ring at
 * cx=8 cy=8 r=7. The active step is the exception: a conic-gradient comet and a
 * pulsing dot are CSS on top of the same ring (see the checklist section of
 * styles.css), because the comet's mask cannot be drawn in SVG.
 */
function StepIndicator({ status, paused }: { status: ProcessingStep["status"]; paused: boolean }) {
  if (status === "active" && !paused) {
    return (
      <span className="step-indicator step-active" data-step-icon="active">
        <svg className="step-ring-svg" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <circle className="step-ring" cx="8" cy="8" r="7" />
        </svg>
        <span className="step-comet" />
        <span className="step-dot" />
      </span>
    );
  }
  const state = status === "active" ? "paused" : status;
  return (
    <svg className="step-indicator" data-step-icon={state} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle className="step-ring" cx="8" cy="8" r="7" />
      {state === "complete" && <path className="step-mark" d="M4.9 8.3 7 10.4l4.1-4.6" />}
      {state === "skipped" && <path className="step-mark" d="M5.25 8h5.5" />}
      {state === "failed" && <path className="step-mark" d="M8 4.75v3.75M8 11.25v.01" />}
      {state === "paused" && (
        <>
          <circle className="step-arc" cx="8" cy="8" r="7" strokeDasharray="11 33" transform="rotate(-90 8 8)" />
          <path className="step-mark" d="M6.5 5.8v4.4M9.5 5.8v4.4" />
        </>
      )}
    </svg>
  );
}

function itemProgress(step: ProcessingStep) {
  return ["active", "complete"].includes(step.status) && step.totalItems != null && step.totalItems > 0 && step.currentItem != null
    ? `${step.currentItem} of ${step.totalItems}`
    : null;
}

function statusLabel(status: ProcessingStep["status"], paused: boolean) {
  if (status === "active" && paused) return "Paused";
  switch (status) {
    case "active": return "In progress";
    case "complete": return "Complete";
    case "skipped": return "Skipped";
    case "failed": return "Failed";
    default: return "Pending";
  }
}

/**
 * Renders engine-reported processing steps as an accessible ordered list.
 * It is a pure view over API state: a checkmark appears only for a step the
 * engine reported as `complete`, and elapsed time is derived only from the
 * active step's real `startedAt`. It never infers completion from item
 * counts, progress values, or elapsed time.
 *
 * `compact` is the iPhone/iPad status view's plain-row version; it also leaves
 * out an item count the step's own detail already states ("575s of 1161s").
 *
 * Three opt-in props (all off by default) serve the Workspace page:
 * `summary` takes the heading row in place of the visible title (the title
 * stays in the DOM as screen-reader text, so the region keeps its name);
 * `collapsible` keeps the steps closed until asked for, except that a failed
 * step opens them; `quiet` drops the active row's detail and the "x of y"
 * counts the summary already carries.
 */
export function ProcessChecklist({ steps, jobState, compact = false, label = "Short creation progress", summary, collapsible = false, quiet = false }: { steps: ProcessingStep[]; jobState?: JobState; compact?: boolean; label?: string; summary?: ReactNode; collapsible?: boolean; quiet?: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  const paused = jobState === "paused";

  // Tick elapsed only while an active step with startedAt exists and is not paused.
  const hasActiveStartedAt = steps.some((step) => step.status === "active" && step.startedAt);
  useEffect(() => {
    if (paused || !hasActiveStartedAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasActiveStartedAt, paused]);

  // Announcement and checkmark-animation state, adjusted during render (not via effect)
  // when props change. This follows the React docs pattern documented at
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  const [announcement, setAnnouncement] = useState("");
  const [freshlyCompleted, setFreshlyCompleted] = useState<Set<string>>(() => new Set());
  // Skipped and failed steps settle in once, the first time they arrive live.
  const [freshlySettled, setFreshlySettled] = useState<Set<string>>(() => new Set());
  // A finished run folds to one line; the steps stay one click away.
  const [stepsOpen, setStepsOpen] = useState(false);
  // Collapsible panels use a tri-state: null means "no choice yet", so the
  // default (closed, or open on a failure) can follow the steps until the user
  // decides.
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const [prevSnapshot, setPrevSnapshot] = useState<{ steps: ProcessingStep[]; jobState?: JobState } | null>(null);
  const prev = prevSnapshot;

  if (prev) {
    const stepsChanged = prev.steps !== steps;
    const stateChanged = prev.jobState !== jobState;
    if (stepsChanged || stateChanged) {
      const messages: string[] = [];
      const newCompletes = new Set<string>();
      const newSettles = new Set<string>();
      if (stepsChanged) {
        for (const step of steps) {
          const before = prev.steps.find((item) => item.id === step.id);
          const progress = itemProgress(step);
          if (before) {
            if (before.status !== step.status) {
              if (step.status === "complete") {
                messages.push(step.label);
                newCompletes.add(step.id);
              } else if (step.status === "failed") {
                messages.push(`${step.label} failed`);
                newSettles.add(step.id);
              } else if (step.status === "skipped") {
                messages.push(`${step.label} skipped`);
                newSettles.add(step.id);
              } else if (step.status === "active") {
                messages.push(progress ? `${step.label} ${progress}` : step.label);
              }
            } else if (step.id === "render" && step.status === "active" && progress && before.currentItem !== step.currentItem) {
              messages.push(`${step.label} ${progress}`);
            }
          } else if (step.status === "complete") {
            newCompletes.add(step.id);
          } else if (step.status === "failed" || step.status === "skipped") {
            newSettles.add(step.id);
          }
        }
      }
      if (stateChanged) {
        if (jobState === "paused") messages.push("Processing paused");
        else if (prev.jobState === "paused") messages.push("Processing resumed");
      }
      if (messages.length) setAnnouncement(messages.join(". "));
      if (newCompletes.size) {
        setFreshlyCompleted((current) => {
          const next = new Set(current);
          for (const id of newCompletes) next.add(id);
          return next;
        });
      }
      if (newSettles.size) {
        setFreshlySettled((current) => {
          const next = new Set(current);
          for (const id of newSettles) next.add(id);
          return next;
        });
      }
      setPrevSnapshot({ steps, jobState });
    }
  } else {
    // Initialize the snapshot on the first render so that subsequent prop
    // changes are detected; no announcement on mount.
    setPrevSnapshot({ steps, jobState });
  }

  if (steps.length === 0) return null;

  const headingId = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-heading`;
  const listId = `${headingId}-steps`;
  const finished = steps.every((step) => step.status === "complete" || step.status === "skipped");
  const hasFailed = steps.some((step) => step.status === "failed");
  const activeIndex = steps.findIndex((step) => step.status === "active");
  const folded = collapsible ? !(userOpen ?? hasFailed) : finished && !stepsOpen;
  const completeCount = steps.filter((step) => step.status === "complete").length;
  const countText = finished ? `${completeCount} of ${steps.length} complete`
    : collapsible && activeIndex >= 0 ? `Step ${activeIndex + 1} of ${steps.length}`
      : `${steps.length} step${steps.length === 1 ? "" : "s"}`;

  return (
    <section className={`checklist-panel${compact ? " compact" : ""}${collapsible ? " is-collapsible" : ""}${paused ? " is-paused" : ""}`} aria-labelledby={headingId} data-testid="short-creation-progress">
      <div className="checklist-heading">
        <h2 id={headingId} className={summary ? "sr-only" : undefined}>{label}</h2>
        {summary}
        <span className="checklist-count">{countText}</span>
        {collapsible && <button type="button" className="checklist-toggle checklist-toggle-chevron" aria-label={folded ? "Show steps" : "Hide steps"} title={folded ? "Show steps" : "Hide steps"} aria-expanded={!folded} aria-controls={listId} onClick={() => setUserOpen(folded)}><ChevronDown size={16} aria-hidden="true" className="checklist-chevron" /></button>}
        {!collapsible && finished && <button type="button" className="checklist-toggle" aria-expanded={!folded} aria-controls={listId} onClick={() => setStepsOpen((open) => !open)}>{folded ? "Show steps" : "Hide steps"}</button>}
      </div>
      <div className="checklist-live sr-only" role="status" aria-live="polite">{announcement}</div>
      <ol id={listId} className="process-checklist" aria-label={label} data-testid="progress-step-list" hidden={folded}>
        {steps.map((step) => {
          const active = step.status === "active";
          const progress = itemProgress(step);
          const shownProgress = quiet && (active || step.status === "complete") ? null : compact && statesCount(step.detail, step.currentItem) ? null : progress;
          return (
            <li key={step.id} className={`checklist-step status-${step.status}${active ? " active-row" : ""}${step.status === "complete" && freshlyCompleted.has(step.id) ? " checkmark-new" : ""}${(step.status === "skipped" || step.status === "failed") && freshlySettled.has(step.id) ? " settle-new" : ""}`} aria-current={active ? "step" : undefined} data-step-id={step.id} data-testid={`progress-step-${step.id}`}>
              <span className="checklist-icon" aria-hidden="true"><StepIndicator status={step.status} paused={paused} /></span>
              <div className="checklist-step-body">
                <span className="checklist-label" title={step.label}>{step.label}</span>
                <span className="checklist-step-meta">
                  <span className="checklist-status-text">{statusLabel(step.status, paused)}</span>
                  {active && !paused && (quiet ? step.startedAt : (step.detail || step.startedAt)) && (
                    <span className="checklist-detail" title={quiet ? undefined : step.detail || undefined}>
                      {step.startedAt && <time className="checklist-elapsed">Elapsed {formatElapsed(step.startedAt, now)}</time>}
                      {!quiet && step.detail && <span className="checklist-detail-text" title={step.detail}>{step.detail}</span>}
                    </span>
                  )}
                  {(step.status === "skipped" || step.status === "failed") && step.detail && (
                    <span className="checklist-detail" title={step.detail}><span className="checklist-detail-text" title={step.detail}>{step.detail}</span></span>
                  )}
                  {shownProgress && <span className="checklist-progress">{shownProgress}</span>}
                </span>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}