import {
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import {
  ChevronLeft,
  Clipboard,
  FileText,
  Link2,
  Paperclip,
  Play,
  Plus,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";

import {
  type ClipboardSuggestion,
  STARTUP_FILE_ACCEPT,
  createClipboardSuggestionFromText,
  getClipboardFilesFromEvent,
  getClipboardSuggestion,
  normalizeUrl,
  startupFileExt,
  startupFileKey,
  startupLinkLabel,
} from "@/components/app/create-agent-dialog-clipboard";
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  useTemplateActions,
  parseTemplateArgs,
  type Template,
  type TemplateArg,
} from "@/hooks/use-templates";
import { type CliAgentType } from "@/lib/agent-types";
import { useRadixPopoverZFix } from "@/hooks/use-radix-popover-z-fix";
import { swallowEscapeFromCombobox } from "@/lib/dialog-escape";
import { agentRoute } from "@/lib/agent-routes";
import { cn } from "@/lib/utils";

function ArgInput({
  arg,
  value,
  onChange,
}: {
  arg: TemplateArg;
  value: string;
  onChange: (value: string) => void;
}): JSX.Element {
  return (
    <div className="space-y-2">
      <label className="text-sm text-muted-foreground">{arg.name}</label>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={`Enter ${arg.name}`}
        className="h-8 text-sm"
      />
    </div>
  );
}

const CONTEXT_LINK_INPUT_ID = "launch-template-context-link-input";
const CONTEXT_LINK_ERROR_ID = "launch-template-context-link-error";

function LaunchAddContextMenu({
  onAddFile,
  onAddLink,
}: {
  onAddFile: () => void;
  onAddLink: () => void;
}) {
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={onAddFile}
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm text-foreground hover:bg-white/[0.1]"
      >
        <Upload className="h-3.5 w-3.5 text-muted-foreground" />
        Add file
      </button>
      <button
        type="button"
        onClick={onAddLink}
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm text-foreground hover:bg-white/[0.1]"
      >
        <Link2 className="h-3.5 w-3.5 text-muted-foreground" />
        Add link
      </button>
    </div>
  );
}

