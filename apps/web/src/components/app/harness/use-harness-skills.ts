import { useQuery } from "@tanstack/react-query";
import type { HarnessSkill, HarnessSkillsResponse } from "@dispatch/shared";

import { api } from "@/lib/api";

export function harnessSkillsQueryKey(agentId: string | null) {
  return ["harness-skills", agentId] as const;
}

/** The skills the harness agent can load; feeds the composer's slash menu. */
export function useHarnessSkills(agentId: string | null): HarnessSkill[] {
  const query = useQuery({
    queryKey: harnessSkillsQueryKey(agentId),
    queryFn: () =>
      api<HarnessSkillsResponse>(`/api/v1/agents/${agentId}/harness/skills`),
    enabled: agentId !== null,
    staleTime: 60_000,
  });
  return query.data?.skills ?? [];
}
