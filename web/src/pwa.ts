export const PWA_UPDATE_READY_EVENT = "s6-cut:pwa-update-ready";

const INSTALL_DISMISSED_KEY = "s6.pwa.install.dismissed";

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

export type PwaInstallSnapshot = { available: boolean; installed: boolean; revision: number };

let deferredInstallPrompt: InstallPromptEvent | null = null;
let installedThisSession = false;
let dismissedThisSession = false;
let installRevision = 0;
const installListeners = new Set<() => void>();

function publishInstallState() {
  installRevision += 1;
  for (const listener of installListeners) listener();
}

// Capture this before React mounts; Chromium can fire it while the app shell is loading.
if (__S6_PWA_ENABLED__ && typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event as InstallPromptEvent;
    publishInstallState();
  });
  window.addEventListener("appinstalled", () => {
    installedThisSession = true;
    deferredInstallPrompt = null;
    publishInstallState();
  });
}

export function getPwaInstallSnapshot(): PwaInstallSnapshot {
  return { available: deferredInstallPrompt !== null, installed: installedThisSession, revision: installRevision };
}

export function getPwaInstallRevision() {
  return installRevision;
}

export function subscribePwaInstall(listener: () => void) {
  installListeners.add(listener);
  return () => { installListeners.delete(listener); };
}

export function wasPwaInstallDismissed() {
  if (dismissedThisSession) return true;
  try { if (window.localStorage.getItem(INSTALL_DISMISSED_KEY) === "1") return true; } catch { /* Try session storage below. */ }
  try { return window.sessionStorage.getItem(INSTALL_DISMISSED_KEY) === "1"; } catch { return false; }
}

export function dismissPwaInstall() {
  dismissedThisSession = true;
  try { window.localStorage.setItem(INSTALL_DISMISSED_KEY, "1"); } catch {
    try { window.sessionStorage.setItem(INSTALL_DISMISSED_KEY, "1"); } catch { /* In-memory dismissal still prevents repeat offers this page session. */ }
  }
  publishInstallState();
}

export function isPwaStandalone() {
  return Boolean(window.matchMedia?.("(display-mode: standalone)").matches) ||
    ("standalone" in navigator && Boolean((navigator as Navigator & { standalone?: boolean }).standalone));
}

export function isIOSDevice() {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
}

export async function promptPwaInstall() {
  const promptEvent = deferredInstallPrompt;
  if (!promptEvent) return "unavailable" as const;
  deferredInstallPrompt = null;
  publishInstallState();
  try {
    await promptEvent.prompt();
    return (await promptEvent.userChoice).outcome;
  } catch {
    return "failed" as const;
  }
}

export function announceWaiting(registration: ServiceWorkerRegistration) {
  if (!registration.waiting) return;
  window.dispatchEvent(new CustomEvent<ServiceWorkerRegistration>(PWA_UPDATE_READY_EVENT, { detail: registration }));
}

export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return Promise.resolve(undefined);

  return navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).then((registration) => {
    announceWaiting(registration);
    registration.addEventListener("updatefound", () => {
      const worker = registration.installing;
      if (!worker) return;
      worker.addEventListener("statechange", () => {
        if (worker.state === "installed" && navigator.serviceWorker.controller) announceWaiting(registration);
      });
    });
    return registration.update().then(() => registration, () => registration);
  });
}

export function activateWaitingServiceWorker(registration: ServiceWorkerRegistration) {
  const waiting = registration.waiting;
  if (!waiting) return false;

  const reload = () => window.location.reload();
  navigator.serviceWorker.addEventListener("controllerchange", reload, { once: true });
  waiting.postMessage({ type: "SKIP_WAITING" });
  return true;
}
