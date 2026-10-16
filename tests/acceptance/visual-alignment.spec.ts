/**
 * Visual-alignment acceptance.
 *
 * These assertions encode the geometry contracts the compact design system
 * relies on — one badge size, one control height per row, one page guide — so a
 * future rule that quietly re-introduces a 21.39px chip or a shrunken action
 * column fails here rather than in a screenshot review.
 *
 * Everything is measured from the rendered page, never from the stylesheet, and
 * every tolerance is 1px unless a fluid `fr` track makes an exact match
 * impossible (noted where it applies).
 */
import { expect, test } from "@playwright/test";

type Page = import("@playwright/test").Page;

const viewports = [
  ["desktop", 1440, 900],
  ["laptop", 1280, 800],
  ["small-laptop", 1024, 768],
  ["tablet", 768, 1024],
  ["mobile", 390, 844],
] as const;

/** Every primary destination, by the accessible name on its rail button. */
const routes = ["Projects", "Library", "Workspace", "Shorts Editor", "Jobs", "Settings"] as const;

const spread = (values: number[]) => Math.max(...values) - Math.min(...values);

async function gotoRoute(page: Page, name: string) {
  await page.getByRole("button", { name, exact: true }).first().click();
  await page.waitForTimeout(400);
}

async function expectNoHorizontalOverflow(page: Page, where: string) {
  const measurement = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(measurement.scrollWidth, `${where}: document scrolls horizontally`).toBeLessThanOrEqual(measurement.clientWidth + 1);
}

/**
 * First-party content clipped by an ancestor that is not a scroll container.
 * Deliberate affordances are excluded: a scrollable region, an `ellipsis`
 * truncation and screen-reader-only text are all designed to overflow.
 */
async function findClippedContent(page: Page) {
  return page.evaluate(() => {
    const clipped: { selector: string; dx: number; dy: number }[] = [];
    for (const element of document.querySelectorAll("body *")) {
      if (!element.getClientRects().length) continue;
      if (element.closest(".sr-only")) continue;
      // A single-line form control is its own scroll container for its value:
      // the asset inspector's Licence field holds 49 characters in a 246px box
      // and reports a 36px overflow while working exactly as designed. That is
      // the control scrolling, not an ancestor clipping first-party content,
      // which is what this scan is for.
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName)) continue;
      const style = getComputedStyle(element);
      const scrolls = (value: string) => value === "auto" || value === "scroll";
      if (scrolls(style.overflowX) || scrolls(style.overflowY)) continue;
      if (style.overflowX === "visible" && style.overflowY === "visible") continue;
      if (style.textOverflow === "ellipsis") continue;
      if (style.webkitLineClamp && style.webkitLineClamp !== "none") continue;
      const dx = element.scrollWidth - element.clientWidth;
      const dy = element.scrollHeight - element.clientHeight;
      if (dx > 1 || dy > 1) {
        const className = typeof element.className === "string" ? element.className.trim().split(/\s+/).join(".") : "";
        clipped.push({ selector: `${element.tagName.toLowerCase()}${className ? `.${className}` : ""}`, dx, dy });
      }
    }
    return clipped;
  });
}

