import { useEffect, useState } from "react";
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

  const handleReload = (): void => {
    setReloading(true);
    reloadApp();
  };

  const handleDismiss = (): void => {
    writeDismissed(serverVersion);
    setDismissedVersion(serverVersion);
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "fixed z-50 left-1/2 -translate-x-1/2 top-4",
        "pt-[env(safe-area-inset-top)]",
        "md:left-auto md:translate-x-0 md:right-4 md:bottom-4 md:top-auto",
        "md:pt-0 md:pb-[env(safe-area-inset-bottom)]",
        "w-[calc(100vw-2rem)] max-w-sm"
      )}
    >
      <div
        className={cn(
          "flex items-center gap-3 rounded-lg overflow-hidden",
          "bg-primary text-primary-foreground",
          "shadow-2xl ring-1 ring-primary/60 px-4 py-3"
        )}
      >
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">New version available</div>
          <div className="text-xs opacity-80 truncate">
            Reload to update to {serverVersion}
          </div>
        </div>
        <Button
          size="sm"
          onClick={handleReload}
          disabled={reloading}
          className="shrink-0"
        >
          <RefreshCw
            className={cn("h-3.5 w-3.5 mr-1.5", reloading && "animate-spin")}
          />
          Reload
        </Button>
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Dismiss update notification"
          className={cn(
            "shrink-0 h-8 w-8 inline-flex items-center justify-center rounded-md",
            "text-primary-foreground/70 hover:text-primary-foreground hover:bg-primary-foreground/10",
            "transition-colors"
          )}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
