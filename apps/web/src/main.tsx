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
  let axis: "x" | "y" | null = null;
  const scrolls = (value: string) => value === "auto" || value === "scroll";
  document.addEventListener(
    "touchstart",
    (e) => {
      touchStartTarget = (e.target as Element | null) ?? null;
      const touch = e.touches[0];
      touchStart = touch
        ? { x: touch.clientX, y: touch.clientY }
        : { x: 0, y: 0 };
      axis = null;
    },
    { passive: true }
  );
  document.addEventListener(
    "touchmove",
    (e) => {
      // The gesture's axis decides which scrollers count: a sideways swipe
      // over a Tasks column must reach the board around it, a vertical one
      // the list it is in. The first few pixels are a finger settling, not a
      // direction, so the axis waits for real travel and then holds for the
      // gesture; until then a scroller in either axis counts. Reading the
      // axis off that jitter cancelled sideways swipes that began slightly
      // vertical over a column too short to scroll.
      const touch = e.touches[0];
      if (!axis && touch) {
        const dx = Math.abs(touch.clientX - touchStart.x);
        const dy = Math.abs(touch.clientY - touchStart.y);
        if (Math.max(dx, dy) >= 10) axis = dx > dy ? "x" : "y";
      }
      let el: Element | null = touchStartTarget;
      while (el && el !== document.body) {
        const style = window.getComputedStyle(el);
        const scrollsX =
          axis !== "y" &&
          scrolls(style.overflowX) &&
          el.scrollWidth > el.clientWidth;
        const scrollsY =
          axis !== "x" &&
          scrolls(style.overflowY) &&
          el.scrollHeight > el.clientHeight;
        const scrollable = scrollsX || scrollsY;
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
