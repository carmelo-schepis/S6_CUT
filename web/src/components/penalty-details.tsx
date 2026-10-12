import { AlertTriangle } from "lucide-react";
import type { ScoreBreakdown } from "../types";

type PenaltyRow = {
  kind: "filler_words" | "length_off_target";
  label: string;
  points: number;
  detail: string;
};

function formatSeconds(value: number) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(1)));
}

export function penaltyRows(score: ScoreBreakdown) {
  return (score.penaltyItems ?? []).flatMap((item): PenaltyRow[] => {
    if (item.kind === "filler_words") {
      const counts = item.fillerWordCounts;
      const detail = counts && Object.keys(counts).length > 0
        ? `${Object.entries(counts).map(([word, count]) => `“${word}” ×${count}`).join(", ")} · ${item.pointsPerWord ?? 0} points each`
        : "Filler words detected";
      return item.points > 0 ? [{ kind: item.kind, label: "Filler words", points: item.points, detail }] : [];
    }
    if (item.kind === "length_off_target") {
      const detail = item.speechSeconds != null && item.targetSeconds != null
        ? `${formatSeconds(item.speechSeconds)} s of speech vs a ${formatSeconds(item.targetSeconds)} s target`
        : "Speech length differed from the target";
      return item.points > 0 ? [{ kind: item.kind, label: "Length off target", points: item.points, detail }] : [];
    }
    return [];
  });
}

export function PenaltyDetails({ score }: { score: ScoreBreakdown }) {
  if (score.penalties <= 0) return null;
  const itemsAvailable = score.penaltyItems != null;
  const rows = penaltyRows(score);

  return <details className="penalty-details">
    <summary><AlertTriangle size={14} /> <span>Penalties −{Math.round(score.penalties)}</span></summary>
    <div className="penalty-details-content">
      {itemsAvailable ? <>
        <p className="penalty-details-intro">Taken off the selection score after the factors above are combined.</p>
        <div className="penalty-details-rows">{rows.map((row) => <div className="penalty-detail-row" key={row.kind}>
          <strong>{row.label}<span>−{Math.round(row.points)}</span></strong>
          <small>{row.detail}</small>
        </div>)}</div>
      </> : <>
        <p>This clip was scored before itemized penalties were saved, so only the total is available.</p>
        <p>Penalties come from filler words (um, uh, like, basically, actually) and from speech that runs longer or shorter than the target length.</p>
      </>}
    </div>
  </details>;
}
