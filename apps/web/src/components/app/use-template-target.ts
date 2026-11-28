import { useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import {
  useLaunchTargets,
  useLaunchTargetData,
} from "@/hooks/use-launch-targets";
import { useAgentModelCatalog } from "@/hooks/use-agent-model-catalog";
import type { TemplateDraft } from "./automations-template-draft";

/** Target selection is owned by the template editor, including its save payload. */
export function useTemplateTarget(
  draft: TemplateDraft,
  setDraft: Dispatch<SetStateAction<TemplateDraft>>,
  savedId?: string,
  location = { directory: draft.directory, projectId: draft.projectId },
  onTargetLocation?: (directory: string) => void
) {
  const launch = useLaunchTargets(
    savedId ? { kind: "template", id: savedId } : undefined
  );
  const data = useLaunchTargetData(launch.target, {
    ...location,
    agentType: draft.agentType,
    model: draft.model,
  });
  const models = useAgentModelCatalog(draft.agentType, true, {
    data: data.info?.catalog,
    loading:
      launch.list.isLoading ||
      launch.projection.isFetching ||
      data.catalogLoading,
  });
  useEffect(() => {
    const types = data.info?.agentTypes;
    if (launch.changed && types?.length && !types.includes(draft.agentType))
      setDraft((old) => ({
        ...old,
        agentType: types[0]!,
        model: null,
        effort: null,
      }));
  }, [launch.changed, data.info?.agentTypes, draft.agentType, setDraft]);
  const applied = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!launch.changed || !data.data || applied.current === launch.key) return;
    applied.current = launch.key;
    const baseBranch = data.data.defaults.baseBranch;
    setDraft((old) => ({
      ...old,
      baseBranch,
      directory: data.data!.directory,
    }));
    onTargetLocation?.(data.data.directory);
  }, [launch.changed, launch.key, data.data, setDraft, onTargetLocation]);
  // A new template starts at main for a folder. A project launched from its
  // repository starts at that repository's default branch (empty: the runner
  // resolves it), unless a branch was already picked.
  const repositoryBase = useRef(false);
  const startBase = savedId ? undefined : data.data?.defaults.baseBranch;
  useEffect(() => {
    if (startBase === undefined) return;
    setDraft((old) => {
      if (startBase === "" && old.baseBranch === "main") {
        repositoryBase.current = true;
        return { ...old, baseBranch: "" };
      }
      if (startBase && repositoryBase.current && old.baseBranch === "") {
        repositoryBase.current = false;
        return { ...old, baseBranch: startBase };
      }
      return old;
    });
  }, [startBase, setDraft]);
  return {
    launch,
    data,
    models,
    choose: (key: string) => {
      setDraft((old) => ({ ...old, model: null, effort: null, persona: null }));
      launch.choose(key);
    },
  };
}
export type TemplateTarget = ReturnType<typeof useTemplateTarget>;
