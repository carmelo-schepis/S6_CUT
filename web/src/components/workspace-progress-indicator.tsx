type WorkspaceProgressIndicatorProps = {
  value: number;
  isProcessing: boolean;
  label: string;
};

export function WorkspaceProgressIndicator({ value, isProcessing, label }: WorkspaceProgressIndicatorProps) {
  const displayValue = Math.max(0, Math.floor(value));
  return <span
    className={`nav-work-progress${isProcessing ? " is-processing" : ""}`}
    role="img"
    aria-label={label}
    data-testid="workspace-work-progress"
    data-progress-value={displayValue}
    data-digits={Math.min(String(displayValue).length, 3)}
  >
    <svg className="nav-work-progress-ring" viewBox="0 0 28 28" aria-hidden="true" focusable="false" data-testid={isProcessing ? "workspace-work-spinner" : undefined}>
      <circle className="nav-work-progress-track" cx="14" cy="14" r="12" pathLength="100" strokeWidth={2} />
      <circle className="nav-work-progress-indicator" cx="14" cy="14" r="12" pathLength="100" strokeWidth={2} strokeLinecap="round" />
    </svg>
    <span className="nav-work-progress-value" data-testid="workspace-work-count" aria-hidden="true">{displayValue}</span>
  </span>;
}
