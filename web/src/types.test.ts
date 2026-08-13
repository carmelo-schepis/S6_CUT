import { describe, expect, it } from "vitest";
import { beatSchema, clipSchema, jobSchema } from "./types";

const score = {
  hook: 80, coherence: 82, ending: 79, energy: 70, practicalValue: 75,
  visualPotential: 77, completeness: 91, penalties: 2, llmContribution: null,
  total: 82, explanation: "A complete, useful thought.",
};

describe("versioned UI contracts", () => {
  it("rejects malformed clip ranges and scores", () => {
    expect(() => clipSchema.parse({ id: "one", index: 1, state: "complete", start: -1, end: 5, duration: 6, openingLine: "Hello", score, selected: true, fallbackUsed: false, provenance: [] })).toThrow();
    expect(() => clipSchema.parse({ id: "one", index: 1, state: "complete", start: 0, end: 5, duration: 5, openingLine: "Hello", score: { ...score, total: 102 }, selected: true, fallbackUsed: false, provenance: [] })).toThrow();
  });

  it("keeps exact beat spans explicit", () => {
    const script = "The Beatles changed popular music.";
    const beat = beatSchema.parse({ id: "beat", start: 0, end: 2.5, charStart: 0, charEnd: script.length, text: script, concept: "The Beatles", source: "text-card", confidence: .7, matchReason: "fallback" });
    expect(script.slice(beat.charStart, beat.charEnd)).toBe(beat.text);
  });

  it("requires schema version 1 for durable jobs", () => {
    expect(() => jobSchema.parse({ schemaVersion: 2 })).toThrow();
  });
});
