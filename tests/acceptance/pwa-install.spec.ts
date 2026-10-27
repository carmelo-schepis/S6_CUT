import { expect, test } from "@playwright/test";

function skipUnlessChromium(browserName: string) {
  test.skip(browserName !== "chromium", "Install prompt event behavior is Chromium-specific.");
}

function injectBeforeInstallPrompt(page: import("@playwright/test").Page, outcome: "accepted" | "dismissed" = "accepted") {
  return page.addInitScript((choice) => {
    const originalAddEventListener = window.addEventListener.bind(window);
    Object.defineProperty(window, "__pwaPromptCalls", { configurable: true, writable: true, value: 0 });
    window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) => {
      if (type === "beforeinstallprompt" && listener) {
        const event = new Event(type, { cancelable: true }) as Event & {
          prompt: () => Promise<void>;
          userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
        };
        event.prompt = async () => { (window as unknown as Window & { __pwaPromptCalls: number }).__pwaPromptCalls += 1; };
        event.userChoice = Promise.resolve({ outcome: choice, platform: "test" });
        if (typeof listener === "function") listener.call(window, event);
        else listener.handleEvent(event);
      }
      return originalAddEventListener(type, listener as EventListener, options);
    }) as typeof window.addEventListener;
  }, outcome);
}

test("Docker build serves the PWA and presents its install invitation on secure origins", async ({ page, request, browserName }) => {
  skipUnlessChromium(browserName);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Create a project" })).toBeVisible();
  const html = await page.locator("html").evaluate((element) => element.outerHTML);
  expect(html).toContain('rel="manifest"');
  expect((await request.get("/manifest.webmanifest")).ok()).toBe(true);
  expect((await request.get("/sw.js")).ok()).toBe(true);
  await expect(page.getByTestId("pwa-install-offer")).toBeVisible();
  await expect(page.getByRole("button", { name: "How to install" })).toBeVisible();
});

test("install prompt captured before React mounts is invoked once and reports acceptance", async ({ page, browserName }) => {
  skipUnlessChromium(browserName);
  await injectBeforeInstallPrompt(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Create a project" })).toBeVisible();
  const offer = page.getByTestId("pwa-install-offer");
  await expect(offer.getByRole("button", { name: "Install" })).toBeVisible();
  await offer.getByRole("button", { name: "Install" }).click();
  await expect(page.getByText("Installation is starting.")).toBeVisible();
  await expect(offer.getByRole("button", { name: "How to install" })).toBeVisible();
  await offer.getByRole("button", { name: "How to install" }).click();
  await expect(page.getByText("In your browser menu, choose Install S6_cut or Add to Home screen.")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as Window & { __pwaPromptCalls: number }).__pwaPromptCalls)).toBe(1);
});

test("a dismissed prompt offers browser menu instructions and does not prompt again", async ({ page, browserName }) => {
  skipUnlessChromium(browserName);
  await injectBeforeInstallPrompt(page, "dismissed");
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const offer = page.getByTestId("pwa-install-offer");
  await offer.getByRole("button", { name: "Install" }).click();
  await expect(page.getByText("Installation was cancelled. You can try again from your browser menu.")).toBeVisible();
  await expect(page.getByText("In your browser menu, choose Install S6_cut or Add to Home screen.")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as Window & { __pwaPromptCalls: number }).__pwaPromptCalls)).toBe(1);
});

test("appinstalled suppresses the invitation", async ({ page, browserName }) => {
  skipUnlessChromium(browserName);
  await page.addInitScript(() => {
    const originalAddEventListener = window.addEventListener.bind(window);
    window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) => {
      if (type === "appinstalled" && listener) {
        const event = new Event(type);
        if (typeof listener === "function") listener.call(window, event);
        else listener.handleEvent(event);
      }
      return originalAddEventListener(type, listener as EventListener, options);
    }) as typeof window.addEventListener;
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Create a project" })).toBeVisible();
  await expect(page.getByTestId("pwa-install-offer")).toHaveCount(0);
});

test("dismissal persists for the origin after reload", async ({ page, browserName }) => {
  skipUnlessChromium(browserName);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const offer = page.getByTestId("pwa-install-offer");
  await expect(offer).toBeVisible();
  await offer.getByRole("button", { name: "Not now" }).click();
  await expect(offer).toHaveCount(0);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Create a project" })).toBeVisible();
  await expect(page.getByTestId("pwa-install-offer")).toHaveCount(0);
});

test("session storage fallback keeps dismissal across reload when local storage is unavailable", async ({ page, browserName }) => {
  skipUnlessChromium(browserName);
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new DOMException("Storage disabled", "SecurityError"); } });
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const offer = page.getByTestId("pwa-install-offer");
  await expect(offer).toBeVisible();
  await offer.getByRole("button", { name: "Not now" }).click();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Create a project" })).toBeVisible();
  await expect(page.getByTestId("pwa-install-offer")).toHaveCount(0);
});

test("HTTP shows an HTTPS explanation instead of invoking the install prompt", async ({ page, browserName }) => {
  skipUnlessChromium(browserName);
  await injectBeforeInstallPrompt(page);
  await page.addInitScript(() => Object.defineProperty(window, "isSecureContext", { configurable: true, value: false }));
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const offer = page.getByTestId("pwa-install-offer");
  await expect(offer.getByRole("button", { name: "HTTPS required" })).toBeVisible();
  await offer.getByRole("button", { name: "HTTPS required" }).click();
  await expect(page.getByText("Open the HTTPS address for this S6_cut Docker app to install it.")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as Window & { __pwaPromptCalls: number }).__pwaPromptCalls)).toBe(0);
});

test("standalone display mode suppresses the install invitation", async ({ page, browserName }) => {
  skipUnlessChromium(browserName);
  await page.addInitScript(() => {
    const originalMatchMedia = window.matchMedia.bind(window);
    window.matchMedia = (query: string) => query === "(display-mode: standalone)"
      ? ({ matches: true, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false } as MediaQueryList)
      : originalMatchMedia(query);
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Create a project" })).toBeVisible();
  await expect(page.getByTestId("pwa-install-offer")).toHaveCount(0);
});

test("iPhone Safari gets the compact Share then Add to Home Screen instructions", async ({ page, browserName, isMobile }) => {
  test.skip(browserName !== "webkit" || !isMobile, "This interface is specific to the iPhone WebKit project.");
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const offer = page.getByTestId("pwa-install-offer");
  await expect(offer).toBeVisible();
  await expect(offer).toHaveClass(/pwa-install-offer-mobile/);
  await offer.getByRole("button", { name: "How to add" }).click();
  await expect(page.getByText("In Safari, tap Share, then Add to Home Screen.")).toBeVisible();
});

test("ordinary Vite build omits manifest, service worker, and invitation", async ({ page, request, browserName }) => {
  test.skip(browserName !== "chromium", "Build-mode check uses one browser.");
  test.skip(!process.env.S6_PWA_OFF_URL, "Set S6_PWA_OFF_URL to an isolated default-build server to check PWA-disabled output.");
  const origin = process.env.S6_PWA_OFF_URL!;
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  const html = await page.locator("html").evaluate((element) => element.outerHTML);
  expect(html).not.toContain('rel="manifest"');
  expect((await request.get(new URL("/manifest.webmanifest", origin).toString())).status()).toBe(404);
  expect((await request.get(new URL("/sw.js", origin).toString())).status()).toBe(404);
  await expect(page.getByTestId("pwa-install-offer")).toHaveCount(0);
});
