import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Unit tests for the desktop app's platform-agnostic logic — main-process
// helpers (e.g. secrets) and pure renderer utilities (e.g. safeHref, aiPrompts).
// These run in plain Node; nothing here needs a DOM or a live Electron runtime
// (electron is mocked where touched). The React plugin is only here so tests may
// import from `.tsx` modules without tripping over JSX.
export default defineConfig({
  plugins: [react()],
  // Mirror the "@renderer" alias from electron.vite.config.ts so renderer
  // modules under test resolve the same way they do in the app.
  resolve: {
    alias: {
      "@renderer": resolve("src/renderer/src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
