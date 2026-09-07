import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRight, CheckCircle2, CircleHelp, FileVideo, FastForward, Layout, X, Zap } from "lucide-react";

type HelpSection = "getting-started" | "processing" | "editorial" | "subtitles" | "layouts" | "troubleshooting";

const sections: { id: HelpSection; label: string }[] = [
  { id: "getting-started", label: "Getting started" },
  { id: "processing", label: "Fast, Auto & Smart" },
  { id: "editorial", label: "Editorial modes" },
  { id: "subtitles", label: "Subtitle styles" },
  { id: "layouts", label: "Video layouts" },
  { id: "troubleshooting", label: "Troubleshooting" },
];

const editorialModes = [
  ["Funny", "Punchlines & reactions", "Prioritises moments with humour, reactions, and a strong payoff."],
  ["Serious", "Complete claims", "Favors complete, self-contained claims and context over isolated sound bites."],
  ["Educational", "Clear explanations", "Favors explanatory passages that make a useful idea understandable."],
  ["Hype", "Hooks & high energy", "Favors energetic openings, momentum, and attention-grabbing moments."],
] as const;

const subtitleReferences = [
  ["Funny", "Oversized, heavy white type with a hard dark outline; emoji accents are sparse and deterministic.", "/help/subtitles-funny.png"],
  ["Serious", "A restrained, high-contrast treatment designed to keep complete claims readable.", "/help/subtitles-serious.png"],
  ["Educational", "A clear editorial highlight treatment with word-by-word current-word emphasis.", "/help/subtitles-educational.png"],
  ["Hype", "High-energy grouping with bold contrast and brief accent emphasis for hooks.", "/help/subtitles-hype.png"],
] as const;

const layoutReferences = [
  ["9:16 vertical", "Best for Shorts, Reels, and TikTok. The full source frame is preserved when a centre crop would lose substantial detail.", "/help/layout-9-16.png"],
  ["16:9 landscape", "Best for long-form scenes and conventional video players. Long-form Clip mode selects scenes across the source.", "/help/layout-16-9.png"],
  ["1:1 square", "A balanced social layout for feeds that display square media.", "/help/layout-1-1.png"],
  ["4:5 portrait", "A taller feed-friendly layout when 9:16 is not required.", "/help/layout-4-5.png"],
] as const;

function SectionHeading({ id, eyebrow, title, children }: { id: string; eyebrow: string; title: string; children?: ReactNode }) {
  return <header className="help-section-heading"><span className="eyebrow">{eyebrow}</span><h2 id={id}>{title}</h2>{children}</header>;
}

