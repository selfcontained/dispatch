import { ChevronDown } from "lucide-react";
import { useAtom } from "jotai";
import { useCallback, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { AgentTypeIcon } from "@/components/app/agent-type-icon";
import { PersonaLauncherDialog } from "@/components/app/persona-launcher-dialog";
import { type Agent } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAgentModelCatalog } from "@/hooks/use-agent-model-catalog";
import { useClickOutside } from "@/hooks/use-click-outside";
import { api } from "@/lib/api";
import {
  AGENT_TYPE_LABELS,
  type AgentType,
  isCliAgentType,
} from "@/lib/agent-types";
import { reviewAgentModelPrefAtom } from "@/lib/store";
import { cn } from "@/lib/utils";

type PersonaSummary = {
  slug: string;
  name: string;
  description: string;
};

function defaultReviewAgentType(agent: Agent): AgentType {
  return (
    agent.reviewAgentType ??
    (agent.type === "claude" ||
    agent.type === "opencode" ||
    agent.type === "cursor"
      ? agent.type
      : "codex")
  );
}

export function PersonaLauncher({
  agent,
  enabledAgentTypes,
  disabled = false,
  disabledReason,
}: {
  agent: Agent;
  enabledAgentTypes: AgentType[];
  disabled?: boolean;
  disabledReason?: string;
}): JSX.Element {
  const queryClient = useQueryClient();
  const cwd = agent.worktreePath ?? agent.cwd;
  const reviewerTypes = enabledAgentTypes.filter(isCliAgentType);
  const showReviewAgentTypePicker = reviewerTypes.length > 1;
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedPersonas, setSelectedPersonas] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [selectedAgentType, setSelectedAgentType] = useState<AgentType>(
    defaultReviewAgentType(agent)
  );
  const [typeDropdownOpen, setTypeDropdownOpen] = useState(false);
  const typeCmdRef = useRef<HTMLDivElement>(null);
  const typeTriggerRef = useRef<HTMLButtonElement>(null);

  const modelAtom = useMemo(
    () => reviewAgentModelPrefAtom(`${selectedAgentType}:${cwd}`),
    [selectedAgentType, cwd]
  );
  const [selectedModel, setSelectedModel] = useAtom(modelAtom);

  const { options: modelOptions, loading: modelCatalogLoading } =
    useAgentModelCatalog(selectedAgentType);
  const showModelSelect = modelCatalogLoading || modelOptions.length > 0;

  const { data: personas = [] } = useQuery<PersonaSummary[]>({
    queryKey: ["personas", cwd],
    queryFn: async () => {
      const result = await api<{ personas: PersonaSummary[] }>(
        `/api/v1/personas?cwd=${encodeURIComponent(cwd)}`
      );
      return result.personas;
    },
  });

  const closeTypeDropdown = useCallback(() => setTypeDropdownOpen(false), []);
  useClickOutside(typeCmdRef, typeDropdownOpen, closeTypeDropdown);

  const launchMutation = useMutation({
    mutationFn: async (personas: string[]) => {
      await persistReviewAgentType(selectedAgentType);
      await api(`/api/v1/agents/${agent.id}/launch-review`, {
        method: "POST",
        body: JSON.stringify({
          personas,
          agentType: selectedAgentType,
          // A stored id the catalog no longer offers means "CLI default",
          // same as the select renders it.
          model: modelOptions.some((option) => option.id === selectedModel)
            ? selectedModel
            : null,
          note: note.trim() ? note.trim() : null,
        }),
      });
    },
    onSuccess: () => {
      setDialogOpen(false);
    },
  });

  // Dispatch ships built-in personas, so an empty list means the personas
  // request itself failed rather than an unconfigured repo.
  if (personas.length === 0) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            disabled
            className="gap-1.5 border border-white/[0.12] bg-white/[0.06] text-muted-foreground backdrop-blur-md disabled:pointer-events-auto disabled:opacity-60"
            data-testid="launch-reviewer-button-disabled"
          >
            <AgentTypeIcon
              type={defaultReviewAgentType(agent)}
              className="h-4 w-4 border-none bg-transparent p-0 text-foreground/80"
            />
            Review
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          Could not load reviewer personas for this workspace.
        </TooltipContent>
      </Tooltip>
    );
  }

  const openDialog = (agentType = defaultReviewAgentType(agent)) => {
    setSelectedAgentType(agentType);
    setSelectedPersonas([]);
    setNote("");
    launchMutation.reset();
    setTypeDropdownOpen(false);
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

  const reviewButton = (
    <Button
      variant="ghost"
      disabled={disabled || launchMutation.isPending}
      className={cn(
        "gap-1.5 border border-white/[0.12] bg-white/[0.06] text-muted-foreground backdrop-blur-md hover:bg-white/[0.1] hover:text-foreground disabled:pointer-events-auto",
        showReviewAgentTypePicker && "rounded-r-none border-r-0"
      )}
      data-testid="launch-reviewer-button"
      onClick={() => openDialog()}
    >
      <AgentTypeIcon
        type={defaultReviewAgentType(agent)}
        className="h-4 w-4 border-none bg-transparent p-0 text-foreground/80"
      />
      Review
    </Button>
  );

  return (
    <>
      <div className="flex items-center">
        {disabled && disabledReason ? (
          <Tooltip>
            <TooltipTrigger asChild>{reviewButton}</TooltipTrigger>
            <TooltipContent>{disabledReason}</TooltipContent>
          </Tooltip>
        ) : (
          reviewButton
        )}

        {showReviewAgentTypePicker ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                disabled={disabled || launchMutation.isPending}
                className="rounded-l-none border border-white/[0.12] bg-white/[0.06] backdrop-blur-md px-1 text-muted-foreground hover:bg-white/[0.1] hover:text-foreground"
                data-testid="launch-reviewer-type-dropdown"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {reviewerTypes.map((agentType) => (
                <DropdownMenuItem
                  key={agentType}
                  className="text-foreground"
                  onClick={() => openDialog(agentType)}
                  data-testid={`launch-reviewer-type-${agentType}`}
                >
                  <span className="flex items-center gap-3">
                    <AgentTypeIcon
                      type={agentType}
                      className="h-4 w-4 border-none bg-transparent p-0 text-foreground/80"
                    />
                    <span>{AGENT_TYPE_LABELS[agentType]}</span>
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>

      <PersonaLauncherDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        reviewerTypes={reviewerTypes}
        selectedAgentType={selectedAgentType}
        setSelectedAgentType={setSelectedAgentType}
        typeDropdownOpen={typeDropdownOpen}
        setTypeDropdownOpen={setTypeDropdownOpen}
        typeCmdRef={typeCmdRef}
        typeTriggerRef={typeTriggerRef}
        showModelSelect={showModelSelect}
        modelOptions={modelOptions}
        modelCatalogLoading={modelCatalogLoading}
        selectedModel={selectedModel}
        setSelectedModel={setSelectedModel}
        personas={personas}
        selectedPersonas={selectedPersonas}
        setSelectedPersonas={setSelectedPersonas}
        note={note}
        setNote={setNote}
        launchMutation={launchMutation}
      />
    </>
  );
}
