import { useState } from "react";
import { ArrowDownToLine, CheckCircle2 } from "lucide-react";
import type { MacAppUpdateState } from "@dispatch/shared";

import { ActivityBars } from "@/components/ui/activity-bars";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  useMacAppUpdate,
  useMacAppUpdateAction,
} from "@/hooks/use-mac-app-update";
import { formatRelativeTime } from "@/lib/format";

const PROGRESS: Partial<Record<MacAppUpdateState["phase"], string>> = {
  checking: "Checking for updates",
  downloading: "Downloading update",
  installing: "Installing update. Dispatch will restart",
};

/**
 * Updates for a server run by the macOS app. The menu bar app owns Sparkle; this
 * card relays check and install requests to it while it is connected.
 */
export function MacAppUpdatesCard(): JSX.Element {
  const { data, isPending } = useMacAppUpdate();
  const action = useMacAppUpdateAction();
  const [confirming, setConfirming] = useState(false);
  const state = data?.connected ? data.state : null;

  if (!state) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Update Dispatch</CardTitle>
          <CardDescription>
            Click the Dispatch icon in your Mac’s menu bar, then choose{" "}
            <strong>Check for Updates</strong>. To receive updates
            automatically, make sure{" "}
            <strong>Install Updates Automatically</strong> is enabled.
          </CardDescription>
          {!isPending && (
            <p className="text-sm text-muted-foreground">
              While Dispatch is open on the Mac, you can also check for and
              install updates here.
            </p>
          )}
        </CardHeader>
      </Card>
    );
  }

  const progress = PROGRESS[state.phase];
  const idle = state.phase === "idle" || state.phase === "error";
  const install = () => {
    setConfirming(false);
    action.mutate("install");
  };

  return (
    <Card>
      <CardHeader className="gap-4">
        <div className="flex flex-col gap-1.5">
          <CardTitle>Update Dispatch</CardTitle>
          <CardDescription>
            The Dispatch app on your Mac installs updates.{" "}
            {state.automatic
              ? "It installs them automatically."
              : "Automatic updates are off. Turn them on from its menu bar icon."}
          </CardDescription>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Button
            size="sm"
            onClick={() => action.mutate("check")}
            disabled={!idle || action.isPending}
            className="self-start text-muted-foreground hover:text-foreground"
            data-testid="mac-app-check-button"
          >
            Check for updates
          </Button>
          <div className="flex min-w-0 items-center gap-2 text-sm">
            {progress ? (
              <>
                <ActivityBars
                  size={14}
                  className="shrink-0 text-muted-foreground"
                />
                <span className="truncate text-muted-foreground">
                  {progress}
                </span>
              </>
            ) : idle && state.checkedAt && !state.availableVersion ? (
              <>
                <CheckCircle2 className="h-4 w-4 shrink-0 text-green-500" />
                <span className="truncate">
                  Up to date · checked {formatRelativeTime(state.checkedAt)}
                </span>
              </>
            ) : null}
          </div>
        </div>

        {state.phase === "recovery" && (
          <div className="rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            The last update didn’t finish. On the Mac, open the Dispatch menu
            bar icon and choose <strong>Retry Update Recovery</strong>.
          </div>
        )}
        {(state.error || action.error) && (
          <div className="rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {action.error?.message ?? state.error}
          </div>
        )}

        {state.availableVersion && state.phase !== "installing" && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <ArrowDownToLine className="h-4 w-4 text-blue-400" />
              <span className="text-sm text-foreground">
                <span className="font-mono font-semibold">
                  {state.availableVersion}
                </span>{" "}
                available · you have{" "}
                <span className="font-mono">{state.version}</span>
              </span>
            </div>
            <Button
              variant="primary"
              className="self-start"
              disabled={!idle || action.isPending}
              onClick={() => setConfirming(true)}
              data-testid="mac-app-install-button"
            >
              Install {state.availableVersion} and restart
            </Button>
          </div>
        )}
      </CardHeader>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              Install Dispatch{" "}
              <span className="font-mono">{state.availableVersion}</span>
            </DialogTitle>
            <DialogDescription>
              The Mac app downloads the update, stops this server, installs it
              and starts it again. Dispatch is unavailable for about a minute.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={install}>
              Install and restart
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
