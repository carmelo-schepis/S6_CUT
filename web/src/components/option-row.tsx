import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";

/**
 * One collapsible option in the create panel: a row showing its title and
 * current value, which opens its controls inline. The name of the toggle is the
 * title alone; the value is announced as its description. The panel stays
 * mounted and is hidden, so a choice (or a selected file) survives collapsing.
 */
export function OptionRow({ id, title, summary, open, onToggle, children }: {
  id: string;
  title: string;
  summary: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return <div className="create-option">
    <button type="button" className="create-option-toggle" aria-expanded={open} aria-controls={`create-option-${id}-panel`}
      aria-labelledby={`create-option-${id}-title`} aria-describedby={`create-option-${id}-value`} onClick={onToggle}>
      <span id={`create-option-${id}-title`} className="create-option-title">{title}</span>
      <span id={`create-option-${id}-value`} className="create-option-value">{summary}</span>
      <ChevronDown size={16} aria-hidden="true" className="create-option-chevron" />
    </button>
    <div id={`create-option-${id}-panel`} className="create-option-panel" hidden={!open}>{children}</div>
  </div>;
}
