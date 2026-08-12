/* ClippyMe — PublishModal: setup → CONCURRENT upload progress → done */

const PLAT_META = { tiktok: { icon: "tiktok", label: "TikTok" }, ig: { icon: "instagram", label: "Reels" }, yt: { icon: "youtube", label: "Shorts" } };

function PubProgressRow({ clip, idx, plats, progress }) {
  const tasks = Object.keys(plats).filter((k) => plats[k]);
  const allDone = tasks.every((p) => (progress[clip.id + ":" + p] || 0) >= 100);
  return (
    <div className={"pubrow" + (allDone ? " done" : "")}>
      <div className="pthumb" style={{ background: CLIP_GRADS[idx % CLIP_GRADS.length] }}></div>
      <div className="pinfo">
        <div className="pttl">{clip.title}</div>
        <div className="pplats">
          {tasks.map((p) => {
            const v = Math.round(progress[clip.id + ":" + p] || 0);
            const done = v >= 100;
            const started = v > 0;
            return (
              <div className="pp" key={p}>
                <Social n={PLAT_META[p].icon} color={done ? "02C5BF" : "7E7E8F"} size={13} />
                <div className="ptrack"><i className={p} style={{ width: v + "%" }}></i></div>
                <span className={"pstat" + (done ? " done" : started ? "" : " wait")}>{done ? "live" : started ? v + "%" : "queued"}</span>
              </div>
            );
          })}
        </div>
      </div>
      <div className="pcheck"><Icon n={allDone ? "check" : "loader"} /></div>
    </div>
  );
}

function PublishModal({ clips, onClose, onScheduled }) {
  const all = clips.length > 1;
  const [plats, setPlats] = useState({ tiktok: true, ig: true, yt: false });
  const [schedule, setSchedule] = useState(true);
  const [caption, setCaption] = useState("This changed everything for me 👀 #shorts #viral #fyp");
  const [stage, setStage] = useState("setup"); // setup | uploading | done
  const [progress, setProgress] = useState({});
  const toggle = (k) => setPlats((p) => ({ ...p, [k]: !p[k] }));
  const anyPlat = Object.values(plats).some(Boolean);

  // Concurrent upload simulation — every clip×platform task runs in a worker
  // pool at once. Daily-limit bookkeeping stays serial (note below), but the
  // network uploads overlap instead of blocking each other.
  const runUploads = () => {
    setStage("uploading");
    const tasks = [];
    clips.forEach((c, ci) => Object.keys(plats).filter((k) => plats[k]).forEach((p, pi) => {
      tasks.push({ key: c.id + ":" + p, start: (ci * 90 + pi * 140) % 700, dur: 1500 + ((c.id * 37 + pi * 53) % 1200) });
    }));
    const t0 = Date.now();
    const id = setInterval(() => {
      const el = Date.now() - t0;
      const next = {};
      let allDone = true;
      tasks.forEach((t) => {
        const v = Math.max(0, Math.min(100, ((el - t.start) / t.dur) * 100));
        next[t.key] = v;
        if (v < 100) allDone = false;
      });
      setProgress(next);
      if (allDone) { clearInterval(id); setTimeout(() => { setStage("done"); onScheduled && onScheduled(); }, 400); }
    }, 60);
  };

  const submit = () => { if (schedule) { setStage("done"); onScheduled && onScheduled(); } else { runUploads(); } };

  const title = stage === "done" ? (schedule ? "Scheduled" : "Published")
    : all ? `Publish ${clips.length} clips` : `Publish · ${clips[0]?.title || ""}`;

  return (
    <div className="overlay" onClick={onClose}>
      <div className={"modal" + (all ? " wide" : "")} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h3>{title}</h3>
            {stage === "uploading" && <div className="mh-sub">uploading concurrently · daily-limit checks in order</div>}
          </div>
          <button className="x" onClick={onClose}><Icon n="x" /></button>
        </div>

        {stage === "setup" && (
          <>
            <div className="modal-body">
              <div className="field">
                <span className="field-label">Platforms</span>
                <div className="plats">
                  {PLATFORMS.map((p) => <PlatPill key={p.id} {...p} on={plats[p.id]} onClick={() => toggle(p.id)} />)}
                </div>
              </div>
              <div className="field">
                <span className="field-label">Caption</span>
                <textarea className="ta" rows="3" value={caption} onChange={(e) => setCaption(e.target.value)}></textarea>
              </div>
              <div className="opt" style={{ borderBottom: 0 }}>
                <div className="oico"><Icon n="calendar-clock" /></div>
                <div className="otxt"><div className="ot">Schedule for prime time</div><div className="od">Zernio · 20:30 CET tonight</div></div>
                <div className="r"><Switch on={schedule} onChange={setSchedule} /></div>
              </div>
            </div>
            <div className="modal-foot">
              <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
              <div className="mf-right">
                <Btn variant="secondary" icon="send" disabled={!anyPlat} onClick={() => { setSchedule(false); runUploads(); }}>Publish now</Btn>
                <Btn variant="grad" icon="calendar-clock" disabled={!anyPlat} onClick={submit}>{schedule ? "Schedule" : "Queue"}</Btn>
              </div>
            </div>
          </>
        )}

        {stage === "uploading" && (
          <div className="modal-body">
            <div className="pubgrid">
              {clips.map((c, i) => <PubProgressRow key={c.id} clip={c} idx={i} plats={plats} progress={progress} />)}
            </div>
          </div>
        )}

        {stage === "done" && (
          <div className="modal-body" style={{ textAlign: "center", padding: "36px 24px" }}>
            <div style={{ width: 60, height: 60, borderRadius: "50%", background: "var(--success-bg)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 18px" }}>
              <Icon n={schedule ? "calendar-check" : "party-popper"} style={{ width: 28, height: 28, color: "var(--brand-teal)" }} />
            </div>
            <div style={{ fontWeight: 700, fontSize: 18 }}>
              {all ? `${clips.length} clips ` : "Clip "}{schedule ? "scheduled" : "published"}
            </div>
            <p style={{ color: "var(--fg-3)", fontSize: 13.5, marginTop: 8, lineHeight: 1.5 }}>
              {schedule
                ? "Queued via Zernio for the next prime-time slot · 20:30 CET."
                : "Live now across " + Object.entries(plats).filter(([, v]) => v).map(([k]) => PLAT_META[k].label).join(", ") + "."}
            </p>
            <div style={{ marginTop: 22 }}>
              <Btn variant="secondary" onClick={onClose}>Done</Btn>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

Object.assign(window, { PublishModal });
