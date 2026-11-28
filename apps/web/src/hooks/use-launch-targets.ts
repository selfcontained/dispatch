import { useCallback, useEffect, useState } from "react";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CatalogResponse } from "./use-agent-model-catalog";
import type { EngineStatus } from "./use-engines";
import type { AgentType } from "@/lib/agent-types";
import type { Project } from "./use-projects";
import { api } from "@/lib/api";

export type LaunchFields = Record<string, string>;
export type LaunchTarget = {
  key: string;
  name: string;
  status: string;
  location: {
    folders: boolean;
    repositories?: boolean;
    projects?: Array<Project & { repository: string | null }>;
    repositorySearchUrl?: string;
    error?: string;
  };
  dataUrl: string;
  historyUrl?: string;
  branchesUrl: string;
  defaultBaseBranch: string;
  launchFields: LaunchFields;
  selectionFields: LaunchFields;
};
export type TargetData = {
  catalog: CatalogResponse;
  agentTypes: AgentType[];
  engineOptions: EngineStatus[] | null;
  effort?: import("@dispatch/shared").AgentConfigChoice[];
  directory: string;
  branchesUrl: string;
  personasUrl: string;
  defaults: {
    baseBranch: string;
    preferenceKey: string;
    launchFields: LaunchFields;
    templateFields?: LaunchFields;
  };
};
type Projection = {
  targetKey: string;
  inherited: boolean;
  projectId: string | null;
  directory: string;
  reviewPreferenceKey?: string;
  locationLabel?: string;
};

/** Selection belongs to the mounted form. Keys and read URLs are never decoded. */
export function useLaunchTargets(
  saved?: {
    kind: "template" | "trigger" | "agent";
    id: string;
  },
  inheritedTemplateId?: string,
  enabled = true
) {
  const [choice, setChoice] = useState<string | null>(null);
  const reset = useCallback(() => setChoice(null), []);
  const list = useQuery({
    queryKey: ["launch-targets"],
    enabled,
    queryFn: async () =>
      (await api<{ targets: LaunchTarget[] }>("/api/v1/launch-targets"))
        .targets,
    refetchInterval: 5000,
  });
  const projection = useQuery({
    queryKey: ["saved-launch-target", saved?.kind, saved?.id],
    enabled: enabled && Boolean(saved),
    queryFn: () =>
      api<Projection>(
        `/api/v1/launch-targets/saved/${saved!.kind}/${encodeURIComponent(saved!.id)}`
      ),
  });
  const inherited = useQuery({
    queryKey: ["saved-launch-target", "template", inheritedTemplateId],
    enabled: enabled && Boolean(inheritedTemplateId),
    queryFn: () =>
      api<Projection>(
        `/api/v1/launch-targets/saved/template/${encodeURIComponent(inheritedTemplateId!)}`
      ),
  });
  const resolved = projection.data?.inherited
    ? (inherited.data ?? projection.data)
    : projection.data;
  const key = choice ?? (saved ? resolved?.targetKey : list.data?.[0]?.key);
  const target = list.data?.find((candidate) => candidate.key === key);
  return {
    list,
    projection,
    target,
    key,
    choose: setChoice,
    reset,
    changed: choice !== null,
    fields: choice !== null ? (target?.selectionFields ?? {}) : {},
    selectionReady: choice === null || Boolean(target),
  };
}

export function useLaunchTargetData(
  target: LaunchTarget | undefined,
  {
    directory,
    projectId,
    agentType,
    model,
  }: {
    directory: string;
    projectId?: string | null;
    agentType: AgentType;
    model?: string | null;
  },
  enabled = true
) {
  const client = useQueryClient();
  useEffect(
    () =>
      client.getQueryCache().subscribe((event) => {
        if (
          event.type === "updated" &&
          ((event.query.queryKey.length === 1 &&
            event.query.queryKey[0] === "agent-models") ||
            (event.query.queryKey.length === 2 &&
              event.query.queryKey[0] === "engine-status")) &&
          ["invalidate", "success"].includes(event.action.type)
        ) {
          void client.invalidateQueries(
            { queryKey: ["agent-models", "launch-target"] },
            { cancelRefetch: false }
          );
        }
      }),
    [client]
  );
  const params = new URLSearchParams({
    directory,
    agentType,
    ...(projectId ? { projectId } : {}),
  });
  // Engine metadata belongs to the target; locations have their own URLs and preferences.
  const infoKey = [
    "agent-models",
    "launch-target-info",
    target?.key,
    agentType,
  ] as const;
  const cachedInfo = useQuery<
    Pick<TargetData, "catalog" | "agentTypes" | "engineOptions">
  >({ queryKey: infoKey, queryFn: skipToken });
  const base = useQuery({
    queryKey: [
      "agent-models",
      "launch-target",
      target?.key,
      directory,
      projectId ?? null,
      agentType,
    ],
    enabled: enabled && Boolean(target),
    queryFn: async () => {
      const result = await api<TargetData>(`${target!.dataUrl}?${params}`);
      client.setQueryData(infoKey, {
        catalog: result.catalog,
        agentTypes: result.agentTypes,
        engineOptions: result.engineOptions,
      });
      return result;
    },
    placeholderData: (previous, query) =>
      query !== undefined &&
      query.queryKey[2] === target?.key &&
      query.queryKey[3] === directory &&
      query.queryKey[4] === (projectId ?? null) &&
      previous?.catalog.models[agentType] !== undefined
        ? previous
        : undefined,
    refetchInterval: 10000,
  });
  const selected = useQuery({
    queryKey: [
      "agent-models",
      "launch-target",
      target?.key,
      directory,
      projectId ?? null,
      agentType,
      model,
    ],
    enabled: enabled && Boolean(target && model),
    queryFn: () =>
      api<TargetData>(
        `${target!.dataUrl}?${params}&${new URLSearchParams({ model: model! })}`
      ),
    refetchInterval: 10000,
  });
  const info = base.data ?? cachedInfo.data;
  const catalog = info?.catalog;
  const reported = catalog?.models[agentType]?.find(
    (item) => item.id === (model ?? catalog.defaults?.[agentType])
  )?.effort;
  const effort = model
    ? (selected.data?.effort ?? reported)
    : (reported ?? (base.isPlaceholderData ? undefined : base.data?.effort));
  const branchParams = new URLSearchParams({
    directory,
    ...(projectId ? { projectId } : {}),
  });
  return {
    ...base,
    branchesUrl:
      base.data?.branchesUrl ??
      (target?.branchesUrl ? `${target.branchesUrl}?${branchParams}` : ""),
    defaultBaseBranch:
      base.data?.defaults?.baseBranch ?? target?.defaultBaseBranch ?? "",
    info,
    effort,
    catalogLoading: base.isLoading && !info,
    data: base.data ? { ...base.data, effort } : undefined,
  };
}
