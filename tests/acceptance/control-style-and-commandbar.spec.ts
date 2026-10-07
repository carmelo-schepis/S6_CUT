/**
 * Control-style and command-bar acceptance.
 *
 * Two contracts the "Buttons look weird" report exposed:
 *
 *   1. Controls are outlines, not filled blobs. A control at rest has no opaque
 *      fill and is never a circle or a pill; fill is spent on hover alone. The
 *      loading-shimmer `.skeleton*` components and the status dots are a
 *      different family and are excluded by name.
 *   2. Everything in the workspace command bar sits on one optical axis. The
 *      folder picker used to be a two-row grid inside a bottom-aligned flex
 *      row, so its label overhung the actions by 20px and the 24px status chip
 *      sat 4px below the 32px buttons.
 *
 * `visual-alignment.spec.ts` could not catch (2): it visits the Workspace route
 * with no project selected, where the command bar is never rendered, and its
 * row grouping reads only `.button`/`.icon-button`, not `select` or `.status`.
 */
import { expect, test } from "@playwright/test";
import path from "node:path";
import { createClipProject, root } from "./support/workspace";

type Page = import("@playwright/test").Page;

const spread = (values: number[]) => Math.max(...values) - Math.min(...values);

/** Contract-locked round, or a status indicator rather than a control. */
const EXEMPT = [".step-badge", ".engine-dot", ".checklist-icon", ".skeleton", ".skeleton-card", ".skeleton-tile"];

async function gotoRoute(page: Page, name: string) {
  await page.getByRole("button", { name, exact: true }).first().click();
  await page.waitForTimeout(400);
}

/** Every visible control, with the geometry and paint that define its style. */
async function readControls(page: Page, exempt: string[]) {
  return page.evaluate((exemptSelectors) => {
    const alpha = (colour: string) => {
      const parts = /rgba?\(([^)]+)\)/.exec(colour);
      if (!parts) return 0;
      const channels = parts[1].split(",").map((value) => parseFloat(value));
      return channels.length > 3 ? channels[3] : 1;
    };
    return [...document.querySelectorAll<HTMLElement>(".button, .icon-button, .play-button")]
      .filter((element) => element.getClientRects().length > 0)
      .filter((element) => !exemptSelectors.some((selector) => element.closest(selector)))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          label: (element.textContent || element.getAttribute("aria-label") || "").trim().slice(0, 28),
          className: element.className,
          width: rect.width,
          height: rect.height,
          radius: style.borderRadius,
          radiusPx: parseFloat(style.borderRadius) || 0,
          fillAlpha: alpha(style.backgroundColor),
          borderWidth: parseFloat(style.borderTopWidth) || 0,
          borderColour: style.borderTopColor,
        };
      });
  }, exempt);
}

