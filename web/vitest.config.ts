import { mergeConfig } from "vite";
import { defineConfig } from "vitest/config";
import viteConfig from "./vite.config.ts";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "jsdom",
      setupFiles: "./src/test/setup.ts",
      include: ["src/**/*.test.{ts,tsx}"],
      pool: "forks",
      maxWorkers: 1,
      css: true,
      // jsdom renders the full stylesheet and some interaction tests are
      // heavy; leave headroom for parallel suite runs.
      testTimeout: 15_000,
    },
  }),
);