export function HelpDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [activeSection, setActiveSection] = useState<HelpSection>("getting-started");
  const closeButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement as HTMLElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab" || !dialog.current) return;
      const focusable = Array.from(dialog.current.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea, [tabindex]:not([tabindex='-1'])")).filter((element) => !element.hasAttribute("disabled"));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      opener.current?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;
  const goTo = (id: HelpSection) => {
    setActiveSection(id);
    const section = document.getElementById(`help-${id}`);
    if (section && content.current) content.current.scrollTo({ top: section.offsetTop, left: 0, behavior: "smooth" });
  };

  return <div className="help-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="help-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="help-dialog-title">
      <header className="help-header"><div><span className="eyebrow">S6 Cut guide</span><h1 id="help-dialog-title">S6 Cut Help</h1><p>Make local, reviewable cuts without losing track of what the engine is doing.</p></div><button ref={closeButton} className="icon-button help-close" onClick={onClose} aria-label="Close S6 Cut Help"><X size={18} /></button></header>
      <div className="help-body">
        <nav className="help-nav" aria-label="Help sections"><strong>On this page</strong>{sections.map((section) => <button key={section.id} className={activeSection === section.id ? "active" : ""} onClick={() => goTo(section.id)}>{section.label}<ArrowRight size={13} /></button>)}</nav>
        <div className="help-content" ref={content}>
          <section id="help-getting-started" className="help-section" aria-labelledby="help-getting-started-title">
            <SectionHeading id="help-getting-started-title" eyebrow="01 · Workflow" title="Getting started"><p>Everything stays on this machine unless you choose an authorised URL or enable an optional provider.</p></SectionHeading>
            <div className="help-steps"><article><span>1</span><FileVideo size={18} /><h3>Import or select footage</h3><p>In Projects, choose <strong>Local file</strong> and browse or drop one supported video. You can also paste a public HTTPS YouTube URL or select a source from Library. Script mode accepts exact pasted text or a .txt/.md file.</p></article><article><span>2</span><Layout size={18} /><h3>Choose the output</h3><p>Pick an editorial style, short-form 9:16 or long-form 16:9, the number of clips/scenes, processing mode, and whether to burn subtitles. Advanced controls add 1:1, 4:5, duration, and project-folder choices.</p></article><article><span>3</span><Zap size={18} /><h3>Generate, review, export</h3><p>Select <strong>Create</strong> to queue the job. Open the workspace to watch durable progress, select finished clips, preview them, and use <strong>Download</strong> or <strong>Export selected</strong> for a ZIP with a manifest and credits.</p></article></div>
          </section>
          <section id="help-processing" className="help-section" aria-labelledby="help-processing-title"><SectionHeading id="help-processing-title" eyebrow="02 · Processing" title="Fast, Auto & Smart"><p>These modes describe how the local engine plans and renders a Clip mode project.</p></SectionHeading><div className="help-mode-grid"><article><FastForward size={20} /><h3>Fast</h3><p>Fast uses FFprobe and deterministic non-overlapping windows, then renders each cut independently with FFmpeg. It skips transcription, providers, semantic selection, Library matching, and captions unless selected windows need local caption timing. Use it for a quick, predictable first pass or when no provider is configured. The trade-off is that it does not understand meaning, so windows are not ranked for hooks or story.</p></article><article><CircleHelp size={20} /><h3>Auto</h3><p>Auto is the default. With a connected OpenRouter profile it selects Smart processing; without one it intentionally resolves to the Fast local cut. This makes Auto a safe “best available” choice: it never requires a provider, but it cannot provide semantic planning when none is available.</p></article><article><CheckCircle2 size={20} /><h3>Smart</h3><p>Smart transcribes locally with Faster-Whisper and word timestamps, creates scored candidates, and may ask the selected OpenRouter profile to order validated local candidates. Provider failures fall back to deterministic local planning; OpenRouter never performs transcription.</p></article></div></section>
          <section id="help-editorial" className="help-section" aria-labelledby="help-editorial-title"><SectionHeading id="help-editorial-title" eyebrow="03 · Editorial" title="Editorial modes"><p>These are the four styles currently available in the Projects create panel.</p></SectionHeading><div className="help-editorial-list">{editorialModes.map(([name, note, description]) => <article key={name}><span className={`style-swatch ${name.toLowerCase()}`} /><div><h3>{name}</h3><strong>{note}</strong><p>{description}</p></div></article>)}</div></section>
          <section id="help-subtitles" className="help-section" aria-labelledby="help-subtitles-title"><SectionHeading id="help-subtitles-title" eyebrow="04 · Captions" title="Subtitle styles"><p>Caption treatments are fixed by the selected editorial style at job creation. Captions use local word timestamps and the current word is highlighted.</p></SectionHeading><div className="help-reference-grid">{subtitleReferences.map(([name, description, src]) => <figure key={name}><div className="help-reference-frame"><img src={src} alt={`${name} subtitle treatment reference showing timed word-highlight captions`} /></div><figcaption><strong>{name}</strong><span>{description}</span></figcaption></figure>)}</div></section>
          <section id="help-layouts" className="help-section" aria-labelledby="help-layouts-title"><SectionHeading id="help-layouts-title" eyebrow="05 · Canvas" title="Video layouts"><p>Choose a layout in Advanced controls, or use Long form for a 16:9 landscape project.</p></SectionHeading><div className="help-reference-grid layout-grid">{layoutReferences.map(([name, description, src]) => <figure key={name}><div className="help-reference-frame"><img src={src} alt={`${name} video layout reference from the running S6 Cut application`} /></div><figcaption><strong>{name}</strong><span>{description}</span></figcaption></figure>)}</div></section>
          <section id="help-troubleshooting" className="help-section" aria-labelledby="help-troubleshooting-title"><SectionHeading id="help-troubleshooting-title" eyebrow="06 · Recovery" title="Troubleshooting"><p>The application keeps useful state and error details visible instead of hiding failures.</p></SectionHeading><dl className="help-troubleshooting"><div><dt>Engine availability</dt><dd>Check the status badge in the top bar and the local-tools summary on Projects. “Engine offline” means the FastAPI engine did not answer; use Retry, then check the engine/container logs.</dd></div><div><dt>Failed processing job</dt><dd>Open the project workspace. The failure strip shows the engine error and offers Retry failed work, Retry import, or a local fallback when applicable. Completed clips remain preserved.</dd></div><div><dt>Missing or unsupported media</dt><dd>Use a supported MP4, MOV, WebM, MKV, M4V, or AVI file. Uploads are validated with FFprobe; check that the file is readable, not DRM-protected, and within the configured size and duration limits.</dd></div><div><dt>Preview or export problems</dt><dd>Only validated, completed clips get preview/download links. Reselect a completed clip and try again; for exports, confirm at least one clip is included. The workspace details and job history contain warnings, stage labels, and error text.</dd></div></dl></section>
        </div>
      </div>
    </div>
  </div>;
}
