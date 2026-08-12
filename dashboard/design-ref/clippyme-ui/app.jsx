/* ClippyMe — App: tab + stage state machine, modals, toasts, confetti */

const DEFAULT_OPTS = {
  mode: "single", source: "url", url: "", file: null, batch: "", instructions: "",
  clips: 7, aspect: "9:16",
  detect: true, reframe: true, smartcut: true, zoom: true,
  subtitles: true, subMode: "karaoke", subPreset: "hormozi_bold", subPosition: "center",
  hooks: true, hookPos: "top", hookSize: "M",
  language: "multi",
  platforms: { tiktok: true, ig: true, yt: false },
  preset: "viral",
};

const CONFETTI_COLORS = ["#E6428D", "#9850C3", "#675ADD", "#0A81D9", "#02C5BF", "#F7BC59"];

function Confetti() {
  const pieces = useMemo(() => Array.from({ length: 90 }, (_, i) => ({
    left: Math.random() * 100, delay: Math.random() * 0.6, dur: 2.2 + Math.random() * 1.6,
    color: CONFETTI_COLORS[i % CONFETTI_COLORS.length], rot: Math.random() * 360, w: 6 + Math.random() * 6,
  })), []);
  return (
    <div className="confetti">
      {pieces.map((p, i) => (
        <i key={i} style={{ left: p.left + "%", background: p.color, width: p.w, height: p.w * 1.6,
          transform: `rotate(${p.rot}deg)`, animationDelay: p.delay + "s", animationDuration: p.dur + "s" }} />
      ))}
    </div>
  );
}

function Toasts({ items }) {
  const ic = { success: "circle-check", warn: "triangle-alert", info: "info" };
  return (
    <div className="toasts">
      {items.map((t) => (
        <div key={t.id} className={"toast " + t.type}>
          <span className="ti"><Icon n={ic[t.type]} /></span>
          <span>{t.msg}</span>
        </div>
      ))}
    </div>
  );
}

function App() {
  const [tab, setTab] = useState("create");
  const [stage, setStage] = useState("idle"); // idle | processing | results
  const [opts, setOpts] = useState(DEFAULT_OPTS);
  const [media, setMedia] = useState(null);
  const [history, setHistory] = useState(HISTORY_SEED);
  const [historyOpen, setHistoryOpen] = useState(null);
  const [publishClips, setPublishClips] = useState(null);
  const [captionsClip, setCaptionsClip] = useState(null);
  const [showKey, setShowKey] = useState(false);
  const [confetti, setConfetti] = useState(false);
  const [toasts, setToasts] = useState([]);

  useEffect(() => { refreshIcons(); });

  const pushToast = useCallback((type, msg) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, type, msg }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3400);
  }, []);

  // manual edits clear the active preset highlight; preset picks set it.
  const set = (patch) => setOpts((o) => ({ ...o, ...patch, preset: null }));
  const pickPreset = (p) => setOpts((o) => ({ ...o, ...p.opts, preset: p.id }));

  const startJob = () => {
    const m = opts.mode === "single"
      ? (opts.source === "url" ? { type: "url", payload: opts.url } : { type: "file", payload: opts.file })
      : { type: "url", payload: `${opts.batch.split("\n").filter((l) => l.trim()).length} videos` };
    setMedia(m);
    setStage("processing");
  };

  const finishJob = () => {
    setStage("results");
    setConfetti(true);
    setTimeout(() => setConfetti(false), 3200);
    pushToast("success", "7 clips ready — top score 92");
    setHistory((h) => [{
      id: "j_" + Math.random().toString(16).slice(2, 6),
      source: media?.type === "url" ? (media.payload || "YouTube video") : (media?.payload || "Local file"),
      platform: media?.type || "url", clips: CLIPS.length, score: 92, when: "just now", cost: "0.42", published: false,
      grad: Math.floor(Math.random() * CLIP_GRADS.length),
    }, ...h]);
  };

  const resetToCreate = () => { setStage("idle"); setMedia(null); setTab("create"); };

  const openPublish = (clips) => setPublishClips(Array.isArray(clips) ? clips : [clips]);
  const onScheduled = () => { setConfetti(true); setTimeout(() => setConfetti(false), 2600); };

  const goTab = (next) => {
    if (next === "create" && stage === "results") { setStage("idle"); setMedia(null); }
    setHistoryOpen(null);
    setTab(next);
  };

  return (
    <div>
      <TopNav tab={tab} setTab={goTab} busy={stage === "processing"} />
      {confetti && <Confetti />}

      {tab === "create" && stage === "idle" && (
        <CreateView opts={opts} set={set} onPickPreset={pickPreset}
          onCreate={() => { startJob(); }} />
      )}
      {tab === "create" && stage === "processing" && (
        <ProcessingView media={media} onDone={finishJob} onCancel={resetToCreate} />
      )}
      {tab === "create" && stage === "results" && (
        <ResultsView clips={CLIPS} doneIn="1:54" onBack={resetToCreate}
          onPublish={openPublish} onPublishAll={openPublish} onCaptions={(c) => setCaptionsClip(c)} />
      )}

      {tab === "history" && !historyOpen && (
        <HistoryView history={history}
          onOpen={(h) => setHistoryOpen(h)}
          onDelete={(id) => { setHistory((hh) => hh.filter((x) => x.id !== id)); pushToast("info", "Job deleted"); }}
          onClear={() => { setHistory([]); pushToast("info", "History cleared"); }} />
      )}
      {tab === "history" && historyOpen && (
        <div className="fade-in">
          <div className="container" style={{ paddingTop: 24, paddingBottom: 0 }}>
            <Btn variant="secondary" size="sm" icon="arrow-left" onClick={() => setHistoryOpen(null)}>Back to history</Btn>
          </div>
          <ResultsView clips={CLIPS} doneIn={null} embedded
            onPublish={openPublish} onPublishAll={openPublish} onCaptions={(c) => setCaptionsClip(c)} />
        </div>
      )}

      {tab === "settings" && <SettingsView />}

      {publishClips && (
        <PublishModal clips={publishClips}
          onClose={() => setPublishClips(null)}
          onScheduled={onScheduled} />
      )}
      {captionsClip && (
        <CaptionEditModal clip={captionsClip} idx={CLIPS.findIndex((c) => c.id === captionsClip.id)}
          onClose={() => setCaptionsClip(null)}
          onSave={() => { setCaptionsClip(null); pushToast("success", "Captions updated"); }} />
      )}
      {showKey && <ApiKeyModal onClose={() => setShowKey(false)} onGoToSettings={() => { setShowKey(false); setTab("settings"); }} />}

      <Toasts items={toasts} />
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);
