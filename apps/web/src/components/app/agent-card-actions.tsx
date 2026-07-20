import { Archive, Pause, Pencil, Play } from "lucide-react";

import { PersonaLauncher } from "@/components/app/persona-launcher";
import { type Agent } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import { type AgentType } from "@/lib/agent-types";

export type AgentCardActionsProps = {
  agent: Agent;
  isStopped: boolean;
  isTerminalAgent: boolean;
  enabledAgentTypes: AgentType[];
  closeOnSessionAction: boolean;
  onRequestClose?: () => void;
  startAgent: (agent: Agent) => Promise<void>;
  onEditSettings: () => void;
  setStopTarget: (agent: Agent | null) => void;
  setStopConfirmOpen: (open: boolean) => void;
  setDeleteTarget: (agent: Agent | null) => void;
  setDeleteConfirmOpen: (open: boolean) => void;
};

/**
 * Footer of an expanded agent card: persona launcher on the left, session
 * lifecycle controls (resume/pause, settings, archive) on the right.
 */
export function AgentCardActions({
  agent,
  isStopped,
  isTerminalAgent,
  enabledAgentTypes,
  closeOnSessionAction,
  onRequestClose,
  startAgent,
  onEditSettings,
  setStopTarget,
  setStopConfirmOpen,
  setDeleteTarget,
  setDeleteConfirmOpen,
}: AgentCardActionsProps): JSX.Element {
  return (
    <div className="flex flex-col gap-3 px-0 pb-1">
      <div className="flex min-h-9 items-center justify-between gap-2 pt-2">
        <div className="min-h-9 min-w-0 flex items-center">
          {isTerminalAgent ? null : (
            <PersonaLauncher
              agent={agent}
              enabledAgentTypes={enabledAgentTypes}
              disabled={isStopped || agent.status === "archiving"}
              disabledReason={
                isStopped
                  ? "Agent is stopped — start it before launching a review."
                  : agent.status === "archiving"
                    ? "Agent is archiving."
                    : undefined
              }
            />
          )}
          {/* Keep review visible for every parent agent; lifecycle controls stay on the right. */}
        </div>
        <div className="flex h-9 shrink-0 items-center gap-[18px]">
          {isStopped && agent.status !== "archiving" ? (
            <Button
              size="sm"
              variant="ghost-primary"
              className="h-8 w-8 rounded-full border border-status-done/35 bg-status-done/10 p-0"
              aria-label="Resume"
              title="Resume"
              onClick={() => {
                if (closeOnSessionAction) onRequestClose?.();
                void startAgent(agent);
              }}
            >
              <Play className="h-3.5 w-3.5" />
            </Button>
          ) : !isStopped && agent.status !== "archiving" ? (
            <Button
              size="sm"
              variant="ghost-warning"
              className="h-8 w-8 rounded-full border border-status-waiting/35 bg-status-waiting/10 p-0"
              aria-label="Pause"
              title="Pause"
              onClick={() => {
                setStopTarget(agent);
                setStopConfirmOpen(true);
              }}
            >
              <Pause className="h-3.5 w-3.5" />
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            className="h-8 w-8 rounded-full border border-blue-500/35 bg-blue-500/10 p-0 text-blue-400 hover:bg-blue-500/15 hover:text-blue-300"
            data-testid={`agent-session-settings-${agent.id}`}
            aria-label="Edit session settings"
            title="Edit session settings"
            onClick={onEditSettings}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            variant="ghost-destructive"
            className="h-8 w-8 rounded-full border border-status-blocked/35 bg-status-blocked/10 p-0"
            data-testid={`agent-archive-${agent.id}`}
            aria-label="Archive"
            title="Archive"
            disabled={
              agent.status === "archiving" || agent.status === "creating"
            }
            onClick={() => {
              setDeleteTarget(agent);
              setDeleteConfirmOpen(true);
            }}
          >
            <Archive className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
