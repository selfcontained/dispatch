import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { toast } from "@/components/ui/toast";

import { reloadApp } from "@/lib/pwa-update";
import {
  dismissVersionMismatch,
  getServerVersion,
  isVersionMismatch,
  isVersionMismatchDismissed,
  subscribeVersionMismatch,
} from "@/lib/version";

// Shared with the release toast, so there is one update toast at a time.
const TOAST_ID = "dispatch-update-available";

function isEditableElement(element: Element | null): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  if (element.isContentEditable) return true;
  return matches(element, ["input", "textarea", "select"]);
}

function matches(element: HTMLElement, selectors: string[]): boolean {
  return selectors.some((selector) => element.matches(selector));
}

/**
 * Subscribes to the version-mismatch signal and surfaces it as a sticky
 * toast, which the ToastHost renders. It carries a `Reload` action and
 * persists until the user dismisses it or reloads. All this component
 * renders itself is the confirmation for reloading over an open field.
 */
export function UpdateAvailableToast(): JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const reloadingRef = useRef(false);
  const hadFocusedEditableRef = useRef(false);

  useEffect(() => {
    const handleReload = (event: { preventDefault: () => void }): void => {
      const activeElement = document.activeElement;
      const hadFocusedEditable =
        hadFocusedEditableRef.current || isEditableElement(activeElement);
      hadFocusedEditableRef.current = false;

      if (
        window.location.pathname.startsWith("/settings") &&
        hadFocusedEditable
      ) {
        // The toast stays up until the answer.
        event.preventDefault();
        setConfirming(true);
        return;
      }

      if (reloadingRef.current) return;
      reloadingRef.current = true;

      if (isEditableElement(activeElement)) {
        activeElement.blur();
      }

      void reloadApp();
    };

    const sync = (): void => {
      const visible = isVersionMismatch() && !isVersionMismatchDismissed();
      if (!visible) {
        toast.dismiss(TOAST_ID);
        return;
      }

      const serverVersion = getServerVersion();
      const message = serverVersion
        ? `Server updated to ${serverVersion}.`
        : "Server updated.";

      toast.info(message, {
        id: TOAST_ID,
        description: "Reload to pick up the new version.",
        duration: Infinity,
        icon: RefreshCw,
        action: {
          label: "Reload",
          onClick: handleReload,
        },
        // Not called when the toast is retired from code.
        onDismiss: () => {
          dismissVersionMismatch();
        },
      });
    };

    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target as Element | null;
      if (!target) return;
      // Sample focus before the toast click steals it. We can't pin to the
      // specific toast id because sonner doesn't always reflect `id` as a
      // DOM attribute, so we check membership in any sonner toast — fine
      // since the update toast is the only one that triggers a reload.
      if (target.closest("[data-sonner-toast]")) {
        hadFocusedEditableRef.current = isEditableElement(
          document.activeElement
        );
      }
    };

    window.addEventListener("pointerdown", handlePointerDown, true);
    const unsubscribe = subscribeVersionMismatch(sync);
    sync();

    return () => {
      unsubscribe();
      window.removeEventListener("pointerdown", handlePointerDown, true);
      toast.dismiss(TOAST_ID);
    };
  }, []);

  return (
    <ConfirmDialog
      open={confirming}
      onOpenChange={setConfirming}
      tone="primary"
      title="Reload Dispatch?"
      description="You have a settings field open. Reloading now may discard unsaved changes."
      confirmLabel="Reload anyway"
      errorTitle="Couldn’t reload."
      onConfirm={() => {
        if (reloadingRef.current) return;
        reloadingRef.current = true;
        void reloadApp();
      }}
    />
  );
}
