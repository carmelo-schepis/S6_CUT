const SCREENSHOT_CSP_ERROR = "Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive";

/**
 * WebKit logs one console error each time Playwright takes a screenshot of a
 * page or element: the app's `style-src 'self'` refuses the stylesheet
 * Playwright injects. `caret: "initial"` does not stop it.
 *
 * WebKit words a refused inline style from the app the same way. So take
 * screenshots through `take`, and `visible` drops only as many of these
 * errors as screenshots were taken. Any further one is the app's and stays.
 * Chromium logs nothing for a screenshot, so nothing is dropped there.
 */
export function screenshotCspAllowance(browserName: string) {
  let taken = 0;
  return {
    async take(screenshot: () => Promise<unknown>) {
      taken += 1;
      await screenshot();
    },
    visible(consoleErrors: string[]) {
      if (browserName !== "webkit") return consoleErrors;
      let allowance = taken;
      return consoleErrors.filter((error) => {
        if (allowance > 0 && error.startsWith(SCREENSHOT_CSP_ERROR)) {
          allowance -= 1;
          return false;
        }
        return true;
      });
    },
  };
}
