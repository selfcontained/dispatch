import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { type Agent, type FeedbackItem } from "@/components/app/types";
import { api } from "@/lib/api";

export type FeedbackDetailState =
  | { parentAgentId: string; itemId: number }
  | { parentAgentId: string; summaryAgentId: string }
  | null;

export const SEVERITY_DOT: Record<string, string> = {
  critical: "bg-red-500",
  high: "bg-orange-500",
  medium: "bg-yellow-500",
  low: "bg-blue-400",
  info: "bg-muted-foreground",
};

export const SEVERITY_LABELS: Record<
  string,
  { label: string; variant: "error" | "default" }
> = {
  critical: { label: "Critical", variant: "error" },
  high: { label: "High", variant: "error" },
  medium: { label: "Medium", variant: "default" },
  low: { label: "Low", variant: "default" },
  info: { label: "Info", variant: "default" },
};

export const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  forwarded: { label: "Sent", color: "text-blue-400" },
  fixed: { label: "Fixed", color: "text-green-500" },
  ignored: { label: "Ignored", color: "text-muted-foreground/60" },
};

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

export function bySeverity(a: FeedbackItem, b: FeedbackItem): number {
  return (SEVERITY_ORDER[a.severity] ?? 4) - (SEVERITY_ORDER[b.severity] ?? 4);
}

export function compareFeedbackForPanel(
  a: FeedbackItem,
  b: FeedbackItem
): number {
  if (a.roundNumber !== b.roundNumber) {
    return a.roundNumber - b.roundNumber;
  }
  const aThread = a.respondsToFeedbackId ?? a.id;
  const bThread = b.respondsToFeedbackId ?? b.id;
  if (aThread !== bThread) {
    return aThread - bThread;
  }
  return bySeverity(a, b);
}

export function shortSha(sha: string | null | undefined): string | null {
  if (!sha) return null;
  return sha.slice(0, 7);
}

export function canCancelRecheck(agent: Agent): boolean {
  const review = agent.review;
  if (!review?.allowRecheck) return false;
  return review.status === "awaiting_recheck";
}

export function formatFeedbackText(item: FeedbackItem): string {
  const parts: string[] = [];
  if (item.filePath)
    parts.push(
      `File: ${item.filePath}${item.lineNumber ? `:${item.lineNumber}` : ""}`
    );
  parts.push(`Severity: ${item.severity}`);
  parts.push(item.description);
  if (item.suggestion) parts.push(`Suggestion: ${item.suggestion}`);
  return parts.join("\n");
}

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
