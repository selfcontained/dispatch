import { useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
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
      className={`relative flex shrink-0 items-center justify-center rounded text-xs font-semibold text-foreground ${className}`}
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
      <div
        role="group"
        aria-label="Launch location type"
        className="relative flex w-full rounded-lg border border-white/[0.08] bg-black/20 p-1 shadow-[inset_0_1px_3px_rgba(0,0,0,0.25)]"
      >
        <span
          aria-hidden="true"
          data-testid="location-toggle-thumb"
          className="pointer-events-none absolute inset-y-1 left-1 w-[calc((100%-8px)/2)] rounded-md border border-white/[0.12] bg-white/[0.06] shadow-[0_1px_4px_rgba(0,0,0,0.3),inset_0_1px_0_rgba(255,255,255,0.06)] transition-transform duration-200 ease-out motion-reduce:transition-none"
          style={{
            transform: projectId ? "translateX(0)" : "translateX(100%)",
          }}
        />
        <Button
          type="button"
          variant="ghost"
          className={`relative z-10 h-9 flex-1 rounded px-3 text-sm hover:bg-transparent ${projectId ? "text-foreground" : "text-muted-foreground"}`}
          aria-pressed={!!projectId}
          disabled={!projects.length}
          title={
            !projects.length
              ? "Create a project from the sidebar to use this option"
              : undefined
          }
          onClick={() =>
            select(
              projects.find((p) => p.id === lastProjectId.current) ??
                projects[0] ??
                null
            )
          }
        >
          Project
        </Button>
        <Button
          type="button"
          variant="ghost"
          className={`relative z-10 h-9 flex-1 rounded px-3 text-sm hover:bg-transparent ${!projectId ? "text-foreground" : "text-muted-foreground"}`}
          aria-pressed={!projectId}
          onClick={() => select(null)}
        >
          Folder
        </Button>
      </div>
      {projectId && (
        <div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="default"
                className="h-[38px] w-full justify-between px-3"
                aria-label="Choose project"
              >
                <span className="flex min-w-0 items-center gap-2">
                  {project && <ProjectIcon project={project} />}
                  <span className="truncate">
                    {project?.name ??
                      (isLoading ? "Loading projects…" : "Choose a project")}
                  </span>
                </span>
                <ChevronDown className="h-4 w-4 shrink-0" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="max-h-72 w-[var(--radix-dropdown-menu-trigger-width)] min-w-0 overflow-y-auto"
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
                      className="block truncate text-xs text-muted-foreground"
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
                <div className="px-2 py-2 text-sm text-muted-foreground">
                  No projects yet
                </div>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="flex h-5 items-center justify-end text-xs text-muted-foreground">
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
