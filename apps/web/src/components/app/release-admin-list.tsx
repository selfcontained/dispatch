import { CheckCircle2, ExternalLink } from "lucide-react";
import type { GitHubRelease } from "@/components/app/release-utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatShortDateTime } from "@/lib/format";
import { Alert } from "@/components/ui/alert";
import { LoadError } from "@/components/ui/async-boundary";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { LoadingSkeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";

type RecentReleasesProps = {
  releases: GitHubRelease[];
  releasesLoading: boolean;
  releasesError: unknown;
  onRetry: () => void;
  promoteError: string | null;
  promotingTag: string | null;
  promotionUrl: string | null;
  confirmPromoteTag: string | null;
  onConfirmPromoteTagChange: (tag: string | null) => void;
  /** Rejects when the promotion didn't start. */
  onPromote: (tag: string) => Promise<void>;
};

/**
 * The "Recent releases" list, with the inline promote-to-stable confirm
 * flow for prereleases.
 */
export function RecentReleases({
  releases,
  releasesLoading,
  releasesError,
  onRetry,
  promoteError,
  promotingTag,
  promotionUrl,
  confirmPromoteTag,
  onConfirmPromoteTagChange,
  onPromote,
}: RecentReleasesProps): JSX.Element {
  return (
    <div>
      <div className="mb-3 section-label">Recent releases</div>

      {promoteError && (
        <Alert
          title="Couldn’t confirm the promotion."
          error={promoteError}
          className="mb-3"
        />
      )}

      {releasesError ? (
        <LoadError
          thing="releases"
          error={releasesError}
          retrying={releasesLoading}
          onRetry={onRetry}
          className="mb-3"
        />
      ) : releasesLoading && releases.length === 0 ? (
        <LoadingSkeleton label="Loading releases…" rowClassName="h-12" />
      ) : null}

      {releases.length > 0 && (
        <div className="flex flex-col gap-1">
          {releases.map((r) => (
            <div
              key={r.tag}
              className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-edge bg-fill-inset px-3 py-3"
            >
              <span className="font-mono text-body-md font-semibold text-foreground">
                {r.tag}
              </span>
              <Badge tone={r.isPrerelease ? "warning" : "success"}>
                {r.isPrerelease ? "Pre-release" : "Stable"}
              </Badge>
              <span className="text-body-sm text-muted-foreground">
                {formatShortDateTime(r.publishedAt)}
              </span>
              <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2">
                {r.isPrerelease && promotingTag === r.tag && (
                  <span className="flex items-center gap-1.5 text-body-sm text-muted-foreground">
                    <Spinner />
                    Promoting…
                    {promotionUrl && (
                      <a
                        href={promotionUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-info hover:underline"
                      >
                        workflow
                      </a>
                    )}
                  </span>
                )}
                {r.isPrerelease && promotingTag !== r.tag && (
                  <Button
                    size="sm"
                    variant="ghost"
                    tone="success"
                    onClick={() => onConfirmPromoteTagChange(r.tag)}
                    disabled={promotingTag !== null}
                  >
                    Promote
                  </Button>
                )}
                {!r.isPrerelease && (
                  <CheckCircle2 className="h-3.5 w-3.5 text-success/veil" />
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

      {!releasesLoading && !releasesError && releases.length === 0 && (
        <p className="text-body-sm text-muted-foreground">No releases found.</p>
      )}

      <ConfirmDialog
        open={confirmPromoteTag !== null}
        onOpenChange={(open) => {
          if (!open) onConfirmPromoteTagChange(null);
        }}
        tone="primary"
        title={`Promote ${confirmPromoteTag ?? "release"}?`}
        description="It’s marked stable and becomes the latest release for everyone on the stable channel."
        confirmLabel="Promote release"
        errorTitle="Couldn’t promote the release."
        onConfirm={async () => {
          if (confirmPromoteTag) await onPromote(confirmPromoteTag);
        }}
      />
    </div>
  );
}
