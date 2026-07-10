import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

// Electron has three build targets — main (Node), preload (Node, injected into
// the renderer), and renderer (the React/DOM app). electron-vite wires them
// together and serves the renderer over a dev server during `dev`.
export default defineConfig({
  main: {
    // @kestravault/core is a workspace package (its dist isn't guaranteed to exist
    // inside a packaged app's node_modules), so bundle it into main rather than
    // externalizing it; its own runtime deps (supabase-js, yaml) stay external
    // and are declared as direct dependencies so electron-builder packs them.
    plugins: [externalizeDepsPlugin({ exclude: ["@kestravault/core"] })],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    resolve: {
      alias: {
        "@renderer": resolve("src/renderer/src"),
      },
    },
    plugins: [react()],
  },
});
