import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Chrome,
  Copy,
  Download,
  FolderOpen,
  MonitorSmartphone,
  Plus,
  Puzzle,
  ShieldCheck,
  Unplug,
} from "lucide-react";
import { useSearchParams } from "react-router-dom";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useCopyText } from "@/hooks/use-copy";
import { api } from "@/lib/api";
import { formatDateTime, formatRelativeTime } from "@/lib/format";

type ApprovalState =
  | "idle"
  | "approving"
  | "waiting"
  | "timedOut"
  | "connected"
  | "error";

type BrowserExtensionConnection = {
  id: string;
  deviceName: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
};

const connectionsQueryKey = ["browser-extension", "connections"] as const;
const postApprovalRefreshAttempts = 21;
const postApprovalRefreshDelayMs = 500;
const initiallyVisibleConnections = 5;

export function BrowserExtensionSettings(): JSX.Element {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const pairingId = searchParams.get("browserExtensionPairing");
  const code = searchParams.get("code");
  const hasPairingRequest = pairingId !== null || code !== null;
  const pairingRequestIsValid = Boolean(pairingId && code);
  const [approvalState, setApprovalState] = useState<ApprovalState>("idle");
  const [error, setError] = useState("");
  const [showInstallGuide, setShowInstallGuide] = useState(false);
  const [showAllConnections, setShowAllConnections] = useState(false);
  const [copiedUrl, copyText] = useCopyText();
  const connectionsBeforeApprovalRef = useRef<Set<string>>(new Set());
  const previousConnectionCountRef = useRef<number | null>(null);
  const connectionsQuery = useQuery({
    queryKey: connectionsQueryKey,
    refetchOnWindowFocus: "always",
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

      if (!cancelled) setApprovalState("timedOut");
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

  useEffect(() => {
    if (!connectionsQuery.data) return;

    const connectionCount = connectionsQuery.data.length;
    const previousConnectionCount = previousConnectionCountRef.current;
    previousConnectionCountRef.current = connectionCount;
    const hasPostApprovalConnection = connectionsQuery.data.some(
      (connection) => !connectionsBeforeApprovalRef.current.has(connection.id)
    );

    if (
      (approvalState === "waiting" || approvalState === "timedOut") &&
      hasPostApprovalConnection
    ) {
      setApprovalState("connected");
    }

    if (
      previousConnectionCount !== null &&
      connectionCount > previousConnectionCount
    ) {
      setShowInstallGuide(false);
    }
  }, [approvalState, connectionsQuery.data]);

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

  const connections = connectionsQuery.data ?? [];
  const hasConnections = connections.length > 0;
  const visibleConnections = showAllConnections
    ? connections
    : connections.slice(0, initiallyVisibleConnections);
  const hiddenConnectionCount = connections.length - visibleConnections.length;
  const dispatchUrl = window.location.origin;

  return (
    <div
      className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-6"
      data-testid="browser-extension-settings"
    >
      <div>
        <h2 className="text-xl font-semibold">Connections</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Connect tools that can send work and context to your Dispatch agents.
        </p>
      </div>

      {(hasPairingRequest || approvalState === "connected") && (
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
              ) : approvalState === "timedOut" ? (
                <div className="space-y-3" role="alert">
                  <div>
                    <p className="text-sm font-medium">
                      Browser has not finished connecting
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Keep the extension open while it finishes the exchange,
                      then check again. If the request is no longer visible in
                      the extension, start a new connection there.
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="primary"
                    onClick={() => setApprovalState("waiting")}
                  >
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
          </CardContent>
        </Card>
      )}

      {!hasPairingRequest &&
        approvalState !== "connected" &&
        connectionsQuery.isPending && (
          <Card>
            <CardContent className="pt-4">
              <p className="text-sm text-muted-foreground" role="status">
                Checking browser connections...
              </p>
            </CardContent>
          </Card>
        )}

      {!hasPairingRequest &&
        approvalState !== "connected" &&
        !connectionsQuery.isPending &&
        !connectionsQuery.isError && (
          <Card>
            <CardHeader className="flex-row items-start gap-3 space-y-0">
              <div className="rounded-lg bg-primary/10 p-2 text-primary">
                <Chrome className="h-5 w-5" aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1 space-y-1.5">
                <CardTitle className="text-base">
                  {hasConnections
                    ? "Dispatch Browser Feedback"
                    : "Try browser feedback"}
                </CardTitle>
                <CardDescription>
                  {hasConnections
                    ? `${connections.length} ${connections.length === 1 ? "browser is" : "browsers are"} paired and ready to send selected page context.`
                    : "Select an element on any web app, add a comment, and send both directly to an agent."}
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {!hasConnections && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    asChild
                    variant="primary"
                    onClick={() => setShowInstallGuide(true)}
                  >
                    <a href="/dispatch-browser-feedback.zip" download>
                      <Download className="mr-2 h-4 w-4" aria-hidden="true" />
                      Download extension ZIP
                    </a>
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setShowInstallGuide((visible) => !visible)}
                    aria-expanded={showInstallGuide}
                  >
                    {showInstallGuide ? "Hide setup" : "Already downloaded?"}
                    {showInstallGuide ? (
                      <ChevronUp className="ml-2 h-4 w-4" aria-hidden="true" />
                    ) : (
                      <ChevronDown
                        className="ml-2 h-4 w-4"
                        aria-hidden="true"
                      />
                    )}
                  </Button>
                </div>
              )}
              {hasConnections && (
                <Button
                  type="button"
                  variant="default"
                  onClick={() => setShowInstallGuide((visible) => !visible)}
                  aria-expanded={showInstallGuide}
                >
                  <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
                  Add another browser
                </Button>
              )}

              {showInstallGuide && (
                <div
                  className="space-y-4 rounded-lg border border-border bg-background/40 p-4"
                  data-testid="extension-install-guide"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-[1_1_16rem]">
                      <p className="text-sm font-medium">
                        Finish setup in Chrome
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        The extension is a developer preview, so Chrome loads it
                        from an unzipped folder for now.
                      </p>
                    </div>
                    {hasConnections && (
                      <Button asChild variant="primary" size="sm">
                        <a href="/dispatch-browser-feedback.zip" download>
                          <Download
                            className="mr-2 h-3.5 w-3.5"
                            aria-hidden="true"
                          />
                          Download ZIP
                        </a>
                      </Button>
                    )}
                  </div>
                  <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))] gap-3">
                    <div className="min-w-0 rounded-lg border border-border p-3">
                      <FolderOpen
                        className="mb-2 h-4 w-4 text-primary"
                        aria-hidden="true"
                      />
                      <p className="text-sm font-medium">
                        1. Unzip the download
                      </p>
                      <p className="mt-1 break-words text-xs text-muted-foreground">
                        Keep the extracted folder somewhere Chrome can continue
                        to access it.
                      </p>
                    </div>
                    <div className="min-w-0 rounded-lg border border-border p-3">
                      <Puzzle
                        className="mb-2 h-4 w-4 text-primary"
                        aria-hidden="true"
                      />
                      <p className="text-sm font-medium">2. Load the folder</p>
                      <p className="mt-1 break-words text-xs text-muted-foreground">
                        Open{" "}
                        <code className="break-all">chrome://extensions</code>,
                        enable Developer mode, then choose Load unpacked.
                      </p>
                    </div>
                    <div className="min-w-0 rounded-lg border border-border p-3">
                      <Chrome
                        className="mb-2 h-4 w-4 text-primary"
                        aria-hidden="true"
                      />
                      <p className="text-sm font-medium">3. Connect Dispatch</p>
                      <p className="mt-1 break-words text-xs text-muted-foreground">
                        Open the extension, enter this Dispatch URL, and verify
                        the pairing code here.
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2">
                    <code className="min-w-0 flex-1 truncate text-xs">
                      {dispatchUrl}
                    </code>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="shrink-0"
                      onClick={() => copyText(dispatchUrl)}
                      aria-label="Copy Dispatch URL"
                    >
                      {copiedUrl ? (
                        <Check className="h-3.5 w-3.5" aria-hidden="true" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                      )}
                      <span className="ml-1.5">
                        {copiedUrl ? "Copied" : "Copy"}
                      </span>
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}

      {(hasConnections || hasPairingRequest || connectionsQuery.isError) && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Paired browsers</CardTitle>
            <CardDescription>
              Each browser has its own access. Revoking one does not disconnect
              the others.
            </CardDescription>
          </CardHeader>
          <CardContent>
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
            ) : connections.length === 0 ? (
              <p className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                Waiting for this browser to finish connecting.
              </p>
            ) : (
              <div className="space-y-2" data-testid="paired-browser-list">
                {visibleConnections.map((connection) => (
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
                {connections.length > initiallyVisibleConnections && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="w-full"
                    onClick={() => setShowAllConnections((visible) => !visible)}
                  >
                    {showAllConnections
                      ? "Show fewer browsers"
                      : `Show ${hiddenConnectionCount} more ${hiddenConnectionCount === 1 ? "browser" : "browsers"}`}
                  </Button>
                )}
              </div>
            )}
            {revokeMutation.isError && (
              <p className="mt-2 text-sm text-destructive" role="alert">
                Could not revoke that browser. Try again.
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
