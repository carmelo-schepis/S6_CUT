import { describe, expect, it } from "vitest";
import { penaltyItemSchema, scoreSchema } from "../types";
import { PenaltyDetails, penaltyRows } from "./penalty-details";

const score = (penaltyItems: unknown) => scoreSchema.parse({
  hook: 80, coherence: 80, ending: 80, energy: 80, practicalValue: 80,
  visualPotential: 80, completeness: 80, penalties: 14, total: 70,
  explanation: "fixture", penaltyItems,
});

describe("penaltyRows", () => {
  it("returns positive itemized penalties with transcript counts and timing", () => {
    const parsed = score([
      { kind: "filler_words", points: 8, fillerWordCounts: { um: 1, like: 1 }, pointsPerWord: 4 },
      { kind: "length_off_target", points: 6, speechSeconds: 22.5, targetSeconds: 37.5 },
      { kind: "filler_words", points: 0, fillerWordCounts: {}, pointsPerWord: 4 },
    ]);

    expect(penaltyRows(parsed)).toEqual([
      { kind: "filler_words", label: "Filler words", points: 8, detail: "“um” ×1, “like” ×1 · 4 points each" },
      { kind: "length_off_target", label: "Length off target", points: 6, detail: "22.5 s of speech vs a 37.5 s target" },
    ]);
  });

  it("ignores unknown future kinds and validates their extensible kind string", () => {
    const futureItem = penaltyItemSchema.parse({ kind: "future_kind", points: 3 });
    expect(penaltyRows(score([futureItem]))).toEqual([]);
  });

  it("renders the native disclosure only when penalties are positive", () => {
    const noPenalty = scoreSchema.parse({
      hook: 80, coherence: 80, ending: 80, energy: 80, practicalValue: 80,
      visualPotential: 80, completeness: 80, penalties: 0, total: 80, explanation: "fixture",
    });
    expect(PenaltyDetails({ score: noPenalty })).toBeNull();
  });
});
