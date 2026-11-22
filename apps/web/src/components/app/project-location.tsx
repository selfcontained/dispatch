import { useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/segmented-control";
import { useProjects, type Project } from "@/hooks/use-projects";
export function ProjectIcon({
  project,
  className = "h-6 w-6",
  fallback,
}: {
  project: Project;
  className?: string;
  fallback?: ReactNode;
}) {
  const [loaded, setLoaded] = useState<string | null>(null);
  const src = `/api/v1/projects/${project.id}/icon?v=${encodeURIComponent(project.updatedAt)}`;
  return (
    <span
      className={`relative flex shrink-0 items-center justify-center rounded-sm text-body-sm font-semibold text-foreground ${className}`}
    >
      <span aria-hidden className={loaded === src ? "invisible" : ""}>
        {fallback ?? project.name.slice(0, 1).toUpperCase()}
      </span>
      <img
        alt=""
        className={`absolute inset-0 h-full w-full object-contain ${loaded === src ? "opacity-100" : "opacity-0"}`}
        src={src}
        onLoad={() => setLoaded(src)}
        onError={() => setLoaded(null)}
      />
    </span>
  );
}

/** Full-width location toggle; keep the folder picker mounted to retain validation. */
export function ProjectLocation({
  projectId,
  rememberedProjectId,
  onChange,
  children,
}: {
  projectId: string | null | undefined;
  rememberedProjectId?: string | null;
  onChange: (project: Project | null) => void;
  children: ReactNode;
}) {
  const { data: projects = [], isLoading, isError, refetch } = useProjects();
  const lastProjectId = useRef(rememberedProjectId ?? projectId);
  const project = projects.find((p) => p.id === projectId);
  const select = (p: Project | null) => {
    if (p) lastProjectId.current = p.id;
    else if (projectId) lastProjectId.current = projectId;
    onChange(p);
  };
  return (
    <div className="space-y-1" data-testid="project-location">
      <SegmentedControl
        layout="fill"
        aria-label="Launch location type"
        value={projectId ? "project" : "folder"}
        onValueChange={(next) =>
          select(
            next === "folder"
              ? null
              : (projects.find((p) => p.id === lastProjectId.current) ??
                  projects[0] ??
                  null)
          )
        }
      >
        <SegmentedControlItem
          value="project"
          disabled={!projects.length}
          className="disabled:pointer-events-auto"
          hint={
            !projects.length
              ? "Create a project from the sidebar to use this option"
              : undefined
          }
        >
          Project
        </SegmentedControlItem>
        <SegmentedControlItem value="folder">Folder</SegmentedControlItem>
      </SegmentedControl>
      {projectId && (
        <div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="field"
                className="w-full"
                aria-label="Choose project"
              >
                <span className="flex min-w-0 items-center gap-2">
                  {project && <ProjectIcon project={project} />}
                  <span className="truncate">
                    {project?.name ??
                      (isLoading ? "Loading projects…" : "Choose a project")}
                  </span>
                </span>
                <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="max-h-[clamp(4rem,var(--radix-dropdown-menu-content-available-height),18rem)] w-[var(--radix-dropdown-menu-trigger-width)] min-w-0 overflow-y-auto"
            >
              {projects.map((p) => (
                <DropdownMenuItem
                  key={p.id}
                  className="flex min-w-0 items-center gap-3 py-2 text-foreground"
                  onSelect={() => select(p)}
                >
                  <ProjectIcon project={p} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{p.name}</span>
                    <span
                      className="block truncate text-body-sm text-muted-foreground"
                      title={p.repoRoot}
                    >
                      {p.repoRoot}
                    </span>
                  </span>
                  <span className="flex w-4 shrink-0 justify-center">
                    {p.id === projectId && <Check className="h-4 w-4" />}
                  </span>
                </DropdownMenuItem>
              ))}
              {isError && (
                <DropdownMenuItem
                  className="text-foreground"
                  onSelect={() => void refetch()}
                >
                  Couldn't load projects. Retry
                </DropdownMenuItem>
              )}
              {!isLoading && !isError && !projects.length && (
                <div className="px-2 py-2 text-body-md text-muted-foreground">
                  No projects yet
                </div>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="flex h-5 items-center justify-end text-body-sm text-muted-foreground">
            <span className="truncate" title={project?.repoRoot}>
              {project?.repoRoot}
            </span>
          </div>
        </div>
      )}
      <div hidden={!!projectId}>{children}</div>
    </div>
  );
}
