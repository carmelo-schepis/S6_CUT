/* ClippyMe — Results: ResultCard + ResultsView (with multi-select) */

function ResultCard({ clip, idx, selectMode, selected, onClick, onPublish, onCaptions }) {
  const top = clip.score >= 90;
  return (
    <div className={"clip" + (top ? " top" : "") + (selected ? " sel" : "")} onClick={onClick}>
      <div className="clip-media" style={{ background: CLIP_GRADS[idx % CLIP_GRADS.length] }}>
        <div className="clip-top">
          <span className="score"><Icon n="flame" style={{ width: 12, height: 12 }} />{clip.score}</span>
          {selectMode
            ? <span className="clip-check"><Icon n="check" /></span>
            : top && <Badge tone="blue" icon="trending-up">Top</Badge>}
        </div>
        <div className="clip-hook">{clip.hook[0]}<br /><span className="y">{clip.hook[1]}</span></div>
        <div className="clip-bottom">
          <div className="clip-sub">{clip.sub[0]}<b>{clip.sub[1]}</b>{clip.sub[2]}</div>
          <span className="dur">{clip.dur}</span>
        </div>
        {!selectMode && <div className="play"><span><Icon n="play" /></span></div>}
      </div>
      <div className="clip-foot">
        <span className="ttl">{clip.title}</span>
        <span className="mini" title="Edit captions" onClick={(e) => { e.stopPropagation(); onCaptions(clip); }}><Icon n="captions" /></span>
        <span className="mini" title="Publish" onClick={(e) => { e.stopPropagation(); onPublish(clip); }}><Icon n="send" /></span>
      </div>
    </div>
  );
}

function ResultsView({ clips, doneIn, onBack, onPublish, onPublishAll, onCaptions, embedded }) {
  const [selectMode, setSelectMode] = useState(false);
  const [sel, setSel] = useState({});
  const selIds = Object.keys(sel).filter((k) => sel[k]);
  const toggleSel = (id) => setSel((s) => ({ ...s, [id]: !s[id] }));
  const exitSelect = () => { setSelectMode(false); setSel({}); };

  return (
    <div className="container fade-in">
      <div className="results-head">
        {!embedded && <Btn variant="icon" icon="arrow-left" onClick={onBack} title="Start over" />}
        <h2>{clips.length} clips ready</h2>
        {doneIn && <Badge tone="teal" icon="check">done in {doneIn}</Badge>}
        <div className="rh-right">
          <Btn variant="secondary" size="sm" icon={selectMode ? "x" : "check-square"} onClick={() => selectMode ? exitSelect() : setSelectMode(true)}>
            {selectMode ? "Cancel" : "Select"}
          </Btn>
          {!selectMode && <Btn variant="secondary" size="sm" icon="download">Export all</Btn>}
          {!selectMode && <Btn variant="grad" size="sm" icon="send" onClick={() => onPublishAll(clips)}>Publish all</Btn>}
        </div>
      </div>
      <div className="results-sub">Sorted by virality score · top moment {Math.max(...clips.map((c) => c.score))}</div>

      {selectMode && (
        <div className="actionbar">
          <span className="sel-n">{selIds.length} selected</span>
          <div className="ab-right">
            <Btn variant="secondary" size="sm" icon="download" disabled={!selIds.length}>Export</Btn>
            <Btn variant="grad" size="sm" icon="send" disabled={!selIds.length}
              onClick={() => onPublishAll(clips.filter((c) => sel[c.id]))}>Publish {selIds.length || ""}</Btn>
          </div>
        </div>
      )}

      <div className="results-grid">
        {clips.map((c, i) => (
          <ResultCard key={c.id} clip={c} idx={i}
            selectMode={selectMode} selected={!!sel[c.id]}
            onClick={() => selectMode ? toggleSel(c.id) : onPublish(c)}
            onPublish={onPublish} onCaptions={onCaptions} />
        ))}
      </div>
    </div>
  );
}

Object.assign(window, { ResultCard, ResultsView });
