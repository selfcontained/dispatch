import { defineConfig } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";

const isProd = process.env.NODE_ENV === "production";
const browserExtensionArchiveName = "dispatch-browser-feedback.zip";
const browserExtensionArchivePath = path.resolve(
  __dirname,
  "../browser-extension/dist",
  browserExtensionArchiveName
);

function browserExtensionArchivePlugin(): Plugin {
  const readArchive = () => {
    if (!existsSync(browserExtensionArchivePath)) {
      throw new Error(
        `Browser extension archive is missing at ${browserExtensionArchivePath}. Run the browser extension package step first.`
      );
    }
    return readFileSync(browserExtensionArchivePath);
  };

  return {
    name: "dispatch-browser-extension-archive",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = request.url?.split("?", 1)[0];
        if (pathname !== `/${browserExtensionArchiveName}`) {
          next();
          return;
        }

        if (request.method !== "GET" && request.method !== "HEAD") {
          response.statusCode = 405;
          response.setHeader("Allow", "GET, HEAD");
          response.end("Method Not Allowed");
          return;
        }

        const archive = readArchive();
        response.statusCode = 200;
        response.setHeader("Content-Type", "application/zip");
        response.setHeader("Content-Length", archive.byteLength);
        response.setHeader(
          "Content-Disposition",
          `attachment; filename=\"${browserExtensionArchiveName}\"`
        );
        response.end(request.method === "HEAD" ? undefined : archive);
      });
    },
  };
}

// Bake the workspace version into the bundle. The web client compares
// this against the `X-Dispatch-Version` response header to detect a
// stale bundle after a server self-update.
const rootPackageJson = JSON.parse(
  readFileSync(path.resolve(__dirname, "../../package.json"), "utf8")
) as { version?: unknown };
if (
  typeof rootPackageJson.version !== "string" ||
  !rootPackageJson.version.trim()
) {
  throw new Error("Root package.json is missing a version field");
}
const packageVersion = rootPackageJson.version.trim();
// Mirror the shape check from the server-side runtime-assets codegen so
// a malformed release surfaces at build time, not as a runtime
// X-Dispatch-Version header failure.
if (!/^[0-9A-Za-z.+-]+$/.test(packageVersion)) {
  throw new Error(
    `Invalid "version" in root package.json: ${JSON.stringify(packageVersion)}`
  );
}

export default defineConfig({
  cacheDir: process.env.DISPATCH_VITE_CACHE_DIR,
  define: {
    __DISPATCH_VERSION__: JSON.stringify(packageVersion),
  },
  plugins: [
    react(),
    browserExtensionArchivePlugin(),
    isProd &&
      VitePWA({
        registerType: "prompt",
        includeAssets: [
          "icons/teal/apple-touch-icon.png",
          "icons/teal/favicon.png",
        ],
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
              purpose: "any",
            },
            {
              src: "/icons/teal/pwa-512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "any",
            },
            {
              src: "/icons/teal/pwa-512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "maskable",
            },
          ],
        },
        workbox: {
          // Do not cache API traffic by default; this app is realtime-oriented.
          navigateFallbackDenylist: [/^\/api\//],
          // Bundle has grown past the 2 MiB workbox default; bump to 4 MiB
          // so the PWA precache continues to cover the whole app shell.
          maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        },
      }),
  ].filter(Boolean),
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    watch: {
      // chokidar's fsevents backend silently fails on paths inside git worktrees
      // (e.g. .dispatch/worktrees/...). Falling back to Node's native fs.watch
      // fixes HMR without the CPU overhead of polling.
      useFsEvents: false,
    },
    proxy: {
      "/api": {
        target:
          process.env.VITE_API_TARGET ??
          `http://127.0.0.1:${process.env.DISPATCH_PORT}`,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
