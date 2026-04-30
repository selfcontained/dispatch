import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { router } from "./router";
import { initPWAUpdate } from "./lib/pwa-update";
import "./index.css";

// Document-to-viewport lock for iPad-class devices. CSS handles the bulk of
// it (see index.css @media (pointer: coarse) and (min-width: 768px)), but
// iOS Safari sometimes still lets a touch-drag in non-scrollable areas
// shift the locked body. Preempt those touches: walk from touchstart up the
// tree; if no ancestor is actually scrollable in the gesture direction,
// preventDefault on touchmove so iOS does nothing.
if (window.matchMedia("(pointer: coarse) and (min-width: 768px)").matches) {
  let touchStartTarget: Element | null = null;
  document.addEventListener(
    "touchstart",
    (e) => {
      touchStartTarget = (e.target as Element | null) ?? null;
    },
    { passive: true }
  );
  document.addEventListener(
    "touchmove",
    (e) => {
      let el: Element | null = touchStartTarget;
      while (el && el !== document.body) {
        const style = window.getComputedStyle(el);
        const overflowY = style.overflowY;
        if (
          (overflowY === "auto" || overflowY === "scroll") &&
          el.scrollHeight > el.clientHeight
        ) {
          return; // touch is in a real scroll container — let it scroll
        }
        el = el.parentElement;
      }
      e.preventDefault();
    },
    { passive: false }
  );
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

initPWAUpdate();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>
);
