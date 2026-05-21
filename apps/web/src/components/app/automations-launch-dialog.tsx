import {
  type DragEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import { Play } from "lucide-react";
import { toast } from "sonner";

import { ContextPicker } from "@/components/app/context-picker";
import { startupFileKey } from "@/components/app/create-agent-dialog-clipboard";
import { AgentTypeCombobox } from "@/components/app/automations-form-fields";
import { ActivityBars } from "@/components/ui/activity-bars";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  useTemplateActions,
  parseTemplateArgs,
  type Template,
  type TemplateArg,
} from "@/hooks/use-templates";
import { type AgentType } from "@/lib/agent-types";
import { useRadixPopoverZFix } from "@/hooks/use-radix-popover-z-fix";
import { swallowEscapeFromCombobox } from "@/lib/dialog-escape";
import { agentRoute } from "@/lib/agent-routes";

function ArgInput({
  arg,
  value,
  onChange,
}: {
  arg: TemplateArg;
  value: string;
  onChange: (value: string) => void;
}): JSX.Element {
  const inputId = useId();

  return (
    <div className="space-y-2">
      <label htmlFor={inputId} className="text-sm text-muted-foreground">
        {arg.name}
        {arg.required ? (
          <span className="ml-1 text-status-blocked">*</span>
        ) : null}
      </label>
      {arg.multiline ? (
        <Textarea
          id={inputId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={`Enter ${arg.name}`}
          className="min-h-24 resize-y text-sm"
        />
      ) : (
        <Input
          id={inputId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={`Enter ${arg.name}`}
          className="h-8 text-sm"
        />
      )}
    </div>
  );
}

export function LaunchTemplateDialog({
  template,
  open,
  onOpenChange,
  agentTypes,
}: {
  template: Template;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentTypes: AgentType[];
}): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <LaunchTemplateDialogContent
          template={template}
          onOpenChange={onOpenChange}
          agentTypes={agentTypes}
        />
      ) : null}
    </Dialog>
  );
}

