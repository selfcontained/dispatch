import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import path from "node:path";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icons/teal/apple-touch-icon.png", "icons/teal/favicon.png"],
      manifest: {
        id: "/",
        name: "Dispatch",
        short_name: "Dispatch",
        description: "Local-first control plane for remote Codex CLI agents.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#141414",
        theme_color: "#141414",
        icons: [
          {
            src: "/icons/teal/pwa-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any"
          },
          {
            src: "/icons/teal/pwa-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any"
          },
          {
            src: "/icons/teal/pwa-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable"
          }
        ]
      },
      workbox: {
        // Do not cache API traffic by default; this app is realtime-oriented.
        navigateFallbackDenylist: [/^\/api\//]
      }
    })
  ],
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    proxy: {
      "/api": {
        target: process.env.VITE_API_TARGET ?? `http://127.0.0.1:${process.env.DISPATCH_PORT ?? 6767}`,
        changeOrigin: true,
        ws: true
      }
    }
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src")
    }
  },
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
});