test.describe("visual alignment", () => {
  test("step badges are one component at one size on every screen", async ({ page }) => {
    test.setTimeout(180_000);
    for (const [name, width, height] of viewports) {
      await page.setViewportSize({ width, height });
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await gotoRoute(page, "Projects");

      const badges = await page.locator(".step-badge").evaluateAll((elements) => elements.map((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const digit = element.firstChild && element.firstChild.nodeType === Node.TEXT_NODE
          ? (() => { const range = document.createRange(); range.selectNodeContents(element); return range.getBoundingClientRect(); })()
          : null;
        return {
          text: (element.textContent || "").trim(),
          width: rect.width, height: rect.height, left: rect.left, top: rect.top,
          boxSizing: style.boxSizing, flex: style.flex, padding: style.padding,
          fontSize: style.fontSize, lineHeight: style.lineHeight, transform: style.transform,
          borderRadius: style.borderRadius, aspectRatio: style.aspectRatio,
          fontVariantNumeric: style.fontVariantNumeric, position: style.position,
          digit: digit ? { left: digit.left, right: digit.right, top: digit.top, bottom: digit.bottom } : null,
          // The heading row the badge shares an axis with.
          row: element.parentElement ? (() => { const r = element.parentElement!.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; })() : null,
        };
      }));

      expect(badges.length, `${name}: expected the three numbered steps`).toBe(3);
      expect(badges.map((badge) => badge.text)).toEqual(["1", "2", "3"]);

      for (const badge of badges) {
        // Fixed 24x24 box, whatever the heading beside it does.
        expect(badge.width, `${name}: badge ${badge.text} width`).toBe(24);
        expect(badge.height, `${name}: badge ${badge.text} height`).toBe(24);
        expect(badge.boxSizing, `${name}: badge ${badge.text} box-sizing`).toBe("border-box");
        // Never shrinks in a flex row.
        expect(badge.flex, `${name}: badge ${badge.text} flex`).toBe("0 0 24px");
        expect(badge.padding, `${name}: badge ${badge.text} padding`).toBe("0px");
        // `line-height: 1` — the digit's line box is exactly its own type size,
        // so one- and two-digit values centre on the same optical axis.
        expect(parseFloat(badge.lineHeight), `${name}: badge ${badge.text} line-height`).toBe(parseFloat(badge.fontSize));
        expect(badge.aspectRatio, `${name}: badge ${badge.text} aspect-ratio`).toBe("1 / 1");
        expect(parseFloat(badge.borderRadius), `${name}: badge ${badge.text} is not a pill`).toBeGreaterThanOrEqual(12);
        expect(badge.fontVariantNumeric, `${name}: badge ${badge.text} figures`).toBe("tabular-nums");
        expect(badge.position, `${name}: badge ${badge.text} is positioned out of flow`).toBe("static");
        expect(badge.transform, `${name}: badge ${badge.text} transform`).toBe("none");
        // The digit stays inside its circle.
        expect(badge.digit!.left, `${name}: badge ${badge.text} digit escapes left`).toBeGreaterThanOrEqual(badge.left - 0.5);
        expect(badge.digit!.right, `${name}: badge ${badge.text} digit escapes right`).toBeLessThanOrEqual(badge.left + badge.width + 0.5);
        expect(badge.digit!.top, `${name}: badge ${badge.text} digit escapes top`).toBeGreaterThanOrEqual(badge.top - 0.5);
        expect(badge.digit!.bottom, `${name}: badge ${badge.text} digit escapes bottom`).toBeLessThanOrEqual(badge.top + badge.height + 0.5);
        // Centred on its heading's vertical axis.
        const rowCentre = (badge.row!.top + badge.row!.bottom) / 2;
        expect(Math.abs((badge.top + badge.height / 2) - rowCentre), `${name}: badge ${badge.text} off its heading axis`).toBeLessThanOrEqual(0.5);
      }

      // Badges 1, 2 and 3 are the same box, not three sizes.
      expect(spread(badges.map((badge) => badge.width)), `${name}: badge widths differ`).toBe(0);
      expect(spread(badges.map((badge) => badge.height)), `${name}: badge heights differ`).toBe(0);
    }
  });

  test("the Processing mode control and the Create action share one control height", async ({ page }) => {
    test.setTimeout(120_000);
    // The create flow is one column: output settings, then Create underneath.
    for (const [name, width, height] of [viewports[0], viewports[1], viewports[3]] as const) {
      await page.setViewportSize({ width, height });
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await gotoRoute(page, "Projects");

      const measure = await page.evaluate(() => {
        const tabs = document.querySelector<HTMLElement>(".processing-mode-tabs");
        const create = document.querySelector<HTMLElement>(".create-button");
        if (!tabs || !create) return null;
        const column = (element: Element) => element.closest(".create-step")!.getBoundingClientRect();
        return {
          tabs: tabs.getBoundingClientRect().toJSON(),
          create: create.getBoundingClientRect().toJSON(),
          tabsColumn: column(tabs).toJSON(),
          createColumn: column(create).toJSON(),
          options: [...tabs.querySelectorAll<HTMLElement>("button")].map((option) => option.getBoundingClientRect().toJSON()),
        };
      });
      expect(measure, `${name}: create panel controls`).not.toBeNull();
      const { tabs, create, tabsColumn, createColumn, options } = measure!;

      expect(tabs.height, `${name}: Processing mode height`).toBe(create.height);
      expect(create.top, `${name}: Create follows the output settings`).toBeGreaterThan(tabsColumn.top);

      // The action block fills its column; it must never shrink to its label.
      expect(create.width, `${name}: Create button does not fill its column`).toBeGreaterThan(createColumn.width - 40);

      // Adjacent segmented options share height and baseline, and a selected
      // option is not drawn larger than an unselected one.
      expect(spread(options.map((option) => option.height)), `${name}: segmented option heights`).toBeLessThanOrEqual(0.5);
      expect(spread(options.map((option) => option.top)), `${name}: segmented option baselines`).toBeLessThanOrEqual(0.5);
    }
  });

  test("a selected option is exactly the size of an unselected one", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await gotoRoute(page, "Projects");

    for (const [group, names] of [
      [".processing-mode-tabs", ["Auto", "Fast", "Smart"]],
      [".format-tabs", ["Short form · 9:16", "Long form · 16:9"]],
    ] as const) {
      const sizes: { name: string; width: number; height: number }[] = [];
      for (const name of names) {
        await page.locator(group).getByRole("button", { name, exact: true }).click();
        await page.waitForTimeout(150);
        const measured = await page.locator(group).evaluate((control) => [...control.querySelectorAll<HTMLElement>("button")].map((option) => {
          const rect = option.getBoundingClientRect();
          return { name: (option.textContent || "").trim(), width: rect.width, height: rect.height, selected: option.classList.contains("active") };
        }));
        expect(spread(measured.map((option) => option.height)), `${group}: heights change with selection`).toBeLessThanOrEqual(0.5);
        expect(spread(measured.map((option) => option.width)), `${group}: widths change with selection`).toBeLessThanOrEqual(1);
        sizes.push(...measured);
      }
      // Every measurement of the group, across every selection, is one size.
      expect(spread(sizes.map((option) => option.height)), `${group}: selection changed the outer height`).toBeLessThanOrEqual(0.5);
    }

    // Editorial style cards carry a selected border; it must not grow the card.
    const cards = await page.locator(".style-card").evaluateAll((elements) => elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { width: rect.width, height: rect.height, selected: element.classList.contains("active"), boxSizing: getComputedStyle(element).boxSizing };
    }));
    expect(cards.some((card) => card.selected), "expected one selected style card").toBe(true);
    expect(spread(cards.map((card) => card.height)), "selected style card height differs").toBeLessThanOrEqual(0.5);
    // Cards divide a fluid grid, so widths may differ by a rounding remainder.
    expect(spread(cards.map((card) => card.width)), "selected style card width differs").toBeLessThanOrEqual(1);
    expect(cards.every((card) => card.boxSizing === "border-box"), "style cards are not border-box").toBe(true);
  });

  test("repeated components keep one geometry per row", async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/", { waitUntil: "domcontentloaded" });

    for (const route of routes) {
      await gotoRoute(page, route);

      // Small status pills are one component: one height everywhere.
      const chipHeights = await page.locator(".status").evaluateAll((elements) => elements
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => element.getBoundingClientRect().height));
      if (chipHeights.length) expect(spread(chipHeights), `${route}: status chip heights differ`).toBeLessThanOrEqual(0.5);

      // Cards of the same kind share their internal padding.
      for (const selector of [".asset-card", ".job-card", ".clip-tile"]) {
        const paddings = await page.locator(selector).evaluateAll((elements) => elements
          .filter((element) => element.getClientRects().length > 0)
          .map((element) => getComputedStyle(element).padding));
        if (paddings.length > 1) expect(new Set(paddings).size, `${route}: ${selector} padding differs`).toBe(1);
      }

      // Buttons that share a row share a height and a top edge.
      const rows = await page.evaluate(() => {
        const buttons = [...document.querySelectorAll<HTMLElement>(".button, .icon-button")]
          .filter((element) => element.getClientRects().length > 0)
          .map((element) => { const rect = element.getBoundingClientRect(); return { label: (element.textContent || element.getAttribute("aria-label") || "").trim().slice(0, 24), top: rect.top, bottom: rect.bottom, height: rect.height }; });
        const grouped: (typeof buttons)[] = [];
        for (const button of buttons) {
          const row = grouped.find((candidate) => candidate.some((other) => Math.abs(other.top - button.top) <= 12
            && Math.min(other.bottom, button.bottom) - Math.max(other.top, button.top) > Math.min(other.height, button.height) * 0.6));
          if (row) row.push(button); else grouped.push([button]);
        }
        return grouped.filter((row) => row.length > 1);
      });
      for (const row of rows) {
        expect(spread(row.map((button) => button.height)), `${route}: buttons on one row differ in height (${row.map((b) => b.label).join(", ")})`).toBeLessThanOrEqual(0.5);
        expect(spread(row.map((button) => button.top)), `${route}: buttons on one row differ in top edge (${row.map((b) => b.label).join(", ")})`).toBeLessThanOrEqual(0.5);
      }
    }
  });

  test("major sections share one horizontal guide, with nothing clipped or overflowing", async ({ page }) => {
    test.setTimeout(240_000);
    for (const [name, width, height] of viewports) {
      await page.setViewportSize({ width, height });
      await page.goto("/", { waitUntil: "domcontentloaded" });

      for (const route of routes) {
        await gotoRoute(page, route);
        await expectNoHorizontalOverflow(page, `${name}/${route}`);

        const clipped = await findClippedContent(page);
        expect(clipped, `${name}/${route}: first-party content clipped by its parent`).toEqual([]);

        // The page container, the sticky topbar and any full-bleed band all
        // start their content on the same column.
        const guides = await page.evaluate(() => {
          const inset = getComputedStyle(document.documentElement).getPropertyValue("--page-inset").trim();
          const container = document.querySelector<HTMLElement>(".page, .workspace-page");
          const topbar = document.querySelector<HTMLElement>(".topbar");
          const read = (element: HTMLElement | null) => {
            if (!element) return null;
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return { left: rect.left + parseFloat(style.paddingLeft), right: rect.right - parseFloat(style.paddingRight) };
          };
          return { inset, container: read(container), topbar: read(topbar) };
        });
        // The inset resolves to a whole number of pixels at every width, so a
        // section edge never lands on a subpixel column.
        expect(Number.isInteger(parseFloat(guides.inset)), `${name}: --page-inset ${guides.inset} is fractional`).toBe(true);
        expect(guides.container, `${name}/${route}: page container`).not.toBeNull();
        expect(Math.abs(guides.container!.left - guides.topbar!.left), `${name}/${route}: topbar and page start on different columns`).toBeLessThanOrEqual(1);
        expect(Math.abs(guides.container!.right - guides.topbar!.right), `${name}/${route}: topbar and page end on different columns`).toBeLessThanOrEqual(1);
      }
    }
  });
});
