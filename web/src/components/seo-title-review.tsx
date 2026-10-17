import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Sparkles } from "lucide-react";
import type { TitleApplyItem, TitleKind, TitleSuggestion, TitleSuggestionResponse } from "../types";
import { Button } from "./common";

const kindLabels: Record<TitleKind, string> = { clip: "Clip", source: "Source", project: "Project" };
/** YouTube truncates titles in most surfaces at about 70 characters. */
export const SEO_TITLE_SOFT_LIMIT = 70;
const titleMaxLength = (kind: TitleKind) => kind === "project" ? 160 : 100;
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), summary, [href], [tabindex]:not([tabindex="-1"])';

type Row = { key: string; suggestion: TitleSuggestion; checked: boolean; title: string; description: string; edited: boolean };

const toRows = (suggestions: TitleSuggestion[]): Row[] => suggestions.map((suggestion, index) => ({
  key: `${suggestion.kind}:${suggestion.assetId ?? suggestion.projectId ?? index}`,
  suggestion, checked: true, title: suggestion.suggestedTitle, description: suggestion.suggestedDescription, edited: false,
}));

/** Reviews AI/rule-based title suggestions before any of them is written. */
export function SeoTitleReviewDialog({ result, applying, error, onCancel, onApply }: { result: TitleSuggestionResponse; applying: boolean; error: string | null; onCancel: () => void; onApply: (items: TitleApplyItem[]) => void }) {
  const [rows, setRows] = useState<Row[]>(() => toRows(result.suggestions));
  const dialogRef = useRef<HTMLElement>(null);
  const checkedRows = rows.filter((row) => row.checked);
  const blankTitle = checkedRows.some((row) => !row.title.trim());
  const update = (key: string, patch: Partial<Row>) => setRows((current) => current.map((row) => row.key === key ? { ...row, ...patch } : row));

  useEffect(() => {
    const dialog = dialogRef.current;
    (dialog?.querySelector<HTMLElement>(FOCUSABLE) ?? dialog)?.focus();
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") { event.preventDefault(); if (!applying) onCancel(); return; }
    if (event.key !== "Tab") return;
    const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = focusable[0]; const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  const apply = () => {
    if (!checkedRows.length || blankTitle || applying) return;
    onApply(checkedRows.map(({ suggestion, title, description, edited }) => ({
      kind: suggestion.kind, assetId: suggestion.assetId ?? null, projectId: suggestion.projectId ?? null,
      currentTitle: suggestion.currentTitle, title: title.trim(), description: description.trim(), revision: suggestion.revision ?? null, edited,
    })));
  };

  return <div className="dialog-backdrop" role="presentation"><section ref={dialogRef} className="confirmation-dialog seo-title-dialog" role="dialog" aria-modal="true" aria-labelledby="seo-title-review-heading" data-testid="seo-title-review" tabIndex={-1} onKeyDown={handleKeyDown}>
    <header className="seo-title-dialog-head"><Sparkles size={18} aria-hidden="true" /><h2 id="seo-title-review-heading">Review SEO titles</h2></header>
    <div className="seo-title-dialog-body">
      {!result.aiAvailable && <p className="seo-title-notice" role="note">Connect an OpenRouter profile in Settings to write AI titles; only rule-based project renames are shown.</p>}
      {result.warning && <p className="seo-title-notice" role="note">{result.warning}</p>}
      {rows.length ? <ul className="seo-title-rows">{rows.map((row) => {
        const { suggestion } = row;
        const name = suggestion.currentTitle;
        return <li key={row.key} className={`seo-title-row${row.checked ? "" : " unchecked"}`} data-testid="seo-title-row" data-asset-id={suggestion.assetId ?? undefined} data-project-id={suggestion.projectId ?? undefined}>
          <input type="checkbox" aria-label={`Apply title for ${name}`} checked={row.checked} disabled={applying} onChange={(event) => update(row.key, { checked: event.target.checked })} />
          <div className="seo-title-row-body">
            <div className="seo-title-row-head"><span className="origin-badge">{kindLabels[suggestion.kind]}</span><p className="seo-title-current"><span>Current</span> {name}</p></div>
            <div className="seo-title-field"><input aria-label={`New title for ${name}`} value={row.title} maxLength={titleMaxLength(suggestion.kind)} disabled={applying} aria-invalid={row.checked && !row.title.trim()} onChange={(event) => update(row.key, { title: event.target.value, edited: true })} /><span className={`seo-title-counter${row.title.length > SEO_TITLE_SOFT_LIMIT ? " over" : ""}`}>{row.title.length}/{SEO_TITLE_SOFT_LIMIT}</span></div>
            {suggestion.kind !== "project" && <details className="seo-title-description"><summary>Description</summary><textarea aria-label={`New description for ${name}`} rows={3} maxLength={500} value={row.description} disabled={applying} onChange={(event) => update(row.key, { description: event.target.value, edited: true })} /></details>}
          </div>
        </li>;
      })}</ul> : <p className="seo-title-empty">Nothing to retitle — every selected item already has a reviewed title.</p>}
      {result.skipped.length > 0 && <section className="seo-title-skipped" data-testid="seo-title-skipped" aria-labelledby="seo-title-skipped-heading"><h3 id="seo-title-skipped-heading">Skipped</h3><ul>{result.skipped.map((item, index) => <li key={`${item.assetId ?? item.projectId ?? "skip"}-${index}`}><strong>{item.title}</strong><span>{item.reason}</span></li>)}</ul></section>}
      {result.requests > 0 && <p className="form-hint seo-title-cost">Cost: ${result.costUsd.toFixed(4)} ({result.costKind}){result.model ? ` · ${result.model}` : ""}</p>}
      {blankTitle && <p className="form-hint" role="status">Every ticked row needs a title.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
    <div className="dialog-actions"><Button disabled={applying} onClick={onCancel}>Cancel</Button><Button variant="primary" disabled={applying || !checkedRows.length || blankTitle} aria-busy={applying || undefined} onClick={apply}>{applying ? "Applying…" : `Apply selected (${checkedRows.length})`}</Button></div>
  </section></div>;
}
