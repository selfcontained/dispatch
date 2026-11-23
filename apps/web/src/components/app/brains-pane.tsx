import { useNavigate, useParams } from "react-router-dom";
import { Activity, Database, List, Radio } from "lucide-react";

import { useBrainProjects } from "@/hooks/use-brain";
import { repoBasename } from "@/components/app/brains-utils";
import { encodeRepoRoot } from "@/lib/brain-encoding";
import { shortPath } from "@/lib/format";
import { cn } from "@/lib/utils";
import { RowButton } from "@/components/ui/row-button";
import { AsyncBoundary } from "@/components/ui/async-boundary";
import { EmptyState } from "@/components/ui/empty-state";

export function BrainsListContent({
  onItemSelect,
}: {
  onItemSelect?: () => void;
}): JSX.Element {
  const navigate = useNavigate();
  const { encodedRepoRoot } = useParams<{ encodedRepoRoot?: string }>();
  const query = useBrainProjects();
  const showOverview = !encodedRepoRoot;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <AsyncBoundary
          query={query}
          thing="brain projects"
          className="m-3"
          isEmpty={(projects) => projects.length === 0}
          empty={
            <EmptyState
              title="No brain data yet."
              description="Brain data will appear here when agents write shared memory."
            />
          }
        >
          {(projects) => (
            <div>
              <RowButton
                className={cn(
                  "rounded-none border-b border-r-4 border-border border-r-transparent px-3 py-3 text-body-md text-muted-foreground",
                  showOverview && "border-r-primary bg-surface-hover"
                )}
                onClick={() => {
                  navigate("/automations/brains");
                  onItemSelect?.();
                }}
              >
                <Activity className="size-icon-md" />
                <span>Overview</span>
              </RowButton>
              {projects.map((project) => {
                const encoded = encodeRepoRoot(project.repoRoot);
                const selected = encodedRepoRoot === encoded;
                return (
                  <div
                    key={project.repoRoot}
                    role="button"
                    tabIndex={0}
                    className={cn(
                      "w-full cursor-pointer border-b border-r-4 border-border border-r-transparent px-3 py-2 text-left transition-colors hover:bg-surface-hover",
                      selected && "border-r-primary bg-surface-hover"
                    )}
                    onClick={() => {
                      navigate(`/automations/brains/${encoded}`);
                      onItemSelect?.();
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        navigate(`/automations/brains/${encoded}`);
                        onItemSelect?.();
                      }
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-body-md font-semibold leading-5">
                          {repoBasename(project.repoRoot)}
                        </div>
                        <div
                          className="truncate font-mono text-label-sm text-muted-foreground"
                          title={project.repoRoot}
                        >
                          {shortPath(project.repoRoot)}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 text-label-xs text-muted-foreground shrink-0">
                        {project.objectCount > 0 ? (
                          <span className="flex items-center gap-0.5">
                            <Database className="h-2.5 w-2.5" />
                            {project.objectCount}
                          </span>
                        ) : null}
                        {project.listCount > 0 ? (
                          <span className="flex items-center gap-0.5">
                            <List className="h-2.5 w-2.5" />
                            {project.listCount}
                          </span>
                        ) : null}
                        {project.eventCount > 0 ? (
                          <span className="flex items-center gap-0.5">
                            <Radio className="h-2.5 w-2.5" />
                            {project.eventCount}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </AsyncBoundary>
      </div>
    </div>
  );
}
