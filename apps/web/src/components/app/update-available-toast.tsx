import { useEffect, useRef } from "react";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { reloadApp } from "@/lib/pwa-update";
import {
  dismissVersionMismatch,
  getServerVersion,
  isVersionMismatch,
  isVersionMismatchDismissed,
  subscribeVersionMismatch,
} from "@/lib/version";

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
 * sonner toast. Returns no JSX — sonner's `<Toaster />` is responsible for
 * rendering. The toast carries a `Reload` action and persists until the
 * user dismisses it or reloads.
 *
 * The component name is preserved so existing imports keep resolving;
 * conceptually this is now an effect-only controller, not a renderer.
 */
export function UpdateAvailableToast(): null {
  const reloadingRef = useRef(false);
  const hadFocusedEditableRef = useRef(false);

  useEffect(() => {
    const handleReload = (): void => {
      const activeElement = document.activeElement;
      const hadFocusedEditable =
        hadFocusedEditableRef.current || isEditableElement(activeElement);
      hadFocusedEditableRef.current = false;

      if (
        window.location.pathname.startsWith("/settings") &&
        hadFocusedEditable &&
        !window.confirm(
          "You have a settings field open. Reloading now may discard unsaved changes. Reload anyway?"
        )
      ) {
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
        ? `Server updated to ${serverVersion}. Reload to pick it up.`
        : "Server updated. Reload to pick up the new version.";

      toast(message, {
        id: TOAST_ID,
        duration: Infinity,
        icon: <RefreshCw className="h-4 w-4" />,
        action: {
          label: "Reload",
          onClick: handleReload,
        },
        // Capture whether an editable element was focused at the moment
        // the user reached for the toast — sonner's Action button does not
        // pierce through focus the way a native button would, so we sample
        // focus on pointerdown before the toast steals it.
        onAutoClose: () => {
          hadFocusedEditableRef.current = false;
        },
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

  return null;
}
