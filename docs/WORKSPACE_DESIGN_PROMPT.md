# Workspace — design prompt

A build prompt for the S6_cut **Workspace** route (`web/src/components/workspace-view.tsx`,
styles in `web/src/styles.css`). It states the intent, the geometry, and the
contracts, and ends with the Playwright suite that proves the result.

Everything here is additive to the existing design system. The token surface in
`:root` is the system; extend it, never bypass it (`DO-NOT-CHANGE/AGENTS.md` §7).

---

## 1. The brief

> You are the UI designer for a local-first video studio. The Workspace is where
> a customer reviews what the engine produced: a progress ledger, the source
> script, the rendered output, an auditable score, and a strip of beats or clips.
> It is the densest route in the product and the one a customer stares at
> longest. Make it read like a tool that was designed, not assembled.

Three words, made concrete:

| Word | What it means here |
|---|---|
| **Professional** | Nothing lands on a subpixel. One measure, one rhythm, one inset, one chrome height. Status is a signal, not a wash of colour. |
| **Dynamic** | The output frame scales with the viewport instead of sitting at a fixed 405px on every screen. The one in-flight row is the only thing that moves or lifts. |
| **Focused** | The video is the largest object in the viewer. Twelve finished steps stop outshouting the one that is running. |

## 2. What was wrong

Measured on the live page before the pass, at a 1600×1100 viewport:

| Defect | Evidence |
|---|---|
| No measure | `.workspace-page` capped at **1900px** while `.page` and `.topbar` use **1540px**. Above a ~1600px viewport the content ran ~200px wider than the bar directly above it. |
| Fractional geometry | Grid columns resolved to **310.612 / 751.487 / 350.7px** from `minmax(205px,.62fr) minmax(420px,1.5fr) minmax(220px,.7fr)`. Every hairline inside those panels then landed on a different subpixel column. |
| No vertical rhythm | Bands separated by **24 / 8 / 2px** depending on which band it was. Command bar padding was `12px 4px` — 4px off the guide every panel below it started on. |
| Progress panel dominated | 12 full-width rows, each with a green tint and a green border: **321px** of green wash, 26% of the fold, on a project where every step had finished. |
| Ragged status column | Each row's status was right-aligned against the margin, so "Complete", "Skipped · Plan supplied by…" and "1 of 1 · Complete" all started on a different column, twelve rows deep. |
| Output was the smallest object | The 9:16 frame rendered **228 × 405** inside a **751px** panel. |
| Panels were not a system | Panels: `border-radius: 0`. Tiles inside them: `6px`. Three cards pushed together with `border-left: 0`. |
| Chip stretched | The beat-tile status chip sits in a grid row of its own and stretched to it — **24px** in the topbar, **32.5px** and **40.5px** on tiles whose text wrapped, against a `--chip-height` of 24px. |

## 3. The geometry

All values resolve from existing tokens. New tokens are declared in `:root`
alongside the ones they extend.

### Measure and rhythm

| Token | Value | Applies to |
|---|---|---|
| `--ws-measure` | `1540px` | `.workspace-page` max-width. **Not a new number** — it is the measure `.page` already uses and `.topbar` mirrors via `padding-inline: max(--page-inset, (100% - 1540px)/2 + --page-inset)`. |
| `--page-inset` | `32px` (24 ≤1180, 20 ≤600) | The one horizontal guide. |
| `--space-6` | `24px` | The gap between **every** band: command bar → progress → grid → board. No exceptions. |
| `--space-4` | `16px` | Inline padding of every panel chrome row and every panel body. |
| `--space-3` | `12px` | Gap between tiles in a film strip; tile interior padding. |

### The three-panel slab

| Token | Value |
|---|---|
| `--ws-rail-left` | `300px` (`260px` ≤1180) |
| `--ws-rail-right` | `340px` (`300px` ≤1180) |
| middle column | `minmax(0, 1fr)` — takes what is left, so all three edges are whole pixels |
| `--ws-panel-radius` | `12px` (`--radius-xl`) |

The three panels are **one framed object**, not three cards: hairline dividers
between them, and only the outer corners rounded —
`12px 0 0 12px` on the first, `0 12px 12px 0` on the last. Rounded per-panel
rather than by clipping the grid, so a focus ring inside a panel is never cut
off at the panel edge.

Collapse: 3-up → 2-up at 1180px (the source rail is dropped, it is the column a
narrow viewport can most afford to lose) → stacked at 820px.

### Chrome

Every chrome row — `.panel-tabs`, `.inspector-tabs`, `.panel-title`,
`.viewer-toolbar`, `.transport`, `.board-header` — is **40px** tall with
**16px** inline padding. The first tab in a tab set pulls back by its own
padding so its *text* starts on the panel's inset, not 12px inside it.

`.checklist-heading` is the one deliberate exception at **36px**: the progress
panel lives inside a 280–340px height contract that eleven rows already spend
275px of, and those four pixels are the difference between comfortable and
failing.

