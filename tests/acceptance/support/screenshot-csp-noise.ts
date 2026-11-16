import type { Page } from "@playwright/test";

const SCREENSHOT_CSP_ERROR = "Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive";

type ConsoleSource = Pick<Page, "on" | "evaluate">;

/**
 * WebKit logs one console error each time Playwright takes a screenshot of a
 * page or element: the app's `style-src 'self'` refuses the stylesheet
 * Playwright injects. `caret: "initial"` does not stop it.
 *
 * WebKit words a refused inline style from the app the same way. So take
 * screenshots through `take`: `visible` drops only an error that arrived
 * during a screenshot call, at most one per call. A screenshot that logs
 * nothing consumes no allowance, so an app error logged before, between or
 * after screenshots is always reported, and a window with two errors
 * (screenshot plus app) keeps the second. Chromium logs nothing for a
 * screenshot, so nothing is dropped there.
 */
export function screenshotCspAllowance(page: ConsoleSource, browserName: string) {
  const errors: string[] = [];
  const windows: Array<{ start: number; end: number }> = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  return {
    errors,
    async take(screenshot: () => Promise<unknown>) {
      const start = errors.length;
      await screenshot();
      // The console entry crosses the browser connection after the screenshot
      // resolves; one round-trip drains it into this screenshot's window.
      await page.evaluate(() => undefined);
      windows.push({ start, end: errors.length });
    },
    visible() {
      if (browserName !== "webkit") return errors;
      const dropped = new Set<number>();
      for (const { start, end } of windows) {
        for (let index = start; index < end; index += 1) {
          if (errors[index].startsWith(SCREENSHOT_CSP_ERROR)) {
            dropped.add(index);
            break;
          }
        }
      }
      return errors.filter((_, index) => !dropped.has(index));
    },
  };
}
