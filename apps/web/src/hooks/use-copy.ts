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
 * Hook for copying text to clipboard.
 * Prefers the Clipboard API (works inside dialogs/sheets with focus traps),
 * falls back to execCommand for iOS Safari non-secure contexts.
 * Returns [copied, copyText] — `copied` is true for 2s after a successful copy.
 */
export function useCopyText(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  const markCopied = useCallback(() => {
    setCopied(true);
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(false), 2000);
  }, []);

  const copyText = useCallback((text: string) => {
    // Prefer Clipboard API — it works inside focus-trapped dialogs (sheets, modals)
    // where execCommand fails because the hidden textarea can't receive focus.
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text).then(markCopied).catch(() => {
        // Clipboard API rejected (e.g. non-secure context) — try execCommand
        if (copyViaExecCommand(text)) markCopied();
      });
      return;
    }
    // No Clipboard API — fall back to execCommand (iOS Safari non-secure contexts)
    if (copyViaExecCommand(text)) markCopied();
  }, [markCopied]);

  return [copied, copyText];
}
