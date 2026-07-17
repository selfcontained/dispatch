import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  // public/ holds the Chrome manifest; without this the lib build would copy
  // it over the Safari manifest.json already placed in the outDir.
  publicDir: false,
  build: {
    outDir: "dist/safari/unpacked",
    emptyOutDir: false,
    lib: {
      entry: resolve(import.meta.dirname, "src/safari/overlay/index.ts"),
      name: "DispatchFeedbackOverlay",
      formats: ["iife"],
      fileName: () => "feedback-overlay.js",
    },
    minify: false,
  },
});
