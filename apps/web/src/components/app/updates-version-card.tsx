import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { Markdown } from "@/components/ui/markdown";
import type { ReleaseStatus } from "@/hooks/use-release-stream";
import { formatShortDateTime } from "@/lib/format";
import type { AppVersionInfo } from "./release-utils";

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
  return (
    <>
      <div>
        <div className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
          Current version
        </div>
        {status ? (
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-xl font-bold text-foreground">
              {status.tag ?? "unknown"}
            </span>
            {status.deployedAt ? (
              <span className="text-xs text-muted-foreground">
                {formatShortDateTime(status.deployedAt)}
              </span>
            ) : null}
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">Loading...</span>
        )}

        {versionInfo && (
          <div className="mt-3 grid gap-2 rounded-lg border border-white/[0.12] bg-white/[0.04] p-3 text-sm">
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">Release tag</span>
              <span className="font-mono">
                {versionInfo.releaseTag ?? "unreleased"}
              </span>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">Package version</span>
              <span className="font-mono">
                {versionInfo.version ?? "unknown"}
              </span>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">Git SHA</span>
              <span className="font-mono">
                {versionInfo.gitSha ?? "unavailable"}
              </span>
            </div>
          </div>
        )}
      </div>

      {versionInfo?.releaseNotes && (
        <div>
          <button
            onClick={onToggleNotes}
            className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors"
          >
            {notesExpanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            Release notes
            {versionInfo.releaseUrl ? (
              <a
                className="ml-2 inline-flex items-center gap-1 text-xs normal-case tracking-normal text-blue-400 hover:underline"
                href={versionInfo.releaseUrl}
                rel="noopener noreferrer"
                target="_blank"
                onClick={(e) => e.stopPropagation()}
              >
                <ExternalLink className="h-3 w-3" />
                GitHub
              </a>
            ) : null}
          </button>
          {notesExpanded && (
            <div className="mt-2 rounded-lg border border-white/[0.12] bg-white/[0.04] p-3">
              <div className="max-h-56 overflow-y-auto text-sm text-muted-foreground">
                <Markdown>{versionInfo.releaseNotes}</Markdown>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
