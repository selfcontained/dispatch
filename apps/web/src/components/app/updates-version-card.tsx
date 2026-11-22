import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { Markdown } from "@/components/ui/markdown";
import { Button } from "@/components/ui/button";
import type { ReleaseStatus } from "@/hooks/use-release-stream";
import { formatShortDateTime } from "@/lib/format";
import type { AppVersionInfo } from "./release-utils";
import { LoadingSkeleton } from "@/components/ui/skeleton";

type UpdatesVersionCardProps = {
  status: ReleaseStatus | null;
  versionInfo: AppVersionInfo | null;
  notesExpanded: boolean;
  onToggleNotes: () => void;
};

/**
 * Current version summary plus the collapsible release notes beneath it.
 * Both regions read from the same `versionInfo` payload, so they travel
 * together as sibling blocks of the settings column.
 */
export function UpdatesVersionCard({
  status,
  versionInfo,
  notesExpanded,
  onToggleNotes,
}: UpdatesVersionCardProps): JSX.Element {
  const version = versionInfo?.version ?? null;
  const headline = status?.tag ?? versionInfo?.releaseTag ?? version;
  // The package version only adds anything when the headline isn't already
  // it (a recorded deploy that disagrees with the build).
  const packageVersion =
    version && version !== headline && `v${version}` !== headline
      ? version
      : null;
  const details = [
    packageVersion ? `package ${packageVersion}` : null,
    versionInfo?.gitSha ?? null,
    status?.deployedAt ? formatShortDateTime(status.deployedAt) : null,
  ].filter(Boolean);

  return (
    <>
      <div>
        <div className="mb-1.5 section-label">Current version</div>
        {status || versionInfo ? (
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span
              data-testid="current-version"
              className="font-mono text-heading-lg text-foreground"
            >
              {headline ?? "unknown"}
            </span>
            {details.length > 0 ? (
              <span className="font-mono text-body-sm text-muted-foreground">
                {details.join(" · ")}
              </span>
            ) : null}
          </div>
        ) : (
          <LoadingSkeleton
            label="Loading the current version…"
            rows={1}
            rowClassName="h-7 w-40"
          />
        )}
      </div>

      {versionInfo?.releaseNotes && (
        <div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="xs"
              aria-expanded={notesExpanded}
              onClick={onToggleNotes}
              className="-ml-2 text-label-xs uppercase tracking-wider"
            >
              {notesExpanded ? <ChevronDown /> : <ChevronRight />}
              Release notes
            </Button>
            {versionInfo.releaseUrl ? (
              <a
                className="inline-flex items-center gap-1 text-body-sm text-info hover:underline"
                href={versionInfo.releaseUrl}
                rel="noopener noreferrer"
                target="_blank"
              >
                <ExternalLink className="h-3 w-3" />
                GitHub
              </a>
            ) : null}
          </div>
          {notesExpanded && (
            <div className="mt-2 rounded-lg border border-edge bg-fill-inset p-3">
              <div className="max-h-56 overflow-y-auto text-body-md text-muted-foreground">
                <Markdown>{versionInfo.releaseNotes}</Markdown>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
