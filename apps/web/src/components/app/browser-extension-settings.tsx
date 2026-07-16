import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Chrome, MonitorSmartphone, ShieldCheck, Unplug } from "lucide-react";
import { useSearchParams } from "react-router-dom";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { api } from "@/lib/api";
import { formatDateTime, formatRelativeTime } from "@/lib/format";

type ApprovalState = "idle" | "approving" | "waiting" | "connected" | "error";

type BrowserExtensionConnection = {
  id: string;
  deviceName: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
};

const connectionsQueryKey = ["browser-extension", "connections"] as const;
const postApprovalRefreshAttempts = 6;
const postApprovalRefreshDelayMs = 500;

export function BrowserExtensionSettings(): JSX.Element {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const pairingId = searchParams.get("browserExtensionPairing");
  const code = searchParams.get("code");
  const hasPairingRequest = pairingId !== null || code !== null;
  const pairingRequestIsValid = Boolean(pairingId && code);
  const [approvalState, setApprovalState] = useState<ApprovalState>("idle");
  const [error, setError] = useState("");
  const connectionsBeforeApprovalRef = useRef<Set<string>>(new Set());
  const connectionsQuery = useQuery({
    queryKey: connectionsQueryKey,
    queryFn: async () => {
      const result = await api<{ connections: BrowserExtensionConnection[] }>(
        "/api/v1/browser-extension/connections"
      );
      return result.connections;
    },
  });
  const revokeMutation = useMutation({
    mutationFn: (connectionId: string) =>
      api(`/api/v1/browser-extension/connections/${connectionId}`, {
        method: "DELETE",
      }),
    onSuccess: (_result, connectionId) => {
      queryClient.setQueryData<BrowserExtensionConnection[]>(
        connectionsQueryKey,
        (connections) =>
          connections?.filter((connection) => connection.id !== connectionId)
      );
    },
  });

  useEffect(() => {
    if (approvalState !== "waiting") return;

    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let finishWaiting: (() => void) | undefined;

    const refreshUntilConnectionAppears = async () => {
      await queryClient.cancelQueries({ queryKey: connectionsQueryKey });

      for (let attempt = 0; attempt < postApprovalRefreshAttempts; attempt++) {
        if (cancelled) return;

        await queryClient.refetchQueries({
          queryKey: connectionsQueryKey,
          type: "active",
        });
        if (cancelled) return;

        const connections =
          queryClient.getQueryData<BrowserExtensionConnection[]>(
            connectionsQueryKey
          ) ?? [];
        if (
          connections.some(
            (connection) =>
              !connectionsBeforeApprovalRef.current.has(connection.id)
          )
        ) {
          setApprovalState("connected");
          return;
        }

        if (attempt < postApprovalRefreshAttempts - 1) {
          await new Promise<void>((resolve) => {
            finishWaiting = resolve;
            refreshTimer = setTimeout(resolve, postApprovalRefreshDelayMs);
          });
          finishWaiting = undefined;
          refreshTimer = undefined;
        }
      }
    };

    void refreshUntilConnectionAppears();

    return () => {
      cancelled = true;
      if (refreshTimer !== undefined) clearTimeout(refreshTimer);
      finishWaiting?.();
    };
  }, [approvalState, queryClient]);

  useEffect(() => {
    if (approvalState !== "connected" || (!pairingId && !code)) return;
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete("browserExtensionPairing");
    nextParams.delete("code");
    setSearchParams(nextParams, { replace: true });
  }, [approvalState, code, pairingId, searchParams, setSearchParams]);

  const approvePairing = async () => {
    if (!pairingId || !code) return;

    setApprovalState("approving");
    setError("");

    const baselineResult = connectionsQuery.data
      ? { data: connectionsQuery.data }
      : await connectionsQuery.refetch();
    if (!baselineResult.data) {
      setError(
        "Could not load existing browser connections. Check your connection and try again."
      );
      setApprovalState("error");
      return;
    }
    connectionsBeforeApprovalRef.current = new Set(
      baselineResult.data.map((connection) => connection.id)
    );

    try {
      const response = await fetch(
        `/api/v1/browser-extension/pairings/${encodeURIComponent(pairingId)}/approve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ code }),
        }
      );

      if (!response.ok) {
        let message = "Could not approve this browser extension connection.";
        try {
          const body = (await response.json()) as { error?: string };
          message = body.error ?? message;
        } catch {
          // The default message handles non-JSON error responses.
        }
        setError(message);
        setApprovalState("error");
        return;
      }

      setApprovalState("waiting");
    } catch {
      setError(
        "Unable to reach the server. Check your connection and try again."
      );
      setApprovalState("error");
    }
  };

  return (
    <div>
      <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Browser Extension
      </h3>
      <Card className="max-w-xl" data-testid="browser-extension-settings">
        <CardHeader className="flex-row items-start gap-3 space-y-0">
          <div className="rounded-lg bg-primary/10 p-2 text-primary">
            <Chrome className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="space-y-1.5">
            <CardTitle className="text-base">
              Connect Chrome to Dispatch
            </CardTitle>
            <CardDescription>
              The Dispatch extension can send selected page elements and your
              comments to an agent you choose.
            </CardDescription>
          </div>
        </CardHeader>

        <CardContent className="space-y-5">
          {(hasPairingRequest || approvalState === "connected") && (
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
                      You can close this page and return to the Dispatch
                      extension.
                    </p>
                  </div>
                </div>
              ) : !pairingRequestIsValid ? (
                <p className="text-sm text-destructive" role="alert">
                  This browser extension pairing link is incomplete. Return to
                  the extension and start the connection again.
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
                      Return to the extension to finish connecting. This page
                      will update when the browser appears below.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div>
                    <p className="text-sm font-medium">
                      Chrome is requesting permission to connect
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Approve only if you started this request. The extension
                      will be able to view available agents and send page
                      feedback to the agent you select.
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
                    onClick={() => void approvePairing()}
                    disabled={approvalState === "approving"}
                  >
                    {approvalState === "approving"
                      ? "Connecting..."
                      : "Approve connection"}
                  </Button>
                </div>
              )}
            </div>
          )}

          <div
            className={hasPairingRequest ? "border-t border-border pt-5" : ""}
          >
            <div className="mb-3">
              <p className="text-sm font-medium">Paired browsers</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Each browser has its own access. Revoking one does not
                disconnect the others.
              </p>
            </div>

            {connectionsQuery.isPending ? (
              <p className="text-sm text-muted-foreground" role="status">
                Loading paired browsers...
              </p>
            ) : connectionsQuery.isError ? (
              <div className="space-y-2">
                <p className="text-sm text-destructive" role="alert">
                  Could not load paired browsers.
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="border border-border"
                  onClick={() => void connectionsQuery.refetch()}
                >
                  Try again
                </Button>
              </div>
            ) : connectionsQuery.data.length === 0 ? (
              <p className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                No browsers are currently paired.
              </p>
            ) : (
              <div className="space-y-2" data-testid="paired-browser-list">
                {connectionsQuery.data.map((connection) => (
                  <div
                    key={connection.id}
                    className="flex items-center gap-3 rounded-md border border-border bg-background/50 px-3 py-3"
                    data-testid={`paired-browser-${connection.id}`}
                  >
                    <MonitorSmartphone
                      className="h-4 w-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {connection.deviceName}
                      </p>
                      <p
                        className="mt-0.5 text-xs text-muted-foreground"
                        title={`Paired ${formatDateTime(connection.createdAt)}; expires ${formatDateTime(connection.expiresAt)}`}
                      >
                        {connection.lastUsedAt
                          ? `Last used ${formatRelativeTime(connection.lastUsedAt)}`
                          : `Paired ${formatRelativeTime(connection.createdAt)}`}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="shrink-0 gap-1.5 text-destructive hover:text-destructive"
                      aria-label={`Revoke ${connection.deviceName}`}
                      disabled={revokeMutation.isPending}
                      onClick={() => revokeMutation.mutate(connection.id)}
                    >
                      <Unplug className="h-3.5 w-3.5" aria-hidden="true" />
                      Revoke
                    </Button>
                  </div>
                ))}
              </div>
            )}

            {revokeMutation.isError && (
              <p className="mt-2 text-sm text-destructive" role="alert">
                Could not revoke that browser. Try again.
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
