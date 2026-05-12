import { useEffect } from "react";

const CSS_RULE = "[data-radix-popper-content-wrapper]{z-index:80!important}";

let refCount = 0;
let styleEl: HTMLStyleElement | null = null;

export function useRadixPopoverZFix(): void {
  useEffect(() => {
    refCount++;
    if (refCount === 1) {
      styleEl = document.createElement("style");
      styleEl.textContent = CSS_RULE;
      document.head.appendChild(styleEl);
    }
    return () => {
      refCount--;
      if (refCount === 0 && styleEl) {
        styleEl.remove();
        styleEl = null;
      }
    };
  }, []);
}
