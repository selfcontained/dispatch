import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type { AgentType } from "@/lib/agent-types";
import type { Agent } from "@/components/app/types";
import { sortAgentsByCreatedAtDesc } from "@/lib/agent-sort";
import {
  parseTemplateArgs as parseSharedTemplateArgs,
  substituteArgs as substituteSharedArgs,
  type TemplatePromptArg as TemplateArg,
} from "../../../server/src/templates/arg-parser";
import type { TemplateRecord } from "../../../server/src/templates/store";

export type { TemplateArg };

export type Template = TemplateRecord;

export type AddTemplateConfig = {
  name: string;
  directory: string;
  description?: string | null;
  prompt?: string | null;
  agentType?: AgentType;
  useWorktree?: boolean;
  baseBranch?: string | null;
  branchName?: string | null;
  fullAccess?: boolean;
  callable?: boolean;
  allowMedia?: boolean;
};

export type LaunchResult = {
  agent: Agent;
};

export function parseTemplateArgs(prompt: string): TemplateArg[] {
  return parseSharedTemplateArgs(prompt);
}

export function substituteArgs(
  prompt: string,
  args: Record<string, string>
): string {
  return substituteSharedArgs(prompt, args);
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
    mutationFn: ({
      id,
      args,
      agentType,
      startupFiles,
      startupLinks,
    }: {
      id: string;
      args?: Record<string, string>;
      agentType?: AgentType;
      startupFiles?: File[];
      startupLinks?: string[];
    }) => {
      const hasFiles =
        (startupFiles && startupFiles.length > 0) ||
        (startupLinks && startupLinks.length > 0);
      if (hasFiles) {
        const formData = new FormData();
        if (args) formData.append("args", JSON.stringify(args));
        if (agentType) formData.append("agentType", agentType);
        if (startupLinks) {
          formData.append("startupLinks", JSON.stringify(startupLinks));
        }
        for (const file of startupFiles ?? []) {
          formData.append("startupFiles", file);
        }
        return api<LaunchResult>(`/api/v1/templates/${id}/launch`, {
          method: "POST",
          body: formData,
        });
      }
      return api<LaunchResult>(`/api/v1/templates/${id}/launch`, {
        method: "POST",
        body: JSON.stringify({ args, agentType }),
      });
    },
    onSuccess: (result) => {
      queryClient.setQueryData<Agent[]>(["agents"], (old) => {
        if (!old) return [result.agent];
        const index = old.findIndex((agent) => agent.id === result.agent.id);
        if (index === -1) {
          return sortAgentsByCreatedAtDesc([result.agent, ...old]);
        }
        const next = [...old];
        next[index] = result.agent;
        return sortAgentsByCreatedAtDesc(next);
      });
    },
  });

  return { addTemplate, updateTemplate, removeTemplate, launchTemplate };
}
