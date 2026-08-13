import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ReleaseInfo } from "@/hooks/use-release-stream";
import type { ReleaseInfoSnapshot } from "@/hooks/use-cached-release-info";
import { describeForceTriggers } from "./release-utils";

type UpdatesForceConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  displayInfo: ReleaseInfo | ReleaseInfoSnapshot | null;
  onConfirm: (tag: string) => void;
};

/**
 * Confirmation for bypassing an assisted-update gate and running the
 * standard updater anyway. Renders nothing unless an update is actually
 * on offer, matching the guard that used to sit inline in UpdatesSection.
 */
export function UpdatesForceConfirmDialog({
  open,
  onOpenChange,
  displayInfo,
  onConfirm,
}: UpdatesForceConfirmDialogProps): JSX.Element | null {
  if (!displayInfo?.updateAvailable || !displayInfo.latestTag) return null;
  const latestTag = displayInfo.latestTag;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Skip the agent-assisted update?</DialogTitle>
        </DialogHeader>

        <div className="flex items-start gap-2 rounded border border-amber-500/30 bg-amber-500/[0.08] px-3 py-2 text-sm text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
          <span>
            <span className="font-mono text-amber-100">{latestTag}</span>{" "}
            {describeForceTriggers(displayInfo)}. This may leave your install in
            a non-working state.
          </span>
        </div>

        <div className="mt-1 flex flex-wrap gap-2">
          <Button
            variant="primary"
            onClick={() => {
              onOpenChange(false);
              onConfirm(latestTag);
            }}
            data-testid="force-standard-update-confirm"
          >
            Run standard update anyway
          </Button>
          <Button variant="default" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
