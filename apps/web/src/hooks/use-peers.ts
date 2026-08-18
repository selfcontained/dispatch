import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";

export type LinkedPeer = {
  id: string;
  name: string;
};

/**
 * The linked instances this Dispatch knows about. Shared query key so the
 * sidebar's per-card lookups and the settings pane resolve from one fetch —
 * every agent card on screen would otherwise ask independently.
 */
export function useLinkedPeers(enabled = true) {
  return useQuery({
    queryKey: ["peers", "list"],
    queryFn: async () =>
      (await api<{ peers: LinkedPeer[] }>("/api/v1/peers")).peers,
    enabled,
    staleTime: 60_000,
  });
}

/**
 * What THIS machine calls the instance an agent runs on, or null for local
 * agents. Falls back to the raw instance id until the peer list resolves —
 * "inst_9f2c62a1b0" is unhelpful, but it beats a flash of nothing.
 */
export function usePeerName(peerId: string | null | undefined): string | null {
  const { data } = useLinkedPeers(Boolean(peerId));
  if (!peerId) return null;
  return data?.find((peer) => peer.id === peerId)?.name ?? peerId;
}
