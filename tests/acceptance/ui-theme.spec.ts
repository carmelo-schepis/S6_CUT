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
 *   3. accents come only from the approved palette;
 *   4. no brand red is painted anywhere — the accent is white, and red survives
 *      only as the failure signal.
 *
 * Rule 4 exists because rule 3 cannot see the problem it guards: that test only
 * inspects fully opaque paint, and a brand hue lives mostly in low-alpha tints
 * and borders. A recolour that misses one panel border or one `:has()` rule
 * looks finished and is not.
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

const routes = ["Projects", "Library", "Workspace", "Shorts Editor", "Jobs", "Settings"] as const;

/**
 * The chromatic paint this UI is allowed to show. The brand accent is white and
 * white is near-neutral, so it never reaches this list — the accent passes by
 * being colourless, which is the point.
 */
const APPROVED_ACCENTS = new Set([
  "rgb(118, 107, 255)", // --accent-primary  (option selection, independent of brand)
  "rgb(145, 137, 255)", // --accent-primary-hover
  "rgb(76, 183, 130)",  // --success
  "rgb(240, 168, 75)",  // --warning
  "rgb(242, 56, 85)",   // --error / --accent-crimson
  // Destructive-action states, stepped from --error toward the surface below.
  // These only paint on :hover/:active/:disabled, so the scan above rarely
  // reaches them; they are listed so the ramp is declared rather than implied.
  "rgb(208, 48, 73)",   // --error-hover
  "rgb(175, 41, 62)",   // --error-active
  "rgb(109, 35, 47)",   // --error-disabled
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
      const textSize = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--type-text-size").trim());

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
        expect(b.fontSize, `${where} font-size`).toBe(textSize);
        expect(b.fontWeight, `${where} font-weight`).toBe("500");
        // `line-height: 1`: the digit's line box is exactly its own type size.
        expect(b.lineHeight, `${where} line-height`).toBe(textSize);
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
        // Chromium serialises a `color-mix(in srgb, …)` result as
        // `color(srgb 0.81 0.19 0.28)`, not as `rgb()`. Without this branch a
        // whole ramp of painted colour is invisible to the scan.
        const read = (value: string): { r: number; g: number; b: number; a: number } | null => {
          const legacy = /^rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?/.exec(value);
          if (legacy) return { r: +legacy[1], g: +legacy[2], b: +legacy[3], a: legacy[4] === undefined ? 1 : +legacy[4] };
          const modern = /^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?:\s*\/\s*([\d.]+))?/.exec(value);
          if (modern) return { r: Math.round(+modern[1] * 255), g: Math.round(+modern[2] * 255), b: Math.round(+modern[3] * 255), a: modern[4] === undefined ? 1 : +modern[4] };
          return null;
        };
        const out: string[] = [];
        for (const el of document.querySelectorAll<HTMLElement>("*")) {
          if (el.closest("svg,canvas,video,img,iframe") || el.closest(".caption-preview")) continue;
          const style = getComputedStyle(el);
          for (const value of [style.backgroundColor, style.borderTopColor, style.borderLeftColor, style.color, style.outlineColor]) {
            const parsed = read(value);
            if (!parsed) continue;
            const { r, g, b, a } = parsed;
            if (a < 0.99) continue;                                    // tints composite onto dark surfaces
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

  test("no brand red is painted anywhere", async ({ page }) => {
    test.setTimeout(300_000);
    const offenders: unknown[] = [];
    for (const [, width, height] of viewports) {
      await page.setViewportSize({ width, height });
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await expect(page.locator(".app-rail nav")).toBeVisible();
      for (const route of routes) {
        await openRoute(page, route);
        const found = await page.evaluate(() => {
          // Every colour in a value, alpha included. Alpha is deliberately NOT a
          // reason to skip: a brand hue survives a recolour mostly as low-alpha
          // tints and hairlines, which is exactly the hole this test closes.
          // Both serialisations matter — Chromium writes a `color-mix(in srgb,…)`
          // result as `color(srgb 0.81 0.19 0.28)`, never as `rgb()`.
          const LEGACY = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:\s*[,/]\s*([\d.]+))?\s*\)/g;
          const MODERN = /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)/g;
          type Paint = { r: number; g: number; b: number; a: number; text: string };
          const extract = (value: string): Paint[] => {
            const out: Paint[] = [];
            LEGACY.lastIndex = 0;
            for (let m = LEGACY.exec(value); m; m = LEGACY.exec(value)) {
              out.push({ r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4], text: m[0] });
            }
            MODERN.lastIndex = 0;
            for (let m = MODERN.exec(value); m; m = MODERN.exec(value)) {
              out.push({ r: Math.round(+m[1] * 255), g: Math.round(+m[2] * 255), b: Math.round(+m[3] * 255), a: m[4] === undefined ? 1 : +m[4], text: m[0] });
            }
            return out;
          };
          const triple = (p: Paint) => `${p.r},${p.g},${p.b}`;

          // Resolve the semantic reds through a real element, so a var() chain or
          // a color-mix() yields the used colour rather than its source text —
          // and through the same parser, so the allow-list cannot round
          // differently from the values it is compared against.
          const probe = document.createElement("span");
          probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none";
          document.body.appendChild(probe);
          const allowed = new Set<string>();
          for (const token of ["--error", "--error-hover", "--error-active", "--error-disabled", "--warning"]) {
            probe.style.color = "";
            probe.style.color = `var(${token})`;
            for (const paint of extract(getComputedStyle(probe).color)) allowed.add(triple(paint));
          }
          probe.remove();

          const bad: { cls: string; tag: string; property: string; colour: string }[] = [];
          for (const el of document.querySelectorAll<HTMLElement>("*")) {
            // The caption preview simulates the subtitle FFmpeg burns into the
            // frame; it keeps the render's own colours, not the product's.
            if (el.closest("svg,canvas,video,img,iframe") || el.closest(".caption-preview")) continue;
            const style = getComputedStyle(el);
            const properties = {
              backgroundColor: style.backgroundColor,
              backgroundImage: style.backgroundImage,
              borderTopColor: style.borderTopColor,
              borderRightColor: style.borderRightColor,
              borderBottomColor: style.borderBottomColor,
              borderLeftColor: style.borderLeftColor,
              color: style.color,
              outlineColor: style.outlineColor,
              boxShadow: style.boxShadow,
            };
            for (const [property, value] of Object.entries(properties)) {
              if (!value || value === "none") continue;
              for (const paint of extract(value)) {
                if (paint.a === 0) continue;
                // Meaningfully red, rather than neutral, white or a cool hue.
                if (paint.r - Math.max(paint.g, paint.b) < 24) continue;
                if (allowed.has(triple(paint))) continue;
                bad.push({
                  cls: String(el.className).slice(0, 48) || "(no class)",
                  tag: el.tagName.toLowerCase(),
                  property,
                  colour: paint.text,
                });
              }
            }
          }
          return bad;
        });
        for (const item of found) offenders.push({ route, width, ...item });
      }
    }
    const summary = offenders.slice(0, 25);
    expect(offenders, `brand red still painted (${offenders.length} occurrences): ${JSON.stringify(summary, null, 1)}`).toEqual([]);
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
      // Brand red, retired for a white accent. Red is a failure signal now, so
      // any of these reappearing is the brand creeping back one component at a
      // time — which is how it got everywhere the first time.
      "#B51F3D", "#CC2949", "#971830", "#762135", "181, 31, 61",
      "160,0,30", "197,29,58",
      "#d92f4a", "#bd263e", "#74303d",                      // old .button-danger ramp
    ];
    const found = obsolete.filter((literal) => css.includes(literal));
    expect(found, `obsolete accent literals still present: ${found.join(", ")}`).toEqual([]);
  });
});
