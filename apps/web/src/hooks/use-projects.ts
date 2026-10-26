import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import {
  useLocation,
  useNavigate,
  matchPath,
  type NavigateOptions,
  type Location,
  type To,
} from "react-router-dom";
import { api } from "@/lib/api";
import { selectedProjectIdAtom } from "@/lib/store";
import type { ProjectRecord } from "../../../server/src/projects/store";
export type Project = ProjectRecord;
export function useProjects() {
  return useQuery<Project[]>({
    queryKey: ["projects"],
    queryFn: () => api("/api/v1/projects"),
  });
}
export function useProjectScope() {
  const location = useLocation();
  const savedId = useAtomValue(selectedProjectIdAtom);
  const { data: projects = [], isSuccess, isFetching } = useProjects();
  const id = projectIdForLocation(location, savedId);
  return {
    projectId:
      isSuccess && !isFetching && !projects.some((p) => p.id === id)
        ? null
        : id || null,
    project: projects.find((p) => p.id === id),
    projects,
  };
}

function projectIdForLocation(location: Location, savedId: string | null) {
  const explicitId = new URLSearchParams(location.search).get("project");
  if (explicitId !== null) return explicitId || null;
  // An explicit agent link without a scope must stay reachable even when a
  // different project was last selected. All projects contains that agent;
  // only an explicit project query is allowed to restrict the deep link.
  if (matchPath("/agents/:agentId/*", location.pathname)) return null;
  // Preserve the original All projects view when returning to a bare history
  // entry, without adding a query parameter to every default dashboard URL.
  return location.state?.dispatchProjectScope === "all" ? null : savedId;
}

function isProjectDashboard(pathname: string) {
  return (
    /^\/(agents|tasks|automations)(\/|$)/.test(pathname) &&
    !/^\/automations\/brains(\/|$)/.test(pathname)
  );
}

/** One synchronization owner, mounted with the sidebar project switcher. */
export function useProjectSelection() {
  const scope = useProjectScope();
  const { projectId } = scope;
  const location = useLocation();
  const navigate = useNavigate();
  const saveId = useSetAtom(selectedProjectIdAtom);

  useEffect(() => {
    saveId(projectId);
    // Materialize the fallback in this history entry. An empty parameter
    // means All projects, so back/forward cannot restore a newer preference
    // in place of the choice originally shown on this page.
    if (!isProjectDashboard(location.pathname)) return;
    const query = new URLSearchParams(location.search);
    if (!query.has("project") && projectId === null) {
      if (location.state?.dispatchProjectScope !== "all") {
        navigate(location, {
          replace: true,
          state: { ...location.state, dispatchProjectScope: "all" },
        });
      }
      return;
    }
    if (query.get("project") === (projectId ?? "")) return;
    query.set("project", projectId ?? "");
    navigate(
      { ...location, search: `?${query}` },
      { replace: true, state: location.state }
    );
  }, [projectId, location, navigate, saveId]);

  return scope;
}
/** Preserve the project scope across navigation within the dashboard. */
export function useProjectNavigate() {
  const navigate = useNavigate();
  const location = useLocation();
  const savedId = useAtomValue(selectedProjectIdAtom);
  const id = projectIdForLocation(location, savedId);
  return useCallback(
    (to: To, options?: NavigateOptions) => {
      const url =
        typeof to === "string" ? new URL(to, window.location.origin) : null;
      const pathname =
        url?.pathname ?? (typeof to === "string" ? "" : to.pathname);
      if (pathname && !isProjectDashboard(pathname))
        return navigate(to, options);
      const query = new URLSearchParams(
        url?.search ?? (typeof to === "string" ? "" : to.search) ?? ""
      );
      if (!query.has("project") && id) query.set("project", id);
      if (!query.size) return navigate(to, options);
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
