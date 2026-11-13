import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown, LoaderCircle } from "lucide-react";
import { readableError } from "../api";
import type { OpenRouterModel } from "../types";
import { Button } from "./common";

type Phase = "closed" | "blocked" | "scanning" | "ready" | "error";
type Row = { key: string; value: string; name: string; detail: string | null };

/**
 * Searchable model dropdown. Every open starts a new scan, so no earlier list is shown.
 * Picking only changes the field value; the caller decides when to save.
 */
export function ModelPicker({ id, label, hint, value, onChange, disabled = false, placeholder, scan, scanBlocked = null, savedValue = null, autoOption, describe, emptyMessage }: {
  id: string;
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  scan: (signal: AbortSignal) => Promise<OpenRouterModel[]>;
  scanBlocked?: string | null;
  savedValue?: string | null;
  autoOption?: string;
  describe?: (model: OpenRouterModel) => string | null;
  emptyMessage: string;
}) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("closed");
  const [models, setModels] = useState<OpenRouterModel[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState(false);
  const [active, setActive] = useState(-1);
  const controllerRef = useRef<AbortController | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listId = `${id}-options`;
  const hintId = `${id}-hint`;
  const optionId = (index: number) => `${id}-option-${index}`;

  const query = value.trim().toLowerCase();
  const visible = typed && query ? models.filter((model) => model.id.toLowerCase().includes(query) || model.name.toLowerCase().includes(query)) : models;
  const rows: Row[] = [
    ...(autoOption ? [{ key: "auto", value: "", name: autoOption, detail: null }] : []),
    ...visible.map((model) => ({ key: model.id, value: model.id, name: model.name, detail: describe ? describe(model) : null })),
  ];
  const savedMissing = Boolean(savedValue && phase === "ready" && models.length > 0 && !models.some((model) => model.id === savedValue));

  const runScan = () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    // A new scan shows the full list again, so earlier typing does not hide what the provider returns.
    setPhase("scanning"); setModels([]); setError(null); setTyped(false);
    // Called synchronously so the request starts with the open, not a tick later.
    let request: Promise<OpenRouterModel[]>;
    try { request = scan(controller.signal); } catch (cause) { request = Promise.reject(cause); }
    request
      .then((next) => { if (controllerRef.current !== controller) return; setModels(next); setPhase("ready"); })
      .catch((cause: unknown) => {
        if (controllerRef.current !== controller || controller.signal.aborted) return;
        setError(readableError(cause)); setPhase("error");
      });
  };

  const openPicker = () => {
    if (disabled || open) return;
    setOpen(true); setTyped(false); setActive(-1); setError(null); setModels([]);
    wrapRef.current?.scrollIntoView?.({ block: "nearest" });
    if (scanBlocked) { setPhase("blocked"); return; }
    runScan();
  };

  const close = () => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setOpen(false); setPhase("closed"); setModels([]); setActive(-1);
  };

  const pick = (row: Row) => { onChange(row.value); close(); };

  useEffect(() => () => { controllerRef.current?.abort(); }, []);
  useEffect(() => {
    if (active >= 0) document.getElementById(optionId(active))?.scrollIntoView?.({ block: "nearest" });
    // optionId is derived from the stable id prop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) { openPicker(); return; }
      if (rows.length === 0) return;
      setActive((current) => (event.key === "ArrowDown" ? Math.min(current + 1, rows.length - 1) : Math.max(current - 1, 0)));
    } else if (event.key === "Enter") {
      if (open && active >= 0 && rows[active]) { event.preventDefault(); pick(rows[active]); }
    } else if (event.key === "Escape") {
      if (open) { event.preventDefault(); close(); }
    } else if (event.key === "Tab") {
      close();
    }
  };

  const statusText = phase === "blocked" ? scanBlocked
    : phase === "scanning" ? "Scanning models…"
    : phase === "ready" ? (models.length === 0 ? emptyMessage : visible.length === 0 && typed ? "No models match your search." : `${models.length} models found`)
    : null;

  return <div className="field model-picker" ref={wrapRef} onBlur={(event) => { if (!wrapRef.current?.contains(event.relatedTarget as Node | null)) close(); }}>
    <label className="field-label" htmlFor={id}>{label}</label>
    <div className="model-picker-control">
      <input id={id} role="combobox" type="text" value={value} disabled={disabled} placeholder={placeholder} autoComplete="off" spellCheck={false}
        aria-expanded={open} aria-controls={open ? listId : undefined} aria-autocomplete="list" aria-describedby={hintId}
        aria-activedescendant={open && active >= 0 && rows[active] ? optionId(active) : undefined}
        onChange={(event) => { if (!open) openPicker(); setTyped(true); setActive(-1); onChange(event.target.value); }}
        onClick={() => openPicker()} onKeyDown={onKeyDown} />
      <button type="button" className="model-picker-chevron" tabIndex={-1} disabled={disabled}
        aria-label={open ? "Hide models" : "Show models"} onMouseDown={(event) => event.preventDefault()}
        onClick={() => (open ? close() : openPicker())}><ChevronDown size={15} /></button>
      {open && <div className="model-picker-popup">
        {statusText && <p className="model-picker-status" role="status">{phase === "scanning" && <LoaderCircle size={13} className="spin" aria-hidden="true" />}{statusText}</p>}
        {savedMissing && <p className="model-picker-status" role="status">Not found in the latest scan.</p>}
        {phase === "error" && <div className="model-picker-error">
          <p role="alert">{error}</p>
          <Button onClick={() => runScan()}>Try again</Button>
        </div>}
        {phase === "ready" && rows.length > 0 && <ul id={listId} role="listbox" aria-label={label} className="model-picker-list">
          {rows.map((row, index) => <li key={row.key} id={optionId(index)} role="option" aria-selected={row.value === value}
            className={`model-picker-row${index === active ? " is-active" : ""}`}
            onMouseDown={(event) => event.preventDefault()} onClick={() => pick(row)}>
            <span className="model-picker-name">{row.value === value ? <Check size={13} aria-hidden="true" /> : null}<span>{row.name}</span></span>
            {row.detail && <small>{row.detail}</small>}
          </li>)}
        </ul>}
      </div>}
    </div>
    <small id={hintId}>{hint}</small>
  </div>;
}
