import { useCallback, useState } from "react";
import { Loader2, Pause } from "lucide-react";

import { type Agent } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

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
  onStop
}: StopAgentDialogProps): JSX.Element {
  const [stopping, setStopping] = useState(false);

  const close = useCallback(() => {
    setOpen(false);
    setStopTarget(null);
  }, [setOpen, setStopTarget]);

  const handleConfirmStop = useCallback(async () => {
    if (!stopTarget) return;

    setStopping(true);
    try {
      await onStop(stopTarget);
      setOpen(false);
      setStopTarget(null);
    } finally {
      setStopping(false);
    }
  }, [stopTarget, onStop, setOpen, setStopTarget]);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) close(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pause Agent</DialogTitle>
          <DialogDescription>
            {stopTarget
              ? `Pause "${stopTarget.name}"? The session will be paused. Resume it later to continue where you left off.`
              : "Pause this agent?"}
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" data-testid="stop-agent-cancel" onClick={close} disabled={stopping}>
            Cancel
          </Button>
          <Button
            variant="default"
            data-testid="stop-agent-confirm"
            disabled={stopping}
            onClick={() => void handleConfirmStop()}
          >
            {stopping ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Pause className="mr-1.5 h-4 w-4" />}
            Pause
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