function LaunchTemplateDialogContent({
  template,
  onOpenChange,
  agentTypes,
}: {
  template: Template;
  onOpenChange: (open: boolean) => void;
  agentTypes: AgentType[];
}): JSX.Element {
  const navigate = useNavigate();
  const { launchTemplate } = useTemplateActions();
  const launchButtonRef = useRef<HTMLButtonElement>(null);

  const args = useMemo(
    () => (template.prompt ? parseTemplateArgs(template.prompt) : []),
    [template.prompt]
  );
  const [argValues, setArgValues] = useState<Record<string, string>>({});
  const [agentType, setAgentType] = useState<AgentType>(template.agentType);

  const isTerminal = agentType === "terminal";
  const showMedia = !isTerminal && template.allowMedia;
  const [startupFiles, setStartupFiles] = useState<File[]>([]);
  const [startupLinks, setStartupLinks] = useState<string[]>([]);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const startupFilePreviewsRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    setArgValues({});
    setAgentType(template.agentType);
  }, [template.agentType]);

  useEffect(() => {
    if (args.length > 0) return;
    requestAnimationFrame(() => launchButtonRef.current?.focus());
  }, [args.length]);

  useEffect(() => {
    const previews = startupFilePreviewsRef.current;
    return () => {
      for (const url of previews.values()) {
        URL.revokeObjectURL(url);
      }
      previews.clear();
    };
  }, []);

  useRadixPopoverZFix();

  const appendStartupFiles = useCallback((files: File[]) => {
    if (files.length === 0) return;
    setStartupFiles((current) => {
      const next = [...current];
      const seen = new Set(current.map(startupFileKey));
      for (const file of files) {
        const key = startupFileKey(file);
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(file);
        if (
          file.type.startsWith("image/") &&
          !startupFilePreviewsRef.current.has(key)
        ) {
          startupFilePreviewsRef.current.set(key, URL.createObjectURL(file));
        }
      }
      return next;
    });
  }, []);

  const handleRemoveStartupFile = useCallback((fileToRemove: File) => {
    const key = startupFileKey(fileToRemove);
    const url = startupFilePreviewsRef.current.get(key);
    if (url) {
      URL.revokeObjectURL(url);
      startupFilePreviewsRef.current.delete(key);
    }
    setStartupFiles((current) =>
      current.filter((file) => startupFileKey(file) !== key)
    );
  }, []);

  const handleRemoveStartupLink = useCallback((linkToRemove: string) => {
    setStartupLinks((current) =>
      current.filter((link) => link !== linkToRemove)
    );
  }, []);

  const handleAddLink = useCallback((url: string) => {
    setStartupLinks((current) =>
      current.includes(url) ? current : [...current, url]
    );
  }, []);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      const droppedFiles = Array.from(event.dataTransfer.files ?? []);
      if (droppedFiles.length === 0) return;
      event.preventDefault();
      setDraggingFiles(false);
      appendStartupFiles(droppedFiles);
    },
    [appendStartupFiles]
  );

  const allArgsFilled =
    args.length === 0 ||
    args.every((a) => !a.required || argValues[a.key]?.trim());

  const handleLaunch = useCallback(() => {
    const launchArgs = args.length > 0 ? argValues : undefined;
    launchTemplate
      .mutateAsync({
        id: template.id,
        args: launchArgs,
        agentType,
        startupFiles: startupFiles.length > 0 ? startupFiles : undefined,
        startupLinks: startupLinks.length > 0 ? startupLinks : undefined,
      })
      .then((result) => {
        onOpenChange(false);
        navigate(agentRoute(result.agent.id));
      })
      .catch((err: Error) => {
        toast.error(`Failed to launch: ${err.message}`);
      });
  }, [
    agentType,
    args,
    argValues,
    launchTemplate,
    navigate,
    onOpenChange,
    startupFiles,
    startupLinks,
    template.id,
  ]);

  return (
    <DialogContent
      className="max-w-md"
      onEscapeKeyDown={(e) => {
        swallowEscapeFromCombobox(e);
      }}
    >
      <DialogHeader className="space-y-2">
        <DialogTitle>{template.name}</DialogTitle>
        {template.description ? (
          <DialogDescription>{template.description}</DialogDescription>
        ) : (
          <DialogDescription>
            This will create a new agent from this template.
          </DialogDescription>
        )}
      </DialogHeader>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (allArgsFilled && !launchTemplate.isPending) handleLaunch();
        }}
        onDragOver={
          showMedia
            ? (event) => {
                if (event.dataTransfer.types.includes("Files")) {
                  event.preventDefault();
                  setDraggingFiles(true);
                }
              }
            : undefined
        }
        onDragLeave={
          showMedia
            ? (event) => {
                if (
                  event.currentTarget.contains(
                    event.relatedTarget as Node | null
                  )
                ) {
                  return;
                }
                setDraggingFiles(false);
              }
            : undefined
        }
        onDrop={showMedia ? handleDrop : undefined}
      >
        <div className="space-y-2">
          <label className="text-sm text-muted-foreground">Agent type</label>
          <AgentTypeCombobox
            value={agentType}
            onChange={setAgentType}
            agentTypes={agentTypes}
          />
        </div>

        {args.length > 0 ? (
          <div className="mt-3 flex flex-col gap-3">
            {args.map((arg) => (
              <ArgInput
                key={arg.key}
                arg={arg}
                value={argValues[arg.key] ?? ""}
                onChange={(value) =>
                  setArgValues((prev) => ({ ...prev, [arg.key]: value }))
                }
              />
            ))}
          </div>
        ) : null}

        {showMedia ? (
          <ContextPicker
            className="mt-3"
            files={startupFiles}
            links={startupLinks}
            draggingFiles={draggingFiles}
            filePreviewsRef={startupFilePreviewsRef}
            onAppendFiles={appendStartupFiles}
            onRemoveFile={handleRemoveStartupFile}
            onAddLink={handleAddLink}
            onRemoveLink={handleRemoveStartupLink}
          />
        ) : null}

        <div className="flex flex-row-reverse justify-start gap-2 pt-3">
          <Button
            type="submit"
            variant="primary"
            disabled={!allArgsFilled || launchTemplate.isPending}
          >
            {launchTemplate.isPending ? (
              <ActivityBars size={16} className="mr-1.5" />
            ) : (
              <Play className="h-3.5 w-3.5 mr-1.5 fill-current" />
            )}
            Launch
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}
