import { ShieldCheck, Sparkles, Zap } from "lucide-react";
import { bumpVersion } from "@/components/app/release-utils";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type {
  ReleaseInfo,
  ReleaseVersionType,
} from "@/hooks/use-release-stream";
import { cn } from "@/lib/utils";

const VERSION_CONFIG: Record<
  ReleaseVersionType,
  { icon: typeof ShieldCheck; color: string }
> = {
  patch: { icon: ShieldCheck, color: "text-success" },
  minor: { icon: Sparkles, color: "text-info" },
  major: { icon: Zap, color: "text-status-merged" },
};

type CreateReleaseSectionProps = {
  info: ReleaseInfo | null;
  bumpBase: string | null;
  releaseInFlight: boolean;
  confirmType: ReleaseVersionType | null;
  onConfirmTypeChange: (type: ReleaseVersionType | null) => void;
  /** Rejects when the release didn't start. */
  onRelease: (versionType: ReleaseVersionType) => Promise<void>;
};

/**
 * The "Create release" section — one button per version bump plus the
 * confirmation dialog. Hidden entirely when there is nothing to release.
 */
export function CreateReleaseSection({
  info,
  bumpBase,
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
      <div className="mb-3 section-label">Create release</div>

      <div className="flex flex-wrap gap-2">
        {(["patch", "minor", "major"] as ReleaseVersionType[]).map((type) => {
          const { icon: Icon, color } = VERSION_CONFIG[type];
          const nextTag = bumpVersion(bumpBase, type);
          return (
            <Button
              key={type}
              onClick={() => onConfirmTypeChange(type)}
              disabled={releaseInFlight}
            >
              <Icon className={cn("h-3.5 w-3.5", color)} />
              <span className="capitalize">{type}</span>
              {nextTag && (
                <span className="font-mono text-body-sm text-muted-foreground">
                  {nextTag}
                </span>
              )}
            </Button>
          );
        })}
      </div>

      <ConfirmDialog
        open={confirmType !== null}
        onOpenChange={(open) => {
          if (!open) onConfirmTypeChange(null);
        }}
        tone="primary"
        title={
          <>
            Create {confirmType ?? ""} release
            {confirmType && bumpVersion(bumpBase, confirmType) && (
              <>
                {" "}
                <span className="font-mono">
                  {bumpVersion(bumpBase, confirmType)}
                </span>
              </>
            )}
            ?
          </>
        }
        description={
          <>
            This triggers the release workflow against{" "}
            <span className="font-mono">main</span> on GitHub.
          </>
        }
        confirmLabel="Create release"
        errorTitle="Couldn’t start the release."
        onConfirm={async () => {
          if (confirmType) await onRelease(confirmType);
        }}
      />
    </div>
  );
}
