import { ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

import type { ApprovalState } from "./use-extension-pairing";

type BrowserExtensionPairingCardProps = {
  approvalState: ApprovalState;
  pairingRequestIsValid: boolean;
  code: string | null;
  error: string;
  onApprove: () => void;
  onCheckAgain: () => void;
};

export function BrowserExtensionPairingCard({
  approvalState,
  pairingRequestIsValid,
  code,
  error,
  onApprove,
  onCheckAgain,
}: BrowserExtensionPairingCardProps): JSX.Element {
  return (
    <Card className="border-primary/30">
      <CardHeader className="flex-row items-start gap-3 space-y-0 pb-3">
        <div className="rounded-lg bg-primary/10 p-2 text-primary">
          <ShieldCheck className="h-5 w-5" aria-hidden="true" />
        </div>
        <div className="space-y-1.5">
          <CardTitle className="text-base">
            {approvalState === "connected"
              ? "Browser connected"
              : approvalState === "timedOut"
                ? "Connection still pending"
                : "Approve this browser"}
          </CardTitle>
          <CardDescription>
            {approvalState === "connected"
              ? "The extension is ready to send feedback to your agents."
              : approvalState === "timedOut"
                ? "Dispatch has not seen the browser finish connecting yet."
                : "Finish the connection request you started in the extension."}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <div className="rounded-lg border border-border bg-background/50 p-4">
          {approvalState === "connected" ? (
            <div className="flex items-start gap-3" role="status">
              <ShieldCheck
                className="mt-0.5 h-5 w-5 shrink-0 text-status-working"
                aria-hidden="true"
              />
              <div>
                <p className="text-sm font-medium">
                  Browser extension connected
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  You can close this page and return to the Dispatch extension.
                </p>
              </div>
            </div>
          ) : !pairingRequestIsValid ? (
            <p className="text-sm text-destructive" role="alert">
              This browser extension pairing link is incomplete. Return to the
              extension and start the connection again.
            </p>
          ) : approvalState === "waiting" ? (
            <div className="flex items-start gap-3" role="status">
              <ShieldCheck
                className="mt-0.5 h-5 w-5 shrink-0 text-status-working"
                aria-hidden="true"
              />
              <div>
                <p className="text-sm font-medium">Connection approved</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Return to the extension to finish connecting. This page will
                  update when the browser appears below.
                </p>
              </div>
            </div>
          ) : approvalState === "timedOut" ? (
            <div className="space-y-3" role="alert">
              <div>
                <p className="text-sm font-medium">
                  Browser has not finished connecting
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Keep the extension open while it finishes the exchange, then
                  check again. If the request is no longer visible in the
                  extension, start a new connection there.
                </p>
              </div>
              <Button type="button" variant="primary" onClick={onCheckAgain}>
                Check again
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <p className="text-sm font-medium">
                  Chrome is requesting permission to connect
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Approve only if you started this request. The extension will
                  be able to view available agents and send page feedback to the
                  agent you select.
                </p>
              </div>
              <div className="rounded-lg border border-primary/30 bg-primary/10 px-4 py-3 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Confirm this code matches the extension
                </p>
                <code className="mt-1 block text-xl font-semibold tracking-[0.18em] text-foreground">
                  {code}
                </code>
              </div>
              {approvalState === "error" && (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              )}
              <Button
                type="button"
                variant="primary"
                onClick={onApprove}
                disabled={approvalState === "approving"}
              >
                {approvalState === "approving"
                  ? "Connecting..."
                  : "Approve connection"}
              </Button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
