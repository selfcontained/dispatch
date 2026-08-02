import { MonitorSmartphone, Unplug } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatDateTime, formatRelativeTime } from "@/lib/format";

import type { BrowserExtensionConnection } from "./use-extension-pairing";

const initiallyVisibleConnections = 5;

type BrowserExtensionConnectionsCardProps = {
  connections: BrowserExtensionConnection[];
  isPending: boolean;
  isError: boolean;
  onRetry: () => void;
  showAllConnections: boolean;
  setShowAllConnections: Dispatch<SetStateAction<boolean>>;
  revokeIsPending: boolean;
  revokeIsError: boolean;
  onRevoke: (connectionId: string) => void;
};

export function BrowserExtensionConnectionsCard({
  connections,
  isPending,
  isError,
  onRetry,
  showAllConnections,
  setShowAllConnections,
  revokeIsPending,
  revokeIsError,
  onRevoke,
}: BrowserExtensionConnectionsCardProps): JSX.Element {
  const visibleConnections = showAllConnections
    ? connections
    : connections.slice(0, initiallyVisibleConnections);
  const hiddenConnectionCount = connections.length - visibleConnections.length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Paired browsers</CardTitle>
        <CardDescription>
          Each browser has its own access. Revoking one does not disconnect the
          others.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <p className="text-sm text-muted-foreground" role="status">
            Loading paired browsers...
          </p>
        ) : isError ? (
          <div className="space-y-2">
            <p className="text-sm text-destructive" role="alert">
              Could not load paired browsers.
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="border border-border"
              onClick={onRetry}
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
                  disabled={revokeIsPending}
                  onClick={() => onRevoke(connection.id)}
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
        {revokeIsError && (
          <p className="mt-2 text-sm text-destructive" role="alert">
            Could not revoke that browser. Try again.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
