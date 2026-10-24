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
  let touchStart = { x: 0, y: 0 };
  const scrolls = (value: string) => value === "auto" || value === "scroll";
  document.addEventListener(
    "touchstart",
    (e) => {
      touchStartTarget = (e.target as Element | null) ?? null;
      const touch = e.touches[0];
      touchStart = touch
        ? { x: touch.clientX, y: touch.clientY }
        : { x: 0, y: 0 };
    },
    { passive: true }
  );
  document.addEventListener(
    "touchmove",
    (e) => {
      // The gesture's axis decides which scrollers count: a sideways swipe
      // over a Tasks column must reach the board around it, a vertical one
      // the list it is in.
      const touch = e.touches[0];
      const horizontal = touch
        ? Math.abs(touch.clientX - touchStart.x) >
          Math.abs(touch.clientY - touchStart.y)
        : false;
      let el: Element | null = touchStartTarget;
      while (el && el !== document.body) {
        const style = window.getComputedStyle(el);
        const scrollable = horizontal
          ? scrolls(style.overflowX) && el.scrollWidth > el.clientWidth
          : scrolls(style.overflowY) && el.scrollHeight > el.clientHeight;
        if (scrollable) {
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
