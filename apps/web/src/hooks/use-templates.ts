import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type { CliAgentType } from "@/lib/agent-types";
import type { Agent } from "@/components/app/types";
import { sortAgentsByCreatedAtDesc } from "@/lib/agent-sort";

export type Template = {
  id: string;
  directory: string;
  name: string;
  description: string | null;
  prompt: string | null;
  agentType: CliAgentType;
  useWorktree: boolean;
  baseBranch: string | null;
  branchName: string | null;
  fullAccess: boolean;
  callable: boolean;
  createdAt: string;
  updatedAt: string;
};

export type TemplateArg = {
  name: string;
  key: string;
  placeholder: string;
};

export type AddTemplateConfig = {
  name: string;
  directory: string;
  description?: string | null;
  prompt?: string | null;
  agentType?: CliAgentType;
  useWorktree?: boolean;
  baseBranch?: string | null;
  branchName?: string | null;
  fullAccess?: boolean;
  callable?: boolean;
};

export type LaunchResult = {
  agent: Agent;
};

const ARG_REGEX = /\{\{D:([^}]+)\}\}/g;

export function parseTemplateArgs(prompt: string): TemplateArg[] {
  const seen = new Set<string>();
  const args: TemplateArg[] = [];
  let match;
  while ((match = ARG_REGEX.exec(prompt)) !== null) {
    const name = match[1].trim();
    const key = name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      args.push({ name, key, placeholder: match[0] });
    }
  }
  return args;
}

export function useTemplates(enabled = true) {
  return useQuery<Template[]>({
    queryKey: ["templates"],
    queryFn: () => api<Template[]>("/api/v1/templates"),
    enabled,
    refetchOnWindowFocus: false,
  });
}

export function useTemplateActions() {
  const queryClient = useQueryClient();
  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ["templates"] });
  };

  const addTemplate = useMutation({
    mutationFn: (template: AddTemplateConfig) =>
      api<Template>("/api/v1/templates", {
        method: "POST",
        body: JSON.stringify(template),
      }),
    onSuccess: invalidate,
  });

  const updateTemplate = useMutation({
    mutationFn: ({
      id,
      ...updates
    }: Partial<AddTemplateConfig> & { id: string }) =>
      api<Template>(`/api/v1/templates/${id}`, {
        method: "PATCH",
        body: JSON.stringify(updates),
      }),
    onSuccess: invalidate,
  });

  const removeTemplate = useMutation({
    mutationFn: (id: string) =>
      api<Template>(`/api/v1/templates/${id}`, {
        method: "DELETE",
      }),
    onSuccess: invalidate,
  });

  const launchTemplate = useMutation({
    mutationFn: ({ id, args }: { id: string; args?: Record<string, string> }) =>
      api<LaunchResult>(`/api/v1/templates/${id}/launch`, {
        method: "POST",
        body: JSON.stringify({ args }),
      }),
    onSuccess: (result) => {
      queryClient.setQueryData<Agent[]>(["agents"], (old) =>
        sortAgentsByCreatedAtDesc([...(old ?? []), result.agent])
      );
    },
  });

  return { addTemplate, updateTemplate, removeTemplate, launchTemplate };
}
