/**
 * WebKit logs this console error every time Playwright's `page.screenshot()`
 * runs: the stylesheet Playwright injects is refused by the app's
 * `style-src 'self'`. It comes from the test tool, not the app, and
 * `caret: "initial"` does not stop it.
 *
 * WebKit words a refused inline style from the app the same way, so this is
 * ignored only in WebKit. Chromium logs nothing for a screenshot and still
 * reports an app inline style ("Applying inline style violates ..."), so the
 * CSP check stays covered there.
 */
export function isScreenshotCspNoise(text: string, browserName: string): boolean {
  return browserName === "webkit"
    && text.startsWith("Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive");
}
