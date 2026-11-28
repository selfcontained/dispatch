import { useEffect, useRef } from "react";
import {
  useLaunchTargets,
  useLaunchTargetData,
} from "@/hooks/use-launch-targets";
import { useAgentModelCatalog } from "@/hooks/use-agent-model-catalog";
import { type AgentType, type CliAgentType } from "@/lib/agent-types";

/**
 * A job's "Runs on" target, as templates and task triggers choose theirs. A
 * saved job reads its target through its backing template. A folder target
 * keeps the job form's own folder, catalog and effort reads; a project target
 * supplies its projects, engines, models and effort.
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
  const byProject = launch.target?.location.kind === "project";
  const data = useLaunchTargetData(
    launch.target,
    { directory, projectId, agentType, model },
    byProject
  );
  const models = useAgentModelCatalog(
    agentType,
    true,
    byProject
      ? {
          data: data.info?.catalog,
          loading:
            launch.list.isLoading ||
            launch.projection.isFetching ||
            data.catalogLoading,
        }
      : undefined
  );
  const types = byProject ? data.info?.agentTypes : undefined;
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
    projects: byProject ? (launch.target?.location.projects ?? []) : [],
  };
}
export type JobTarget = ReturnType<typeof useJobTarget>;
