import { useEffect, useRef, useState } from "react";

import { Card, CardContent } from "@/components/ui/card";
import { useCopyText } from "@/hooks/use-copy";

import { BrowserExtensionConnectionsCard } from "./browser-extension-connections-card";
import { BrowserExtensionPairingCard } from "./browser-extension-pairing-card";
import { BrowserExtensionSetupCard } from "./browser-extension-setup-card";
import {
  useExtensionConnections,
  useExtensionPairing,
} from "./use-extension-pairing";

export function BrowserExtensionSettings(): JSX.Element {
  const { connectionsQuery, revokeMutation } = useExtensionConnections();
  const {
    code,
    hasPairingRequest,
    pairingRequestIsValid,
    approvalState,
    setApprovalState,
    error,
    approvePairing,
  } = useExtensionPairing(connectionsQuery);
  const [showInstallGuide, setShowInstallGuide] = useState(false);
  const [showAllConnections, setShowAllConnections] = useState(false);
  const [copiedUrl, copyText] = useCopyText();
  const previousConnectionCountRef = useRef<number | null>(null);

  useEffect(() => {
    if (!connectionsQuery.data) return;

    const connectionCount = connectionsQuery.data.length;
    const previousConnectionCount = previousConnectionCountRef.current;
    previousConnectionCountRef.current = connectionCount;

    if (
      previousConnectionCount !== null &&
      connectionCount > previousConnectionCount
    ) {
      setShowInstallGuide(false);
    }
  }, [connectionsQuery.data]);

  const connections = connectionsQuery.data ?? [];
  const hasConnections = connections.length > 0;

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
        <BrowserExtensionPairingCard
          approvalState={approvalState}
          pairingRequestIsValid={pairingRequestIsValid}
          code={code}
          error={error}
          onApprove={() => void approvePairing()}
          onCheckAgain={() => setApprovalState("waiting")}
        />
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
          <BrowserExtensionSetupCard
            connectionCount={connections.length}
            showInstallGuide={showInstallGuide}
            setShowInstallGuide={setShowInstallGuide}
            copiedUrl={copiedUrl}
            onCopyUrl={copyText}
          />
        )}

      {(hasConnections || hasPairingRequest || connectionsQuery.isError) && (
        <BrowserExtensionConnectionsCard
          connections={connections}
          isPending={connectionsQuery.isPending}
          isError={connectionsQuery.isError}
          onRetry={() => void connectionsQuery.refetch()}
          showAllConnections={showAllConnections}
          setShowAllConnections={setShowAllConnections}
          revokeIsPending={revokeMutation.isPending}
          revokeIsError={revokeMutation.isError}
          onRevoke={(connectionId) => revokeMutation.mutate(connectionId)}
        />
      )}
    </div>
  );
}
