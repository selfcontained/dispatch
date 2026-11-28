import type { Project } from "@/hooks/use-projects";
import { useRepositoryProject } from "@/hooks/use-repository-project";
import { Alert } from "@/components/ui/alert";
import { RunnerRepositoryPicker } from "./runner-repository-picker";
import { PROJECT_COLORS } from "./color-picker";

export function RunnerProjectPicker({
  searchUrl,
  projects,
  projectId,
  loading,
  error,
  onProject,
}: {
  searchUrl?: string;
  projects: Project[];
  projectId: string | null;
  loading: boolean;
  error: boolean;
  onProject: (id: string) => void;
}) {
  const create = useRepositoryProject();
  return (
    <>
      <RunnerRepositoryPicker
        key={searchUrl}
        searchUrl={searchUrl}
        projects={projects}
        projectId={projectId}
        loading={loading}
        error={error}
        pending={create.isPending}
        onProject={onProject}
        onRepository={(repository) => {
          create.mutate(
            {
              repository,
              name: new URL(repository).pathname
                .replace(/\/+$/, "")
                .split("/")
                .pop()!
                .replace(/\.git$/, "")
                .slice(0, 80),
              color: PROJECT_COLORS[0]!,
            },
            { onSuccess: (project) => onProject(project.id) }
          );
        }}
      />
      {create.error && (
        <Alert title="Couldn’t create the project." error={create.error} />
      )}
    </>
  );
}
