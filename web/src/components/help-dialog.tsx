import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRight, BookOpen, BriefcaseBusiness, CheckCircle2, CircleHelp, FileVideo, FastForward, KeyRound, Layout, LockKeyhole, X, Zap } from "lucide-react";
import { StepBadge } from "./common";
import { HelpVideoPreview } from "./help-video-preview";

type HelpSection = "getting-started" | "processing" | "music" | "batches" | "editorial" | "subtitles" | "layouts" | "library" | "workspace" | "shorts-editor" | "jobs-settings" | "troubleshooting";

const sections: { id: HelpSection; label: string }[] = [
  { id: "getting-started", label: "Getting started" },
  { id: "processing", label: "Fast, Auto & Smart" },
  { id: "music", label: "Music mode" },
  { id: "batches", label: "High-volume batches" },
  { id: "editorial", label: "Editorial modes" },
  { id: "subtitles", label: "Subtitle styles" },
  { id: "layouts", label: "Video layouts" },
  { id: "library", label: "Personal Library" },
  { id: "workspace", label: "Workspace & export" },
  { id: "shorts-editor", label: "Shorts Editor" },
  { id: "jobs-settings", label: "Jobs & settings" },
  { id: "troubleshooting", label: "Troubleshooting" },
];

const editorialModes = [
  ["Funny", "Punchlines & reactions", "Prioritises moments with humour, reactions, and a strong payoff."],
  ["Serious", "Complete claims", "Favors complete, self-contained claims and context over isolated sound bites."],
  ["Educational", "Clear explanations", "Favors explanatory passages that make a useful idea understandable."],
  ["Hype", "Hooks & high energy", "Favors energetic openings, momentum, and attention-grabbing moments."],
] as const;

