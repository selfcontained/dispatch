import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import {
  useLocation,
  useNavigate,
  type NavigateOptions,
  type To,
} from "react-router-dom";
import { api } from "@/lib/api";
import type { ProjectRecord } from "../../../server/src/projects/store";
export type Project = ProjectRecord;
export function useProjects() {
  return useQuery<Project[]>({
    queryKey: ["projects"],
    queryFn: () => api("/api/v1/projects"),
  });
}
export function useProjectScope() {
  const { search } = useLocation();
  const { data: projects = [], isSuccess } = useProjects();
  const id = new URLSearchParams(search).get("project");
  return {
    projectId: isSuccess && !projects.some((p) => p.id === id) ? null : id,
    project: projects.find((p) => p.id === id),
    projects,
  };
}
/** Preserve the project scope across navigation within the dashboard. */
export function useProjectNavigate() {
  const navigate = useNavigate();
  const { search } = useLocation();
  const id = new URLSearchParams(search).get("project");
  return useCallback(
    (to: To, options?: NavigateOptions) => {
      if (!id) return navigate(to, options);
      if (
        typeof to === "string" &&
        (/^\/(settings|activity)(\/|$)/.test(to) ||
          to.startsWith("/automations/brains"))
      )
        return navigate(to, options);
      const url =
        typeof to === "string" ? new URL(to, window.location.origin) : null;
      const query = new URLSearchParams(
        url?.search ?? (typeof to === "string" ? "" : to.search) ?? ""
      );
      if (!query.has("project")) query.set("project", id);
      return navigate(
        typeof to === "string"
          ? `${url!.pathname}?${query}${url!.hash}`
          : { ...to, search: `?${query}` },
        options
      );
    },
    [navigate, id]
  );
}
export function useProjectActions() {
  const qc = useQueryClient();
  const invalidate = () =>
    Promise.all(
      ["projects", "agents", "templates", "jobs"].map((key) =>
        qc.invalidateQueries({ queryKey: [key] })
      )
    );
  return useMutation({
    mutationFn: ({
      id,
      remove,
      ...input
    }: {
      id?: string;
      remove?: boolean;
      name?: string;
      repoRoot?: string;
      color?: string;
      iconOverride?: string | null;
    }) =>
      api(`/api/v1/projects${id ? `/${id}` : ""}`, {
        method: remove ? "DELETE" : id ? "PATCH" : "POST",
        body: remove ? undefined : JSON.stringify(input),
      }),
    onSuccess: invalidate,
  });
}
