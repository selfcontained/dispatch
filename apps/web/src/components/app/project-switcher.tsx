import { useRef, useState } from "react";
import { panelFrame } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { matchPath, useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  Layers,
  Plus,
  Check,
  Settings,
  Pencil,
} from "lucide-react";
import {
  useProjectSelection,
  useProjects,
  type Project,
} from "@/hooks/use-projects";
import type { Agent } from "./types";
import { agentScopeProjectId } from "@/lib/agent-lineage";
import { ProjectIcon } from "./project-location";
import { ProjectEditor } from "./project-editor";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogCancel,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { AsyncBoundary } from "@/components/ui/async-boundary";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * Sections whose content is per project (Tasks) pass `allowAll={false}`:
 * "All projects" is not a view there, so the menu omits it and an empty
 * scope reads as a prompt rather than a selection.
 */
export function ProjectSwitcher({ allowAll = true }: { allowAll?: boolean }) {
  const { project, projects } = useProjectSelection();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const trigger = useRef<HTMLButtonElement>(null);
  const projectsQuery = useProjects();
  const [manage, setManage] = useState(false);
  const [edit, setEdit] = useState<Project | "new" | null>(null);
  const select = (id?: string) => {
    // A retained, in-scope URL is incidental to this scope choice. Do not
    // overwrite the target scope's last explicit agent selection with it.
    const navigationOptions = { state: { dispatchProjectSwitch: true } };
    const query = new URLSearchParams(location.search);
    query.set("project", id ?? "");
    // A project choice is an explicit scope change, not a task deep link.
    if (location.pathname === "/tasks") query.delete("task");
    // Likewise an open agent outside the new scope is deselected in the same
    // navigation, so its chat never renders under the other project.
    const agentId = matchPath("/agents/:agentId/*", location.pathname)?.params
      .agentId;
    const agents = queryClient.getQueryData<Agent[]>(["agents"]) ?? [];
    const agent = agents.find((a) => a.id === agentId);
    if (
      agentId &&
      id &&
      (!agent || agentScopeProjectId(agent, agents) !== id)
    ) {
      for (const key of ["thread", "file", "line"]) query.delete(key);
      navigate(
        { pathname: "/agents", search: query.toString() },
        navigationOptions
      );
      return;
    }
    navigate(
      {
        pathname: location.pathname,
        search: query.toString(),
        hash: location.hash,
      },
      navigationOptions
    );
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            ref={trigger}
            size="sm"
            className="w-full min-w-0 justify-between text-muted-foreground hover:text-foreground"
            aria-label="Filter by project"
          >
            <span className="flex min-w-0 items-center gap-2">
              {project ? (
                <ProjectIcon project={project} className="h-4 w-4" />
              ) : (
                <Layers className="h-4 w-4 shrink-0" />
              )}
              <span className="truncate">
                {project?.name ??
                  (allowAll ? "All projects" : "Choose a project")}
              </span>
            </span>
            <ChevronDown className="text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          loop
          side="bottom"
          avoidCollisions={false}
          align="start"
          className="project-filter-menu w-[var(--radix-dropdown-menu-trigger-width)] min-w-0"
        >
          {allowAll && (
            <>
              <DropdownMenuItem
                className="flex items-center gap-2 text-foreground"
                onSelect={() => select()}
              >
                <span className="min-w-0 flex-1 truncate">All projects</span>
                {!project && <Check className="h-3.5 w-3.5 shrink-0" />}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          {projects.map((p) => (
            <DropdownMenuItem
              key={p.id}
              className="flex items-center gap-2 text-foreground"
              onSelect={() => select(p.id)}
            >
              <ProjectIcon project={p} className="h-4 w-4" />
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              {p.id === project?.id && (
                <Check className="h-3.5 w-3.5 shrink-0" />
              )}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="flex items-center gap-2 text-foreground"
            onSelect={() => setManage(true)}
          >
            <Settings className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 truncate">Manage projects</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={manage && !edit} onOpenChange={setManage}>
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!edit) trigger.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Projects</DialogTitle>
            <DialogDescription>
              Give each folder a name, icon, and color.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-2">
            <AsyncBoundary
              query={projectsQuery}
              thing="projects"
              isEmpty={() => !projects.length}
              empty={
                <EmptyState
                  title="No projects yet."
                  description="Folder launches always remain available."
                />
              }
            >
              {() => (
                <>
                  {projects.map((p) => (
                    <div
                      key={p.id}
                      className={cn(panelFrame, "flex items-center gap-3 p-3")}
                    >
                      <ProjectIcon project={p} />
                      <span
                        aria-hidden
                        className="h-6 w-1 shrink-0 rounded-sm"
                        style={{ background: p.color }}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-body-md font-medium">
                          {p.name}
                        </div>
                        <div className="truncate text-body-sm text-muted-foreground">
                          {p.repoRoot}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        aria-label={`Edit ${p.name}`}
                        onClick={() => setEdit(p)}
                      >
                        <Pencil />
                        Edit
                      </Button>
                    </div>
                  ))}
                </>
              )}
            </AsyncBoundary>
          </DialogBody>
          <DialogFooter>
            <DialogCancel>Done</DialogCancel>
            <Button variant="primary" onClick={() => setEdit("new")}>
              <Plus />
              New project
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {edit && (
        <ProjectEditor
          project={edit === "new" ? undefined : edit}
          onClose={() => setEdit(null)}
          onSaved={() => setEdit(null)}
        />
      )}
    </>
  );
}
