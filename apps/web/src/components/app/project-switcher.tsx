import { useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  ChevronDown,
  Layers,
  Plus,
  Check,
  Settings,
  Pencil,
} from "lucide-react";
import { useProjectSelection, type Project } from "@/hooks/use-projects";
import { ProjectIcon } from "./project-location";
import { ProjectEditor } from "./project-editor";
import { Button } from "@/components/ui/button";
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

export function ProjectSwitcher() {
  const { project, projects } = useProjectSelection();
  const navigate = useNavigate();
  const location = useLocation();
  const trigger = useRef<HTMLButtonElement>(null);
  const [manage, setManage] = useState(false);
  const [edit, setEdit] = useState<Project | "new" | null>(null);
  const select = (id?: string) => {
    const query = new URLSearchParams(location.search);
    query.set("project", id ?? "");
    navigate({
      pathname: location.pathname,
      search: query.toString(),
      hash: location.hash,
    });
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            ref={trigger}
            size="sm"
            variant="default"
            className="w-full min-w-0 justify-between gap-2 px-2 text-muted-foreground hover:text-foreground"
            aria-label="Filter by project"
          >
            <span className="flex min-w-0 items-center gap-2">
              {project ? (
                <ProjectIcon project={project} className="h-4 w-4" />
              ) : (
                <Layers className="h-4 w-4 shrink-0" />
              )}
              <span className="truncate">
                {project?.name ?? "All projects"}
              </span>
            </span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="project-filter-menu w-[var(--radix-dropdown-menu-trigger-width)] min-w-0"
        >
          <DropdownMenuItem
            className="flex items-center gap-2 text-foreground"
            onSelect={() => select()}
          >
            <span className="min-w-0 flex-1 truncate">All projects</span>
            {!project && <Check className="h-3.5 w-3.5 shrink-0" />}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
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
              Give each repository a name, icon, and color.
            </DialogDescription>
          </DialogHeader>
          <div className="-m-1 min-h-0 space-y-2 overflow-y-auto p-1">
            {projects.map((p) => (
              <div
                key={p.id}
                className="flex items-center gap-3 rounded-lg border border-border p-3"
              >
                <ProjectIcon project={p} />
                <span
                  aria-hidden
                  className="h-6 w-1 shrink-0 rounded"
                  style={{ background: p.color }}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{p.name}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {p.repoRoot}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="default"
                  aria-label={`Edit ${p.name}`}
                  onClick={() => setEdit(p)}
                >
                  <Pencil className="mr-1.5 h-3 w-3" />
                  Edit
                </Button>
              </div>
            ))}
            {!projects.length && (
              <p className="py-4 text-sm text-muted-foreground">
                No projects yet. Folder launches always remain available.
              </p>
            )}
          </div>
          <div className="flex justify-between gap-2 pt-2">
            <Button onClick={() => setEdit("new")}>
              <Plus className="mr-2 h-4 w-4" />
              Create project
            </Button>
            <Button variant="ghost" onClick={() => setManage(false)}>
              Done
            </Button>
          </div>
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
