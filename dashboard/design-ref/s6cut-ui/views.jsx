/* ClippyMe — HistoryView, SettingsView, ApiKeyModal */

function HistoryView({ history, onOpen, onDelete, onClear }) {
  if (!history.length) {
    return (
      <div className="container narrow fade-in">
        <Hero eyebrow="History" line1="Nothing here yet." sub="Every job you run shows up here — ready to reopen, re-export, or publish again." />
        <div className="empty">
          <div className="ei"><Icon n="clock" /></div>
          <h3>No jobs yet</h3>
          <p>Head to Create, paste a link, and your finished clips will land here.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="container narrow fade-in">
      <div className="results-head" style={{ marginBottom: 18 }}>
        <h2>History</h2>
        <Badge tone="out">{history.length} jobs</Badge>
        <div className="rh-right">
          <Btn variant="ghost" size="sm" icon="trash-2" onClick={onClear}>Clear all</Btn>
        </div>
      </div>
      <Panel pad={false} className="hlist">
        {history.map((h) => (
          <div className="hrow" key={h.id} onClick={() => onOpen(h)}>
            <div className="hthumb" style={{ background: CLIP_GRADS[h.grad % CLIP_GRADS.length] }}>{h.score}</div>
            <div style={{ minWidth: 0 }}>
              <div className="ht">{h.source}</div>
              <div className="hm">
                <Icon n={h.platform === "url" ? "globe" : "file-video"} style={{ width: 11, height: 11, verticalAlign: "-1px", marginRight: 5 }} />
                {h.clips} clips · ${h.cost} · {h.when}
              </div>
            </div>
            <div className="hr">
              {h.published ? <Badge tone="teal" icon="check">published</Badge> : <Badge tone="amber" icon="clock">draft</Badge>}
              <span className="mini" title="Delete" onClick={(e) => { e.stopPropagation(); onDelete(h.id); }}><Icon n="trash-2" /></span>
              <Icon n="chevron-right" style={{ width: 18, height: 18, color: "var(--fg-4)" }} />
            </div>
          </div>
        ))}
      </Panel>
    </div>
  );
}

function KeyRow({ icon, name, desc, value, set, connected, placeholder }) {
  const [reveal, setReveal] = useState(false);
  return (
    <div className="keyrow">
      <div className="ki"><Icon n={icon} /></div>
      <div style={{ minWidth: 0 }}>
        <div className="kt">{name}</div>
        <div className="kd">{desc}</div>
      </div>
      <div className="kr">
        {connected && !value ? null : null}
        <input className="key-input" type={reveal ? "text" : "password"} value={value}
          placeholder={placeholder} onChange={(e) => set(e.target.value)} />
        <span className="mini" title={reveal ? "Hide" : "Show"} onClick={() => setReveal(!reveal)}><Icon n={reveal ? "eye-off" : "eye"} /></span>
        {value ? <Badge tone="teal" icon="check">set</Badge> : <Badge tone="out">empty</Badge>}
      </div>
    </div>
  );
}

function SettingsView() {
  const [gemini, setGemini] = useState("");
  const [deepgram, setDeepgram] = useState("");
  const [hf, setHf] = useState("");
  const [zernio, setZernio] = useState(false);
  const [cookies, setCookies] = useState(true);
  return (
    <div className="container narrow fade-in">
      <Hero eyebrow="Settings" line1="Keys & connections." sub="Everything is stored locally. Your keys never leave your machine." />

      <Panel title="API keys" sub="Required for transcription & moment detection" icon="key-round" style={{ marginBottom: 18 }}>
        <KeyRow icon="sparkles" name="Gemini" desc="Viral-moment detection" value={gemini} set={setGemini} placeholder="AIza…" />
        <KeyRow icon="audio-lines" name="Deepgram" desc="Nova-3 transcription" value={deepgram} set={setDeepgram} placeholder="dg_…" />
        <KeyRow icon="scan-face" name="Hugging Face token" desc="Speaker diarization models" value={hf} set={setHf} placeholder="hf_…" />
      </Panel>

      <Panel title="Publishing" sub="Push finished clips to socials" icon="send" style={{ marginBottom: 18 }}>
        <div className="zernio-card">
          <div className="zico"><Icon n="rss" /></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="kt">Zernio</div>
            <div className="kd">{zernio ? "Connected · scheduling to TikTok, Reels & Shorts" : "Connect to schedule prime-time posts"}</div>
          </div>
          {zernio
            ? <span className="conn"><Icon n="circle-check" />Connected</span>
            : <Btn variant="primary" size="sm" icon="link" onClick={() => setZernio(true)}>Connect</Btn>}
        </div>
      </Panel>

      <Panel title="Downloads" sub="For age- or region-restricted sources" icon="cookie">
        <div className="opt" style={{ borderBottom: 0 }}>
          <div className="oico"><Icon n="cookie" /></div>
          <div className="otxt"><div className="ot">YouTube cookies</div><div className="od">{cookies ? "Configured · restricted videos OK" : "Not set · public videos only"}</div></div>
          <div className="r"><Switch on={cookies} onChange={setCookies} /></div>
        </div>
      </Panel>
    </div>
  );
}

function ApiKeyModal({ onClose, onGoToSettings }) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h3>Add your Gemini key</h3><button className="x" onClick={onClose}><Icon n="x" /></button></div>
        <div className="modal-body">
          <p style={{ color: "var(--fg-2)", fontSize: 14, lineHeight: 1.55 }}>
            ClippyMe needs a Gemini key to score the transcript and find viral moments. It's stored locally and never leaves your machine.
          </p>
        </div>
        <div className="modal-foot">
          <Btn variant="ghost" onClick={onClose}>Later</Btn>
          <div className="mf-right"><Btn variant="primary" icon="settings" onClick={onGoToSettings}>Open settings</Btn></div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { HistoryView, SettingsView, ApiKeyModal });
