import { useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
          <Select
            value={project?.id ?? ""}
            disabled={!projects.length}
            onValueChange={(id) => {
              const next = projects.find((p) => p.id === id);
              if (next) select(next);
            }}
          >
            <SelectTrigger
              aria-label="Choose project"
              className="[&>span]:min-w-0"
            >
              <SelectValue placeholder="Choose a project">
                <span className="flex min-w-0 items-center gap-2">
                  {project && (
                    <ProjectIcon project={project} className="h-5 w-5" />
                  )}
                  <span className="truncate">
                    {project?.name ??
                      (isLoading ? "Loading projects…" : "Choose a project")}
                  </span>
                </span>
              </SelectValue>
            </SelectTrigger>
            <SelectContent className="max-h-[clamp(4rem,var(--radix-select-content-available-height),18rem)] w-[var(--radix-select-trigger-width)]">
              {projects.map((p) => (
                <SelectItem
                  key={p.id}
                  value={p.id}
                  textValue={p.name}
                  className="min-w-0 [&>span:last-child]:min-w-0 [&>span:last-child]:flex-1"
                >
                  <span className="flex min-w-0 items-center gap-3">
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
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {isError && (
            <FieldError className="mt-1.5">
              Couldn’t load projects.{" "}
              <Button
                type="button"
                variant="link"
                size="inline"
                onClick={() => void refetch()}
              >
                Retry
              </Button>
            </FieldError>
          )}
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