function LaunchAddContextLinkForm({
  value,
  onChange,
  onSubmit,
  onBack,
  isValid,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  onBack: () => void;
  isValid: boolean;
}) {
  return (
    <div className="space-y-1.5 p-1">
      <label
        htmlFor={CONTEXT_LINK_INPUT_ID}
        className="text-xs text-muted-foreground"
      >
        Link URL
      </label>
      <Input
        id={CONTEXT_LINK_INPUT_ID}
        autoFocus
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            if (value.trim().length > 0 && isValid) {
              onSubmit();
            }
          }
        }}
        placeholder="https://..."
        aria-invalid={!isValid}
        aria-describedby={!isValid ? CONTEXT_LINK_ERROR_ID : undefined}
      />
      {!isValid ? (
        <p id={CONTEXT_LINK_ERROR_ID} className="text-xs text-status-blocked">
          Enter a valid `http:` or `https:` URL.
        </p>
      ) : null}
      <div className="flex justify-between gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          <ChevronLeft className="mr-1 h-3 w-3" />
          Back
        </Button>
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={onSubmit}
          disabled={value.trim().length === 0 || !isValid}
        >
          Add link
        </Button>
      </div>
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
  agentTypes: CliAgentType[];
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
  agentTypes: CliAgentType[];
}): JSX.Element {
  const navigate = useNavigate();
  const { launchTemplate } = useTemplateActions();
  const launchButtonRef = useRef<HTMLButtonElement>(null);

  const args = useMemo(
    () => (template.prompt ? parseTemplateArgs(template.prompt) : []),
    [template.prompt]
  );
  const [argValues, setArgValues] = useState<Record<string, string>>({});
  const [agentType, setAgentType] = useState<CliAgentType>(template.agentType);

  // Context / files state
  const showMedia = template.allowMedia;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const clipboardRequestIdRef = useRef(0);
  const [startupFiles, setStartupFiles] = useState<File[]>([]);
  const [startupLinks, setStartupLinks] = useState<string[]>([]);
  const [linkDraft, setLinkDraft] = useState("");
  const [checkingClipboard, setCheckingClipboard] = useState(false);
  const [clipboardPasteMode, setClipboardPasteMode] = useState(false);
  const [pasteTooltip, setPasteTooltip] = useState<string | null>(null);
  const pasteTooltipTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const clipboardPasteRef = useRef<HTMLInputElement>(null);
  const [clipboardReadFeedback, setClipboardReadFeedback] = useState<
    string | null
  >(null);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addMode, setAddMode] = useState<"menu" | "link">("menu");

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

  const applyClipboardSuggestion = useCallback(
    (suggestion: ClipboardSuggestion) => {
      switch (suggestion.kind) {
        case "image":
        case "file":
          appendStartupFiles([suggestion.file]);
          break;
        case "url":
          setStartupLinks((current) =>
            current.includes(suggestion.url)
              ? current
              : [...current, suggestion.url]
          );
          break;
        case "text":
          break;
      }
    },
    [appendStartupFiles]
  );

  const handleCheckClipboard = useCallback(() => {
    setCheckingClipboard(true);
    setClipboardReadFeedback(null);
    const requestId = clipboardRequestIdRef.current + 1;
    clipboardRequestIdRef.current = requestId;
    void getClipboardSuggestion().then((result) => {
      if (clipboardRequestIdRef.current !== requestId) return;
      setCheckingClipboard(false);
      if (result.suggestion) {
        applyClipboardSuggestion(result.suggestion);
        return;
      }
      if (result.status === "blocked" || result.status === "unsupported") {
        setClipboardPasteMode(true);
        requestAnimationFrame(() => clipboardPasteRef.current?.focus());
      } else {
        setClipboardReadFeedback("Nothing readable found on the clipboard.");
      }
    });
  }, [applyClipboardSuggestion]);

  const handleClipboardPasteInput = useCallback(
    (event: ClipboardEvent<HTMLInputElement>) => {
      event.preventDefault();
      const pastedFiles = getClipboardFilesFromEvent(event);
      if (pastedFiles.length > 0) {
        appendStartupFiles(pastedFiles);
        setClipboardPasteMode(false);
        return;
      }
      const textSuggestion = createClipboardSuggestionFromText(
        event.clipboardData.getData("text/plain")
      );
      if (textSuggestion?.kind === "url") {
        applyClipboardSuggestion(textSuggestion);
        setClipboardPasteMode(false);
        return;
      }
      clearTimeout(pasteTooltipTimerRef.current);
      setPasteTooltip("No files or images found");
      pasteTooltipTimerRef.current = setTimeout(
        () => setPasteTooltip(null),
        2500
      );
    },
    [appendStartupFiles, applyClipboardSuggestion]
  );

  const handleClipboardPasteBlur = useCallback(() => {
    setClipboardPasteMode(false);
    setPasteTooltip(null);
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

  const handleFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const selected = Array.from(event.target.files ?? []);
      appendStartupFiles(selected);
      event.target.value = "";
    },
    [appendStartupFiles]
  );

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

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLElement>) => {
      const pastedFiles = getClipboardFilesFromEvent(event);
      if (pastedFiles.length > 0) {
        event.preventDefault();
        appendStartupFiles(pastedFiles);
        setClipboardReadFeedback(null);
        return;
      }

      const textSuggestion = createClipboardSuggestionFromText(
        event.clipboardData.getData("text/plain")
      );
      if (textSuggestion?.kind === "url") {
        event.preventDefault();
        applyClipboardSuggestion(textSuggestion);
        setClipboardReadFeedback(null);
      }
    },
    [appendStartupFiles, applyClipboardSuggestion]
  );

  const handleAddOpenChange = useCallback((next: boolean) => {
    setAddOpen(next);
    if (!next) {
      setAddMode("menu");
      setLinkDraft("");
    }
  }, []);

  const handleAddFileFromMenu = useCallback(() => {
    setAddOpen(false);
    setAddMode("menu");
    requestAnimationFrame(() => fileInputRef.current?.click());
  }, []);

  const handleAddLinkFromMenu = useCallback(() => {
    setAddMode("link");
  }, []);

  const handleAddLinkBack = useCallback(() => {
    setLinkDraft("");
    setAddMode("menu");
  }, []);

  const normalizedLinkDraft = normalizeUrl(linkDraft);
  const linkDraftIsValid =
    linkDraft.trim().length === 0 || normalizedLinkDraft !== null;

  const addStartupLink = useCallback(() => {
    if (!normalizedLinkDraft) return false;
    setStartupLinks((current) =>
      current.includes(normalizedLinkDraft)
        ? current
        : [...current, normalizedLinkDraft]
    );
    setLinkDraft("");
    return true;
  }, [normalizedLinkDraft]);

  const handleAddLinkSubmit = useCallback(() => {
    if (!addStartupLink()) return;
    setAddMode("menu");
    setAddOpen(false);
  }, [addStartupLink]);

  const allArgsFilled =
    args.length === 0 || args.every((a) => argValues[a.key]?.trim());

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

  const hasContextItems = startupFiles.length > 0 || startupLinks.length > 0;

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
          <div
            className={cn(
              "mt-3 space-y-3 rounded-md border bg-muted/20 px-3 py-3 transition-colors",
              draggingFiles
                ? "border-status-done/35 bg-status-done/8 ring-1 ring-inset ring-status-done/30"
                : "border-border/70"
            )}
            onPaste={handlePaste}
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                  <Paperclip className="h-3.5 w-3.5" />
                  Context
                </div>
                <p className="text-xs text-muted-foreground">
                  Attach files or links.
                </p>
              </div>
              {clipboardPasteMode ? (
                <div className="relative shrink-0">
                  <input
                    ref={clipboardPasteRef}
                    type="text"
                    placeholder="Paste here"
                    className="h-7 w-32 rounded-md border border-border/70 bg-background/40 px-2 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    onPaste={handleClipboardPasteInput}
                    onBlur={handleClipboardPasteBlur}
                  />
                  {pasteTooltip ? (
                    <div
                      className="absolute right-0 top-full z-50 mt-1.5 whitespace-nowrap rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95"
                      role="status"
                    >
                      {pasteTooltip}
                    </div>
                  ) : null}
                </div>
              ) : (
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  className="h-7 shrink-0 gap-1 px-2 text-xs"
                  onClick={handleCheckClipboard}
                  disabled={checkingClipboard}
                >
                  {checkingClipboard ? (
                    <ActivityBars size={12} className="mr-0.5" />
                  ) : (
                    <Clipboard className="h-3 w-3" />
                  )}
                  Read clipboard
                </Button>
              )}
            </div>
            {clipboardReadFeedback ? (
              <p
                className="text-xs text-muted-foreground"
                role="status"
                aria-live="polite"
              >
                {clipboardReadFeedback}
              </p>
            ) : null}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={STARTUP_FILE_ACCEPT}
              className="hidden"
              onChange={handleFileChange}
            />
            {!hasContextItems ? (
              <Popover open={addOpen} onOpenChange={handleAddOpenChange}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      "flex w-full flex-col items-center justify-center gap-1.5 rounded-md border border-dashed px-4 py-6 text-sm transition-colors",
                      draggingFiles
                        ? "border-status-done bg-status-done/10 text-foreground"
                        : "border-border/70 bg-background/40 text-muted-foreground hover:border-border hover:bg-background/70 hover:text-foreground"
                    )}
                  >
                    {draggingFiles ? (
                      <>
                        <Upload className="h-5 w-5" />
                        <span>Drop file to add</span>
                      </>
                    ) : (
                      <>
                        <Plus className="h-5 w-5" />
                        <span>Add files or links</span>
                        <span className="text-[11px] text-muted-foreground/80">
                          Click to add, or drop a file here
                        </span>
                      </>
                    )}
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-72 p-1">
                  {addMode === "menu" ? (
                    <LaunchAddContextMenu
                      onAddFile={handleAddFileFromMenu}
                      onAddLink={handleAddLinkFromMenu}
                    />
                  ) : (
                    <LaunchAddContextLinkForm
                      value={linkDraft}
                      onChange={setLinkDraft}
                      onSubmit={handleAddLinkSubmit}
                      onBack={handleAddLinkBack}
                      isValid={linkDraftIsValid}
                    />
                  )}
                </PopoverContent>
              </Popover>
            ) : (
              <div className="flex flex-wrap items-start gap-3">
                {startupFiles.map((file) => {
                  const key = startupFileKey(file);
                  const preview = startupFilePreviewsRef.current.get(key);
                  return (
                    <div key={key} className="group flex w-12 flex-col gap-0.5">
                      <div className="relative h-12 w-12 overflow-hidden rounded-md border border-border/70 bg-muted/40">
                        {preview ? (
                          <img
                            src={preview}
                            alt=""
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="flex h-full w-full flex-col items-center justify-center text-muted-foreground">
                            <FileText className="h-3.5 w-3.5" />
                            <span className="text-[8px] font-medium tracking-wide">
                              {startupFileExt(file.name)}
                            </span>
                          </div>
                        )}
                        <button
                          type="button"
                          className="absolute -right-2 -top-2 flex h-10 w-10 items-start justify-end rounded-full p-2 text-muted-foreground transition-opacity hover:text-foreground focus:opacity-100 group-hover:opacity-100"
                          onClick={() => handleRemoveStartupFile(file)}
                          aria-label={`Remove ${file.name}`}
                        >
                          <span className="rounded-full border border-border/70 bg-background p-0.5">
                            <X className="h-2.5 w-2.5" />
                          </span>
                        </button>
                      </div>
                      <span
                        className="w-full truncate text-[8px] leading-tight text-muted-foreground"
                        title={file.name}
                      >
                        {file.name}
                      </span>
                    </div>
                  );
                })}
                {startupLinks.map((link) => {
                  const { host, rest } = startupLinkLabel(link);
                  return (
                    <div
                      key={link}
                      className="group relative flex h-12 max-w-[180px] flex-col justify-center gap-0.5 rounded-md border border-border/70 bg-muted/40 px-2 pr-7 leading-tight"
                      title={link}
                    >
                      <div className="flex items-center gap-1 text-[10px] text-foreground">
                        <Link2 className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />
                        <span className="truncate font-medium">{host}</span>
                      </div>
                      {rest ? (
                        <span className="truncate text-[9px] text-muted-foreground">
                          {rest}
                        </span>
                      ) : null}
                      <button
                        type="button"
                        className="absolute -right-2 -top-2 flex h-10 w-10 items-start justify-end rounded-full p-2 text-muted-foreground transition-opacity hover:text-foreground focus:opacity-100 group-hover:opacity-100"
                        onClick={() => handleRemoveStartupLink(link)}
                        aria-label={`Remove ${link}`}
                      >
                        <span className="rounded-full border border-border/70 bg-background p-0.5">
                          <X className="h-2.5 w-2.5" />
                        </span>
                      </button>
                    </div>
                  );
                })}
                <Popover open={addOpen} onOpenChange={handleAddOpenChange}>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      aria-label="Add context"
                      className={cn(
                        "flex h-12 w-12 items-center justify-center rounded-md border border-dashed transition-colors",
                        draggingFiles
                          ? "border-status-done bg-status-done/10 text-foreground"
                          : "border-border/70 bg-background/40 text-muted-foreground hover:border-border hover:bg-background/70 hover:text-foreground"
                      )}
                    >
                      {draggingFiles ? (
                        <Upload className="h-4 w-4" />
                      ) : (
                        <Plus className="h-4 w-4" />
                      )}
                    </button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-72 p-1">
                    {addMode === "menu" ? (
                      <LaunchAddContextMenu
                        onAddFile={handleAddFileFromMenu}
                        onAddLink={handleAddLinkFromMenu}
                      />
                    ) : (
                      <LaunchAddContextLinkForm
                        value={linkDraft}
                        onChange={setLinkDraft}
                        onSubmit={handleAddLinkSubmit}
                        onBack={handleAddLinkBack}
                        isValid={linkDraftIsValid}
                      />
                    )}
                  </PopoverContent>
                </Popover>
              </div>
            )}
          </div>
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
