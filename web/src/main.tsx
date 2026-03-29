import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import { registerSW } from "virtual:pwa-register";

import { App } from "./App";
import "./index.css";

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

// iOS/iPadOS Safari: prevent the viewport from rubber-banding when the user
// drags on non-scrollable areas (header, terminal canvas, footer, etc.).
// Allow the gesture only when it starts inside a container that can actually
// scroll in the drag direction.
if ("ontouchstart" in window) {
  document.addEventListener(
    "touchmove",
    (e: TouchEvent) => {
      let node = e.target as HTMLElement | null;
      while (node && node !== document.documentElement) {
        const style = getComputedStyle(node);
        const overflowY = style.overflowY;
        if (
          (overflowY === "auto" || overflowY === "scroll") &&
          node.scrollHeight > node.clientHeight
        ) {
          // This container is scrollable — let the browser handle it.
          return;
        }
        node = node.parentElement;
      }
      e.preventDefault();
    },
    { passive: false },
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>
);
