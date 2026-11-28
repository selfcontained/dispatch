import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import type { Project } from "./use-projects";

/** Use the server's repository identity and unique constraint, including races. */
export function useRepositoryProject() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      repository: string;
      name: string;
      color: string;
      iconOverride?: string | null;
    }) => {
      const repository = input.repository;
      const find = async () =>
        (
          await api<Project[]>(
            `/api/v1/projects?${new URLSearchParams({ repository })}`
          )
        )[0];
      const existing = await find();
      if (existing) return existing;
      try {
        return await api<Project>("/api/v1/projects", {
          method: "POST",
          body: JSON.stringify({ ...input, repository }),
        });
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          const existing = await find();
          if (existing) return existing;
        }
        throw error;
      }
    },
    onSuccess: async () => {
      await Promise.all(
        ["projects", "launch-targets"].map((key) =>
          client.invalidateQueries({ queryKey: [key] })
        )
      );
    },
  });
}
