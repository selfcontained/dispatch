import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: false,
    lib: {
      entry: resolve(import.meta.dirname, "src/picker.ts"),
      name: "DispatchElementPicker",
      formats: ["iife"],
      fileName: () => "picker.js",
    },
    minify: false,
  },
});
