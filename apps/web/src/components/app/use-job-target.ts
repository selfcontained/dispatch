import { useEffect, useRef } from "react";
import {
  useLaunchTargets,
  useLaunchTargetData,
} from "@/hooks/use-launch-targets";
import { useAgentModelCatalog } from "@/hooks/use-agent-model-catalog";
import { type AgentType, type CliAgentType } from "@/lib/agent-types";

/**
 * A job's "Runs on" target, as templates and task triggers choose theirs. A
 * saved job reads its target through its backing template. Every target supplies
 * its projects, engines, models and effort; source capabilities govern folders.
 */
export function useJobTarget({
  templateId,
  directory,
  projectId,
  agentType,
  model,
  onAgentTypes,
}: {
  templateId?: string | null;
  directory: string;
  projectId: string | null;
  agentType: CliAgentType;
  model: string | null;
  /** The chosen target's engines, after the selection changes. */
  onAgentTypes: (agentTypes: AgentType[]) => void;
}) {
  const launch = useLaunchTargets(
    templateId ? { kind: "template", id: templateId } : undefined
  );
  // A target that launches by project, not by folder.
  const byProject = launch.target?.location.folders === false;
  const projects = launch.target?.location.projects ?? [];
  const project = projects.find((p) => p.id === projectId);
  // A project without a folder here launches from its repository, so its
  // branches come from the target as a project target's do.
  const byRepository = byProject || Boolean(project && !project.repoRoot);
  const data = useLaunchTargetData(launch.target, {
    directory,
    projectId,
    agentType,
    model,
  });
  const models = useAgentModelCatalog(agentType, true, {
    data: data.info?.catalog,
    loading:
      launch.list.isLoading ||
      launch.projection.isFetching ||
      data.catalogLoading,
  });
  const types = data.info?.agentTypes;
  const reported = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!launch.changed || !types?.length) return;
    const key = `${launch.key}:${types.join(",")}`;
    if (reported.current === key) return;
    reported.current = key;
    onAgentTypes(types);
  }, [launch.changed, launch.key, types, onAgentTypes]);
  return {
    launch,
    data,
    models,
    byProject,
    byRepository,
    projects,
    /** Set when the target can search repositories and create projects. */
    searchUrl: launch.target?.location.repositorySearchUrl,
  };
}
export type JobTarget = ReturnType<typeof useJobTarget>;
