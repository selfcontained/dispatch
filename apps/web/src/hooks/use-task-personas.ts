import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export type TaskPersona = { slug: string; name: string; description: string };

export function useTaskPersonas(cwd: string, projectId?: string | null) {
  const directory = cwd.trim();
  const [settledDirectory, setSettledDirectory] = useState(directory);
  useEffect(() => {
    const timer = setTimeout(() => setSettledDirectory(directory), 300);
    return () => clearTimeout(timer);
  }, [directory]);
  // Keep the query keyed to the current input so previous-directory data
  // cannot appear while waiting for typing to settle.
  const settling = directory !== settledDirectory;
  const query = useQuery({
    queryKey: ["personas", directory, "task", projectId ?? null],
    queryFn: () =>
      api<{
        personas: TaskPersona[];
        warnings?: string[];
        refreshing?: boolean;
      }>(
        `/api/v1/personas?${new URLSearchParams({ cwd: directory, type: "task", ...(projectId ? { projectId } : {}) })}`
      ),
    enabled: Boolean(directory) && !settling,
    refetchInterval: (query) => (query.state.data?.refreshing ? 2000 : false),
  });
  return { ...query, isLoading: query.isLoading || settling };
}
