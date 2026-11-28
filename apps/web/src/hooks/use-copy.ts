import { useCallback, useRef, useState } from "react";

/**
 * Copy text via hidden textarea + execCommand. Works on iOS Safari and other
 * non-secure contexts (e.g. a LAN address over plain HTTP).
 *
 * The textarea is mounted inside the focused dialog, if any, so a modal focus
 * trap does not pull focus back out before the copy runs. The copy event also
 * sets the exact text, so line breaks survive even if the selection is lost.
 */
function copyViaExecCommand(text: string): boolean {
  const previousFocus =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  const host =
    previousFocus?.closest<HTMLElement>(
      "[role='dialog'], [role='alertdialog']"
    ) ?? document.body;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "0";
  textarea.style.top = "0";
  textarea.style.opacity = "0";
  const onCopy = (event: ClipboardEvent) => {
    if (!event.clipboardData) return;
    event.clipboardData.setData("text/plain", text);
    event.preventDefault();
  };
  host.appendChild(textarea);
  document.addEventListener("copy", onCopy);
  textarea.focus();
  textarea.select();

  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.removeEventListener("copy", onCopy);
  host.removeChild(textarea);
  previousFocus?.focus({ preventScroll: true });
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

  const copyText = useCallback(
    (text: string) => {
      // Prefer Clipboard API — it works inside focus-trapped dialogs (sheets, modals)
      // where execCommand fails because the hidden textarea can't receive focus.
      if (navigator.clipboard?.writeText) {
        void navigator.clipboard
          .writeText(text)
          .then(markCopied)
          .catch(() => {
            // Clipboard API rejected (e.g. non-secure context) — try execCommand
            if (copyViaExecCommand(text)) markCopied();
          });
        return;
      }
      // No Clipboard API — fall back to execCommand (iOS Safari non-secure contexts)
      if (copyViaExecCommand(text)) markCopied();
    },
    [markCopied]
  );

  return [copied, copyText];
}