### The progress ledger

A ledger, not twelve chips.

- Rows meet on a **1px hairline**, `gap: 0`. Row height **25px** = 16px icon +
  4px padding × 2 + 1px rule.
- Status travels in the **icon** — green check, amber skip, red alert, stepped
  from `--success` / `--warning` / `--error` with `color-mix`. Finished rows
  paint **no background**.
- Only `.status-active` lifts: `--surface-2` plus a 2px `--selector-highlight`
  inset rule. That accent is the same one a selected tab uses, because it is the
  same idea — the thing the system is currently on.
- Above 540px the status word sits in a **fixed 76px column** (`order: 2`), with
  the detail to its left. All statuses share one left edge. Below 540px the
  existing mobile block stacks label over meta; leave it alone.
- The connector rail starts and stops at the first and last icon centre —
  `top/bottom: 12px`, `left: calc(16px + 8px)`.

### The output viewer

| Token | Value |
|---|---|
| `--ws-frame-height` | `clamp(360px, 52vh, 620px)` |
| stage padding | `24px` |
| frame radius | `8px` (`--radius-lg`) |

The frame is centred on a `--canvas` stage in both axes. The surround is a
**deliberate letterbox**, which is how every editor presents a vertical preview —
not an accident of `place-items`. The ratio the toolbar declares
(`Output · 9:16`) is the ratio actually drawn.

### Film strips

12px gap, 16px inset, equal tile widths and heights, `scroll-snap-type: x
proximity` with `scroll-snap-align: start`. A tile cut in half at the right edge
reads as a layout bug unless the strip says it is a scroller.

### Interaction

`.clip-tile` / `.beat-tile` hover: one surface step (`--surface-3`) and a
stronger hairline, over `.12s`. **No lift, no shadow, no colour** — the page's
depth is carried by the surface ladder, and a hover that invented its own
treatment would be the only object on the page doing so. The global
`prefers-reduced-motion` block already zeroes the transition.

### Typography

The product has two roles: **heading** 12px/600 and **general text** 11px/400.
This pass adds exactly one more, and only because the two existing roles describe
objects *inside* a page and leave the page itself unnamed — the Workspace `<h1>`
rendered at the same 12px as every panel caption beside it.

| Token | Value | Used by |
|---|---|---|
| `--type-title-size` | `18px` (16px ≤600) | `.workspace-project-name` — **this element only** |
| `--type-title-weight` | `600` | |
| `--type-title-line` | `24px` | |
| `--type-title-tracking` | `-0.4px` | |

It is not a general heading size. Do not reach for it anywhere else.

## 4. Contracts you may not break

These are enforced by acceptance suites, not by convention. A redesign that
violates one is not shippable regardless of how it looks.

| Contract | Suite |
|---|---|
| Controls are **outlines** at rest: fill alpha < 0.85, radius ≤ 2px, border ≥ 1px, never a circle or pill. | `control-style-and-commandbar.spec.ts` |
| Every visible first-party text node is **white**. Hierarchy comes from weight, spacing, borders and surfaces — never from a second text hue. | `ui-theme.spec.ts` |
| Painted accents come only from the approved palette: `#766bff` selection, `#4cb782` success, `#f0a84b` warning, `#f23855` error. **No new hue.** | `ui-theme.spec.ts` |
| The progress panel is a full-width vertical list: rows ≤ 28px, panel **280–340px**, `lower-workspace` below it and above 900px at 1440×900. | `vertical-progress.spec.ts` |
| The page container and the topbar start and end on the same column. | `visual-alignment.spec.ts` |
| Status chips are one component at one height (`--chip-height`, 24px). | `visual-alignment.spec.ts` |
| Numbered step badges are 24px circles at `--type-text-size`. | `ui-theme.spec.ts` |

### Note on Linear's system

If you are working from a Linear-derived reference (`DESIGN.md`): take its
**structure** — one measure, a surface ladder carrying hierarchy without shadow,
whole-pixel geometry on a 4px grid, hairline borders, the content as protagonist,
accent spent scarcely — and **not** its palette or type scale. Its lavender
`#5e6ad2`, its grey `ink-muted` / `ink-subtle` ramp, its filled 8px-radius CTAs
and its 80/56/40/28/22px display scale each fail one of the contracts above.
The closest legal equivalent of Linear's lavender here is `--selector-highlight`
`#766bff`, which is already the selection accent and carries the same meaning.

## 5. Result

Measured at 1440×900 after the pass:

| | Before | After |
|---|---|---|
| Page measure | 1900px (topbar 1540px) | 1540px, shared |
| Grid columns | 310.612 / 751.487 / 350.7 | 300 / 613 / 340 |
| Band gaps | 24 / 8 / 2px | 24 / 24 / 24px |
| Progress panel (11 steps) | 321px, green wash | 312px, hairline ledger |
| Status column spread | ragged | **0.00px** |
| Row height / gap | 24px / 2px | 25px / 0px |
| Output frame | 228 × 405 | 233 × 414 (506 at 1100px, 620 cap) |
| Panel radius | 0px | 12px outer |
| Status chip height | 24 / 32.5 / 40.5px | 24px |

