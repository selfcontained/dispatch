import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import { registerSW } from "virtual:pwa-register";

import { App } from "./App";
import "./index.css";

// Detect iPad PWA (standalone mode on iPad-class device) and apply targeted
// scroll-prevention styles.  iPad Safari in PWA mode jumps the viewport when
// typing space in xterm's hidden textarea; the .ipad-pwa class gates the fix
// so it doesn't affect phones where the keyboard must be able to push content.
const isIPad =
  navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent);
const isStandalone =
  "standalone" in navigator && (navigator as Record<string, unknown>).standalone === true;
if (isIPad && isStandalone) {
  document.documentElement.classList.add("ipad-pwa");
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

if (import.meta.env.PROD) {
  // Check for SW updates every 5 minutes so long-lived Safari tabs pick up
  // new deployments without a manual refresh.
  const intervalMS = 5 * 60 * 1000;
  registerSW({
    immediate: true,
    onRegisteredSW(_swUrl, registration) {
      if (registration) {
        setInterval(() => { void registration.update(); }, intervalMS);
      }
    }
  });
} else if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.getRegistrations().then((registrations) => {
    registrations.forEach((registration) => {
      void registration.unregister();
    });
  });
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>
);
