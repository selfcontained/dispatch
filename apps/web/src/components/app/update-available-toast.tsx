import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useUpdateAvailable } from "@/hooks/use-update-available";
import { reloadApp } from "@/lib/reload";
import { cn } from "@/lib/utils";

const DISMISS_KEY = "dispatch:update-toast:dismissed-version";

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

function writeDismissed(version: string): void {
  try {
    localStorage.setItem(DISMISS_KEY, version);
  } catch {
    /* storage unavailable */
  }
}

export function UpdateAvailableToast(): JSX.Element | null {
  const { available, serverVersion } = useUpdateAvailable();
  const location = useLocation();
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(() =>
    readDismissed()
  );
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    if (
      serverVersion &&
      dismissedVersion &&
      serverVersion !== dismissedVersion
    ) {
      setDismissedVersion(null);
    }
  }, [serverVersion, dismissedVersion]);

  if (!available || !serverVersion) return null;
  if (dismissedVersion === serverVersion) return null;
  // Release manager lives under /settings and owns its own update flow + reload
  // CTA, so hide the passive toast there to avoid duplication.
  if (location.pathname.startsWith("/settings")) return null;

  const handleReload = (): void => {
    setReloading(true);
    reloadApp({ waitForUpdate: true }).catch(() => {
      setReloading(false);
    });
  };

  const handleDismiss = (): void => {
    writeDismissed(serverVersion);
    setDismissedVersion(serverVersion);
  };

  return (
    <div
      className={cn(
        "fixed z-50 left-1/2 -translate-x-1/2 top-4",
        "pt-[env(safe-area-inset-top)]",
        "md:left-auto md:translate-x-0 md:right-4 md:bottom-4 md:top-auto",
        "md:pt-0 md:pb-[env(safe-area-inset-bottom)]",
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
            "transition-colors"
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
            New version {serverVersion} available
          </div>
        </div>
        <Button
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
