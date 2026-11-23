import { MonitorSmartphone, Unplug } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Panel,
} from "@/components/ui/card";
import { Hint } from "@/components/ui/tooltip";
import { formatDateTime, formatRelativeTime } from "@/lib/format";

import type { BrowserExtensionConnection } from "./use-extension-pairing";
import { Alert } from "@/components/ui/alert";
import { LoadError } from "@/components/ui/async-boundary";
import { LoadingSkeleton } from "@/components/ui/skeleton";

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
        <CardTitle>Paired browsers</CardTitle>
        <CardDescription>
          Each browser has its own access. Revoking one does not disconnect the
          others.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <LoadingSkeleton label="Loading paired browsers…" />
        ) : isError ? (
          <LoadError thing="paired browsers" onRetry={onRetry} />
        ) : connections.length === 0 ? (
          <p className="text-body-sm text-muted-foreground">
            Waiting for this browser to finish connecting.
          </p>
        ) : (
          <div className="space-y-2" data-testid="paired-browser-list">
            {visibleConnections.map((connection) => (
              <Panel
                key={connection.id}
                className="flex flex-wrap items-center gap-3"
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
                  tone="danger"
                  className="shrink-0"
                  aria-label={`Revoke ${connection.deviceName}`}
                  disabled={revokeIsPending}
                  onClick={() => onRevoke(connection.id)}
                >
                  <Unplug aria-hidden="true" />
                  Revoke
                </Button>
              </Panel>
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
          <Alert title="Couldn’t revoke that browser." className="mt-2">
            Try again.
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
