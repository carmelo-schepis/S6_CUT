import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The status view must never be able to restyle the desktop app, and must stay
// on the desktop's design tokens. Both are cheap to prove from the stylesheet.
const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const mobile = read("./mobile.css");
const desktop = read("../../styles.css");

function selectors(css: string): string[] {
  const found: string[] = [];
  const pattern = /([^{}]+)\{/g;
  for (const match of css.matchAll(pattern)) {
    const prelude = match[1].trim();
    if (prelude.startsWith("@")) continue;
    // Split on top-level commas only: `:is(input, select)` is one selector.
    let depth = 0, current = "";
    for (const character of prelude) {
      if (character === "(") depth += 1;
      if (character === ")") depth -= 1;
      if (character === "," && depth === 0) { found.push(current.trim()); current = ""; } else current += character;
    }
    if (current.trim()) found.push(current.trim());
  }
  return found;
}

describe("status view stylesheet", () => {
  it("scopes every rule to its own .m-* classes, so desktop pages cannot be affected", () => {
    const list = selectors(mobile);
    expect(list.length).toBeGreaterThan(50);
    expect(list.filter((selector) => !selector.startsWith(".m-"))).toEqual([]);
  });

  it("is not referenced from the desktop stylesheet", () => {
    expect(desktop).not.toMatch(/\.m-(app|rail|nav|home|jobs|library|work|wallpaper|poster)/);
  });

  it("declares no font size, hex colour or pill radius of its own", () => {
    expect(mobile.match(/font-size\s*:[^;]+;/g)?.filter((declaration) => !/var\(--type-/.test(declaration)) ?? []).toEqual([]);
    expect(mobile).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(mobile).not.toMatch(/radius[^;]*(999|9999)/);
    expect(mobile).not.toMatch(/--radius-pill/);
  });

  it("uses only tokens the desktop stylesheet defines", () => {
    const defined = new Set([...desktop.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((match) => match[1]));
    const own = new Set([...mobile.matchAll(/(--m-[a-z0-9-]+)\s*:/g)].map((match) => match[1]));
    const used = [...mobile.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1]);
    expect(used.filter((token) => !defined.has(token) && !own.has(token))).toEqual([]);
  });
});