test.describe("control style", () => {
  test("controls are outlines at rest, never filled blobs or circles", async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/", { waitUntil: "domcontentloaded" });

    for (const route of ["Projects", "Library", "Shorts Editor", "Jobs", "Settings"] as const) {
      await gotoRoute(page, route);
      const controls = await readControls(page, EXEMPT);
      expect(controls.length, `${route}: expected visible controls`).toBeGreaterThan(0);

      for (const control of controls) {
        // No opaque fill at rest. Hover fills are asserted separately below.
        expect(control.fillAlpha, `${route}: "${control.label}" has an opaque fill (${control.fillAlpha})`)
          .toBeLessThan(0.85);
        // Near-square corners, and never a circle or a pill.
        expect(control.radius, `${route}: "${control.label}" radius is a circle`).not.toContain("50%");
        expect(control.radiusPx, `${route}: "${control.label}" radius ${control.radius} exceeds the control radius`)
          .toBeLessThanOrEqual(2);
        expect(control.radiusPx, `${route}: "${control.label}" is a pill`)
          .toBeLessThan(Math.min(control.width, control.height) / 2);
        // A borderless transparent control has no affordance left; ghost
        // buttons keep their 1px border and only make it transparent.
        expect(control.borderWidth, `${route}: "${control.label}" has no border to carry the outline`)
          .toBeGreaterThanOrEqual(1);
      }
    }
  });

  test("a control's outline clears 3:1 against what is behind it", async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/", { waitUntil: "domcontentloaded" });

    for (const route of ["Projects", "Library", "Shorts Editor", "Jobs", "Settings"] as const) {
      await gotoRoute(page, route);
      const measured = await page.evaluate(() => {
        // Chromium serialises a color-mix() result as color(srgb …), never as
        // rgb(), so both spellings have to parse or a whole ramp reads as 0.
        const parse = (value: string): [number, number, number, number] | null => {
          const legacy = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?/.exec(value);
          if (legacy) return [+legacy[1], +legacy[2], +legacy[3], legacy[4] === undefined ? 1 : +legacy[4]];
          const modern = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?/.exec(value);
          if (modern) return [+modern[1] * 255, +modern[2] * 255, +modern[3] * 255, modern[4] === undefined ? 1 : +modern[4]];
          return null;
        };
        const over = (fg: [number, number, number, number], bg: [number, number, number]): [number, number, number] =>
          [0, 1, 2].map((i) => fg[3] * fg[i] + (1 - fg[3]) * bg[i]) as [number, number, number];
        const luminance = ([r, g, b]: [number, number, number]) => {
          const channel = (value: number) => {
            const c = value / 255;
            return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
          };
          return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
        };
        const ratio = (a: [number, number, number], b: [number, number, number]) => {
          const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
          return (high + 0.05) / (low + 0.05);
        };
        /** Everything painted behind an element, composited bottom-up. */
        const backdrop = (element: Element): [number, number, number] => {
          const stack: [number, number, number, number][] = [];
          for (let node = element.parentElement; node; node = node.parentElement) {
            const paint = parse(getComputedStyle(node).backgroundColor);
            if (paint && paint[3] > 0) stack.push(paint);
            if (paint && paint[3] >= 0.999) break;
          }
          const root = parse(getComputedStyle(document.documentElement).backgroundColor);
          let base: [number, number, number] = root && root[3] >= 0.999 ? [root[0], root[1], root[2]] : [0, 0, 0];
          for (const paint of stack.reverse()) base = over(paint, base);
          return base;
        };

        const out: { label: string; className: string; ratio: number; border: string; behind: string }[] = [];
        // Only controls whose own border is their boundary. A segmented option
        // or a tab is deliberately borderless — the shell around it carries the
        // boundary — and a ghost button's affordance is its label, so neither
        // is measured here.
        const selector = ".button:not(.button-ghost), .icon-button, .play-button, input:not([type=checkbox]), select, textarea";
        for (const element of document.querySelectorAll<HTMLElement>(selector)) {
          if (!element.getClientRects().length) continue;
          if ((element as HTMLInputElement).disabled) continue;   // WCAG exempts disabled controls
          const style = getComputedStyle(element);
          if (parseFloat(style.borderTopWidth) < 1) continue;
          const edge = parse(style.borderTopColor);
          if (!edge || edge[3] === 0) continue;
          const behind = backdrop(element);
          const own = parse(style.backgroundColor);
          // A background paints to the border box, so a translucent border
          // composites over the control's own fill, then over the backdrop.
          const under = own && own[3] > 0 ? over(own, behind) : behind;
          const painted = over(edge, under);
          out.push({
            label: (element.textContent || element.getAttribute("aria-label") || element.tagName).trim().slice(0, 30),
            className: String(element.className).slice(0, 40),
            ratio: ratio(painted, behind),
            border: style.borderTopColor,
            behind: `rgb(${behind.map((v) => Math.round(v)).join(", ")})`,
          });
        }

        // The checkbox draws its box in ::before, so it is read separately.
        for (const element of document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
          if (!element.getClientRects().length || element.disabled) continue;
          const style = getComputedStyle(element, "::before");
          const edge = parse(style.borderTopColor);
          if (!edge || edge[3] === 0 || parseFloat(style.borderTopWidth) < 1) continue;
          const behind = backdrop(element);
          const own = parse(style.backgroundColor);
          const under = own && own[3] > 0 ? over(own, behind) : behind;
          out.push({
            label: `checkbox ${element.getAttribute("aria-label") || ""}`.trim().slice(0, 30),
            className: "input[type=checkbox]::before",
            ratio: ratio(over(edge, under), behind),
            border: style.borderTopColor,
            behind: `rgb(${behind.map((v) => Math.round(v)).join(", ")})`,
          });
        }
        return out;
      });

      expect(measured.length, `${route}: expected measurable controls`).toBeGreaterThan(0);
      const failing = measured.filter((control) => control.ratio < 3);
      expect(
        failing,
        `${route}: control outlines below the 3:1 non-text contrast floor:\n${failing
          .map((c) => `  "${c.label}" (${c.className}) ${c.ratio.toFixed(2)}:1 — ${c.border} on ${c.behind}`)
          .join("\n")}`,
      ).toEqual([]);
    }
  });

  test("fill is spent on hover, so a control is still legible as a target", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await gotoRoute(page, "Projects");

    const target = page.locator(".button:not(.button-ghost)").first();
    await expect(target).toBeVisible();
    const read = () => target.evaluate((element) => getComputedStyle(element).backgroundColor);
    const resting = await read();
    await target.hover();
    await page.waitForTimeout(150);
    expect(await read(), "hover does not change the control's fill").not.toBe(resting);
  });
});

