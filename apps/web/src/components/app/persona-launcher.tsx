import { remotePlacement } from "@dispatch/runner-protocol";
import { useAtom } from "jotai";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { AgentTypeIcon } from "@/components/app/agent-type-icon";
import { PersonaLauncherDialog } from "@/components/app/persona-launcher-dialog";
import { type Agent } from "@/components/app/types";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { SplitButton } from "@/components/ui/split-button";
import { useAgentModelCatalog } from "@/hooks/use-agent-model-catalog";
import { useRunnerModelCatalog } from "@/hooks/use-runner-engines";
import { useRunners } from "@/hooks/use-runners";
import { api } from "@/lib/api";
import {
  AGENT_TYPE_LABELS,
  type AgentType,
  isCliAgentType,
} from "@/lib/agent-types";
import { reviewAgentModelPrefAtom } from "@/lib/store";

type PersonaSummary = {
  slug: string;
  name: string;
  description: string;
};

function defaultReviewAgentType(agent: Agent): AgentType {
  return agent.reviewAgentType ?? agent.type ?? "codex";
}

export function PersonaLauncher({
  agent,
  enabledAgentTypes,
  disabled = false,
  disabledReason,
  label = "Review",
}: {
  agent: Agent;
  enabledAgentTypes: AgentType[];
  disabled?: boolean;
  disabledReason?: string;
  /** The trigger button's text. */
  label?: string;
}): JSX.Element {
  const queryClient = useQueryClient();
  const cwd = agent.workspacePath ?? agent.worktreePath ?? agent.cwd;
  const runnerId = remotePlacement(agent.cwd)?.runner ?? null;
  const reviewerTypes = enabledAgentTypes.filter(isCliAgentType);
  const showReviewAgentTypePicker = reviewerTypes.length > 1;
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedPersonas, setSelectedPersonas] = useState<string[]>([]);
  const [codeownersSelected, setCodeownersSelected] = useState(false);
  const [note, setNote] = useState("");
  const [selectedAgentType, setSelectedAgentType] = useState<AgentType>(
    defaultReviewAgentType(agent)
  );

  const modelAtom = useMemo(
    () =>
      reviewAgentModelPrefAtom(
        runnerId
          ? `runner://${encodeURIComponent(runnerId)}:${selectedAgentType}:${cwd}`
          : `${selectedAgentType}:${cwd}`
      ),
    [selectedAgentType, cwd, runnerId]
  );
  const [selectedModel, setSelectedModel] = useAtom(modelAtom);

  const localCatalog = useAgentModelCatalog(selectedAgentType, !runnerId);
  const runners = useRunners({ enabled: dialogOpen && Boolean(runnerId) });
  const online =
    runners.data?.find((runner) => runner.id === runnerId)?.status === "online";
  const runnerCatalog = useRunnerModelCatalog(
    runnerId,
    selectedAgentType,
    dialogOpen && online
  );
  const modelOptions = runnerId
    ? online && !runnerCatalog.isError
      ? (runnerCatalog.data?.models ?? [])
      : []
    : localCatalog.options;
  const modelCatalogLoading = runnerId
    ? runners.isLoading || runnerCatalog.isLoading
    : localCatalog.loading;
  const showModelSelect = modelCatalogLoading || modelOptions.length > 0;

  const { data: personaCatalog, isPending: personasPending } = useQuery<{
    personas: PersonaSummary[];
    /** The checkout has a .agents/owners.json to route reviewers by. */
    codeowners: boolean;
    refreshing: boolean;
  }>({
    queryKey: ["personas", agent.id, cwd],
    refetchInterval: (query) => (query.state.data?.refreshing ? 2000 : false),
    queryFn: async () => {
      const result = await api<{
        personas: PersonaSummary[];
        codeowners?: boolean;
        refreshing?: boolean;
      }>(`/api/v1/personas?agentId=${encodeURIComponent(agent.id)}`);
      return {
        personas: result.personas,
        codeowners: result.codeowners === true,
        refreshing: result.refreshing === true,
      };
    },
  });
  const personas = personaCatalog?.personas ?? [];
  const codeownersAvailable = personaCatalog?.codeowners ?? false;

  const launchMutation = useMutation({
    mutationFn: async (selection: {
      personas: string[];
      codeowners: boolean;
    }) => {
      await persistReviewAgentType(selectedAgentType);
      // The request lands in the agent's stream as a post; the agent
      // launches each persona itself, with its own briefing of the work.
      return api<{ ok: boolean; block: { id: string } }>(
        `/api/v1/agents/${agent.id}/launch-persona`,
        {
          method: "POST",
          body: JSON.stringify({
            personas: selection.personas,
            codeowners: selection.codeowners,
            agentType: selectedAgentType,
            // A stored id the catalog no longer offers means "CLI default",
            // same as the select renders it.
            model: modelOptions.some((option) => option.id === selectedModel)
              ? selectedModel
              : null,
            note: note.trim() ? note.trim() : null,
          }),
        }
      );
    },
    onSuccess: () => {
      setDialogOpen(false);
    },
  });

  // Dispatch ships built-in personas, so an empty list means the personas
  // request itself failed rather than an unconfigured repo.
  if (personas.length === 0) {
    return (
      <SplitButton
        size="sm"
        disabled
        menuLabel="Choose reviewer type"
        hint={
          personasPending
            ? "Loading personas…"
            : "Couldn’t load personas for this workspace."
        }
        className="text-muted-foreground"
        data-testid="launch-reviewer-button-disabled"
      >
        <AgentTypeIcon
          type={defaultReviewAgentType(agent)}
          className="size-icon-lg border-none bg-transparent p-0 text-foreground/soft"
        />
        {label}
      </SplitButton>
    );
  }

  const openDialog = (agentType = defaultReviewAgentType(agent)) => {
    setSelectedAgentType(agentType);
    setSelectedPersonas([]);
    setCodeownersSelected(false);
    setNote("");
    launchMutation.reset();
    setDialogOpen(true);
  };

  const persistReviewAgentType = async (nextType: AgentType): Promise<void> => {
    if (agent.reviewAgentType === nextType) return;
    const result = await api<{ agent: Agent }>(
      `/api/v1/agents/${agent.id}/review-agent-type`,
      {
        method: "PATCH",
        body: JSON.stringify({ reviewAgentType: nextType }),
      }
    );
    queryClient.setQueryData<Agent[]>(
      ["agents"],
      (old) =>
        old?.map((item) =>
          item.id === result.agent.id ? result.agent : item
        ) ?? [result.agent]
    );
  };

  return (
    <>
      <SplitButton
        size="sm"
        disabled={disabled || launchMutation.isPending}
        hint={disabled ? disabledReason : undefined}
        className="text-muted-foreground hover:text-foreground"
        data-testid="launch-reviewer-button"
        onClick={() => openDialog()}
        menuLabel="Choose reviewer type"
        menuTestId="launch-reviewer-type-dropdown"
        menu={
          showReviewAgentTypePicker
            ? reviewerTypes.map((agentType) => (
                <DropdownMenuItem
                  key={agentType}
                  className="text-foreground"
                  onClick={() => openDialog(agentType)}
                  data-testid={`launch-reviewer-type-${agentType}`}
                >
                  <span className="flex items-center gap-3">
                    <AgentTypeIcon
                      type={agentType}
                      className="size-icon-lg border-none bg-transparent p-0 text-foreground/soft"
                    />
                    <span>{AGENT_TYPE_LABELS[agentType]}</span>
                  </span>
                </DropdownMenuItem>
              ))
            : null
        }
      >
        <AgentTypeIcon
          type={defaultReviewAgentType(agent)}
          className="size-icon-lg border-none bg-transparent p-0 text-foreground/soft"
        />
        {label}
      </SplitButton>

      <PersonaLauncherDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        reviewerTypes={reviewerTypes}
        selectedAgentType={selectedAgentType}
        setSelectedAgentType={setSelectedAgentType}
        showModelSelect={showModelSelect}
        modelOptions={modelOptions}
        modelCatalogLoading={modelCatalogLoading}
        selectedModel={selectedModel}
        setSelectedModel={setSelectedModel}
        personas={personas}
        selectedPersonas={selectedPersonas}
        setSelectedPersonas={setSelectedPersonas}
        codeownersAvailable={codeownersAvailable}
        codeownersSelected={codeownersSelected}
        setCodeownersSelected={setCodeownersSelected}
        note={note}
        setNote={setNote}
        launchError={launchMutation.error}
        isLaunching={launchMutation.isPending}
        onResetLaunchError={() => launchMutation.reset()}
        onSubmit={() =>
          launchMutation.mutate({
            personas: selectedPersonas,
            codeowners: codeownersSelected,
          })
        }
      />
    </>
  );
}
