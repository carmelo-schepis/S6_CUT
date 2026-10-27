export const PWA_UPDATE_READY_EVENT = "s6-cut:pwa-update-ready";

function announceWaiting(registration: ServiceWorkerRegistration) {
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
