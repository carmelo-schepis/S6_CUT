import { useEffect, useState, useSyncExternalStore } from "react";
import { Download, Smartphone, Wifi, WifiOff } from "lucide-react";
import {
  activateWaitingServiceWorker,
  dismissPwaInstall,
  getPwaInstallRevision,
  getPwaInstallSnapshot,
  isIOSDevice,
  isPwaStandalone,
  promptPwaInstall,
  PWA_UPDATE_READY_EVENT,
  subscribePwaInstall,
  wasPwaInstallDismissed,
} from "../pwa";
import type { PwaInstallSnapshot } from "../pwa";

export function PwaStatus({ mobile = false }: { mobile?: boolean }) {
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine);
  const [backOnline, setBackOnline] = useState(false);
  const [updateRegistration, setUpdateRegistration] = useState<ServiceWorkerRegistration | null>(null);
  const [applyingUpdate, setApplyingUpdate] = useState(false);
  useSyncExternalStore(subscribePwaInstall, getPwaInstallRevision, getPwaInstallRevision);
  const installState: PwaInstallSnapshot = getPwaInstallSnapshot();
  const [dismissed, setDismissed] = useState(wasPwaInstallDismissed);
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const [installMessage, setInstallMessage] = useState("");
  const [installing, setInstalling] = useState(false);

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
  const pwaEnabled = __S6_PWA_ENABLED__;
  const secureContext = typeof window !== "undefined" && window.isSecureContext;
  const standalone = typeof window !== "undefined" && isPwaStandalone();
  const installOfferVisible = pwaEnabled && !standalone && !installState.installed && !dismissed;
  const ios = mobile || (typeof navigator !== "undefined" && isIOSDevice());

  const install = async () => {
    if (installState.available && secureContext && !ios) {
      setInstalling(true);
      const outcome = await promptPwaInstall();
      setInstalling(false);
      if (outcome === "accepted") setInstallMessage("Installation is starting.");
      else if (outcome === "dismissed") {
        setInstallMessage("Installation was cancelled. You can try again from your browser menu.");
        setInstructionsOpen(true);
      } else if (outcome === "failed") {
        setInstallMessage("The install prompt could not open. Use your browser menu to install S6_cut.");
        setInstructionsOpen(true);
      }
      return;
    }
    setInstructionsOpen((open) => !open);
  };

  if (!pwaEnabled) return null;

  return <>
    {installOfferVisible && <section className={mobile ? "pwa-status pwa-install-offer pwa-install-offer-mobile" : "pwa-status pwa-install-offer"} aria-label="Install S6_cut" data-testid="pwa-install-offer">
      <Smartphone size={17} aria-hidden="true" />
      <span className="pwa-install-copy"><strong>Install S6_cut</strong><span>Open your video studio from your home screen.</span></span>
      <div className="pwa-install-actions">
        <button
          type="button"
          className="pwa-update-button"
          disabled={installing}
          aria-expanded={instructionsOpen}
          aria-controls="pwa-install-instructions"
          onClick={() => void install()}
        >{installing ? "Opening install prompt…" : installState.available && secureContext && !ios ? "Install" : !secureContext ? "HTTPS required" : ios ? "How to add" : "How to install"}</button>
        <button type="button" className="pwa-install-dismiss" onClick={() => { dismissPwaInstall(); setDismissed(true); }}>Not now</button>
      </div>
      {instructionsOpen && <p id="pwa-install-instructions" className="pwa-install-instructions" role="status">
        {!secureContext
          ? "Open the HTTPS address for this S6_cut Docker app to install it."
          : ios
            ? "In Safari, tap Share, then Add to Home Screen."
            : "In your browser menu, choose Install S6_cut or Add to Home screen."}
      </p>}
      {installMessage && <p className="pwa-install-instructions" role="status">{installMessage}</p>}
    </section>}
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
