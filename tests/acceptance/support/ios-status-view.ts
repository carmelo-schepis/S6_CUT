import { test, type TestInfo } from "@playwright/test";

/**
 * iPhone and iPad never load the desktop workspace: `isIOSDevice()` in
 * web/src/App.tsx swaps in the read-only status view, which has no rail,
 * Projects create panel, Settings or Library sidebar. A desktop-workspace
 * contract cannot run there; the status view has its own mobile-* specs.
 */
export function skipOnIOSStatusView(testInfo: TestInfo) {
  const name = testInfo.project.name;
  // The emulated "iPad WebKit desktop mode" reports no multi-touch, so the app
  // serves it the desktop workspace and the contract still runs there.
  test.skip(/^(iPhone|iPad)/.test(name) && !name.endsWith("desktop mode"), "iOS provides a read-only status view; this desktop-workspace contract runs on Desktop and Android Chromium and iPad desktop mode");
}
