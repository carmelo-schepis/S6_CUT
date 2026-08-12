/* ClippyMe — app chrome: TopNav + Hero */

function TopNav({ tab, setTab, busy }) {
  const tabs = [
    { id: "create", label: "Create", icon: "wand-sparkles" },
    { id: "history", label: "History", icon: "clock" },
    { id: "settings", label: "Settings", icon: "settings" },
  ];
  return (
    <header className="topnav">
      <div className="brand">
        <img src="logo-mark.png" alt="ClippyMe" />
        <span>Clippy<span className="me">Me</span></span>
      </div>
      <nav className="tabs">
        {tabs.map((t) => (
          <button key={t.id} className={"tab" + (tab === t.id ? " active" : "")} onClick={() => setTab(t.id)}>
            <Icon n={t.icon} /><span className="lbl">{t.label}</span>
          </button>
        ))}
      </nav>
      <div className="nav-right">
        <span className="status-dot">
          <i style={busy ? { background: "var(--brand-blue)", boxShadow: "0 0 0 3px rgba(10,129,217,.16)" } : null}></i>
          <span className="sd-lbl">{busy ? "Working" : "Local"}</span>
        </span>
        <div className="avatar">CM</div>
      </div>
    </header>
  );
}

function Hero({ eyebrow, line1, grad, sub }) {
  return (
    <div className="hero">
      {eyebrow && <div className="eyebrow"><i></i>{eyebrow}</div>}
      <h1>{line1}{grad && <> <span className="grad">{grad}</span></>}</h1>
      {sub && <p>{sub}</p>}
    </div>
  );
}

Object.assign(window, { TopNav, Hero });
