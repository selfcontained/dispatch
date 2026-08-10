import { useNavigate, useParams } from "react-router-dom";
import { Activity, Database, List, Radio } from "lucide-react";

import { useBrainProjects } from "@/hooks/use-brain";
import { repoBasename } from "@/components/app/brains-utils";
import { encodeRepoRoot } from "@/lib/brain-encoding";
import { shortPath } from "@/lib/format";
import { cn } from "@/lib/utils";

export function BrainsListContent({
  onItemSelect,
}: {
  onItemSelect?: () => void;
}): JSX.Element {
  const navigate = useNavigate();
  const { encodedRepoRoot } = useParams<{ encodedRepoRoot?: string }>();
  const { data: projects = [], isLoading } = useBrainProjects();
  const showOverview = !encodedRepoRoot;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="space-y-3 p-4">
            {Array.from({ length: 3 }, (_, i) => (
              <div
                key={i}
                className="h-10 animate-pulse rounded-md bg-muted/40"
              />
            ))}
          </div>
        ) : projects.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">
            <div className="rounded-md border border-dashed border-border p-4">
              <div className="font-medium text-foreground">
                No brain data yet.
              </div>
              <div className="mt-1 text-xs">
                Brain data will appear here when agents write shared memory.
              </div>
            </div>
          </div>
        ) : (
          <div>
            <button
              className={cn(
                "flex w-full items-center gap-2 border-b border-r-4 border-border border-r-transparent px-3 py-2.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/40",
                showOverview && "border-r-primary bg-muted/60"
              )}
              onClick={() => {
                navigate("/automations/brains");
                onItemSelect?.();
              }}
            >
              <Activity className="h-3.5 w-3.5" />
              <span>Overview</span>
            </button>
            {projects.map((project) => {
              const encoded = encodeRepoRoot(project.repoRoot);
              const selected = encodedRepoRoot === encoded;
              return (
                <div
                  key={project.repoRoot}
                  role="button"
                  tabIndex={0}
                  className={cn(
                    "w-full cursor-pointer border-b border-r-4 border-border border-r-transparent px-3 py-2 text-left transition-colors hover:bg-muted/40",
                    selected && "border-r-primary bg-muted/60"
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
                      <div className="truncate text-sm font-semibold leading-5">
                        {repoBasename(project.repoRoot)}
                      </div>
                      <div
                        className="truncate font-mono text-[11px] text-muted-foreground"
                        title={project.repoRoot}
                      >
                        {shortPath(project.repoRoot)}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground shrink-0">
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
      </div>
    </div>
  );
}
