import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

export type WhiteboardScene = {
  records: Record<string, unknown>[];
};

export type WhiteboardData = {
  scene: WhiteboardScene;
  version: number;
  elements: Array<{
    id: string;
    type: string;
    x: number;
    y: number;
    w: number;
    h: number;
    label?: string;
    color?: string;
  }>;
};

export function whiteboardQueryKey(agentId: string) {
  return ["whiteboard", agentId] as const;
}

export function useWhiteboard(agentId: string | null) {
  return useQuery<WhiteboardData>({
    queryKey: whiteboardQueryKey(agentId ?? ""),
    queryFn: async () => {
      const res = await fetch(`/api/v1/agents/${agentId}/whiteboard`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch whiteboard");
      return res.json();
    },
    enabled: !!agentId,
    staleTime: 30_000,
  });
}

export function useSaveWhiteboard(agentId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (scene: WhiteboardScene) => {
      if (!agentId) throw new Error("No agent");
      const res = await fetch(`/api/v1/agents/${agentId}/whiteboard`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scene }),
      });
      if (!res.ok) throw new Error("Failed to save whiteboard");
      return res.json();
    },
    onSuccess: () => {
      if (agentId) {
        void queryClient.invalidateQueries({
          queryKey: whiteboardQueryKey(agentId),
        });
      }
    },
  });
}

export function useUploadWhiteboardSnapshot(agentId: string | null) {
  return useMutation({
    mutationFn: async (blob: Blob) => {
      if (!agentId) throw new Error("No agent");
      const form = new FormData();
      form.append("file", blob, "whiteboard-snapshot.png");
      const res = await fetch(`/api/v1/agents/${agentId}/whiteboard/snapshot`, {
        method: "POST",
        credentials: "include",
        body: form,
      });
      if (!res.ok) throw new Error("Failed to upload snapshot");
      return res.json();
    },
  });
}
