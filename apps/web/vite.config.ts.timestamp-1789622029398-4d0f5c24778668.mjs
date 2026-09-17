// vite.config.ts
import { defineConfig } from "file:///home/nii/.dispatch/server-agt-462dc14ebcd1-agent-4ebcd1/node_modules/.pnpm/vite@5.4.21_@types+node@24.12.0_sass@1.51.0_terser@5.46.1/node_modules/vite/dist/node/index.js";
import react from "file:///home/nii/.dispatch/server-agt-462dc14ebcd1-agent-4ebcd1/node_modules/.pnpm/@vitejs+plugin-react@4.7.0_vite@5.4.21_@types+node@24.12.0_sass@1.51.0_terser@5.46.1_/node_modules/@vitejs/plugin-react/dist/index.js";
import { VitePWA } from "file:///home/nii/.dispatch/server-agt-462dc14ebcd1-agent-4ebcd1/node_modules/.pnpm/vite-plugin-pwa@1.2.0_vite@5.4.21_@types+node@24.12.0_sass@1.51.0_terser@5.46.1__workbo_a8a7373f18d9c4cf3cb58adca3793814/node_modules/vite-plugin-pwa/dist/index.js";
import path from "node:path";
import { existsSync, readFileSync, cpSync } from "node:fs";
var __vite_injected_original_dirname = "/home/nii/.dispatch/server-agt-462dc14ebcd1-agent-4ebcd1/apps/web";
var isProd = process.env.NODE_ENV === "production";
var browserExtensionArchiveName = "dispatch-browser-feedback.zip";
var browserExtensionArchivePath = path.resolve(
  __vite_injected_original_dirname,
  "../browser-extension/dist",
  browserExtensionArchiveName
);
function browserExtensionArchivePlugin() {
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
          `attachment; filename="${browserExtensionArchiveName}"`
        );
        response.end(request.method === "HEAD" ? void 0 : archive);
      });
    }
  };
}
function excalidrawAssets() {
  const fontsDir = path.resolve(
    __vite_injected_original_dirname,
    "node_modules/@excalidraw/excalidraw/dist/prod/fonts"
  );
  const publicPrefix = "/excalidraw/fonts/";
  const skipFamilies = /* @__PURE__ */ new Set(["Xiaolai"]);
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
      const outDir = options.dir ?? path.resolve(__vite_injected_original_dirname, "dist");
      cpSync(fontsDir, path.join(outDir, "excalidraw/fonts"), {
        recursive: true,
        filter: (src) => !skipFamilies.has(path.basename(path.dirname(src))) && !skipFamilies.has(path.basename(src))
      });
    }
  };
}
var rootPackageJson = JSON.parse(
  readFileSync(path.resolve(__vite_injected_original_dirname, "../../package.json"), "utf8")
);
if (typeof rootPackageJson.version !== "string" || !rootPackageJson.version.trim()) {
  throw new Error("Root package.json is missing a version field");
}
var packageVersion = rootPackageJson.version.trim();
if (!/^[0-9A-Za-z.+-]+$/.test(packageVersion)) {
  throw new Error(
    `Invalid "version" in root package.json: ${JSON.stringify(packageVersion)}`
  );
}
var vite_config_default = defineConfig({
  cacheDir: process.env.DISPATCH_VITE_CACHE_DIR,
  define: {
    __DISPATCH_VERSION__: JSON.stringify(packageVersion)
  },
  plugins: [
    react(),
    browserExtensionArchivePlugin(),
    excalidrawAssets(),
    isProd && VitePWA({
      registerType: "prompt",
      includeAssets: [
        "icons/teal/apple-touch-icon.png",
        "icons/teal/favicon.png"
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
        navigateFallbackDenylist: [/^\/api\//],
        // Bundle has grown past the 2 MiB workbox default; bump to 4 MiB
        // so the PWA precache continues to cover the whole app shell.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024
      }
    })
  ].filter(Boolean),
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    watch: {
      // chokidar's fsevents backend silently fails on paths inside git worktrees
      // (e.g. .dispatch/worktrees/...). Falling back to Node's native fs.watch
      // fixes HMR without the CPU overhead of polling.
      useFsEvents: false
    },
    proxy: {
      "/api": {
        target: process.env.VITE_API_TARGET ?? `http://127.0.0.1:${process.env.DISPATCH_PORT}`,
        changeOrigin: true,
        ws: true
      }
    }
  },
  resolve: {
    alias: {
      "@": path.resolve(__vite_injected_original_dirname, "./src")
    }
  },
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
});
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5jb25maWcudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCIvaG9tZS9uaWkvLmRpc3BhdGNoL3NlcnZlci1hZ3QtNDYyZGMxNGViY2QxLWFnZW50LTRlYmNkMS9hcHBzL3dlYlwiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiL2hvbWUvbmlpLy5kaXNwYXRjaC9zZXJ2ZXItYWd0LTQ2MmRjMTRlYmNkMS1hZ2VudC00ZWJjZDEvYXBwcy93ZWIvdml0ZS5jb25maWcudHNcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfaW1wb3J0X21ldGFfdXJsID0gXCJmaWxlOi8vL2hvbWUvbmlpLy5kaXNwYXRjaC9zZXJ2ZXItYWd0LTQ2MmRjMTRlYmNkMS1hZ2VudC00ZWJjZDEvYXBwcy93ZWIvdml0ZS5jb25maWcudHNcIjtpbXBvcnQgeyBkZWZpbmVDb25maWcgfSBmcm9tIFwidml0ZVwiO1xuaW1wb3J0IHR5cGUgeyBQbHVnaW4gfSBmcm9tIFwidml0ZVwiO1xuaW1wb3J0IHJlYWN0IGZyb20gXCJAdml0ZWpzL3BsdWdpbi1yZWFjdFwiO1xuaW1wb3J0IHsgVml0ZVBXQSB9IGZyb20gXCJ2aXRlLXBsdWdpbi1wd2FcIjtcbmltcG9ydCBwYXRoIGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IGV4aXN0c1N5bmMsIHJlYWRGaWxlU3luYywgY3BTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcblxuY29uc3QgaXNQcm9kID0gcHJvY2Vzcy5lbnYuTk9ERV9FTlYgPT09IFwicHJvZHVjdGlvblwiO1xuY29uc3QgYnJvd3NlckV4dGVuc2lvbkFyY2hpdmVOYW1lID0gXCJkaXNwYXRjaC1icm93c2VyLWZlZWRiYWNrLnppcFwiO1xuY29uc3QgYnJvd3NlckV4dGVuc2lvbkFyY2hpdmVQYXRoID0gcGF0aC5yZXNvbHZlKFxuICBfX2Rpcm5hbWUsXG4gIFwiLi4vYnJvd3Nlci1leHRlbnNpb24vZGlzdFwiLFxuICBicm93c2VyRXh0ZW5zaW9uQXJjaGl2ZU5hbWVcbik7XG5cbmZ1bmN0aW9uIGJyb3dzZXJFeHRlbnNpb25BcmNoaXZlUGx1Z2luKCk6IFBsdWdpbiB7XG4gIGNvbnN0IHJlYWRBcmNoaXZlID0gKCkgPT4ge1xuICAgIGlmICghZXhpc3RzU3luYyhicm93c2VyRXh0ZW5zaW9uQXJjaGl2ZVBhdGgpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBCcm93c2VyIGV4dGVuc2lvbiBhcmNoaXZlIGlzIG1pc3NpbmcgYXQgJHticm93c2VyRXh0ZW5zaW9uQXJjaGl2ZVBhdGh9LiBSdW4gdGhlIGJyb3dzZXIgZXh0ZW5zaW9uIHBhY2thZ2Ugc3RlcCBmaXJzdC5gXG4gICAgICApO1xuICAgIH1cbiAgICByZXR1cm4gcmVhZEZpbGVTeW5jKGJyb3dzZXJFeHRlbnNpb25BcmNoaXZlUGF0aCk7XG4gIH07XG5cbiAgcmV0dXJuIHtcbiAgICBuYW1lOiBcImRpc3BhdGNoLWJyb3dzZXItZXh0ZW5zaW9uLWFyY2hpdmVcIixcbiAgICBhcHBseTogXCJzZXJ2ZVwiLFxuICAgIGNvbmZpZ3VyZVNlcnZlcihzZXJ2ZXIpIHtcbiAgICAgIHNlcnZlci5taWRkbGV3YXJlcy51c2UoKHJlcXVlc3QsIHJlc3BvbnNlLCBuZXh0KSA9PiB7XG4gICAgICAgIGNvbnN0IHBhdGhuYW1lID0gcmVxdWVzdC51cmw/LnNwbGl0KFwiP1wiLCAxKVswXTtcbiAgICAgICAgaWYgKHBhdGhuYW1lICE9PSBgLyR7YnJvd3NlckV4dGVuc2lvbkFyY2hpdmVOYW1lfWApIHtcbiAgICAgICAgICBuZXh0KCk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHJlcXVlc3QubWV0aG9kICE9PSBcIkdFVFwiICYmIHJlcXVlc3QubWV0aG9kICE9PSBcIkhFQURcIikge1xuICAgICAgICAgIHJlc3BvbnNlLnN0YXR1c0NvZGUgPSA0MDU7XG4gICAgICAgICAgcmVzcG9uc2Uuc2V0SGVhZGVyKFwiQWxsb3dcIiwgXCJHRVQsIEhFQURcIik7XG4gICAgICAgICAgcmVzcG9uc2UuZW5kKFwiTWV0aG9kIE5vdCBBbGxvd2VkXCIpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IGFyY2hpdmUgPSByZWFkQXJjaGl2ZSgpO1xuICAgICAgICByZXNwb25zZS5zdGF0dXNDb2RlID0gMjAwO1xuICAgICAgICByZXNwb25zZS5zZXRIZWFkZXIoXCJDb250ZW50LVR5cGVcIiwgXCJhcHBsaWNhdGlvbi96aXBcIik7XG4gICAgICAgIHJlc3BvbnNlLnNldEhlYWRlcihcIkNvbnRlbnQtTGVuZ3RoXCIsIGFyY2hpdmUuYnl0ZUxlbmd0aCk7XG4gICAgICAgIHJlc3BvbnNlLnNldEhlYWRlcihcbiAgICAgICAgICBcIkNvbnRlbnQtRGlzcG9zaXRpb25cIixcbiAgICAgICAgICBgYXR0YWNobWVudDsgZmlsZW5hbWU9XFxcIiR7YnJvd3NlckV4dGVuc2lvbkFyY2hpdmVOYW1lfVxcXCJgXG4gICAgICAgICk7XG4gICAgICAgIHJlc3BvbnNlLmVuZChyZXF1ZXN0Lm1ldGhvZCA9PT0gXCJIRUFEXCIgPyB1bmRlZmluZWQgOiBhcmNoaXZlKTtcbiAgICAgIH0pO1xuICAgIH0sXG4gIH07XG59XG5cbmZ1bmN0aW9uIGV4Y2FsaWRyYXdBc3NldHMoKTogUGx1Z2luIHtcbiAgY29uc3QgZm9udHNEaXIgPSBwYXRoLnJlc29sdmUoXG4gICAgX19kaXJuYW1lLFxuICAgIFwibm9kZV9tb2R1bGVzL0BleGNhbGlkcmF3L2V4Y2FsaWRyYXcvZGlzdC9wcm9kL2ZvbnRzXCJcbiAgKTtcbiAgY29uc3QgcHVibGljUHJlZml4ID0gXCIvZXhjYWxpZHJhdy9mb250cy9cIjtcbiAgY29uc3Qgc2tpcEZhbWlsaWVzID0gbmV3IFNldChbXCJYaWFvbGFpXCJdKTtcbiAgcmV0dXJuIHtcbiAgICBuYW1lOiBcImV4Y2FsaWRyYXctYXNzZXRzXCIsXG4gICAgY29uZmlndXJlU2VydmVyKHNlcnZlcikge1xuICAgICAgc2VydmVyLm1pZGRsZXdhcmVzLnVzZSgocmVxLCByZXMsIG5leHQpID0+IHtcbiAgICAgICAgY29uc3QgdXJsID0gKHJlcS51cmwgPz8gXCJcIikuc3BsaXQoXCI/XCIpWzBdO1xuICAgICAgICBpZiAoIXVybC5zdGFydHNXaXRoKHB1YmxpY1ByZWZpeCkpIHJldHVybiBuZXh0KCk7XG4gICAgICAgIGNvbnN0IHJlbCA9IGRlY29kZVVSSUNvbXBvbmVudCh1cmwuc2xpY2UocHVibGljUHJlZml4Lmxlbmd0aCkpO1xuICAgICAgICBjb25zdCBmaWxlID0gcGF0aC5qb2luKGZvbnRzRGlyLCByZWwpO1xuICAgICAgICBpZiAoIWZpbGUuc3RhcnRzV2l0aChmb250c0RpcikgfHwgIWV4aXN0c1N5bmMoZmlsZSkpIHtcbiAgICAgICAgICByZXMuc3RhdHVzQ29kZSA9IDQwNDtcbiAgICAgICAgICByZXR1cm4gcmVzLmVuZCgpO1xuICAgICAgICB9XG4gICAgICAgIHJlcy5zZXRIZWFkZXIoXG4gICAgICAgICAgXCJDb250ZW50LVR5cGVcIixcbiAgICAgICAgICBmaWxlLmVuZHNXaXRoKFwiLndvZmYyXCIpID8gXCJmb250L3dvZmYyXCIgOiBcImZvbnQvd29mZlwiXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybiByZXMuZW5kKHJlYWRGaWxlU3luYyhmaWxlKSk7XG4gICAgICB9KTtcbiAgICB9LFxuICAgIHdyaXRlQnVuZGxlKG9wdGlvbnMpIHtcbiAgICAgIGNvbnN0IG91dERpciA9IG9wdGlvbnMuZGlyID8/IHBhdGgucmVzb2x2ZShfX2Rpcm5hbWUsIFwiZGlzdFwiKTtcbiAgICAgIGNwU3luYyhmb250c0RpciwgcGF0aC5qb2luKG91dERpciwgXCJleGNhbGlkcmF3L2ZvbnRzXCIpLCB7XG4gICAgICAgIHJlY3Vyc2l2ZTogdHJ1ZSxcbiAgICAgICAgZmlsdGVyOiAoc3JjKSA9PlxuICAgICAgICAgICFza2lwRmFtaWxpZXMuaGFzKHBhdGguYmFzZW5hbWUocGF0aC5kaXJuYW1lKHNyYykpKSAmJlxuICAgICAgICAgICFza2lwRmFtaWxpZXMuaGFzKHBhdGguYmFzZW5hbWUoc3JjKSksXG4gICAgICB9KTtcbiAgICB9LFxuICB9O1xufVxuXG4vLyBCYWtlIHRoZSB3b3Jrc3BhY2UgdmVyc2lvbiBpbnRvIHRoZSBidW5kbGUuIFRoZSB3ZWIgY2xpZW50IGNvbXBhcmVzXG4vLyB0aGlzIGFnYWluc3QgdGhlIGBYLURpc3BhdGNoLVZlcnNpb25gIHJlc3BvbnNlIGhlYWRlciB0byBkZXRlY3QgYVxuLy8gc3RhbGUgYnVuZGxlIGFmdGVyIGEgc2VydmVyIHNlbGYtdXBkYXRlLlxuY29uc3Qgcm9vdFBhY2thZ2VKc29uID0gSlNPTi5wYXJzZShcbiAgcmVhZEZpbGVTeW5jKHBhdGgucmVzb2x2ZShfX2Rpcm5hbWUsIFwiLi4vLi4vcGFja2FnZS5qc29uXCIpLCBcInV0ZjhcIilcbikgYXMgeyB2ZXJzaW9uPzogdW5rbm93biB9O1xuaWYgKFxuICB0eXBlb2Ygcm9vdFBhY2thZ2VKc29uLnZlcnNpb24gIT09IFwic3RyaW5nXCIgfHxcbiAgIXJvb3RQYWNrYWdlSnNvbi52ZXJzaW9uLnRyaW0oKVxuKSB7XG4gIHRocm93IG5ldyBFcnJvcihcIlJvb3QgcGFja2FnZS5qc29uIGlzIG1pc3NpbmcgYSB2ZXJzaW9uIGZpZWxkXCIpO1xufVxuY29uc3QgcGFja2FnZVZlcnNpb24gPSByb290UGFja2FnZUpzb24udmVyc2lvbi50cmltKCk7XG4vLyBNaXJyb3IgdGhlIHNoYXBlIGNoZWNrIGZyb20gdGhlIHNlcnZlci1zaWRlIHJ1bnRpbWUtYXNzZXRzIGNvZGVnZW4gc29cbi8vIGEgbWFsZm9ybWVkIHJlbGVhc2Ugc3VyZmFjZXMgYXQgYnVpbGQgdGltZSwgbm90IGFzIGEgcnVudGltZVxuLy8gWC1EaXNwYXRjaC1WZXJzaW9uIGhlYWRlciBmYWlsdXJlLlxuaWYgKCEvXlswLTlBLVphLXouKy1dKyQvLnRlc3QocGFja2FnZVZlcnNpb24pKSB7XG4gIHRocm93IG5ldyBFcnJvcihcbiAgICBgSW52YWxpZCBcInZlcnNpb25cIiBpbiByb290IHBhY2thZ2UuanNvbjogJHtKU09OLnN0cmluZ2lmeShwYWNrYWdlVmVyc2lvbil9YFxuICApO1xufVxuXG5leHBvcnQgZGVmYXVsdCBkZWZpbmVDb25maWcoe1xuICBjYWNoZURpcjogcHJvY2Vzcy5lbnYuRElTUEFUQ0hfVklURV9DQUNIRV9ESVIsXG4gIGRlZmluZToge1xuICAgIF9fRElTUEFUQ0hfVkVSU0lPTl9fOiBKU09OLnN0cmluZ2lmeShwYWNrYWdlVmVyc2lvbiksXG4gIH0sXG4gIHBsdWdpbnM6IFtcbiAgICByZWFjdCgpLFxuICAgIGJyb3dzZXJFeHRlbnNpb25BcmNoaXZlUGx1Z2luKCksXG4gICAgZXhjYWxpZHJhd0Fzc2V0cygpLFxuICAgIGlzUHJvZCAmJlxuICAgICAgVml0ZVBXQSh7XG4gICAgICAgIHJlZ2lzdGVyVHlwZTogXCJwcm9tcHRcIixcbiAgICAgICAgaW5jbHVkZUFzc2V0czogW1xuICAgICAgICAgIFwiaWNvbnMvdGVhbC9hcHBsZS10b3VjaC1pY29uLnBuZ1wiLFxuICAgICAgICAgIFwiaWNvbnMvdGVhbC9mYXZpY29uLnBuZ1wiLFxuICAgICAgICBdLFxuICAgICAgICBtYW5pZmVzdDoge1xuICAgICAgICAgIGlkOiBcIi9cIixcbiAgICAgICAgICBuYW1lOiBcIkRpc3BhdGNoXCIsXG4gICAgICAgICAgc2hvcnRfbmFtZTogXCJEaXNwYXRjaFwiLFxuICAgICAgICAgIGRlc2NyaXB0aW9uOiBcIkxvY2FsLWZpcnN0IGNvbnRyb2wgcGxhbmUgZm9yIHJlbW90ZSBDb2RleCBDTEkgYWdlbnRzLlwiLFxuICAgICAgICAgIHN0YXJ0X3VybDogXCIvXCIsXG4gICAgICAgICAgc2NvcGU6IFwiL1wiLFxuICAgICAgICAgIGRpc3BsYXk6IFwic3RhbmRhbG9uZVwiLFxuICAgICAgICAgIGJhY2tncm91bmRfY29sb3I6IFwiIzE0MTQxNFwiLFxuICAgICAgICAgIHRoZW1lX2NvbG9yOiBcIiMxNDE0MTRcIixcbiAgICAgICAgICBpY29uczogW1xuICAgICAgICAgICAge1xuICAgICAgICAgICAgICBzcmM6IFwiL2ljb25zL3RlYWwvcHdhLTE5Mi5wbmdcIixcbiAgICAgICAgICAgICAgc2l6ZXM6IFwiMTkyeDE5MlwiLFxuICAgICAgICAgICAgICB0eXBlOiBcImltYWdlL3BuZ1wiLFxuICAgICAgICAgICAgICBwdXJwb3NlOiBcImFueVwiLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgc3JjOiBcIi9pY29ucy90ZWFsL3B3YS01MTIucG5nXCIsXG4gICAgICAgICAgICAgIHNpemVzOiBcIjUxMng1MTJcIixcbiAgICAgICAgICAgICAgdHlwZTogXCJpbWFnZS9wbmdcIixcbiAgICAgICAgICAgICAgcHVycG9zZTogXCJhbnlcIixcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIHNyYzogXCIvaWNvbnMvdGVhbC9wd2EtNTEyLnBuZ1wiLFxuICAgICAgICAgICAgICBzaXplczogXCI1MTJ4NTEyXCIsXG4gICAgICAgICAgICAgIHR5cGU6IFwiaW1hZ2UvcG5nXCIsXG4gICAgICAgICAgICAgIHB1cnBvc2U6IFwibWFza2FibGVcIixcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgXSxcbiAgICAgICAgfSxcbiAgICAgICAgd29ya2JveDoge1xuICAgICAgICAgIC8vIERvIG5vdCBjYWNoZSBBUEkgdHJhZmZpYyBieSBkZWZhdWx0OyB0aGlzIGFwcCBpcyByZWFsdGltZS1vcmllbnRlZC5cbiAgICAgICAgICBuYXZpZ2F0ZUZhbGxiYWNrRGVueWxpc3Q6IFsvXlxcL2FwaVxcLy9dLFxuICAgICAgICAgIC8vIEJ1bmRsZSBoYXMgZ3Jvd24gcGFzdCB0aGUgMiBNaUIgd29ya2JveCBkZWZhdWx0OyBidW1wIHRvIDQgTWlCXG4gICAgICAgICAgLy8gc28gdGhlIFBXQSBwcmVjYWNoZSBjb250aW51ZXMgdG8gY292ZXIgdGhlIHdob2xlIGFwcCBzaGVsbC5cbiAgICAgICAgICBtYXhpbXVtRmlsZVNpemVUb0NhY2hlSW5CeXRlczogNCAqIDEwMjQgKiAxMDI0LFxuICAgICAgICB9LFxuICAgICAgfSksXG4gIF0uZmlsdGVyKEJvb2xlYW4pLFxuICBzZXJ2ZXI6IHtcbiAgICBob3N0OiBcIjAuMC4wLjBcIixcbiAgICBhbGxvd2VkSG9zdHM6IHRydWUsXG4gICAgd2F0Y2g6IHtcbiAgICAgIC8vIGNob2tpZGFyJ3MgZnNldmVudHMgYmFja2VuZCBzaWxlbnRseSBmYWlscyBvbiBwYXRocyBpbnNpZGUgZ2l0IHdvcmt0cmVlc1xuICAgICAgLy8gKGUuZy4gLmRpc3BhdGNoL3dvcmt0cmVlcy8uLi4pLiBGYWxsaW5nIGJhY2sgdG8gTm9kZSdzIG5hdGl2ZSBmcy53YXRjaFxuICAgICAgLy8gZml4ZXMgSE1SIHdpdGhvdXQgdGhlIENQVSBvdmVyaGVhZCBvZiBwb2xsaW5nLlxuICAgICAgdXNlRnNFdmVudHM6IGZhbHNlLFxuICAgIH0sXG4gICAgcHJveHk6IHtcbiAgICAgIFwiL2FwaVwiOiB7XG4gICAgICAgIHRhcmdldDpcbiAgICAgICAgICBwcm9jZXNzLmVudi5WSVRFX0FQSV9UQVJHRVQgPz9cbiAgICAgICAgICBgaHR0cDovLzEyNy4wLjAuMToke3Byb2Nlc3MuZW52LkRJU1BBVENIX1BPUlR9YCxcbiAgICAgICAgY2hhbmdlT3JpZ2luOiB0cnVlLFxuICAgICAgICB3czogdHJ1ZSxcbiAgICAgIH0sXG4gICAgfSxcbiAgfSxcbiAgcmVzb2x2ZToge1xuICAgIGFsaWFzOiB7XG4gICAgICBcIkBcIjogcGF0aC5yZXNvbHZlKF9fZGlybmFtZSwgXCIuL3NyY1wiKSxcbiAgICB9LFxuICB9LFxuICBidWlsZDoge1xuICAgIG91dERpcjogXCJkaXN0XCIsXG4gICAgZW1wdHlPdXREaXI6IHRydWUsXG4gIH0sXG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICI7QUFBcVgs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
