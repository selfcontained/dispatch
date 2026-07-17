import { resolve } from "node:path";
import { defineConfig } from "vite";

// The background ships as a single classic script: Safari's support for
// module service workers is inconsistent, and an IIFE bundle removes the
// question entirely.
export default defineConfig({
  publicDir: false,
  build: {
    outDir: "dist/safari/unpacked",
    emptyOutDir: false,
    lib: {
      entry: resolve(import.meta.dirname, "src/safari/background.ts"),
      name: "DispatchFeedbackBackground",
      formats: ["iife"],
      fileName: () => "background.js",
    },
    minify: false,
  },
});