---

## 6. The test

`tests/acceptance/workspace-design-system.spec.ts`. Run it against a running
instance:

```bash
npm run test:acceptance -- workspace-design-system
```

It opens whatever finished project the instance has and skips cleanly when there
is none, so it never puts a 15-minute encode in front of a layout check. Every
number is measured from the rendered page, never read from the stylesheet — a
token that stops being applied fails here.

```ts
/**
 * Workspace design-system acceptance — spacing and text.
 *
 * The workspace is the densest route in the product and the one where a layout
 * regression is hardest to see by eye: twelve progress rows, three panels, a
 * viewer and a film strip all competing for one fold. These assertions encode
 * the geometry the redesign established so it cannot erode a rule at a time.
 *
 * Every number is measured from the rendered page, never read from the
 * stylesheet, so a token that stops being applied fails here.
 *
 * What is locked, and why each one was a real defect before it was locked:
 *
 *   SPACING
 *   1. One measure. `.workspace-page` opted out of the 1540px guide `.page`
 *      uses and `.topbar` mirrors, so above a ~1600px viewport the content ran
 *      ~200px wider than the bar directly above it.
 *   2. One vertical rhythm. The bands between the command bar and the film
 *      strip separated by 24 / 8 / 2px depending on which one it was.
 *   3. Whole pixels. The three panels measured 310.612 / 751.487 / 350.7px
 *      because the grid used fractional `fr` tracks; every hairline inside them
 *      then landed on a different subpixel column.
 *   4. One inline padding for panel chrome, and one height for a chrome row.
 *   5. The progress ledger's status words share a single left edge. They used
 *      to end ragged against the right margin, twelve rows deep.
 *
 *   TEXT
 *   6. Section captions, the page title and the status vocabulary are exact.
 *   7. No first-party text is clipped by its own box.
 *   8. Text stays white — hierarchy comes from weight, spacing and surfaces.
 *
 * The progress panel's 280-340px height contract is owned by
 * vertical-progress.spec.ts; it is re-asserted here only because this suite's
 * ledger rules (hairline rows, no gap) are what spend that budget.
 */
```

> The full source is the file itself — it is the executable half of this
> document, and the two are meant to be read together. The ten cases are:
>
> | Case | Locks |
> |---|---|
> | `the page, the topbar and every band share one horizontal guide` | `max-width` is `1540px`; page and topbar content edges match within 1px at 1920 / 1680 / 1440 / 1280 / 1024; no horizontal overflow. Deliberately samples **above** the measure, which is where the drift used to live and where the existing suite stopped looking. |
> | `every band of the page separates by exactly one 24px gap` | Walks the real children of `.workspace-page` and asserts every consecutive gap is 24px, and that all bands share a left edge and a width. |
> | `the three-panel grid resolves to whole pixels` | Side columns 300/340; every track within 0.5px of an integer; no seam between panels; equal heights; outer corners `12px 0px 0px 12px` and `0px 12px 12px 0px`. |
> | `panel chrome shares one inline padding and one height` | Six chrome rows at 16px inline padding and 40px height (36px for the progress heading), each a multiple of the 4px grid; panel bodies on the same inset. |
> | `a status chip is one component at one height, wherever it appears` | Every `.status` equals `--chip-height`; spread ≤ 0.5px. |
> | `the progress ledger is one hairline-ruled list with an aligned status column` | Panel 280–340px and 12px radius; rows equal height ≤28px, sharing a left edge and width, meeting at gap 0; **every status word on one column**; no non-active row paints a fill. |
> | `the output frame is the largest object in the viewer and is centred` | Frame ≥360px, inside its stage, centred within 1px, 24px stage inset, and the drawn ratio matches the ratio the toolbar declares. |
> | `the film strip scrolls in whole tiles on one gap` | 12px gap, 16px inset, equal tile widths and heights, and snap points whenever the strip actually overflows. |
> | `the page names itself, its sections and its statuses exactly` | Title is the project name at 18px/600 and outranks a panel caption; captions read `Short creation progress`, `Details`, `Clip board`/`Beat board`, `Output · 9:16`; tabs are `Score, Captions, Asset, Info`; clip-mode filters are `All clips, Selected clips, Failed clips`; Beat-mode Workspaces do not show clip filters; every status word is in the closed set. |
> | `no first-party text is clipped by its own box, and all of it is white` | At 1440 / 1280 / 1024 / 768 / 390: nothing overflows its own box unless it declares an ellipsis, a line clamp or a scroller; every text node is white. |
> | `the layout holds from a 4K desktop down to a phone` | At 1920 / 1440 / 1280 / 1024 / 768 / 390: nothing sits outside the viewport, no horizontal scroll, and the panel count measured **from where the panels landed** is 3 / 2 / 1 at the right breakpoints. |
