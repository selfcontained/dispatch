import { useCallback, useRef, useState } from "react";

/** Copy text via hidden textarea + execCommand. Works on iOS Safari non-secure contexts. */
function copyViaExecCommand(text: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.left = "0";
  textarea.style.top = "0";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(textarea);
  return ok;
}

/**
 * Hook for copying text to clipboard with iOS Safari support.
 * Returns [copied, copyText] — `copied` is true for 2s after a successful copy.
 */
export function useCopyText(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  const copyText = useCallback((text: string) => {
    // Try execCommand first (works on iOS Safari non-secure contexts)
    if (copyViaExecCommand(text)) {
      setCopied(true);
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), 2000);
      return;
    }
    // Fall back to Clipboard API
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        if (timerRef.current) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => setCopied(false), 2000);
      }).catch(() => {});
    }
  }, []);

  return [copied, copyText];
}
