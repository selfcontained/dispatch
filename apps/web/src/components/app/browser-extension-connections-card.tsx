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
import { Hint } from "@/components/ui/tooltip";
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
        <CardTitle className="text-heading-md">Paired browsers</CardTitle>
        <CardDescription>
          Each browser has its own access. Revoking one does not disconnect the
          others.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <p className="text-body-md text-muted-foreground" role="status">
            Loading paired browsers...
          </p>
        ) : isError ? (
          <div className="space-y-2">
            <p className="text-body-md text-danger" role="alert">
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
          <p className="rounded-md border border-dashed border-border px-3 py-4 text-body-md text-muted-foreground">
            Waiting for this browser to finish connecting.
          </p>
        ) : (
          <div className="space-y-2" data-testid="paired-browser-list">
            {visibleConnections.map((connection) => (
              <div
                key={connection.id}
                className="flex items-center gap-3 rounded-md border border-border bg-background/veil px-3 py-3"
                data-testid={`paired-browser-${connection.id}`}
              >
                <MonitorSmartphone
                  className="h-4 w-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-body-md font-medium">
                    {connection.deviceName}
                  </p>
                  <Hint
                    label={`Paired ${formatDateTime(connection.createdAt)}; expires ${formatDateTime(connection.expiresAt)}`}
                  >
                    <p className="mt-0.5 text-body-sm text-muted-foreground">
                      {connection.lastUsedAt
                        ? `Last used ${formatRelativeTime(connection.lastUsedAt)}`
                        : `Paired ${formatRelativeTime(connection.createdAt)}`}
                    </p>
                  </Hint>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="shrink-0 text-danger hover:text-danger"
                  aria-label={`Revoke ${connection.deviceName}`}
                  disabled={revokeIsPending}
                  onClick={() => onRevoke(connection.id)}
                >
                  <Unplug aria-hidden="true" />
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
          <p className="mt-2 text-body-md text-danger" role="alert">
            Could not revoke that browser. Try again.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
