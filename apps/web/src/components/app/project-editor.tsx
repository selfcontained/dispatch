import { useLaunchTargets } from "@/hooks/use-launch-targets";
import { useRepositoryProject } from "@/hooks/use-repository-project";
import { RunnerRepositoryPicker } from "./runner-repository-picker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ColorPicker, PROJECT_COLORS, isHexColor } from "./color-picker";
import { readProjectLogoColors } from "./project-logo-color";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Upload, Info } from "lucide-react";
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
  DialogBody,
  DialogCancel,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";
import { Alert } from "@/components/ui/alert";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";

export function ProjectEditor({
  project,
  onClose,
  onSaved,
}: {
  project?: Project;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [source, setSource] = useState("folder");
  const [runnerChoice, setRunnerChoice] = useState("");
  const [repository, setRepository] = useState("");
  const targets = useLaunchTargets(
    undefined,
    undefined,
    !project && source === "repository"
  );
  const runners = targets.list.data ?? [];
  const runnerKey =
    runnerChoice || runners.find((r) => r.status === "online")?.key || "";
  const repositoryAction = useRepositoryProject();
  const [name, setName] = useState(project?.name ?? "");
  const [repoRoot, setRepoRoot] = useState(project?.repoRoot ?? "");
  const [previewRoot, setPreviewRoot] = useState(repoRoot);
  const [manualColor, setManualColor] = useState<string>();
  const [logoPalette, setLogoPalette] = useState<{
    src: string;
    colors: string[];
  }>();
  const [icon, setIcon] = useState<string | null>(
    project?.iconOverride?.startsWith("data:") ? project.iconOverride : null
  );
  const [photo, setPhoto] = useState<HTMLCanvasElement | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<unknown>();
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
    enabled: source === "folder" && !!previewRoot.trim(),
    staleTime: 0,
  });
  const iconSrc =
    icon ??
    (project || repoRoot === previewRoot ? preview.data?.dataUrl : null);
  const logoColors =
    logoPalette?.src === iconSrc ? logoPalette?.colors : undefined;
  const color =
    manualColor ?? project?.color ?? logoColors?.[0] ?? PROJECT_COLORS[0]!;
  const saving = action.isPending || repositoryAction.isPending;
  const validColor = isHexColor(color);
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open && !photo) onClose();
        }}
      >
        <DialogContent busy={saving && !confirmDelete}>
          <DialogHeader>
            <DialogTitle>
              {project ? "Edit project" : "New project"}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {project
                ? `Update ${project.name}’s identity.`
                : "Organize sessions and templates around a folder."}
            </DialogDescription>
          </DialogHeader>
          <DialogForm
            onSubmit={(e) => {
              e.preventDefault();
              if (!validColor) return;
              if (!project && source === "repository") {
                repositoryAction.mutate(
                  { name, repository, color, iconOverride: icon },
                  { onSuccess: onSaved }
                );
                return;
              }
              action.mutate(
                { id: project?.id, name, repoRoot, color, iconOverride: icon },
                { onSuccess: onSaved }
              );
            }}
          >
            <DialogBody className="space-y-4" data-testid="project-editor-body">
              <Field label="Name">
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={80}
                  required
                  autoComplete="off"
                />
              </Field>
              {!project && (
                <Field label="Source">
                  <Select value={source} onValueChange={setSource}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="folder">Folder</SelectItem>
                      <SelectItem value="repository">Repository</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              )}
              {!project && source === "repository" ? (
                <>
                  <Field label="Runner">
                    <Select
                      value={runnerKey}
                      onValueChange={(id) => {
                        setRunnerChoice(id);
                        setRepository("");
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Choose a runner" />
                      </SelectTrigger>
                      <SelectContent>
                        {runners.map((r) => (
                          <SelectItem
                            key={r.key}
                            value={r.key}
                            disabled={r.status !== "online"}
                          >
                            {r.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <RunnerRepositoryPicker
                    key={runnerKey}
                    searchUrl={
                      runners.find((r) => r.key === runnerKey)?.location
                        .repositorySearchUrl
                    }
                    repository={repository}
                    onRepository={(url) => {
                      setRepository(url);
                      if (!name.trim())
                        setName(
                          new URL(url).pathname
                            .replace(/\/+$/, "")
                            .split("/")
                            .pop()!
                            .replace(/\.git$/, "")
                            .slice(0, 80)
                        );
                    }}
                  />
                </>
              ) : project ? (
                <div className="space-y-1.5">
                  <p className="text-body-sm font-medium">Folder</p>
                  <p
                    title={repoRoot}
                    className="truncate text-body-sm text-muted-foreground"
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
                <legend className="text-body-sm font-medium">Icon</legend>
                <div className="flex items-center gap-3">
                  <div
                    className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-subtle"
                    data-testid="project-icon-preview"
                  >
                    {iconSrc ? (
                      <img
                        key={iconSrc}
                        src={iconSrc}
                        onLoad={(e) =>
                          setLogoPalette({
                            src: iconSrc,
                            colors: readProjectLogoColors(e.currentTarget),
                          })
                        }
                        onError={() =>
                          setLogoPalette({ src: iconSrc, colors: [] })
                        }
                        alt="Project icon preview"
                        className="h-12 w-12 object-contain"
                      />
                    ) : (
                      <span className="text-heading-lg font-normal text-muted-foreground">
                        {name.trim().slice(0, 1).toUpperCase() || "?"}
                      </span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex h-4 items-center gap-1">
                      <p
                        className="min-w-0 truncate text-body-sm text-muted-foreground"
                        role="status"
                        title={preview.data?.path ?? undefined}
                      >
                        {icon
                          ? "Custom upload"
                          : preview.isFetching && !preview.data
                            ? "Loading icon…"
                            : preview.isError
                              ? "Couldn’t load the icon"
                              : preview.data?.dataUrl
                                ? "From folder"
                                : "No folder icon"}
                      </p>
                      <Popover>
                        <PopoverTrigger asChild>
                          <IconButton size="icon-xs" label="About folder icons">
                            <Info />
                          </IconButton>
                        </PopoverTrigger>
                        <PopoverContent
                          className="w-64 text-body-sm"
                          side="top"
                        >
                          Add .dispatch/logo.svg or .dispatch/logo.png to the
                          folder to use it automatically. Upload an image to
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
                        disabled={preparing}
                        onClick={() => uploadInput.current?.click()}
                      >
                        <Upload />
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
                    setError(undefined);
                    void prepareAvatarPhoto(file)
                      .then(setPhoto)
                      .catch(setError)
                      .finally(() => setPreparing(false));
                  }}
                />
              </fieldset>
              <fieldset className="space-y-2">
                <legend className="text-body-sm font-medium">Color</legend>
                <ColorPicker
                  value={color}
                  onChange={setManualColor}
                  logoColors={logoColors}
                  label="Project color"
                />
              </fieldset>
            </DialogBody>
            {error ? (
              <Alert title="Couldn’t open the image." error={error} />
            ) : repositoryAction.error ? (
              <Alert
                title="Couldn’t create the project."
                error={repositoryAction.error}
              />
            ) : action.error && !action.variables?.remove ? (
              <Alert
                title={
                  project
                    ? "Couldn’t save the project."
                    : "Couldn’t create the project."
                }
                error={action.error}
              />
            ) : null}
            <DialogFooter
              data-testid="project-editor-footer"
              start={
                project ? (
                  <Button
                    type="button"
                    variant="ghost"
                    tone="danger"
                    disabled={action.isPending}
                    onClick={() => setConfirmDelete(true)}
                  >
                    Delete project
                  </Button>
                ) : null
              }
            >
              <DialogCancel />
              <Button
                type="submit"
                variant="primary"
                pending={saving && !confirmDelete}
                disabled={
                  saving ||
                  preparing ||
                  !validColor ||
                  !name.trim() ||
                  (!project && source === "repository"
                    ? !repository
                    : !project && !repoRoot.trim())
                }
              >
                {project ? "Save changes" : "Create project"}
              </Button>
            </DialogFooter>
          </DialogForm>
          {project && (
            <ConfirmDialog
              open={confirmDelete}
              onOpenChange={setConfirmDelete}
              title={`Delete “${project.name}”?`}
              description="Ungroups sessions and templates. Files are kept."
              confirmLabel="Delete project"
              errorTitle="Couldn’t delete the project."
              onConfirm={async () => {
                await action.mutateAsync({ id: project.id, remove: true });
                toast.success(`Project “${project.name}” deleted.`);
                onSaved();
              }}
            />
          )}
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
