import { useEffect, useState } from "react";
import { AlertTriangle, Check, Circle, LoaderCircle, Minus } from "lucide-react";
import { formatSeconds } from "../status-format";
import type { JobState, ProcessingStep } from "../types";

function formatElapsed(startedAt: string, now: number) {
  return formatSeconds(Math.max(0, (now - new Date(startedAt).getTime()) / 1000));
}

function stepIcon(status: ProcessingStep["status"]) {
  switch (status) {
    case "complete":
      return <Check size={12} />;
    case "active":
      return <LoaderCircle size={12} />;
    case "skipped":
      return <Minus size={12} />;
    case "failed":
      return <AlertTriangle size={12} />;
    default:
      return <Circle size={12} />;
  }
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
 */
export function ProcessChecklist({ steps, jobState, compact = false, label = "Short creation progress" }: { steps: ProcessingStep[]; jobState?: JobState; compact?: boolean; label?: string }) {
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
  const [prevSnapshot, setPrevSnapshot] = useState<{ steps: ProcessingStep[]; jobState?: JobState } | null>(null);
  const prev = prevSnapshot;

  if (prev) {
    const stepsChanged = prev.steps !== steps;
    const stateChanged = prev.jobState !== jobState;
    if (stepsChanged || stateChanged) {
      const messages: string[] = [];
      const newCompletes = new Set<string>();
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
              } else if (step.status === "skipped") {
                messages.push(`${step.label} skipped`);
              } else if (step.status === "active") {
                messages.push(progress ? `${step.label} ${progress}` : step.label);
              }
            } else if (step.id === "render" && step.status === "active" && progress && before.currentItem !== step.currentItem) {
              messages.push(`${step.label} ${progress}`);
            }
          } else if (step.status === "complete") {
            newCompletes.add(step.id);
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
      setPrevSnapshot({ steps, jobState });
    }
  } else {
    // Initialize the snapshot on the first render so that subsequent prop
    // changes are detected; no announcement on mount.
    setPrevSnapshot({ steps, jobState });
  }

  if (steps.length === 0) return null;

  const headingId = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-heading`;

  return (
    <section className={`checklist-panel${compact ? " compact" : ""}${paused ? " is-paused" : ""}`} aria-labelledby={headingId} data-testid="short-creation-progress">
      <div className="checklist-heading">
        <h2 id={headingId}>{label}</h2>
        <span className="checklist-count">{steps.length} step{steps.length === 1 ? "" : "s"}</span>
      </div>
      <div className="checklist-live sr-only" role="status" aria-live="polite">{announcement}</div>
      <ol className="process-checklist" aria-label={label} data-testid="progress-step-list">
        {steps.map((step) => {
          const active = step.status === "active";
          const progress = itemProgress(step);
          return (
            <li key={step.id} className={`checklist-step status-${step.status}${active ? " active-row" : ""}${step.status === "complete" && freshlyCompleted.has(step.id) ? " checkmark-new" : ""}`} aria-current={active ? "step" : undefined} data-step-id={step.id} data-testid={`progress-step-${step.id}`}>
              <span className="checklist-icon" aria-hidden="true">{stepIcon(step.status)}</span>
              <div className="checklist-step-body">
                <span className="checklist-label" title={step.label}>{step.label}</span>
                <span className="checklist-step-meta">
                  <span className="checklist-status-text">{statusLabel(step.status, paused)}</span>
                  {active && !paused && (step.detail || step.startedAt) && (
                    <span className="checklist-detail" title={step.detail || undefined}>
                      {step.startedAt && <time className="checklist-elapsed">Elapsed {formatElapsed(step.startedAt, now)}</time>}
                      {step.detail && <span className="checklist-detail-text" title={step.detail}>{step.detail}</span>}
                    </span>
                  )}
                  {(step.status === "skipped" || step.status === "failed") && step.detail && (
                    <span className="checklist-detail" title={step.detail}><span className="checklist-detail-text" title={step.detail}>{step.detail}</span></span>
                  )}
                  {progress && <span className="checklist-progress">{progress}</span>}
                </span>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}