import { CheckCircle2, ExternalLink } from "lucide-react";
import type { GitHubRelease } from "@/components/app/release-utils";
import { ActivityBars } from "@/components/ui/activity-bars";
import { Button } from "@/components/ui/button";
import { formatShortDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

type RecentReleasesProps = {
  releases: GitHubRelease[];
  releasesLoading: boolean;
  promoteError: string | null;
  promotingTag: string | null;
  confirmPromoteTag: string | null;
  onConfirmPromoteTagChange: (tag: string | null) => void;
  onPromote: (tag: string) => void;
};

/**
 * The "Recent releases" list, with the inline promote-to-stable confirm
 * flow for prereleases.
 */
export function RecentReleases({
  releases,
  releasesLoading,
  promoteError,
  promotingTag,
  confirmPromoteTag,
  onConfirmPromoteTagChange,
  onPromote,
}: RecentReleasesProps): JSX.Element {
  return (
    <div>
      <div className="mb-3 text-[10px] uppercase tracking-widest text-muted-foreground">
        Recent releases
      </div>

      {promoteError && (
        <div className="mb-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {promoteError}
        </div>
      )}

      {releasesLoading && releases.length === 0 && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <ActivityBars size={14} />
          Loading...
        </div>
      )}

      {releases.length > 0 && (
        <div className="flex flex-col gap-1">
          {releases.map((r) => (
            <div
              key={r.tag}
              className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-white/[0.12] bg-white/[0.04] px-3 py-2.5"
            >
              <span className="font-mono text-sm font-semibold text-foreground">
                {r.tag}
              </span>
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                  r.isPrerelease
                    ? "bg-status-waiting/15 text-status-waiting"
                    : "bg-green-500/15 text-green-400"
                )}
              >
                {r.isPrerelease ? "pre-release" : "stable"}
              </span>
              <span className="text-xs text-muted-foreground">
                {formatShortDateTime(r.publishedAt)}
              </span>
              <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2">
                {r.isPrerelease && confirmPromoteTag !== r.tag && (
                  <Button
                    size="sm"
                    variant="ghost-primary"
                    onClick={() => onConfirmPromoteTagChange(r.tag)}
                    disabled={promotingTag === r.tag}
                  >
                    {promotingTag === r.tag ? (
                      <ActivityBars size={12} />
                    ) : (
                      "Promote"
                    )}
                  </Button>
                )}
                {r.isPrerelease && confirmPromoteTag === r.tag && (
                  <>
                    <span className="text-xs text-muted-foreground">
                      Mark stable + latest?
                    </span>
                    <Button
                      size="sm"
                      variant="ghost-primary"
                      onClick={() => onPromote(r.tag)}
                    >
                      Confirm
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onConfirmPromoteTagChange(null)}
                    >
                      Cancel
                    </Button>
                  </>
                )}
                {!r.isPrerelease && (
                  <CheckCircle2 className="h-3.5 w-3.5 text-green-500/50" />
                )}
                <a
                  href={r.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </div>
            </div>
          ))}
        </div>
      )}

      {!releasesLoading && releases.length === 0 && (
        <div className="text-sm text-muted-foreground">No releases found</div>
      )}
    </div>
  );
}
