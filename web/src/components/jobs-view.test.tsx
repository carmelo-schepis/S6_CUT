import { describe, expect, it } from "vitest";
import type { Job } from "../types";
import { groupByDay } from "./jobs-view";

const job = (id: string, updatedAt: string) => ({ id, updatedAt }) as unknown as Job;

describe("groupByDay", () => {
  it("groups jobs under Today, Yesterday and dated headings in list order", () => {
    const now = new Date(2026, 9, 17, 12, 0, 0);
    const groups = groupByDay([
      job("a", new Date(2026, 9, 17, 9).toISOString()),
      job("b", new Date(2026, 9, 17, 1).toISOString()),
      job("c", new Date(2026, 9, 16, 22).toISOString()),
      job("d", new Date(2026, 9, 12, 8).toISOString()),
    ], now);
    expect(groups.map(([day, jobs]) => [day, jobs.map((item) => item.id)])).toEqual([
      ["Today", ["a", "b"]],
      ["Yesterday", ["c"]],
      [new Date(2026, 9, 12).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }), ["d"]],
    ]);
  });
});
