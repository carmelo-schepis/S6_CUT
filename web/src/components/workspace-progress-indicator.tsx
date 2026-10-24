import { useLayoutEffect, useRef } from "react";

type WorkspaceProgressIndicatorProps = {
  value: number;
  isProcessing: boolean;
  label: string;
};

/** The ring's coordinate space: the SVG is 28 units for 28 CSS pixels. */
const CENTRE = 14;

/** Place the number so its drawn digits, not its text box, sit on the ring's
 *  centre. A digit's box includes side bearings, and "1" has far more on its
 *  left than "0" has on its right, so "100" looks pushed to one side when the
 *  box is centred; a line box likewise leaves digits high or low of the middle
 *  at some sizes. SVG text has no line box, so setting its origin from the
 *  digits' measured ink puts them exactly where they belong, with no layout
 *  read-back (which delays the spinner's first frame in WebKit). */
function centreInk(text: SVGTextElement) {
  if (typeof CanvasRenderingContext2D === "undefined") return;
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return;
  const style = getComputedStyle(text);
  // Canvas ink metrics come back in whole pixels, so measure at 20x and scale
  // down; the digits' shape scales linearly and the rounding error shrinks 20x.
  const scale = 20;
  context.font = `${style.fontWeight} ${Number.parseFloat(style.fontSize) * scale}px ${style.fontFamily}`;
  const m = context.measureText(text.textContent || "");
  text.setAttribute("text-anchor", "start");
  text.setAttribute("dominant-baseline", "alphabetic");
  text.setAttribute("x", String(CENTRE - (m.actualBoundingBoxRight - m.actualBoundingBoxLeft) / 2 / scale));
  text.setAttribute("y", String(CENTRE + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2 / scale));
}

export function WorkspaceProgressIndicator({ value, isProcessing, label }: WorkspaceProgressIndicatorProps) {
  const displayValue = Math.max(0, Math.floor(value));
  const text = useRef<SVGTextElement>(null);
  useLayoutEffect(() => {
    const element = text.current;
    if (!element) return;
    centreInk(element);
    // The page font can arrive after first paint; re-centre once it has.
    if (document.fonts?.status === "loaded") return;
    let cancelled = false;
    void document.fonts?.ready.then(() => { if (!cancelled) centreInk(element); });
    return () => { cancelled = true; };
  }, [displayValue]);
  return <span
    className={`nav-work-progress${isProcessing ? " is-processing" : ""}`}
    role="img"
    aria-label={label}
    data-testid="workspace-work-progress"
    data-progress-value={displayValue}
    data-digits={Math.min(String(displayValue).length, 3)}
  >
    <svg className="nav-work-progress-ring" viewBox="0 0 28 28" aria-hidden="true" focusable="false" data-testid={isProcessing ? "workspace-work-spinner" : undefined}>
      <circle className="nav-work-progress-track" cx="14" cy="14" r="12" pathLength="100" strokeWidth={2} />
      <circle className="nav-work-progress-indicator" cx="14" cy="14" r="12" pathLength="100" strokeWidth={2} strokeLinecap="round" />
    </svg>
    {/* A second SVG so the number holds still while the ring spins. */}
    <span className="nav-work-progress-value" data-testid="workspace-work-count" aria-hidden="true">
      <svg viewBox="0 0 28 28" focusable="false">
        <text ref={text} x={CENTRE} y={CENTRE} textAnchor="middle" dominantBaseline="central">{displayValue}</text>
      </svg>
    </span>
  </span>;
}