test.describe("workspace command bar", () => {
  test("the folder picker, the job badge and the actions share one optical axis", async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1512, height: 900 });
    await page.goto("/", { waitUntil: "domcontentloaded" });

    // A running Fast job is the exact state in the report: the folder picker,
    // the stage badge, Pause, Stop & keep and Download ZIP all in one row.
    await createClipProject(page, {
      name: `UI QA — command bar ${Date.now().toString(36)}`,
      // 8/20 is the fixture's working range — the create form rejects a
      // minimum below 8 seconds, and test-video.mp4 is short.
      count: 2, mode: "Fast", aspect: "9:16", min: 8, max: 20, captions: false,
      source: { kind: "file", path: path.join(root, "test-video.mp4") },
    });

    // The transport play control is the big white disc in the report's first
    // image, and an open project is the only state that renders it — the route
    // sweep above never reaches it, so it is asserted here, where one exists.
    const play = page.locator(".play-button");
    await expect(play).toBeVisible();
    const [transport] = await readControls(page, EXEMPT).then((all) => all.filter((control) => control.className.includes("play-button")));
    expect(transport, "expected the transport play control").toBeDefined();
    expect(transport.fillAlpha, `the play control has an opaque fill (${transport.fillAlpha})`).toBeLessThan(0.85);
    expect(transport.radius, "the play control is a disc").not.toContain("50%");
    expect(transport.radiusPx, `the play control radius ${transport.radius} exceeds the control radius`).toBeLessThanOrEqual(2);
    expect(transport.borderWidth, "the play control has no border to carry the outline").toBeGreaterThanOrEqual(1);

    const controls = page.locator(".workspace-controls");
    await expect(controls).toBeVisible();
    await expect(page.locator("#workspace-business-folder")).toBeVisible();
    await expect(controls.locator(".status")).toBeVisible();

    const measured = await controls.evaluate((row) => {
      const axis = (element: Element, label: string) => {
        const rect = element.getBoundingClientRect();
        return { label, top: rect.top, bottom: rect.bottom, height: rect.height, centre: (rect.top + rect.bottom) / 2 };
      };
      const items = [
        axis(row.querySelector("#workspace-business-folder")!, "business folder select"),
        ...[...row.querySelectorAll(".status")].map((chip) => axis(chip, `status "${(chip.textContent || "").trim()}"`)),
        ...[...row.querySelectorAll(".button")].map((button) => axis(button, `button "${(button.textContent || "").trim()}"`)),
      ];
      const field = row.querySelector(".workspace-folder-field")!;
      // A wrapped row has no single axis to hold, so count the lines before
      // measuring centres. Lines are counted by vertical overlap, never by top
      // edge: a centred row deliberately gives a 24px chip and a 32px button
      // different top edges on the very same line, so bucketing tops would
      // report a wrap precisely when the fix is working.
      let lines = 0;
      let lineBottom = Number.NEGATIVE_INFINITY;
      for (const item of [...items].sort((left, right) => left.top - right.top)) {
        if (item.top >= lineBottom) { lines += 1; lineBottom = item.bottom; }
        else lineBottom = Math.max(lineBottom, item.bottom);
      }
      return {
        items,
        rowHeight: row.getBoundingClientRect().height,
        fieldHeight: field.getBoundingClientRect().height,
        controlHeight: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--control-height")),
        lines,
      };
    });

    expect(measured.items.length, "expected the picker, the badge and the job actions").toBeGreaterThanOrEqual(4);
    expect(measured.lines, "the command bar wrapped at 1512px; centres cannot share an axis").toBe(1);

    // The label must not add height to a control row.
    expect(measured.fieldHeight, "the folder field is taller than one control height")
      .toBeLessThanOrEqual(measured.controlHeight + 1);
    expect(measured.rowHeight, "the command bar is taller than one control height")
      .toBeLessThanOrEqual(measured.controlHeight + 1);

    // The actual report: everything on one optical axis.
    const centres = measured.items.map((item) => item.centre);
    expect(
      spread(centres),
      `command bar items are off one axis:\n${measured.items.map((item) => `  ${item.label}: centre ${item.centre.toFixed(1)} h ${item.height}`).join("\n")}`,
    ).toBeLessThanOrEqual(1);
  });
});
