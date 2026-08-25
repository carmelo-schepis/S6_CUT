import type { ButtonHTMLAttributes, PropsWithChildren, ReactNode } from "react";
import { AlertTriangle, Check, LoaderCircle, WifiOff, XCircle } from "lucide-react";
import type { JobState } from "../types";

export function Button({ className = "", variant = "secondary", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger" }) {
  return <button className={`button button-${variant} ${className}`} {...props} />;
}

export function IconButton({ label, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return <button className="icon-button" aria-label={label} title={label} {...props}>{children}</button>;
}

export function StatusBadge({ state, label }: { state: JobState | "local" | "offline" | "fallback" | "ready"; label?: string }) {
  const normalized = state.replace("_", "-");
  const text = label || state.replace("_", " ");
  const icon = state === "complete" || state === "ready" || state === "local" ? <Check size={12} />
    : state === "failed" ? <XCircle size={12} />
      : state === "offline" ? <WifiOff size={12} />
        : state === "active" || state === "queued" || state === "recovered" ? <LoaderCircle size={12} className="spin" />
          : <AlertTriangle size={12} />;
  return <span className={`status status-${normalized}`}>{icon}<span>{text}</span></span>;
}

export function EmptyState({ icon, title, children, action }: PropsWithChildren<{ icon: ReactNode; title: string; action?: ReactNode }>) {
  return <div className="empty-state">
    <div className="empty-icon" aria-hidden="true">{icon}</div>
    <h2>{title}</h2>
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

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
}
