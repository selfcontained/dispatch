import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { api } from "@/lib/api";

export type ApprovalState =
  | "idle"
  | "approving"
  | "waiting"
  | "timedOut"
  | "connected"
  | "error";

export type BrowserExtensionConnection = {
  id: string;
  deviceName: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
};

export const connectionsQueryKey = [
  "browser-extension",
  "connections",
] as const;
const postApprovalRefreshAttempts = 21;
const postApprovalRefreshDelayMs = 500;

export function useExtensionConnections() {
  const queryClient = useQueryClient();
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
  return { connectionsQuery, revokeMutation };
}

export function useExtensionPairing(
  connectionsQuery: UseQueryResult<BrowserExtensionConnection[]>
) {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const pairingId = searchParams.get("browserExtensionPairing");
  const code = searchParams.get("code");
  const hasPairingRequest = pairingId !== null || code !== null;
  const pairingRequestIsValid = Boolean(pairingId && code);
  const [approvalState, setApprovalState] = useState<ApprovalState>("idle");
  const [error, setError] = useState("");
  const connectionsBeforeApprovalRef = useRef<Set<string>>(new Set());

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

    const hasPostApprovalConnection = connectionsQuery.data.some(
      (connection) => !connectionsBeforeApprovalRef.current.has(connection.id)
    );
    if (
      (approvalState === "waiting" || approvalState === "timedOut") &&
      hasPostApprovalConnection
    ) {
      setApprovalState("connected");
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

  return {
    code,
    hasPairingRequest,
    pairingRequestIsValid,
    approvalState,
    setApprovalState,
    error,
    approvePairing,
  };
}
