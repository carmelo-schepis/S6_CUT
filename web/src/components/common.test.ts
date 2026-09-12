import { describe, expect, it } from "vitest";
import { formatDuration, resolveOutputAspectRatio } from "./common";

describe("formatDuration", () => {
  it("carries rounded seconds into the next minute", () => {
    expect(formatDuration(59.6)).toBe("1:00");
    expect(formatDuration(119.6)).toBe("2:00");
  });
});

describe("resolveOutputAspectRatio", () => {
  it.each([
    [1080, 1080, "1:1"],
    [1920, 1080, "16:9"],
    [1080, 1920, "9:16"],
    [1080, 1350, "4:5"],
  ])("derives %s×%s as %s", (width, height, expected) => {
    expect(resolveOutputAspectRatio(undefined, width, height, "short")).toBe(expected);
  });

  it("prefers persisted output metadata over dimensions", () => {
    expect(resolveOutputAspectRatio("4:5", 1080, 1080, "short")).toBe("4:5");
  });

  it("uses a safe content-format fallback for legacy outputs", () => {
    expect(resolveOutputAspectRatio(undefined, undefined, undefined, "short")).toBe("9:16");
    expect(resolveOutputAspectRatio(undefined, null, null, "long")).toBe("16:9");
  });

  it("falls back safely when dimensions are not one of the supported ratios", () => {
    expect(resolveOutputAspectRatio(undefined, 1000, 700, "short")).toBe("9:16");
  });
});
