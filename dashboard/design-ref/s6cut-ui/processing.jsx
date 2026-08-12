/* ClippyMe — ProcessingView: one progress source, vertical pipeline, live log, streaming clips */

function MiniClip({ clip, idx }) {
  return (
    <div className="clip fade-in" style={{ cursor: "default" }}>
      <div className="clip-media" style={{ background: CLIP_GRADS[idx % CLIP_GRADS.length], padding: 10 }}>
        <div className="clip-top"><span className="score" style={{ fontSize: 12, padding: "3px 7px" }}>{clip.score}</span></div>
        <div className="clip-hook" style={{ fontSize: 15 }}>{clip.hook[0]}<br /><span className="y">{clip.hook[1]}</span></div>
        <div className="clip-bottom"><span className="dur">{clip.dur}</span></div>
      </div>
    </div>
  );
}

function ProcessingView({ media, onDone, onCancel }) {
  const [pct, setPct] = useState(0);
  const [logs, setLogs] = useState([]);
  const logRef = useRef(null);
  const shown = useRef(0);

  useEffect(() => {
    const t0 = Date.now();
    const RUN = 8000; // ms
    const id = setInterval(() => {
      const p = Math.min(100, ((Date.now() - t0) / RUN) * 100);
      setPct(p);
      while (shown.current < LOG_SCRIPT.length && LOG_SCRIPT[shown.current].t <= p) {
        const line = LOG_SCRIPT[shown.current];
        const ts = new Date().toLocaleTimeString("en-GB");
        setLogs((L) => [...L, { ts, ...line }]);
        shown.current++;
      }
      if (p >= 100) { clearInterval(id); setTimeout(onDone, 650); }
    }, 80);
    return () => clearInterval(id);
  }, []);

  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; });

  const activeIdx = Math.min(PIPE.length - 1, Math.floor((pct / 100) * PIPE.length));
  // clips stream in after detection (~52%) through finish (~99%)
  const readyCount = pct < 54 ? 0 : Math.min(CLIPS.length, Math.floor(((pct - 54) / 45) * CLIPS.length) + 1);
  const sourceLabel = media?.type === "url" ? media.payload : (media?.payload || "your video");

  return (
    <div className="container fade-in">
      <Hero eyebrow="Pipeline running" line1="Cutting your clips." sub="ClippyMe is working through the pipeline. Clips appear below as soon as they're rendered — no need to wait for the whole batch." />
      <div className="proc">
        {/* vertical pipeline */}
        <aside className="proc-aside">
          <Panel pad={true}>
            <div className="pipe">
              {PIPE.map((s, i) => {
                const done = i < activeIdx || pct >= 100;
                const active = i === activeIdx && pct < 100;
                return (
                  <div key={s.id} className={"pstep" + (done ? " done" : active ? " active" : "")}>
                    <div className="rail">
                      <div className="pdot"><Icon n={done ? "check" : s.icon} /></div>
                      {i < PIPE.length - 1 && <div className="pseg-v"></div>}
                    </div>
                    <div className="pbody">
                      <div className="pname">{s.name}</div>
                      <div className="pmeta">{active ? s.meta + " …" : done ? "done" : s.meta}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </Panel>
        </aside>

        {/* progress + log */}
        <div>
          <Panel pad={true}>
            <div className="pbar-wrap">
              <div className="pbar"><i style={{ width: pct + "%" }}></i></div>
              <div className="pbar-pct tnum">{Math.round(pct)}%</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 16, gap: 10 }}>
              <span className="label" style={{ textTransform: "none", letterSpacing: 0, color: "var(--fg-3)", fontFamily: "var(--font-mono)" }}>
                <span className="mono" style={{ color: "var(--fg-4)" }}>src ·</span> {String(sourceLabel).slice(0, 46)}
              </span>
              <span style={{ marginLeft: "auto" }}>
                <Btn variant="ghost" size="sm" icon="x" onClick={onCancel}>Cancel</Btn>
              </span>
            </div>
            <div className="log" ref={logRef}>
              {logs.map((l, i) => (
                <div key={i} className="ln"><span className="ts">{l.ts}</span> <span className={l.c}>{l.m}</span></div>
              ))}
              {pct < 100 && <div><span className="ts">{new Date().toLocaleTimeString("en-GB")}</span> <span className="cursor"></span></div>}
            </div>
          </Panel>

          <div className="stream-head">
            <h3>Clips</h3>
            {readyCount > 0
              ? <Badge tone="teal" icon="check">{readyCount} ready</Badge>
              : <Badge tone="out">finding moments…</Badge>}
          </div>
          <div className="stream">
            {CLIPS.slice(0, 8).map((c, i) => (
              i < readyCount
                ? <MiniClip key={c.id} clip={c} idx={i} />
                : <div key={c.id} className="slot">{i === readyCount && pct >= 54 ? <div className="sk"></div> : null}</div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { ProcessingView });
