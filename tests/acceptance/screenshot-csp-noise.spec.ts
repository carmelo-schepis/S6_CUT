/**
 * The screenshot CSP allowance is the one place a spec drops a console error,
 * so its boundary rules are pinned here: at most one error per screenshot call,
 * never an allowance that outlives the screenshot that produced it, and the
 * window closes as soon as the screenshot's own error lands.
 */
import { expect, test } from "@playwright/test";
import { screenshotCspAllowance } from "./support/screenshot-csp-noise";

const SCREENSHOT_CSP = "Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive";
// WebKit words a refused inline style from the app the same way, so this is
// indistinguishable from the screenshot's own error once it reaches the list.
const APP_CSP = `${SCREENSHOT_CSP}: app inline style`;
type Listener = (message: { type: () => string; text: () => string }) => void;

function fakePage() {
  const listeners = new Map<string, Listener>();
  const draining: string[] = [];
  let drains = 0;
  function emit(text: string) {
    const listener = listeners.get("console");
    if (!listener) throw new Error("helper did not subscribe to console");
    listener({ type: () => "error", text: () => text });
  }
  const page = {
    on: (event: string, listener: Listener) => { listeners.set(event, listener); },
    // A console entry can cross the browser connection after the screenshot
    // resolves, so the next round-trip is where the helper finds it.
    evaluate: async () => {
      drains += 1;
      const next = draining.shift();
      if (next) emit(next);
    },
  };
  return {
    page: page as unknown as Parameters<typeof screenshotCspAllowance>[0],
    log: emit,
    logOnDrain: (text: string) => draining.push(text),
    drains: () => drains,
    events: () => [...listeners.keys()],
  };
}

test.describe("screenshot CSP allowance", () => {
  test("subscribes to console and drops only the error logged inside a screenshot", async () => {
    const { page, log, events } = fakePage();
    const shots = screenshotCspAllowance(page, "webkit");
    log(APP_CSP);
    await shots.take(async () => { log(SCREENSHOT_CSP); });
    await shots.take(async () => {});
    log(APP_CSP);
    expect(events()).toEqual(["console"]);
    expect(shots.visible()).toEqual([APP_CSP, APP_CSP]);
  });

  test("waits for an error that arrives after the screenshot resolves", async () => {
    const { page, logOnDrain, drains } = fakePage();
    const shots = screenshotCspAllowance(page, "webkit");
    logOnDrain(SCREENSHOT_CSP);
    await shots.take(async () => {});
    expect(drains()).toBe(1);
    expect(shots.visible()).toEqual([]);
  });

  test("a screenshot that logs nothing leaves no allowance for a later app error", async () => {
    const { page, log, drains } = fakePage();
    const shots = screenshotCspAllowance(page, "webkit");
    await shots.take(async () => {});
    log(APP_CSP);
    expect(drains()).toBe(10);
    expect(shots.visible()).toEqual([APP_CSP]);
  });

  test("keeps the app error when one screenshot logs two CSP errors", async () => {
    const { page, log } = fakePage();
    const shots = screenshotCspAllowance(page, "webkit");
    await shots.take(async () => {
      log(SCREENSHOT_CSP);
      log(APP_CSP);
    });
    expect(shots.visible()).toEqual([APP_CSP]);
  });

  test("drops nothing in Chromium", async () => {
    const { page, log } = fakePage();
    const shots = screenshotCspAllowance(page, "chromium");
    await shots.take(async () => { log(SCREENSHOT_CSP); });
    expect(shots.visible()).toEqual([SCREENSHOT_CSP]);
  });
});
