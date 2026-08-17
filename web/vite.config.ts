import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const repoRoot = resolve(process.cwd());
const webRoot = resolve(repoRoot, "web");

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

export default defineConfig({
  root: webRoot,
  plugins: [react(), brandAssets()],
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
