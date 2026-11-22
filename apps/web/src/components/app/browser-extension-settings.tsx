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
import { LoadingSkeleton } from "@/components/ui/skeleton";
import { SettingsGroup } from "@/components/app/settings-layout";
import { toast } from "@/components/ui/toast";

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
    <SettingsGroup
      title="Browser feedback"
      data-testid="browser-extension-settings"
    >
      <div className="space-y-4">
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
                <LoadingSkeleton label="Checking browser connections…" />
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
            onRevoke={(connectionId) =>
              revokeMutation.mutate(connectionId, {
                onSuccess: () => toast.success("Browser access revoked."),
              })
            }
          />
        )}
      </div>
    </SettingsGroup>
  );
}
