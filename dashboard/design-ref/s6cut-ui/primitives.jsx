/* ClippyMe — shared primitives */
const { useState, useEffect, useRef, useCallback, useMemo } = React;

// Lucide icon (app re-runs lucide.createIcons() after each render).
function Icon({ n, cls, style }) {
  return <i data-lucide={n} className={cls} style={style}></i>;
}
function refreshIcons() { if (window.lucide) window.lucide.createIcons(); }

// Brand/social marks via Simple Icons CDN (lucide dropped these).
function Social({ n, color = "white", size = 15, style }) {
  return <img src={`https://cdn.simpleicons.org/${n}/${color}`} width={size} height={size}
    alt={n} style={{ display: "block", ...style }} />;
}

function Btn({ variant = "secondary", size, block, icon, iconRight, children, onClick, disabled, type, style, title }) {
  const cls = ["btn", "btn-" + variant];
  if (size) cls.push("btn-" + size);
  if (block) cls.push("btn-block");
  return (
    <button type={type || "button"} className={cls.join(" ")} onClick={onClick} disabled={disabled} style={style} title={title}>
      {icon && <Icon n={icon} />}{children}{iconRight && <Icon n={iconRight} />}
    </button>
  );
}

function Badge({ tone = "out", icon, children }) {
  return <span className={"badge badge-" + tone}>{icon && <Icon n={icon} />}{children}</span>;
}

function Switch({ on, onChange }) {
  return (
    <button type="button" role="switch" aria-checked={on} className={"sw" + (on ? " on" : "")}
      onClick={(e) => { e.stopPropagation(); onChange && onChange(!on); }}><i></i></button>
  );
}

function Segmented({ options, value, onChange, full, blue, size }) {
  return (
    <div className={"seg" + (full ? " full" : "") + (blue ? " blue" : "")}>
      {options.map((o) => (
        <button key={o.id} type="button" className={value === o.id ? "on" : ""} onClick={() => onChange(o.id)}>
          {o.icon && <Icon n={o.icon} />}{o.label}
        </button>
      ))}
    </div>
  );
}

function Stepper({ value, set, min = 1, max = 12 }) {
  return (
    <div className="stepper">
      <button type="button" onClick={() => set(Math.max(min, value - 1))} aria-label="Decrease">–</button>
      <span>{value}</span>
      <button type="button" onClick={() => set(Math.min(max, value + 1))} aria-label="Increase">+</button>
    </div>
  );
}

function Panel({ title, sub, icon, headRight, pad = true, children, className, style }) {
  return (
    <div className={"panel" + (className ? " " + className : "")} style={style}>
      {title && (
        <div className="panel-head">
          {icon && <div className="ico"><Icon n={icon} /></div>}
          <div>
            <h3>{title}</h3>
            {sub && <div className="sub">{sub}</div>}
          </div>
          {headRight && <div className="right">{headRight}</div>}
        </div>
      )}
      <div className={pad ? "panel-pad" : ""}>{children}</div>
    </div>
  );
}

// Platform pill button (TikTok / Instagram Reels / YouTube Shorts)
const PLATFORMS = [
  { id: "tiktok", icon: "tiktok", label: "TikTok" },
  { id: "ig", icon: "instagram", label: "Reels" },
  { id: "yt", icon: "youtube", label: "Shorts" },
];
function PlatPill({ id, icon, label, on, onClick }) {
  return (
    <button type="button" className={"plat" + (on ? " on " + id : "")} onClick={onClick}>
      <Social n={icon} color={on ? "white" : "7E7E8F"} />{label}
    </button>
  );
}

Object.assign(window, {
  useState, useEffect, useRef, useCallback, useMemo,
  Icon, refreshIcons, Social, Btn, Badge, Switch, Segmented, Stepper, Panel, PLATFORMS, PlatPill,
});
