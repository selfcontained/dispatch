import { useAtom, useStore } from "jotai";
import { projectLastSessionAtom } from "@/lib/store";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ChevronsUpDown, Layers, Plus, Check } from "lucide-react";
import {
  useProjectScope,
  useProjectActions,
  type Project,
} from "@/hooks/use-projects";
import { ProjectIcon } from "./project-location";
import { PathInput } from "./path-input";
import { useCwdHistory } from "./create-agent-dialog-utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
const COLORS = ["#9575ed", "#38b7a0", "#dda348", "#e17b9a", "#649feb"];
export function ProjectSwitcher() {
  const { project, projects } = useProjectScope();
  const navigate = useNavigate();
  const { agentId } = useParams();
  const store = useStore();
  const [, setLastSession] = useAtom(
    projectLastSessionAtom(project?.id ?? "all")
  );
  useEffect(() => {
    if (agentId) setLastSession(agentId);
  }, [agentId, setLastSession]);
  const [edit, setEdit] = useState<Project | "new" | null>(null);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="h-11 w-full justify-between px-3"
            aria-label="Switch project"
          >
            <span className="flex min-w-0 items-center gap-2">
              {project ? (
                <ProjectIcon project={project} />
              ) : (
                <Layers className="h-4 w-4" />
              )}
              <span className="truncate">
                {project?.name ?? "All projects"}
              </span>
            </span>
            <ChevronsUpDown className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-64" align="start">
          <DropdownMenuItem
            className="text-foreground"
            onSelect={() => navigate("/agents")}
          >
            All projects
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {projects.map((p) => (
            <DropdownMenuItem
              key={p.id}
              className="flex items-center gap-2 text-foreground"
              onSelect={() => {
                const last = store.get(projectLastSessionAtom(p.id));
                navigate(`/agents${last ? `/${last}` : ""}?project=${p.id}`);
              }}
            >
              <ProjectIcon project={p} />
              <span className="flex-1 truncate">{p.name}</span>
              {p.id === project?.id && <Check className="h-3 w-3" />}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-foreground"
            onSelect={() => setEdit("new")}
          >
            <Plus className="mr-2 inline h-3 w-3" />
            Create project
          </DropdownMenuItem>
          {project && (
            <DropdownMenuItem
              className="text-foreground"
              onSelect={() => setEdit(project)}
            >
              Edit project
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {edit && (
        <ProjectEditor
          project={edit === "new" ? undefined : edit}
          onClose={() => setEdit(null)}
          onSaved={(p) => {
            setEdit(null);
            navigate(p ? `/agents?project=${p.id}` : "/agents");
          }}
        />
      )}
    </>
  );
}
function ProjectEditor({
  project,
  onClose,
  onSaved,
}: {
  project?: Project;
  onClose: () => void;
  onSaved: (p?: Project) => void;
}) {
  const [name, setName] = useState(project?.name ?? "");
  const [repoRoot, setRepoRoot] = useState(project?.repoRoot ?? "");
  const [color, setColor] = useState(project?.color ?? COLORS[0]);
  const [icon, setIcon] = useState(project?.iconOverride ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const action = useProjectActions();
  const { history } = useCwdHistory();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {project ? "Edit project" : "Create project"}
          </DialogTitle>
          <DialogDescription>
            A branded space for explicitly assigned sessions and templates.
          </DialogDescription>
        </DialogHeader>
        <form
          className="min-h-0 space-y-4 overflow-y-auto"
          onSubmit={(e) => {
            e.preventDefault();
            action.mutate(
              {
                id: project?.id,
                name,
                repoRoot,
                color,
                iconOverride: icon || null,
              },
              { onSuccess: (p) => onSaved(p as Project) }
            );
          }}
        >
          <label className="block text-sm">
            Name
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              required
            />
          </label>
          {project ? (
            <p className="break-all text-xs text-muted-foreground">
              {repoRoot}
            </p>
          ) : (
            <PathInput
              id="project-repo"
              label="Repository"
              value={repoRoot}
              onChange={setRepoRoot}
              history={history}
            />
          )}
          <label className="block text-sm">
            Icon override
            <Input
              value={icon}
              onChange={(e) => setIcon(e.target.value)}
              placeholder="Use repository icon"
              maxLength={8}
            />
          </label>
          <fieldset>
            <legend className="mb-2 text-sm">Color</legend>
            <div className="flex gap-3">
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Color ${c}`}
                  aria-pressed={color === c}
                  className="flex h-8 w-8 items-center justify-center rounded-full text-black"
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                >
                  {color === c && <Check className="h-4 w-4" />}
                </button>
              ))}
            </div>
          </fieldset>
          {action.error && (
            <p role="alert" className="text-sm text-destructive">
              {action.error.message}
            </p>
          )}
          {confirmDelete && (
            <p className="text-sm">
              Delete this project? Sessions, templates, and files are kept;
              project membership is cleared.
            </p>
          )}
          <div className="flex justify-end gap-2">
            {project && (
              <Button
                type="button"
                variant="ghost-destructive"
                disabled={action.isPending}
                onClick={() =>
                  confirmDelete
                    ? action.mutate(
                        { id: project.id, remove: true },
                        { onSuccess: () => onSaved() }
                      )
                    : setConfirmDelete(true)
                }
              >
                {confirmDelete ? "Confirm delete" : "Delete"}
              </Button>
            )}
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={action.isPending || !name.trim() || !repoRoot.trim()}
            >
              {project ? "Save" : "Create project"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
export function ProjectBanner() {
  const { project } = useProjectScope();
  if (!project) return null;
  return (
    <div
      className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-xs font-medium"
      style={{
        borderTop: `3px solid ${project.color}`,
        background: `${project.color}18`,
      }}
    >
      <ProjectIcon project={project} />
      <span className="truncate">{project.name}</span>
    </div>
  );
}