const subtitleReferences = [
  ["Funny", "Oversized, heavy white type with a hard dark outline; emoji accents are sparse and deterministic.", "/help/subtitles-funny.mp4"],
  ["Serious", "A restrained, high-contrast treatment designed to keep complete claims readable.", "/help/subtitles-serious.mp4"],
  ["Educational", "A clear editorial highlight treatment with word-by-word current-word emphasis.", "/help/subtitles-educational.mp4"],
  ["Hype", "High-energy grouping with bold contrast and brief accent emphasis for hooks.", "/help/subtitles-hype.mp4"],
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
      <header className="help-header"><div className="help-header-main"><div className="help-header-mark" aria-hidden="true"><BookOpen size={18} /></div><div className="help-header-copy"><span className="help-header-eyebrow">S6 Cut guide</span><h1 id="help-dialog-title">S6 Cut Help</h1><p>Make local, reviewable cuts without losing track of what the engine is doing.</p></div></div><button ref={closeButton} className="icon-button help-close" onClick={onClose} aria-label="Close S6 Cut Help"><X size={18} /></button></header>
      <div className="help-body">
        <nav className="help-nav" aria-label="Help sections"><strong>On this page</strong>{sections.map((section) => <button key={section.id} className={activeSection === section.id ? "active" : ""} onClick={() => goTo(section.id)}>{section.label}<ArrowRight size={13} /></button>)}</nav>
        <div className="help-content" ref={content}>
          <section id="help-getting-started" className="help-section" aria-labelledby="help-getting-started-title">
            <SectionHeading id="help-getting-started-title" eyebrow="01 · Workflow" title="Getting started"><p>Everything stays on this machine unless you choose an authorised URL or enable an optional provider.</p></SectionHeading>
            <div className="help-steps"><article><StepBadge step={1} /><FileVideo size={18} /><h3>Choose a source</h3><p>In Projects, browse or drop one supported local video, or paste a public HTTPS YouTube URL. Only public links are supported; access controls are not bypassed. On a YouTube URL, <strong>Download video</strong> saves the full source MP4 without creating a project. In Shorts Editor you can also choose a video from Library.</p></article><article><StepBadge step={2} /><Layout size={18} /><h3>Choose the output</h3><p>Pick Clip or Music mode, an editorial style, format, output count, processing mode, and caption options. Advanced controls include aspect ratio, duration, destination folder, and the automatic Subscribe animation.</p></article><article><StepBadge step={3} /><Zap size={18} /><h3>Create, review, export</h3><p>Select <strong>Create</strong> to queue a durable job. In Workspace, follow progress, preview completed clips, retry eligible work, and download individual clips or export selected clips as a ZIP with a manifest and credits.</p></article></div>
          </section>
          <section id="help-processing" className="help-section" aria-labelledby="help-processing-title"><SectionHeading id="help-processing-title" eyebrow="02 · Processing" title="Fast, Auto & Smart"><p>These modes describe how the local engine plans and renders a Clip project.</p></SectionHeading><div className="help-mode-grid"><article><FastForward size={20} /><h3>Fast</h3><p>Fast uses FFprobe and deterministic non-overlapping windows, then renders each cut independently with FFmpeg. It skips transcription, providers, semantic selection, Library matching, and captions unless selected windows need local caption timing. Use it for a quick, predictable first pass or when no provider is configured. The trade-off is that it does not understand meaning, so windows are not ranked for hooks or story.</p></article><article><CircleHelp size={20} /><h3>Auto</h3><p>Auto is the default and resolves to Smart. Speech clips use local transcription and planning; an enabled OpenRouter profile can order validated local candidates. OpenRouter does not transcribe speech. Music always uses local word timing and does not use a provider. Choose Fast when you want deterministic windows without speech transcription.</p></article><article><CheckCircle2 size={20} /><h3>Smart</h3><p>Smart transcribes locally with Faster-Whisper and word timestamps, creates scored candidates, and may ask the selected OpenRouter profile to order validated local candidates. Provider failures fall back to deterministic local planning; OpenRouter never performs transcription.</p></article></div></section>
          <section id="help-music" className="help-section" aria-labelledby="help-music-title"><SectionHeading id="help-music-title" eyebrow="03 · Lyrics" title="Music mode"><p>Choose <strong>Music mode</strong> in Projects for short-form clips built around sung vocals.</p></SectionHeading><div className="help-mode-grid"><article><CheckCircle2 size={20} /><h3>Local transcription</h3><p>Music mode always uses local Faster-Whisper transcription with word timestamps and no voice-activity filtering. Sung lyrics can be missed or misheard, so review the finished clips and captions. Music mode does not use an OpenRouter provider.</p></article><article><Layout size={20} /><h3>Lyrics presentation</h3><p>The Lyrics subtitle theme grid keeps its nine original themes and adds Karaoke focus, Soft glow, and Lyric plate. The independent <strong>Lyric animation</strong> choices are Original (instant), Slow fade, Line crossfade, and Word build. Music video filters are selected separately, so a picture grade does not change the lyric treatment. Optional hook text can appear above the lyrics as plain text or on a white banner. Saved presentation choices appear in Workspace. Music mode is short-form 9:16 and uses the Standard batch planner, up to 30 clips.</p></article><article><FileVideo size={20} /><h3>Plan non-overlapping clips</h3><p>Music clips use the existing non-overlapping planner. If the requested count and minimum duration cannot fit the source, reduce the count or duration; the app explains the limit instead of silently changing your request.</p></article></div></section>
          <section id="help-batches" className="help-section" aria-labelledby="help-batches-title"><SectionHeading id="help-batches-title" eyebrow="04 · Batch planning" title="High-volume batches"><p>High-volume is an optional Speech/Clip mode for larger extraction jobs. Music mode uses its own Standard limit.</p></SectionHeading><div className="help-mode-grid"><article><Zap size={20} /><h3>Request up to 500</h3><p>Standard batches support up to 30 outputs. High-volume supports requests from 1 to 500 and works with short-form or long-form projects and Fast, Auto, or Smart processing.</p></article><article><CheckCircle2 size={20} /><h3>Review the effective target</h3><p>The requested count is preserved. The engine checks valid windows against the actual source duration and, for Smart, the timed transcript. For sources under 30 minutes, the effective target is capped at 300; longer sources can reach 500 when enough valid windows exist. Workspace shows requested, effective, planned, and successful counts and explains reductions.</p></article><article><Layout size={20} /><h3>Local planning and export</h3><p>High-volume planning is deterministic; Smart keeps large candidate batches local instead of sending them to a provider for ordering. Select up to 500 completed clips for export. The ZIP manifest and credits cover only files included in the archive.</p></article></div></section>
          <section id="help-editorial" className="help-section" aria-labelledby="help-editorial-title"><SectionHeading id="help-editorial-title" eyebrow="05 · Editorial" title="Editorial modes"><p>These are the four styles currently available in the Projects create panel.</p></SectionHeading><div className="help-editorial-list">{editorialModes.map(([name, note, description]) => <article key={name}><span className={`style-swatch ${name.toLowerCase()}`} /><div><h3>{name}</h3><strong>{note}</strong><p>{description}</p></div></article>)}</div></section>
          <section id="help-subtitles" className="help-section" aria-labelledby="help-subtitles-title"><SectionHeading id="help-subtitles-title" eyebrow="06 · Captions" title="Subtitle styles"><p>Speech has twelve subtitle treatments with local word timing and previews in Projects. Subtitle appearance is separate from Funny, Serious, Educational, and Hype editorial intent, which continues to guide clip selection. Video filters grade footage before captions and graphics. Fast mode skips transcription and captions, but can still apply picture filters. Music has its own lyric themes and independent animation choices.</p><p>Speech can use an optional heading treatment and generated emoji reactions; both can be turned off, and literal emoji typed in source text remain in captions. Hook text stays off by default. In Projects, tick <strong>Hook text</strong> to open its text field. Speech clips can use your text or generate transcript-grounded hooks automatically when eligible. Music uses the checkbox for optional top text, shown in the upper black area of each clip. The checkbox starts unchecked each time Projects is mounted. Speech hooks are available for eligible Smart, short-form, Standard jobs, whether or not subtitles are burned. Saved presentation choices and hook text are read-only in Workspace. Fast, Long form, and High-volume Speech jobs cannot request hooks. If automatic generation fails or returns unusable text, clips still render without hooks and Workspace shows the warning.</p></SectionHeading><div className="help-reference-grid">{subtitleReferences.map(([name, description, src]) => <figure key={name}><div className="help-reference-frame"><HelpVideoPreview name={name} src={src} /></div><figcaption><strong>{name}</strong><span>{description}</span></figcaption></figure>)}</div></section>
          <section id="help-layouts" className="help-section" aria-labelledby="help-layouts-title"><SectionHeading id="help-layouts-title" eyebrow="07 · Canvas" title="Video layouts"><p>Short-form projects can use 9:16, 1:1, or 4:5. Long form uses 16:9 landscape and selects scenes across the source. The Shorts Editor can also render a chosen trim in any of these aspect ratios.</p></SectionHeading><div className="help-reference-grid layout-grid">{layoutReferences.map(([name, description, src]) => <figure key={name}><div className="help-reference-frame"><img src={src} alt={`${name} video layout reference from the running S6 Cut application`} /></div><figcaption><strong>{name}</strong><span>{description}</span></figcaption></figure>)}</div></section>
          <section id="help-library" className="help-section" aria-labelledby="help-library-title"><SectionHeading id="help-library-title" eyebrow="08 · Reusable media" title="Personal Library"><p>Library stores reusable and project media locally and lets you control how assets can be matched to clips.</p></SectionHeading><div className="help-mode-grid"><article><FileVideo size={20} /><h3>Import and organize</h3><p>Import images, videos, and audio. Search by title, tags, people, or brands; filter by media type, origin, folder, and policy. Business folders can be nested, moved, renamed, archived, and restored.</p></article><article><CheckCircle2 size={20} /><h3>Set matching rules</h3><p>Add trigger phrases, tags, people, brands, licence details, spacing, and per-project use limits. Required, Preferred, Neutral, and Never policies control whether the deterministic resolver may use an asset.</p></article><article><Layout size={20} /><h3>Reuse and protect</h3><p>Generated sources and completed clips appear in Library automatically. Preview assets, bulk-move or remove selected records, and pin protected campaign media. Removing a Library record does not remove its project or job history.</p></article></div></section>
          <section id="help-workspace" className="help-section" aria-labelledby="help-workspace-title"><SectionHeading id="help-workspace-title" eyebrow="09 · Review" title="Workspace & export"><p>Each project has durable progress, source details, media, and a board for reviewing its outputs.</p></SectionHeading><div className="help-mode-grid"><article><Zap size={20} /><h3>Follow and recover work</h3><p>Watch processing stages, progress, download status, and warnings. Pause or stop supported jobs, keep completed outputs, retry failed clips or imports, and switch eligible stalled Smart jobs to Fast local processing.</p></article><article><CheckCircle2 size={20} /><h3>Review clips</h3><p>Filter the board to all, selected, or failed clips. Preview and download completed clips, include the clips you want in an export, and inspect source or generated media without leaving the project.</p></article><article><Layout size={20} /><h3>Export a ZIP</h3><p>Choose <strong>Export selected</strong> to create a ZIP containing the chosen clips, a manifest, and credits. For high-volume jobs, only selected files are included in the archive and its supporting records.</p></article></div></section>
          <section id="help-shorts-editor" className="help-section" aria-labelledby="help-shorts-editor-title"><SectionHeading id="help-shorts-editor-title" eyebrow="10 · Manual editing" title="Shorts Editor"><p>Use Editor for a single, precise short from a local video, a public YouTube URL, or a video in Library.</p></SectionHeading><div className="help-mode-grid"><article><FileVideo size={20} /><h3>Set the trim</h3><p>Preview the source, choose start and end times, set 9:16, 16:9, 1:1, or 4:5, and turn subtitles on or off. The automatic Subscribe animation can be enabled and timed for short-form output.</p></article><article><CircleHelp size={20} /><h3>Ask for a bounded edit</h3><p>The local editing assistant uses simple rules to parse requests for trim duration, start/end, aspect ratio, or subtitles. Review and apply or reject proposals; use Undo to reverse edits. It does not change the source media.</p></article><article><Zap size={20} /><h3>Queue the render</h3><p>Select <strong>Queue short</strong> to render a new output. The original stays intact; progress, completed clips, and retry controls appear in the editor and Jobs.</p></article></div></section>
          <section id="help-jobs-settings" className="help-section" aria-labelledby="help-jobs-settings-title"><SectionHeading id="help-jobs-settings-title" eyebrow="11 · Administration" title="Jobs & settings"><p>Use these areas to monitor the durable queue and configure optional text planning.</p></SectionHeading><div className="help-mode-grid"><article><BriefcaseBusiness size={20} /><h3>Jobs & recovery</h3><p>See active and completed job history, open its project, follow live stages, pause or resume supported work, retry failed clips, and retry stalled or interrupted YouTube imports.</p></article><article><KeyRound size={20} /><h3>Optional OpenRouter profiles</h3><p>Settings lets you add, test, select, duplicate, and remove a text-planning profile. Saved credentials can be encrypted locally or kept for the session. Local Whisper transcription and Fast processing remain available without a profile.</p></article><article><LockKeyhole size={20} /><h3>Local data controls</h3><p>Projects and media are stored on this machine. Settings also has a separate “Delete all content” Library purge action with a typed confirmation; use it only when you intend to remove stored content.</p></article></div></section>
          <section id="help-troubleshooting" className="help-section" aria-labelledby="help-troubleshooting-title"><SectionHeading id="help-troubleshooting-title" eyebrow="12 · Recovery" title="Troubleshooting"><p>The application keeps useful state and error details visible instead of hiding failures.</p></SectionHeading><dl className="help-troubleshooting"><div><dt>Engine availability</dt><dd>Check the status badge in the top bar and the local-tools summary on Projects. “Engine offline” means the FastAPI engine did not answer; use Retry, then check the engine/container logs.</dd></div><div><dt>Failed processing job</dt><dd>Open the project workspace. The failure strip shows the engine error and offers Retry failed work, Retry import, or a local fallback when applicable. Completed clips remain preserved.</dd></div><div><dt>Missing or unsupported media</dt><dd>Use a supported MP4, MOV, WebM, MKV, M4V, or AVI file. Uploads are validated with FFprobe; check that the file is readable, not DRM-protected, and within the configured size and duration limits.</dd></div><div><dt>Preview or export problems</dt><dd>Only validated, completed clips get preview/download links. Reselect a completed clip and try again; for exports, confirm at least one clip is included. The workspace details and job history contain warnings, stage labels, and error text.</dd></div></dl></section>
        </div>
      </div>
    </div>
  </div>;
}
