import { Check, ChevronDown, CircleAlert } from "lucide-react";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { AgentTypeIcon } from "@/components/app/agent-type-icon";
import { type Agent } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { api } from "@/lib/api";
import {
  AGENT_TYPE_LABELS,
  type AgentType,
  isCliAgentType,
} from "@/lib/agent-types";

type PersonaSummary = {
  slug: string;
  name: string;
  description: string;
};

export function PersonaLauncher({
  agent,
  enabledAgentTypes,
  sendTerminalInput,
  disabled = false,
}: {
  agent: Agent;
  enabledAgentTypes: AgentType[];
  sendTerminalInput?: (data: string) => void;
  disabled?: boolean;
}): JSX.Element | null {
  const queryClient = useQueryClient();
  const cwd = agent.worktreePath ?? agent.cwd;
  const [allowRecheck, setAllowRecheck] = useState(false);
  const [isLaunching, setIsLaunching] = useState(false);

  const { data: personas = [] } = useQuery<PersonaSummary[]>({
    queryKey: ["personas", cwd],
    queryFn: async () => {
      const result = await api<{ personas: PersonaSummary[] }>(
        `/api/v1/personas?cwd=${encodeURIComponent(cwd)}`
      );
      return result.personas;
    },
  });
  const hasPersonas = personas.length > 0;
  // Terminal agents can't run personas — exclude from review type options.
  const reviewerTypes = enabledAgentTypes.filter(isCliAgentType);
  const showReviewAgentTypePicker = reviewerTypes.length > 1;

  if (!hasPersonas) {
    return null;
  }

  const reviewAgentType =
    agent.reviewAgentType ??
    (agent.type === "claude" || agent.type === "opencode"
      ? agent.type
      : "codex");

  const launchPersona = async (slug: string) => {
    if (isLaunching) return;
    setIsLaunching(true);
    try {
      await api(`/api/v1/agents/${agent.id}/persona-reviews`, {
        method: "POST",
        body: JSON.stringify({
          persona: slug,
          agentType: reviewAgentType,
          allowRecheck,
        }),
      });
      await queryClient.invalidateQueries({ queryKey: ["agents"] });
    } catch (error) {
      if (sendTerminalInput) {
        const message = [
          `Use the dispatch_launch_persona MCP tool to launch the "${slug}" persona on your current work.`,
          `Use agentType: "${reviewAgentType}" and allowRecheck: ${allowRecheck ? "true" : "false"}.`,
          "Provide a detailed context briefing covering what you built, key files changed, and any areas that need extra attention.",
        ].join(" ");
        sendTerminalInput(message + "\r");
      } else {
        throw error;
      }
    } finally {
      setIsLaunching(false);
    }
  };

  const updateReviewAgentType = async (nextType: AgentType): Promise<void> => {
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
    <div className="flex flex-col items-start gap-2">
      <div className="flex items-center">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              disabled={disabled || isLaunching}
              className={
                showReviewAgentTypePicker
                  ? "gap-1.5 rounded-r-none border border-white/[0.12] border-r-0 bg-white/[0.06] backdrop-blur-md text-muted-foreground hover:bg-white/[0.1] hover:text-foreground"
                  : "gap-1.5 border border-white/[0.12] bg-white/[0.06] backdrop-blur-md text-muted-foreground hover:bg-white/[0.1] hover:text-foreground"
              }
              data-testid="launch-reviewer-button"
            >
              <AgentTypeIcon
                type={reviewAgentType}
                className="h-4 w-4 border-none bg-transparent p-0 text-foreground/80"
              />
              Review
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {personas.map((p, i) => {
              const colorVar = `var(--chart-${(i % 4) + 1})`;
              return (
                <DropdownMenuItem
                  key={p.slug}
                  className="text-foreground"
                  onClick={() => {
                    void launchPersona(p.slug);
                  }}
                >
                  <div className="flex items-start gap-2.5">
                    <div
                      className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: `hsl(${colorVar})` }}
                    />
                    <div>
                      <div
                        className="text-sm font-medium"
                        style={{ color: `hsl(${colorVar})` }}
                      >
                        {p.name}
                      </div>
                      {p.description ? (
                        <div className="text-xs text-muted-foreground">
                          {p.description}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>

        {showReviewAgentTypePicker ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                disabled={disabled || isLaunching}
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
                  onClick={() => {
                    void updateReviewAgentType(agentType);
                  }}
                  data-testid={`launch-reviewer-type-${agentType}`}
                >
                  <span className="flex items-center gap-3">
                    <Check
                      className={`h-3.5 w-3.5 shrink-0 ${agentType === reviewAgentType ? "opacity-100" : "opacity-0"}`}
                    />
                    <span>{AGENT_TYPE_LABELS[agentType]}</span>
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>

      <div className="flex items-start gap-2 pl-1">
        <Checkbox
          id={`persona-recheck-${agent.id}`}
          checked={allowRecheck}
          disabled={disabled || isLaunching}
          onCheckedChange={(checked) => setAllowRecheck(checked === true)}
          data-testid="launch-reviewer-allow-recheck"
        />
        <label
          htmlFor={`persona-recheck-${agent.id}`}
          className="flex items-center gap-1.5 text-xs text-muted-foreground"
        >
          <span>Re-review after I address feedback</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="text-muted-foreground/70 transition-colors hover:text-foreground"
                aria-label="About re-review"
              >
                <CircleAlert className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-64 text-xs">
              Reviewer will stay alive after its initial verdict and verify your
              resolution (~several extra minutes).
            </TooltipContent>
          </Tooltip>
        </label>
      </div>
    </div>
  );
}
