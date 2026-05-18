import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { type Agent, type FeedbackItem } from "@/components/app/types";
import { api } from "@/lib/api";

export function useFeedbackData(parentAgentId: string) {
  const queryClient = useQueryClient();

  const { data: feedback = [] } = useQuery<FeedbackItem[]>({
    queryKey: ["feedback", parentAgentId, "children"],
    queryFn: async () => {
      const result = await api<{ feedback: FeedbackItem[] }>(
        `/api/v1/agents/${parentAgentId}/feedback?scope=children`
      );
      return result.feedback;
    },
    staleTime: 0,
  });

  const { data: allAgents = [] } = useQuery<Agent[]>({
    queryKey: ["agents"],
    queryFn: async () => {
      const result = await api<{ agents: Agent[] }>("/api/v1/agents");
      return result.agents;
    },
    staleTime: 30_000,
  });
  const parentAgent = allAgents.find((a) => a.id === parentAgentId);
  const parentCwd = parentAgent?.worktreePath ?? parentAgent?.cwd;

  type PersonaSummary = { slug: string; name: string };
  const { data: personas = [] } = useQuery<PersonaSummary[]>({
    queryKey: ["personas", parentCwd],
    queryFn: async () => {
      const result = await api<{ personas: PersonaSummary[] }>(
        `/api/v1/personas?cwd=${encodeURIComponent(parentCwd ?? "")}`
      );
      return result.personas;
    },
    enabled: !!parentCwd,
  });

  const personaAttribution = useMemo(() => {
    const slugToIndex = new Map(personas.map((p, i) => [p.slug, i]));
    const map = new Map<string, { name: string; color: string }>();
    for (const agent of allAgents) {
      if (agent.parentAgentId === parentAgentId && agent.persona) {
        const idx = slugToIndex.get(agent.persona);
        const colorVar =
          idx != null ? `var(--chart-${(idx % 4) + 1})` : `var(--chart-1)`;
        const persona = personas.find((p) => p.slug === agent.persona);
        map.set(agent.id, {
          name: persona?.name ?? agent.persona,
          color: `hsl(${colorVar})`,
        });
      }
    }
    return map;
  }, [allAgents, parentAgentId, personas]);

  const updateStatus = useCallback(
    async (item: FeedbackItem, status: string, reason?: string) => {
      const body: { status: string; reason?: string } = { status };
      if (reason !== undefined) body.reason = reason;
      const response = await api<{ feedback: FeedbackItem }>(
        `/api/v1/agents/${item.agentId}/feedback/${item.id}`,
        {
          method: "PATCH",
          body: JSON.stringify(body),
        }
      );
      queryClient.setQueryData<FeedbackItem[]>(
        ["feedback", parentAgentId, "children"],
        (old) => old?.map((f) => (f.id === item.id ? response.feedback : f))
      );
    },
    [queryClient, parentAgentId]
  );

  return { feedback, personaAttribution, updateStatus };
}
