import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Upload, Info } from "lucide-react";
import { useProjectActions, type Project } from "@/hooks/use-projects";
import { api } from "@/lib/api";
import { PathInput } from "./path-input";
import { useCwdHistory } from "./create-agent-dialog-utils";
import { prepareAvatarPhoto } from "./user-avatar/prepare-avatar";
import { AvatarCropDialog } from "./user-avatar/avatar-crop-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

const COLORS = [
  "#9575ed",
  "#38b7a0",
  "#dda348",
  "#e17b9a",
  "#649feb",
  "#ef6c57",
  "#74b85c",
  "#a5aab7",
];
export function ProjectEditor({
  project,
  onClose,
  onSaved,
}: {
  project?: Project;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(project?.name ?? "");
  const [repoRoot, setRepoRoot] = useState(project?.repoRoot ?? "");
  const [previewRoot, setPreviewRoot] = useState(repoRoot);
  const [color, setColor] = useState(project?.color ?? COLORS[0]!);
  const [icon, setIcon] = useState<string | null>(
    project?.iconOverride?.startsWith("data:") ? project.iconOverride : null
  );
  const [photo, setPhoto] = useState<HTMLCanvasElement | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const uploadInput = useRef<HTMLInputElement>(null);
  const uploadButton = useRef<HTMLButtonElement>(null);
  const action = useProjectActions();
  const { history } = useCwdHistory();
  useEffect(() => {
    const timer = setTimeout(() => setPreviewRoot(repoRoot), 300);
    return () => clearTimeout(timer);
  }, [repoRoot]);
  const preview = useQuery<{
    dataUrl: string | null;
    path: string | null;
    source: string | null;
  }>({
    queryKey: ["project-icon-preview", project?.id, previewRoot],
    queryFn: () =>
      api(
        `/api/v1/projects/icon-preview?${new URLSearchParams(project ? { projectId: project.id } : { repoRoot: previewRoot })}`
      ),
    enabled: !!previewRoot.trim(),
    staleTime: 0,
  });
  const iconSrc = icon ?? preview.data?.dataUrl;
  const validColor = /^#[0-9a-fA-F]{6}$/.test(color);
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open && !photo) onClose();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {project ? "Edit project" : "Create project"}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {project
                ? `Update ${project.name}’s identity.`
                : "Organize sessions and templates around a repository."}
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(e) => {
              e.preventDefault();
              if (!validColor) return;
              action.mutate(
                { id: project?.id, name, repoRoot, color, iconOverride: icon },
                { onSuccess: onSaved }
              );
            }}
          >
            <div
              className="-m-1 min-h-0 flex-1 space-y-4 overflow-y-auto p-1"
              data-testid="project-editor-body"
            >
              <label className="block space-y-1 text-sm">
                <span>Name</span>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={80}
                  required
                  autoComplete="off"
                />
              </label>
              {project ? (
                <div className="space-y-1 text-sm">
                  <span>Folder</span>
                  <p
                    title={repoRoot}
                    className="truncate text-xs text-muted-foreground"
                  >
                    {repoRoot}
                  </p>
                </div>
              ) : (
                <PathInput
                  id="project-repo"
                  label="Folder"
                  value={repoRoot}
                  onChange={setRepoRoot}
                  history={history}
                />
              )}
              <fieldset className="space-y-2">
                <legend className="text-sm">Icon</legend>
                <div className="flex items-center gap-3">
                  <div
                    className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/30"
                    data-testid="project-icon-preview"
                  >
                    {iconSrc ? (
                      <img
                        src={iconSrc}
                        alt="Project icon preview"
                        className="h-12 w-12 object-contain"
                      />
                    ) : (
                      <span className="text-xl text-muted-foreground">
                        {name.trim().slice(0, 1).toUpperCase() || "?"}
                      </span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex h-4 items-center gap-1">
                      <p
                        className="min-w-0 truncate text-xs text-muted-foreground"
                        role="status"
                        title={preview.data?.path ?? undefined}
                      >
                        {icon
                          ? "Custom upload"
                          : preview.isFetching && !preview.data
                            ? "Loading icon…"
                            : preview.data?.dataUrl
                              ? "From repository"
                              : "No repository icon"}
                      </p>
                      <Popover>
                        <PopoverTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-5 w-5 shrink-0"
                            aria-label="About repository icons"
                          >
                            <Info className="h-3.5 w-3.5" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-64 text-xs" side="top">
                          Add .dispatch/logo.svg or .dispatch/logo.png to your
                          repo to use it automatically. Upload an image to
                          override it.
                          {preview.data?.path && (
                            <p className="mt-2 break-all text-muted-foreground">
                              {preview.data.path}
                            </p>
                          )}
                        </PopoverContent>
                      </Popover>
                    </div>
                    <div className="flex gap-1">
                      <Button
                        ref={uploadButton}
                        type="button"
                        size="sm"
                        variant="default"
                        disabled={preparing}
                        onClick={() => uploadInput.current?.click()}
                      >
                        <Upload className="mr-1.5 h-3.5 w-3.5" />
                        {preparing ? "Preparing…" : "Upload"}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={!icon}
                        onClick={() => setIcon(null)}
                      >
                        Remove upload
                      </Button>
                    </div>
                  </div>
                </div>
                <input
                  ref={uploadInput}
                  type="file"
                  className="hidden"
                  aria-label="Upload project icon"
                  accept="image/png,image/jpeg,image/webp,image/heic,image/heif,.heic,.heif"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (!file) return;
                    setPreparing(true);
                    setError(null);
                    void prepareAvatarPhoto(file)
                      .then(setPhoto)
                      .catch((err) =>
                        setError(
                          err instanceof Error
                            ? err.message
                            : "Could not open image."
                        )
                      )
                      .finally(() => setPreparing(false));
                  }}
                />
              </fieldset>
              <fieldset className="space-y-2">
                <legend className="text-sm">Color</legend>
                <div className="flex flex-wrap gap-2">
                  {COLORS.map((c) => (
                    <Button
                      key={c}
                      type="button"
                      size="icon"
                      variant="default"
                      aria-label={`Color ${c}`}
                      aria-pressed={color.toLowerCase() === c}
                      className="h-7 w-7 rounded-full border-white/15 text-black"
                      style={{ background: c }}
                      onClick={() => setColor(c)}
                    >
                      {color.toLowerCase() === c && (
                        <Check className="h-4 w-4" />
                      )}
                    </Button>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    type="color"
                    aria-label="Choose custom project color"
                    value={validColor ? color : "#9575ed"}
                    onChange={(e) => setColor(e.target.value)}
                    className="h-9 w-12 shrink-0 cursor-pointer p-1"
                  />
                  <Input
                    aria-label="Project color hex"
                    value={color}
                    onChange={(e) => setColor(e.target.value)}
                    pattern="#[0-9a-fA-F]{6}"
                    maxLength={7}
                    className="w-28 font-mono"
                  />
                </div>
              </fieldset>
              {(error || action.error) && (
                <p role="alert" className="text-sm text-destructive">
                  {error ?? action.error?.message}
                </p>
              )}
              {project && (
                <div className="flex flex-wrap items-center gap-3 rounded-lg bg-muted/30 p-3">
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    disabled={action.isPending}
                    onClick={() =>
                      confirmDelete
                        ? action.mutate(
                            { id: project.id, remove: true },
                            { onSuccess: onSaved }
                          )
                        : setConfirmDelete(true)
                    }
                  >
                    {confirmDelete ? "Confirm delete" : "Delete project"}
                  </Button>
                  <p className="min-w-32 flex-1 text-xs text-muted-foreground">
                    Ungroups sessions and templates. Files are kept.
                  </p>
                  {confirmDelete && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setConfirmDelete(false)}
                    >
                      Keep project
                    </Button>
                  )}
                </div>
              )}
            </div>
            <div
              className="mt-4 flex shrink-0 justify-end gap-2 border-t border-border pt-3"
              data-testid="project-editor-footer"
            >
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={
                  action.isPending ||
                  preparing ||
                  !validColor ||
                  !name.trim() ||
                  !repoRoot.trim()
                }
              >
                {project ? "Save" : "Create project"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      {photo && (
        <AvatarCropDialog
          photo={photo}
          onRestoreFocus={() => uploadButton.current?.focus()}
          onClose={() => setPhoto(null)}
          onSave={async (dataUrl) => {
            setIcon(dataUrl);
          }}
        />
      )}
    </>
  );
}
