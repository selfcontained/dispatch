import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import path from "node:path";
import { readFileSync, cpSync, existsSync } from "node:fs";

const isProd = process.env.NODE_ENV === "production";

// Excalidraw lazy-fetches its fonts from esm.sh unless
// window.EXCALIDRAW_ASSET_PATH points at self-hosted copies (set in
// whiteboard-tab.tsx). Serve them from node_modules in dev and copy them
// into dist/ for the embedded-static prod build. Xiaolai (CJK, 12 MB of
// the 13 MB fonts dir) is deliberately excluded: it is only requested for
// CJK glyphs and missing fonts fall back to system fonts.
function excalidrawAssets(): Plugin {
  const fontsDir = path.resolve(
    __dirname,
    "node_modules/@excalidraw/excalidraw/dist/prod/fonts"
  );
  const publicPrefix = "/excalidraw/fonts/";
  const skipFamilies = new Set(["Xiaolai"]);
  return {
    name: "excalidraw-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0];
        if (!url.startsWith(publicPrefix)) return next();
        const rel = decodeURIComponent(url.slice(publicPrefix.length));
        const file = path.join(fontsDir, rel);
        if (!file.startsWith(fontsDir) || !existsSync(file)) {
          res.statusCode = 404;
          return res.end();
        }
        res.setHeader(
          "Content-Type",
          file.endsWith(".woff2") ? "font/woff2" : "font/woff"
        );
        return res.end(readFileSync(file));
      });
    },
    writeBundle(options) {
      const outDir = options.dir ?? path.resolve(__dirname, "dist");
      cpSync(fontsDir, path.join(outDir, "excalidraw/fonts"), {
        recursive: true,
        filter: (src) =>
          !skipFamilies.has(path.basename(path.dirname(src))) &&
          !skipFamilies.has(path.basename(src)),
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
    excalidrawAssets(),
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
