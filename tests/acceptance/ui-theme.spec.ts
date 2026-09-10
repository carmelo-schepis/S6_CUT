import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Theme contract for the S6 Cut UI.
 *
 * Three rules are enforced here because they are easy to erode one component at
 * a time:
 *   1. every visible first-party text node is white — hierarchy comes from the
 *      two typography roles, weight, spacing, borders and surfaces, never from
 *      a different text hue;
 *   2. every numbered workflow step badge is the same 24px circle, and its
 *      digit stays centred and unclipped whatever the heading beside it does;
 *   3. accents come only from the logo-derived palette.
 *
 * Text drawn inside media (video, canvas, images) and the caption preview — a
 * simulation of the subtitle FFmpeg burns into the frame, not product chrome —
 * are out of scope.
 */

const viewports = [
  ["desktop", 1440, 900],
  ["laptop", 1280, 800],
  ["tablet", 768, 1024],
  ["mobile", 390, 844],
] as const;

const routes = ["Projects", "Library", "Workspace", "Shorts Editor", "AI Video", "Jobs", "Settings"] as const;

/** The logo-derived palette, plus the semantic status hues that must stay distinct. */
const APPROVED_ACCENTS = new Set([
  "rgb(118, 107, 255)", // --accent-primary   (logo indigo)
  "rgb(145, 137, 255)", // --accent-primary-hover / --focus-ring
  "rgb(241, 77, 154)",  // --accent-magenta   (logo burgundy)
  "rgb(255, 154, 122)", // --accent-coral     (logo peach)
  "rgb(242, 56, 85)",   // --accent-crimson   (logo crimson) / --error
  "rgb(111, 168, 255)", // --accent-blue      (logo slate)
  "rgb(143, 163, 200)", // --accent-slate
  "rgb(76, 183, 130)",  // --success
  "rgb(240, 168, 75)",  // --warning
]);

async function openRoute(page: Page, label: string) {
  await page.locator(`.app-rail nav button[aria-label="${label}"]`).first().click();
  await expect(page.locator("#main-content")).toBeVisible();
  await page.waitForTimeout(400);
}

