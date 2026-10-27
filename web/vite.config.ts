import { readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const repoRoot = resolve(process.cwd());
const webRoot = resolve(repoRoot, "web");
const pwaEnabled = process.env.VITE_PWA_ENABLED === "true";

function brandAssets(): Plugin {
  const assets: Record<string, string> = {
    "/app-icon.png": resolve(repoRoot, "LOGO", "App icon.png"),
    "/brand-logo.png": resolve(repoRoot, "LOGO", "Default logo.png"),
    "/legal-logo.png": resolve(repoRoot, "LOGO", "Logo for legal.png"),
  };
  return {
    name: "s6-brand-assets",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const source = request.url && assets[request.url.split("?")[0]];
        if (!source) return next();
        response.setHeader("Content-Type", "image/png");
        response.end(readFileSync(source));
      });
    },
    generateBundle() {
      for (const [fileName, source] of Object.entries(assets)) {
        this.emitFile({ type: "asset", fileName: fileName.slice(1), source: readFileSync(source) });
      }
    },
  };
}

function pwaBuildAssets(): Plugin {
  return {
    name: "s6-pwa-build-assets",
    transformIndexHtml(html) {
      return html.replace(/<!-- pwa-only:start -->([\s\S]*?)<!-- pwa-only:end -->/, (_block, content: string) => pwaEnabled ? content : "");
    },
    writeBundle() {
      if (!pwaEnabled) {
        rmSync(resolve(webRoot, "dist/manifest.webmanifest"), { force: true });
        rmSync(resolve(webRoot, "dist/sw.js"), { force: true });
      }
    },
  };
}

export default defineConfig({
  root: webRoot,
  define: { __S6_PWA_ENABLED__: JSON.stringify(pwaEnabled) },
  plugins: [react(), brandAssets(), pwaBuildAssets()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    // DO-NOT-CHANGE: see DO-NOT-CHANGE/AGENTS.md — proxy maps /api to engine port; keep in sync
    proxy: { "/api": { target: "http://127.0.0.1:8001", changeOrigin: true } },
    fs: { allow: [repoRoot] },
  },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: true },
});
