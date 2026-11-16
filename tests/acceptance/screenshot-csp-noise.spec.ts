/**
 * The screenshot CSP allowance is the one place a spec drops a console error,
 * so its boundary rules are pinned here: at most one error per screenshot call,
 * and never an allowance that outlives the screenshot that produced it.
 */
import { expect, test } from "@playwright/test";
import { screenshotCspAllowance } from "./support/screenshot-csp-noise";

const SCREENSHOT_CSP = "Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive";
// WebKit words a refused inline style from the app the same way, so this is
// indistinguishable from the screenshot's own error once it reaches the list.
const APP_CSP = `${SCREENSHOT_CSP}: app inline style`;

function fakePage() {
  const listeners: Array<(message: { type: () => string; text: () => string }) => void> = [];
  const page = {
    on: (_event: string, listener: (message: { type: () => string; text: () => string }) => void) => { listeners.push(listener); },
    evaluate: async () => undefined,
  };
  return {
    page: page as unknown as Parameters<typeof screenshotCspAllowance>[0],
    log: (text: string) => listeners.forEach((listener) => listener({ type: () => "error", text: () => text })),
  };
}

test.describe("screenshot CSP allowance", () => {
  test("drops only the error logged inside a WebKit screenshot call", async () => {
    const { page, log } = fakePage();
    const shots = screenshotCspAllowance(page, "webkit");
    log(APP_CSP);
    await shots.take(async () => { log(SCREENSHOT_CSP); });
    await shots.take(async () => {});
    log(APP_CSP);
    expect(shots.visible()).toEqual([APP_CSP, APP_CSP]);
  });

  test("a screenshot that logs nothing leaves no allowance for a later app error", async () => {
    const { page, log } = fakePage();
    const shots = screenshotCspAllowance(page, "webkit");
    await shots.take(async () => {});
    log(APP_CSP);
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
