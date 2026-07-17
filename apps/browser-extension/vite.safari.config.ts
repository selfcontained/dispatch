import { copyFileSync, cpSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

// public/ holds the Chrome manifest, so the Safari build assembles its own
// static files instead of using Vite's publicDir copy.
function safariStaticFiles(): Plugin {
  return {
    name: "safari-static-files",
    closeBundle() {
      const outDir = resolve(import.meta.dirname, "dist/safari/unpacked");
      copyFileSync(
        resolve(import.meta.dirname, "manifest.safari.json"),
        resolve(outDir, "manifest.json")
      );
      cpSync(
        resolve(import.meta.dirname, "public/icons"),
        resolve(outDir, "icons"),
        { recursive: true }
      );
    },
  };
}

export default defineConfig({
  publicDir: false,
  plugins: [safariStaticFiles()],
  build: {
    outDir: "dist/safari/unpacked",
    rollupOptions: {
      input: {
        popup: resolve(import.meta.dirname, "popup.html"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
