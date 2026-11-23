import { Field } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Project } from "@/hooks/use-projects";
import { ProjectIcon } from "./project-location";

export function RunnerProjectPicker({
  projects,
  projectId,
  loading,
  error,
  onProject,
}: {
  projects: Project[];
  projectId: string | null;
  loading: boolean;
  error: boolean;
  onProject: (id: string) => void;
}) {
  return (
    <Field
      label="Project"
      required
      error={error ? "Couldn’t load projects." : undefined}
    >
      <Select
        required
        value={projectId ?? ""}
        disabled={!projects.length}
        onValueChange={(id) => {
          if (id) onProject(id);
        }}
      >
        <SelectTrigger
          className="[&>span]:min-w-0"
          data-testid="create-agent-runner-project"
        >
          <SelectValue
            placeholder={
              loading
                ? "Loading projects…"
                : projects.length || error
                  ? "Choose a project"
                  : "No projects with repositories"
            }
          />
        </SelectTrigger>
        <SelectContent className="max-h-[clamp(4rem,var(--radix-select-content-available-height),18rem)] w-[var(--radix-select-trigger-width)]">
          {projects.map((project) => (
            <SelectItem
              key={project.id}
              value={project.id}
              textValue={project.name}
              className="min-w-0 [&>span:last-child]:min-w-0"
            >
              <span className="flex min-w-0 items-center gap-2">
                <ProjectIcon project={project} className="h-5 w-5" />
                <span className="truncate">{project.name}</span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}
