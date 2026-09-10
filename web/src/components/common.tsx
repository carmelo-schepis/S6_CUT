import { useCallback, useRef, useState, type ButtonHTMLAttributes, type PropsWithChildren, type ReactNode } from "react";
import { AlertTriangle, Check, LoaderCircle, WifiOff, XCircle } from "lucide-react";
import { groupWarnings } from "../status-format";
import type { ContentFormat, JobState } from "../types";

export { formatBytes, formatSeconds, sentenceCase } from "../status-format";

export function Button({ className = "", variant = "secondary", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger" }) {
  return <button className={`button button-${variant} ${className}`} {...props} />;
}

export function IconButton({ label, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return <button className="icon-button" aria-label={label} title={label} {...props}>{children}</button>;
}

export function StatusBadge({ state, label }: { state: JobState | "local" | "offline" | "fallback" | "ready" | "checking"; label?: string }) {
  const normalized = state.replace("_", "-");
  const text = label || state.replace("_", " ");
  const icon = state === "complete" || state === "ready" || state === "local" ? <Check size={12} />
    : state === "failed" ? <XCircle size={12} />
      : state === "offline" ? <WifiOff size={12} />
        : state === "checking" ? <LoaderCircle size={12} className="spin" />
        : state === "active" || state === "queued" || state === "recovered" ? <LoaderCircle size={12} className="spin" />
          : <AlertTriangle size={12} />;
  return <span className={`status status-${normalized}`}>{icon}<span>{text}</span></span>;
}

/**
 * `headingLevel` exists because an empty state is sometimes the *only* thing a
 * screen renders. On those screens its title is the page title and must be the
 * `<h1>`; everywhere else it sits under a `PageHeader` and stays an `<h2>`.
 */
export function EmptyState({ icon, title, children, action, headingLevel = 2 }: PropsWithChildren<{ icon: ReactNode; title: string; action?: ReactNode; headingLevel?: 1 | 2 }>) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  return <div className="empty-state">
    <div className="empty-icon" aria-hidden="true">{icon}</div>
    <Heading>{title}</Heading>
    <div className="muted empty-copy">{children}</div>
    {action}
  </div>;
}

export function Progress({ value, label, indeterminate = false }: { value: number; label: string; indeterminate?: boolean }) {
  return <div className={`progress-wrap${indeterminate ? " indeterminate" : ""}`} aria-label={indeterminate ? `${label}: percentage unavailable` : `${label}: ${Math.round(value)}%`}>
    <div className="progress-track"><span style={indeterminate ? undefined : { width: `${Math.max(0, Math.min(100, value))}%` }} /></div>
    <span>{indeterminate ? "—" : `${Math.round(value)}%`}</span>
  </div>;
}

export function Field({ label, hint, children }: PropsWithChildren<{ label: string; hint?: string }>) {
  return <label className="field"><span className="field-label">{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode }) {
  return <header className="page-header">
    <div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1>{description && <p>{description}</p>}</div>
    {actions && <div className="header-actions">{actions}</div>}
  </header>;
}

export function formatAge(value: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export const outputAspectRatios = ["9:16", "1:1", "16:9", "4:5"] as const;
export type OutputAspectRatio = typeof outputAspectRatios[number];

/**
 * Resolve the aspect ratio shown for a rendered output. Published output
 * metadata is preferred, then validated dimensions, with the old project
 * content format as a safe fallback for records created before output
 * dimensions were persisted.
 */
export function resolveOutputAspectRatio(aspect: string | null | undefined, width: number | null | undefined, height: number | null | undefined, fallback: ContentFormat | undefined): OutputAspectRatio {
  const persisted = outputAspectRatios.find((candidate) => candidate === aspect?.trim());
  if (persisted) return persisted;
  if (width && height) {
    const ratio = width / height;
    const closest = outputAspectRatios.reduce((best, candidate) => {
      const [candidateWidth, candidateHeight] = candidate.split(":").map(Number);
      const distance = Math.abs(ratio - candidateWidth / candidateHeight);
      return distance < best.distance ? { candidate, distance } : best;
    }, { candidate: "9:16" as OutputAspectRatio, distance: Number.POSITIVE_INFINITY });
    if (closest.distance / ratio <= 0.02) return closest.candidate;
  }
  return fallback === "long" ? "16:9" : "9:16";
}

export function formatDimensions(aspect: string | null | undefined, width: number | null | undefined, height: number | null | undefined): string {
  const requested = aspect || "9:16";
  return width && height ? `${requested} · ${width} × ${height} px` : `${requested} · dimensions unavailable`;
}

export function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
}

/**
 * Groups repeated engine warnings into one bounded panel instead of rendering
 * one full-width strip per clip. Only the first few rows are shown until the
 * reader asks for the rest, so a five-clip job cannot push the workspace
 * content below the fold.
 */
export function WarningList({ warnings, label = "Processing notes" }: { warnings: string[]; label?: string }) {
  const [expanded, setExpanded] = useState(false);
  const groups = groupWarnings(warnings);
  if (!groups.length) return null;
  const visible = expanded ? groups : groups.slice(0, 3);
  const hidden = groups.length - visible.length;
  return <section className="notice-panel" aria-label={label}>
    <div className="notice-panel-head">
      <AlertTriangle size={13} aria-hidden="true" />
      <strong>{label}</strong>
      <span className="notice-count">{groups.length}</span>
    </div>
    <ul className="notice-list">
      {visible.map((group) => <li key={group.message}>
        {group.scope && <span className="notice-scope">{group.scope}</span>}
        <span className="notice-message">{group.message}</span>
      </li>)}
    </ul>
    {hidden > 0 && <button type="button" className="notice-more" onClick={() => setExpanded(true)}>Show {hidden} more</button>}
    {expanded && groups.length > 3 && <button type="button" className="notice-more" onClick={() => setExpanded(false)}>Show fewer</button>}
  </section>;
}

/**
 * A titled block of related controls. Replaces long undifferentiated field
 * stacks with a scannable group that carries its own heading and spacing.
 */
export function FieldGroup({ title, hint, children, columns = 1, headingLevel = 3 }: PropsWithChildren<{ title: string; hint?: string; columns?: 1 | 2; headingLevel?: 2 | 3 }>) {
  // Screens that place field groups directly under the page `<h1>` pass level 2
  // so the outline does not jump h1 -> h3. The visual treatment is carried by
  // `.field-group-head`, not by the tag, so nothing changes on screen.
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return <section className="field-group" aria-label={title}>
    <div className="field-group-head"><Heading>{title}</Heading>{hint && <p className="field-group-hint">{hint}</p>}</div>
    <div className={columns === 2 ? "field-group-body two-up" : "field-group-body"}>{children}</div>
  </section>;
}

/** Neutral placeholder shown while first data is still loading. */
export function Skeleton({ rows = 3, className = "" }: { rows?: number; className?: string }) {
  return <div className={`skeleton ${className}`.trim()} aria-hidden="true">
    {Array.from({ length: rows }, (_, index) => <span key={index} />)}
  </div>;
}

/**
 * Guards an expensive or state-changing action against re-entrant calls.
 * Disabling a button through React state is not enough on its own: a fast
 * double-click can dispatch both events before the disabled state is applied,
 * which would create two jobs from one customer intent.
 */
export function useSingleFlight() {
  const inFlight = useRef(false);
  return useCallback(async (action: () => Promise<unknown>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    try { await action(); } finally { inFlight.current = false; }
  }, []);
}

/**
 * The numbered badge used by every workflow step.
 *
 * One component so the geometry is defined once: a fixed 24px circle that never
 * shrinks, stretches, clips or turns oval, whatever the heading beside it does.
 * The badge deliberately does not inherit the heading's type — its digit is
 * General text at weight 500 with `line-height: 1`, so a single- and a
 * double-digit value are both optically centred.
 */
export function StepBadge({ step }: { step: number | string }) {
  return <span className="step-badge">{step}</span>;
}
