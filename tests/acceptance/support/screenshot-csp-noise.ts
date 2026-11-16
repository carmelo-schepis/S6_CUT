import type { Page } from "@playwright/test";

const SCREENSHOT_CSP_ERROR = "Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive";

type ConsoleSource = Pick<Page, "on" | "evaluate">;

/**
 * WebKit logs one console error each time Playwright takes a screenshot of a
 * page or element: the app's `style-src 'self'` refuses the stylesheet
 * Playwright injects. `caret: "initial"` does not stop it.
 *
 * WebKit words a refused inline style from the app the same way. So take
 * screenshots through `take`: each call opens a window that closes at the
 * first error it produces, and `visible` drops at most one error from that
 * window. A screenshot that logs nothing leaves an empty window, so an app
 * error logged before, between or after screenshots is always reported, and
 * a window with two errors (screenshot plus app) keeps the second. Chromium
 * logs nothing for a screenshot, so nothing is dropped there.
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
      // resolves. Poll round-trips until it lands, then close the window at
      // once, so anything logged later is outside every screenshot.
      if (browserName === "webkit") {
        for (let attempt = 0; attempt < 10 && errors.length === start; attempt += 1) {
          await page.evaluate(() => undefined);
        }
      }
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
