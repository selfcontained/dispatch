import { type Agent } from "@/components/app/types";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

type StopAgentDialogProps = {
  open: boolean;
  stopTarget: Agent | null;
  setOpen: (open: boolean) => void;
  setStopTarget: (agent: Agent | null) => void;
  onStop: (agent: Agent) => Promise<void>;
};

export function StopAgentDialog({
  open,
  stopTarget,
  setOpen,
  setStopTarget,
  onStop,
}: StopAgentDialogProps): JSX.Element {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setStopTarget(null);
      }}
      // Pausing loses nothing: Resume picks up where it left off.
      tone="primary"
      title={stopTarget ? `Pause “${stopTarget.name}”?` : "Pause this agent?"}
      description="The session will be paused. Resume it later to continue where you left off."
      confirmLabel="Pause agent"
      errorTitle="Couldn’t pause the agent."
      confirmTestId="stop-agent-confirm"
      cancelTestId="stop-agent-cancel"
      onConfirm={async () => {
        if (stopTarget) await onStop(stopTarget);
      }}
    />
  );
}
