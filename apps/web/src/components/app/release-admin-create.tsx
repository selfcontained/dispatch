import { ShieldCheck, Sparkles, Zap } from "lucide-react";
import { bumpVersion } from "@/components/app/release-utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type {
  ReleaseInfo,
  ReleaseVersionType,
} from "@/hooks/use-release-stream";
import { cn } from "@/lib/utils";

const VERSION_CONFIG: Record<
  ReleaseVersionType,
  { icon: typeof ShieldCheck; color: string }
> = {
  patch: { icon: ShieldCheck, color: "text-status-working" },
  minor: { icon: Sparkles, color: "text-status-done" },
  major: { icon: Zap, color: "text-violet-400" },
};

type CreateReleaseSectionProps = {
  info: ReleaseInfo | null;
  bumpBase: string | null;
  releaseError: string | null;
  releaseInFlight: boolean;
  confirmType: ReleaseVersionType | null;
  onConfirmTypeChange: (type: ReleaseVersionType | null) => void;
  onRelease: (versionType: ReleaseVersionType) => void;
};

/**
 * The "Create release" section — one button per version bump plus the
 * confirmation dialog. Hidden entirely when there is nothing to release.
 */
export function CreateReleaseSection({
  info,
  bumpBase,
  releaseError,
  releaseInFlight,
  confirmType,
  onConfirmTypeChange,
  onRelease,
}: CreateReleaseSectionProps): JSX.Element | null {
  if (
    !info ||
    !(
      info.refMissing ||
      Boolean(info.unreleasedFetchError) ||
      info.unreleasedCount > 0
    )
  ) {
    return null;
  }

  return (
    <div>
      <div className="mb-3 text-[10px] uppercase tracking-widest text-muted-foreground">
        Create release
      </div>

      {releaseError && (
        <div className="mb-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {releaseError}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {(["patch", "minor", "major"] as ReleaseVersionType[]).map((type) => {
          const { icon: Icon, color } = VERSION_CONFIG[type];
          const nextTag = bumpVersion(bumpBase, type);
          return (
            <Button
              key={type}
              onClick={() => onConfirmTypeChange(type)}
              disabled={releaseInFlight}
              className="gap-1.5"
            >
              <Icon className={cn("h-3.5 w-3.5", color)} />
              <span className="capitalize">{type}</span>
              {nextTag && (
                <span className="font-mono text-xs text-muted-foreground">
                  {nextTag}
                </span>
              )}
            </Button>
          );
        })}
      </div>

      <Dialog
        open={confirmType !== null}
        onOpenChange={(open) => {
          if (!open) onConfirmTypeChange(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              Create {confirmType ?? ""} release
              {confirmType && bumpVersion(bumpBase, confirmType) && (
                <>
                  {" "}
                  <span className="font-mono">
                    {bumpVersion(bumpBase, confirmType)}
                  </span>
                </>
              )}
            </DialogTitle>
            <DialogDescription>
              This triggers the release workflow against{" "}
              <span className="font-mono">main</span> on GitHub.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onConfirmTypeChange(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                if (confirmType) onRelease(confirmType);
              }}
            >
              Release
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
