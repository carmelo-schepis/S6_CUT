import { useEffect, useState } from "react";
import { Download, Wifi, WifiOff } from "lucide-react";
import { activateWaitingServiceWorker, PWA_UPDATE_READY_EVENT } from "../pwa";

export function PwaStatus() {
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine);
  const [backOnline, setBackOnline] = useState(false);
  const [updateRegistration, setUpdateRegistration] = useState<ServiceWorkerRegistration | null>(null);
  const [applyingUpdate, setApplyingUpdate] = useState(false);

  useEffect(() => {
    let recoveryTimer = 0;
    const handleOffline = () => {
      window.clearTimeout(recoveryTimer);
      setOnline(false);
      setBackOnline(false);
    };
    const handleOnline = () => {
      window.clearTimeout(recoveryTimer);
      setOnline(true);
      setBackOnline(true);
      recoveryTimer = window.setTimeout(() => setBackOnline(false), 4_000);
    };
    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    return () => {
      window.clearTimeout(recoveryTimer);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
    };
  }, []);

  useEffect(() => {
    const handleUpdateReady = (event: Event) => {
      const registration = (event as CustomEvent<ServiceWorkerRegistration>).detail;
      if (registration?.waiting) setUpdateRegistration(registration);
    };
    window.addEventListener(PWA_UPDATE_READY_EVENT, handleUpdateReady);
    return () => window.removeEventListener(PWA_UPDATE_READY_EVENT, handleUpdateReady);
  }, []);

  const update = () => {
    if (!updateRegistration || !activateWaitingServiceWorker(updateRegistration)) return;
    setApplyingUpdate(true);
  };

  return <>
    {!online && <div className="pwa-status pwa-status-offline" role="status" data-testid="pwa-offline-status">
      <WifiOff size={15} aria-hidden="true" />
      <span>Offline mode — the loaded app shell remains available.</span>
    </div>}
    {online && backOnline && <div className="pwa-status pwa-status-online" role="status" data-testid="pwa-online-status">
      <Wifi size={15} aria-hidden="true" />
      <span>Back online — local engine requests can resume.</span>
    </div>}
    {updateRegistration && <div className="pwa-status pwa-status-update" role="status" data-testid="pwa-update-status">
      <Download size={15} aria-hidden="true" />
      <span>A new S6_cut version is ready.</span>
      <button type="button" className="pwa-update-button" onClick={update} disabled={applyingUpdate}>
        {applyingUpdate ? "Applying update…" : "Update app"}
      </button>
    </div>}
  </>;
}
