import { useState } from "react";
import { ArrowDownToLine, CheckCircle2 } from "lucide-react";
import type { MacAppUpdateState } from "@dispatch/shared";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert } from "@/components/ui/alert";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Spinner } from "@/components/ui/spinner";
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
            <p className="text-body-md text-muted-foreground">
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
          <div className="flex min-w-0 items-center gap-2 text-body-md">
            {progress ? (
              <>
                <Spinner className="text-muted-foreground" />
                <span className="truncate text-muted-foreground">
                  {progress}
                </span>
              </>
            ) : idle && state.checkedAt && !state.availableVersion ? (
              <>
                <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
                <span className="truncate">
                  Up to date · checked {formatRelativeTime(state.checkedAt)}
                </span>
              </>
            ) : null}
          </div>
        </div>

        {state.phase === "recovery" && (
          <Alert title="The last update didn’t finish.">
            On the Mac, open the Dispatch menu bar icon and choose{" "}
            <strong>Retry Update Recovery</strong>.
          </Alert>
        )}
        {(state.error || action.error) && !confirming && (
          <Alert
            title="Couldn’t update Dispatch."
            error={action.error ?? state.error}
          />
        )}

        {state.availableVersion && state.phase !== "installing" && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <ArrowDownToLine className="h-4 w-4 text-info" />
              <span className="text-body-md text-foreground">
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

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        tone="primary"
        title={
          <>
            Install Dispatch{" "}
            <span className="font-mono">{state.availableVersion}</span>?
          </>
        }
        description="The Mac app downloads the update, stops this server, installs it and starts it again. Dispatch is unavailable for about a minute."
        confirmLabel="Install and restart"
        errorTitle="Couldn’t start the update."
        onConfirm={() => action.mutateAsync("install")}
      />
    </Card>
  );
}
