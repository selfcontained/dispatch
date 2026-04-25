import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import {
  forcePWAUpdate,
  getNeedRefresh,
  subscribeNeedRefresh,
} from "@/lib/pwa-update";
import { cn } from "@/lib/utils";

type AppVersionInfo = {
  releaseTag: string | null;
  version: string | null;
  gitSha: string | null;
  releaseNotes: string | null;
  releaseUrl: string | null;
};

function isEditableElement(element: Element | null): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  if (element.isContentEditable) return true;
  return matches(element, ["input", "textarea", "select"]);
}

function matches(element: HTMLElement, selectors: string[]): boolean {
  return selectors.some((selector) => element.matches(selector));
}

export function UpdateAvailableToast(): JSX.Element | null {
  const [needRefresh, setNeedRefresh] = useState<boolean>(() =>
    getNeedRefresh()
  );
  const [dismissed, setDismissed] = useState(false);
  const [reloading, setReloading] = useState(false);
  const hadFocusedEditableRef = useRef(false);

  useEffect(() => {
    const unsubscribe = subscribeNeedRefresh(() => {
      setNeedRefresh(true);
      setDismissed(false);
    });
    // Re-sync in case the module flag flipped between render and effect
    // (the dynamic import-resolves-then-onNeedRefresh-fires race).
    if (getNeedRefresh()) setNeedRefresh(true);
    return unsubscribe;
  }, []);

  const { data: versionInfo, isFetched } = useQuery({
    queryKey: ["app-version"],
    queryFn: () => api<AppVersionInfo>("/api/v1/app/version"),
    enabled: needRefresh,
    staleTime: 0,
  });

  if (!needRefresh || dismissed) return null;
  // Wait for the version query to settle before mounting so screen readers
  // get a single aria-live announcement with the final text.
  if (!isFetched) return null;

  const newVersion = versionInfo?.version ?? null;

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

    if (isEditableElement(activeElement)) {
      activeElement.blur();
    }

    setReloading(true);
    forcePWAUpdate(true).catch(() => {
      setReloading(false);
    });
  };

  const handleDismiss = (): void => {
    setDismissed(true);
  };

  return (
    <div
      className={cn(
        "fixed z-50 left-1/2 -translate-x-1/2 bottom-4",
        "pb-[env(safe-area-inset-bottom)]",
        "md:left-auto md:translate-x-0 md:right-4 md:bottom-4 md:top-auto",
        "md:pt-0",
        "w-[calc(100vw-2rem)] max-w-sm md:w-auto md:max-w-lg"
      )}
    >
      <div
        className={cn(
          "relative flex flex-col gap-3 rounded-lg overflow-hidden",
          "sm:flex-row sm:items-center",
          "bg-card text-card-foreground",
          "border border-border border-l-4 border-l-primary",
          "shadow-2xl pl-4 py-3 pr-14 md:pr-12"
        )}
      >
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Dismiss update notification"
          className={cn(
            "absolute top-1 right-1 z-10",
            "h-11 w-11 md:h-8 md:w-8 inline-flex items-center justify-center rounded-md",
            "text-muted-foreground hover:text-foreground hover:bg-muted",
            "transition-colors focus-visible:outline-none",
            "focus-visible:ring-2 focus-visible:ring-ring",
            "focus-visible:ring-offset-2 focus-visible:ring-offset-card"
          )}
        >
          <X className="h-4 w-4" />
        </button>
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <div
            className={cn(
              "shrink-0 h-8 w-8 rounded-md inline-flex items-center justify-center",
              "bg-primary/15 text-primary"
            )}
          >
            <RefreshCw className="h-4 w-4" />
          </div>
          <div
            role="status"
            aria-live="polite"
            className="min-w-0 flex-1 text-sm font-semibold md:whitespace-nowrap"
          >
            {newVersion
              ? `New version ${newVersion} available`
              : "New version available"}
          </div>
        </div>
        <Button
          onPointerDownCapture={() => {
            hadFocusedEditableRef.current = isEditableElement(
              document.activeElement
            );
          }}
          onClick={handleReload}
          disabled={reloading}
          className="h-11 w-full shrink-0 md:h-8 md:w-auto"
        >
          <RefreshCw
            className={cn("h-3.5 w-3.5 mr-1.5", reloading && "animate-spin")}
          />
          Reload
        </Button>
      </div>
    </div>
  );
}
