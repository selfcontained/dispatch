import { type ReactNode } from "react";
import { Archive, Pause, Pencil, Play } from "lucide-react";

import { PersonaLauncher } from "@/components/app/persona-launcher";
import { type Agent } from "@/components/app/types";
import { type AgentType } from "@/lib/agent-types";
import { IconButton } from "@/components/ui/icon-button";

export type AgentCardActionsProps = {
  agent: Agent;
  pinControl?: ReactNode;
  isStopped: boolean;
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
  pinControl,
  isStopped,
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
          <PersonaLauncher
            agent={agent}
            enabledAgentTypes={enabledAgentTypes}
            disabled={isStopped || agent.status === "archiving"}
            disabledReason={
              isStopped
                ? "Agent is stopped — start it before launching a persona."
                : agent.status === "archiving"
                  ? "Agent is archiving."
                  : undefined
            }
          />
          {/* Keep review visible for every parent agent; lifecycle controls stay on the right. */}
        </div>
        <div className="flex min-h-9 shrink-0 items-center gap-2 px-0.5">
          {pinControl}
          {isStopped && agent.status !== "archiving" ? (
            <IconButton
              tone="success"
              className="rounded-full border border-info/line bg-info/tint"
              label="Resume"
              onClick={() => {
                if (closeOnSessionAction) onRequestClose?.();
                void startAgent(agent);
              }}
            >
              <Play />
            </IconButton>
          ) : !isStopped && agent.status !== "archiving" ? (
            <IconButton
              tone="warning"
              className="rounded-full border border-warning/line bg-warning/tint"
              label="Pause"
              onClick={() => {
                setStopTarget(agent);
                setStopConfirmOpen(true);
              }}
            >
              <Pause />
            </IconButton>
          ) : null}
          <IconButton
            className="rounded-full border border-info/line bg-info/tint text-info hover:bg-info/tint-strong hover:text-info"
            data-testid={`agent-session-settings-${agent.id}`}
            label="Session details"
            onClick={onEditSettings}
          >
            <Pencil />
          </IconButton>
          <IconButton
            tone="danger"
            className="rounded-full border border-danger/line bg-danger/tint"
            data-testid={`agent-archive-${agent.id}`}
            label="Archive"
            disabled={
              agent.status === "archiving" || agent.status === "creating"
            }
            onClick={() => {
              setDeleteTarget(agent);
              setDeleteConfirmOpen(true);
            }}
          >
            <Archive />
          </IconButton>
        </div>
      </div>
    </div>
  );
}
