import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { registerServiceWorker } from "./pwa";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("S6_cut could not find its application root.");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    void registerServiceWorker().catch((error: unknown) => {
      // A browser without usable service-worker storage should still get the full
      // online application; PWA support is an enhancement, not a boot dependency.
      console.warn("S6_cut service worker registration failed", error);
    });
  }, { once: true });
}