test.describe("theme contract", () => {
  test("every visible first-party text node is white", async ({ page }) => {
    test.setTimeout(180_000);
    const offenders: unknown[] = [];
    for (const [, width, height] of viewports) {
      await page.setViewportSize({ width, height });
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await expect(page.locator(".app-rail nav")).toBeVisible();
      for (const route of routes) {
        await openRoute(page, route);
        const found = await page.evaluate(() => {
          const SKIP = new Set(["SVG", "CANVAS", "VIDEO", "IMG", "SCRIPT", "STYLE", "NOSCRIPT", "AUDIO", "SOURCE", "TRACK", "IFRAME", "OBJECT", "EMBED"]);
          const bad: { sample: string; colour: string; cls: string }[] = [];
          for (const el of document.querySelectorAll<HTMLElement>("*")) {
            if (SKIP.has(el.tagName)) continue;
            if (el.closest("svg,canvas,video,img,iframe")) continue;
            if (el.closest(".sr-only") || el.closest(".caption-preview")) continue;
            let own = "";
            for (const node of el.childNodes) if (node.nodeType === 3) own += node.nodeValue;
            const field = el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
            if (!own.trim() && !field) continue;
            const rect = el.getBoundingClientRect();
            if (!field && (rect.width === 0 || rect.height === 0)) continue;
            const style = getComputedStyle(el);
            if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
            // Genuinely disabled controls may use white at reduced opacity.
            const disabled = (el as HTMLInputElement).disabled === true || style.cursor === "not-allowed" || el.closest("[disabled]") !== null;
            const white = /^rgba?\(255, 255, 255/.test(style.color);
            if (white) continue;
            if (disabled && /^rgba\(255, 255, 255/.test(style.color)) continue;
            bad.push({ sample: (own.trim() || el.getAttribute("placeholder") || "").slice(0, 40), colour: style.color, cls: String(el.className).slice(0, 40) });
          }
          return bad;
        });
        if (found.length) offenders.push({ route, width, found: found.slice(0, 5) });
      }
    }
    expect(offenders, `non-white text: ${JSON.stringify(offenders, null, 1)}`).toEqual([]);
  });

  test("numbered step badges are 24px circles with centred, unclipped digits", async ({ page }) => {
    test.setTimeout(120_000);
    for (const [, width, height] of viewports) {
      await page.setViewportSize({ width, height });
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await openRoute(page, "Projects");
      const badges = page.locator(".step-badge");
      expect(await badges.count(), `${width}px badge count`).toBeGreaterThan(0);

      const measured = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".step-badge")].map((el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const range = document.createRange();
        range.selectNodeContents(el);
        const glyph = range.getBoundingClientRect();
        return {
          text: el.textContent!.trim(),
          w: rect.width, h: rect.height,
          flexShrink: style.flexShrink, boxSizing: style.boxSizing, display: style.display,
          alignItems: style.alignItems, justifyContent: style.justifyContent,
          padding: style.padding, overflow: style.overflow, aspectRatio: style.aspectRatio,
          fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: style.lineHeight,
          numeric: style.fontVariantNumeric, colour: style.color, whiteSpace: style.whiteSpace,
          dx: (glyph.left + glyph.width / 2) - (rect.left + rect.width / 2),
          dy: (glyph.top + glyph.height / 2) - (rect.top + rect.height / 2),
          inside: glyph.left >= rect.left - 0.5 && glyph.right <= rect.right + 0.5
            && glyph.top >= rect.top - 0.5 && glyph.bottom <= rect.bottom + 0.5,
          clipped: el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1,
        };
      }));

      for (const b of measured) {
        const where = `${width}px badge "${b.text}"`;
        expect(b.w, `${where} width`).toBeCloseTo(24, 1);
        expect(b.h, `${where} height`).toBeCloseTo(24, 1);
        expect(b.w, `${where} is square`).toBeCloseTo(b.h, 1);
        expect(b.flexShrink, `${where} must not shrink`).toBe("0");
        expect(b.boxSizing, `${where} box-sizing`).toBe("border-box");
        // Declared `inline-flex`; a flex/grid item blockifies to `flex`, so accept
        // either — what matters is that it is a centring flex container.
        expect(["inline-flex", "flex"], `${where} display`).toContain(b.display);
        expect(b.alignItems, `${where} align-items`).toBe("center");
        expect(b.justifyContent, `${where} justify-content`).toBe("center");
        expect(b.padding, `${where} padding`).toBe("0px");
        expect(b.overflow, `${where} overflow`).toBe("hidden");
        expect(b.aspectRatio, `${where} aspect-ratio`).toBe("1 / 1");
        expect(b.fontSize, `${where} font-size`).toBe("14px");
        expect(b.fontWeight, `${where} font-weight`).toBe("500");
        expect(b.lineHeight, `${where} line-height`).toBe("14px");
        expect(b.numeric, `${where} tabular figures`).toContain("tabular-nums");
        expect(b.whiteSpace, `${where} stays on one line`).toBe("nowrap");
        expect(b.colour, `${where} colour`).toBe("rgb(255, 255, 255)");
        expect(b.inside, `${where} digit inside its box`).toBe(true);
        expect(b.clipped, `${where} digit not clipped`).toBe(false);
        expect(Math.abs(b.dx), `${where} horizontal centring`).toBeLessThanOrEqual(1);
        expect(Math.abs(b.dy), `${where} vertical centring`).toBeLessThanOrEqual(1);
      }
    }
  });

  test("a badge keeps its circle beside a long wrapping heading and a double digit", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await openRoute(page, "Projects");
    const stressed = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>(".step-badge");
      if (!el) return null;
      el.textContent = "12";
      const heading = el.parentElement!.querySelector<HTMLElement>(".step-label-text");
      if (heading) heading.textContent = "An extremely long step heading that will certainly wrap across several lines";
      const rect = el.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(el);
      const glyph = range.getBoundingClientRect();
      return {
        w: rect.width, h: rect.height,
        clipped: el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1,
        dx: (glyph.left + glyph.width / 2) - (rect.left + rect.width / 2),
      };
    });
    expect(stressed).not.toBeNull();
    expect(stressed!.w, "stays 24px wide").toBeCloseTo(24, 1);
    expect(stressed!.h, "stays 24px tall").toBeCloseTo(24, 1);
    expect(stressed!.clipped, "double digit is not clipped").toBe(false);
    expect(Math.abs(stressed!.dx), "double digit stays centred").toBeLessThanOrEqual(1);
  });

  test("painted accents come only from the logo-derived palette", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const seen = new Set<string>();
    for (const route of routes) {
      await openRoute(page, route);
      for (const colour of await page.evaluate(() => {
        const out: string[] = [];
        for (const el of document.querySelectorAll<HTMLElement>("*")) {
          if (el.closest("svg,canvas,video,img,iframe") || el.closest(".caption-preview")) continue;
          const style = getComputedStyle(el);
          for (const value of [style.backgroundColor, style.borderTopColor, style.borderLeftColor, style.color, style.outlineColor]) {
            const m = value.match(/^rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?/);
            if (!m) continue;
            if (m[4] !== undefined && Number(m[4]) < 0.99) continue;   // tints composite onto dark surfaces
            const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
            if (Math.max(r, g, b) - Math.min(r, g, b) < 24) continue;  // neutral surfaces and white
            if (Math.max(r, g, b) < 60) continue;                      // too dark to read as an accent
            out.push(`rgb(${r}, ${g}, ${b})`);
          }
        }
        return out;
      })) seen.add(colour);
    }
    const unapproved = [...seen].filter((c) => !APPROVED_ACCENTS.has(c));
    expect(unapproved, `unapproved accent colours: ${unapproved.join(", ")}`).toEqual([]);
  });

  test("no obsolete hard-coded accent literals remain in the stylesheet", async () => {
    const css = await fs.readFile(path.join(process.cwd(), "web", "src", "styles.css"), "utf8");
    // Palettes this UI has already moved off. Any reappearance is a regression.
    const obsolete = [
      "#bc886e", "#dda88f", "188,136,110", "221,168,143",   // copper
      "#5e6ad2", "#828fff", "#5e69d1", "94,106,210",        // interim lavender
      "#53c88b", "83,200,139", "88,196,145", "92,186,117",  // previous success
      "#e35c72", "227,92,114",                              // previous error
      "#8de1b4", "#ff9cad", "#f6bd71", "#ecc28b",           // previous status text
      "#71405e", "#4b5a75", "#806d3b", "#9d4a32",           // previous style swatches
      "#0a0a59", "#9d001f",                                 // pre-logo brand hexes
    ];
    const found = obsolete.filter((literal) => css.includes(literal));
    expect(found, `obsolete accent literals still present: ${found.join(", ")}`).toEqual([]);
  });
});
