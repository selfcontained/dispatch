import {
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Check, ChevronDown, ChevronLeft } from "lucide-react";

import { ContextPicker } from "@/components/app/context-picker";
import {
  createClipboardSuggestionFromText,
  getClipboardFilesFromEvent,
  startupFileKey,
} from "@/components/app/create-agent-dialog-clipboard";
import {
  addToCwdHistory,
  CONTEXT_PROMPT_ID,
  LAST_USED_CWD_KEY,
  LAST_USED_TYPE_KEY,
  readCwdHistory,
  readLastUsedAgentType,
  readLastUsedCwd,
  removeCwdFromHistory,
  useCreateAgentPrefs,
} from "@/components/app/create-agent-dialog-utils";
import { WorktreeSection } from "@/components/app/create-agent-worktree-section";
import { PathInput } from "@/components/app/path-input";
import { ActivityBars } from "@/components/ui/activity-bars";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { type Agent } from "@/components/app/types";
import { useClickOutside } from "@/hooks/use-click-outside";
import { useRadixPopoverZFix } from "@/hooks/use-radix-popover-z-fix";
import {
  AGENT_TYPE_LABELS,
  type AgentType,
  sortAgentTypes,
} from "@/lib/agent-types";
import { api } from "@/lib/api";
import { swallowEscapeFromCombobox } from "@/lib/dialog-escape";
import { cn } from "@/lib/utils";

type CreateAgentDialogProps = {
  open: boolean;
  enabledAgentTypes: AgentType[];
  initialAgentType: AgentType | null;
  setOpen: (open: boolean) => void;
  resolveDefaultCwd: () => string;
  onCreated: (agent: Agent, agentType: AgentType) => Promise<void>;
};

export function CreateAgentDialog({
  open,
  enabledAgentTypes,
  initialAgentType,
  setOpen,
  resolveDefaultCwd,
  onCreated,
}: CreateAgentDialogProps): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {open ? (
        <CreateAgentDialogContent
          enabledAgentTypes={enabledAgentTypes}
          initialAgentType={initialAgentType}
          setOpen={setOpen}
          resolveDefaultCwd={resolveDefaultCwd}
          onCreated={onCreated}
        />
      ) : null}
    </Dialog>
  );
}

function CreateAgentDialogContent({
  enabledAgentTypes,
  initialAgentType,
  setOpen,
  resolveDefaultCwd,
  onCreated,
}: Omit<CreateAgentDialogProps, "open">): JSX.Element {
  const [step, setStep] = useState<"config" | "context">("config");
  const promptTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [createName, setCreateName] = useState("");
  const [createType, setCreateType] = useState<AgentType>(() => {
    const preferred = initialAgentType ?? readLastUsedAgentType();
    return preferred && enabledAgentTypes.includes(preferred)
      ? preferred
      : (enabledAgentTypes[0] ?? "codex");
  });
  const [createCwd, setCreateCwd] = useState(() => {
    const resolved = resolveDefaultCwd().trim();
    return resolved || readLastUsedCwd();
  });
  const [createCwdInitialized, setCreateCwdInitialized] = useState(
    () => createCwd.trim().length > 0
  );
  const [createUseWorktree, setCreateUseWorktree] = useState(true);
  const [createWorktreeBranch, setCreateWorktreeBranch] = useState("");
  const [cwdIsGitRepo, setCwdIsGitRepo] = useState<boolean | null>(null);
  const cwdPathInfoRef = useRef<{ isGitRepo: boolean } | null>(null);
  const [initialPrompt, setInitialPrompt] = useState("");
  const [startupFiles, setStartupFiles] = useState<File[]>([]);
  const [startupLinks, setStartupLinks] = useState<string[]>([]);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [contextDraftInvalid, setContextDraftInvalid] = useState(false);
  const [creating, setCreating] = useState(false);
  const [cwdHistory, setCwdHistory] = useState<string[]>(() =>
    readCwdHistory()
  );
  const {
    fullAccess: createFullAccess,
    setFullAccess: setCreateFullAccess,
    autoReview: createAutoReview,
    setAutoReview: setCreateAutoReview,
    baseBranch: createBaseBranch,
    setBaseBranch: setCreateBaseBranch,
    createNewBranch,
    setCreateNewBranch,
  } = useCreateAgentPrefs(createCwd);

  // The new-branch name is per-cwd in spirit (a branch named "repo-A-feature"
  // doesn't make sense in repo B); clear it whenever cwd changes so a name
  // typed for one repo doesn't leak into another.
  useEffect(() => {
    setCreateWorktreeBranch("");
  }, [createCwd]);

  useEffect(() => {
    if (createCwdInitialized) return;
    let cancelled = false;

    void api<{ homeDir: string }>("/api/v1/system/defaults")
      .then((payload) => {
        if (cancelled) return;
        setCreateCwd(payload.homeDir);
        setCreateCwdInitialized(true);
      })
      .catch(() => {
        if (cancelled) return;
        setCreateCwdInitialized(true);
      });

    return () => {
      cancelled = true;
    };
  }, [createCwdInitialized]);

  useEffect(() => {
    if (enabledAgentTypes.includes(createType)) return;
    setCreateType(enabledAgentTypes[0] ?? "codex");
  }, [createType, enabledAgentTypes]);

  useEffect(() => {
    if (step === "context") {
      requestAnimationFrame(() => promptTextareaRef.current?.focus());
    }
  }, [step]);

  useEffect(() => {
    if (step !== "context") {
      setDraggingFiles(false);
    }
  }, [step]);

  const [typeDropdownOpen, setTypeDropdownOpen] = useState(false);
  const typeCmdRef = useRef<HTMLDivElement>(null);
  const typeTriggerRef = useRef<HTMLButtonElement>(null);
  const closeTypeDropdown = useCallback(() => setTypeDropdownOpen(false), []);
  useClickOutside(typeCmdRef, typeDropdownOpen, closeTypeDropdown);

  const handleRemoveCwdHistory = useCallback((cwd: string) => {
    setCwdHistory(removeCwdFromHistory(cwd));
  }, []);

  const handlePathInfoChange = useCallback(
    (info: { isGitRepo: boolean } | null) => {
      cwdPathInfoRef.current = info;
      setCwdIsGitRepo(info ? info.isGitRepo : null);
    },
    []
  );

  // Object URLs for image previews are tracked in a ref so they're created
  // and revoked synchronously alongside the file list, not derived from an
  // effect — that avoids both a one-frame paperclip→thumbnail flicker on add
  // and unnecessary URL churn for unchanged chips on every mutation.
  const startupFilePreviewsRef = useRef<Map<string, string>>(new Map());

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

  const handleAddLink = useCallback((url: string) => {
    setStartupLinks((current) =>
      current.includes(url) ? current : [...current, url]
    );
  }, []);

  const handleStartupPaste = useCallback(
    (event: ClipboardEvent<HTMLElement>) => {
      const target = event.target;
      const targetIsPrompt =
        target instanceof HTMLElement && target.id === CONTEXT_PROMPT_ID;
      if (!targetIsPrompt) return;

      const pastedFiles = getClipboardFilesFromEvent(event);
      if (pastedFiles.length > 0) {
        event.preventDefault();
        appendStartupFiles(pastedFiles);
        return;
      }

      const textSuggestion = createClipboardSuggestionFromText(
        event.clipboardData.getData("text/plain")
      );
      if (textSuggestion?.kind === "url") {
        event.preventDefault();
        handleAddLink(textSuggestion.url);
      }
    },
    [appendStartupFiles, handleAddLink]
  );

  const handleStartupDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      const droppedFiles = Array.from(event.dataTransfer.files ?? []);
      if (droppedFiles.length === 0) return;
      event.preventDefault();
      setDraggingFiles(false);
      appendStartupFiles(droppedFiles);
    },
    [appendStartupFiles]
  );

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

  useEffect(() => {
    const previews = startupFilePreviewsRef.current;
    return () => {
      for (const url of previews.values()) {
        URL.revokeObjectURL(url);
      }
      previews.clear();
    };
  }, []);

  const handleRemoveStartupLink = useCallback((linkToRemove: string) => {
    setStartupLinks((current) =>
      current.filter((link) => link !== linkToRemove)
    );
  }, []);

  const handleClipboardText = useCallback((text: string) => {
    setInitialPrompt((current) =>
      current.trim().length === 0 ? text : `${current.trimEnd()}\n\n${text}`
    );
    requestAnimationFrame(() => promptTextareaRef.current?.focus());
  }, []);

  const enterContextStep = useCallback(() => {
    setStep("context");
  }, []);

  useRadixPopoverZFix();

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const cwd = createCwd.trim();
      if (!cwd) return;

      setCreating(true);
      try {
        // The managed-worktree section is hidden for non-git cwds; force the
        // payload to skip worktree creation in that case so the server doesn't
        // try to run git in a non-repo directory.
        const latestPathInfo = cwdPathInfoRef.current;
        const submitUseWorktree =
          latestPathInfo?.isGitRepo === false ? false : createUseWorktree;
        const contextInitialPrompt =
          step === "context" ? initialPrompt.trim() || undefined : undefined;
        const payloadBase = {
          name: createName.trim(),
          cwd,
          type: createType,
          fullAccess: createFullAccess,
          autoReview: createAutoReview,
          useWorktree: submitUseWorktree,
          createNewBranch: submitUseWorktree ? createNewBranch : undefined,
          worktreeBranch:
            submitUseWorktree && createNewBranch
              ? createWorktreeBranch.trim() || undefined
              : undefined,
          baseBranch:
            submitUseWorktree && createBaseBranch !== "main"
              ? createBaseBranch
              : undefined,
          initialPrompt: contextInitialPrompt,
        };
        const resolvedStartupLinks = startupLinks;
        const useStartupContext =
          step === "context" &&
          (startupFiles.length > 0 || resolvedStartupLinks.length > 0);
        const payload = useStartupContext
          ? await (async () => {
              const formData = new FormData();
              for (const [key, value] of Object.entries(payloadBase)) {
                if (value === undefined || value === "") continue;
                formData.append(key, String(value));
              }
              formData.append(
                "startupLinks",
                JSON.stringify(resolvedStartupLinks)
              );
              for (const file of startupFiles) {
                formData.append("startupFiles", file);
              }
              return api<{ agent: Agent }>("/api/v1/agents", {
                method: "POST",
                body: formData,
              });
            })()
          : await api<{ agent: Agent }>("/api/v1/agents", {
              method: "POST",
              body: JSON.stringify(payloadBase),
            });

        if (typeof window !== "undefined") {
          window.localStorage.setItem(LAST_USED_CWD_KEY, cwd);
          window.localStorage.setItem(LAST_USED_TYPE_KEY, createType);
        }
        setCwdHistory(addToCwdHistory(cwd));
        await onCreated(payload.agent, createType);
      } finally {
        setCreating(false);
      }
    },
    [
      createAutoReview,
      createBaseBranch,
      createCwd,
      createFullAccess,
      createName,
      createNewBranch,
      createType,
      createUseWorktree,
      createWorktreeBranch,
      initialPrompt,
      onCreated,
      startupFiles,
      startupLinks,
      step,
    ]
  );

  const worktreeAvailable = cwdIsGitRepo !== false;
  const worktreeChecked = worktreeAvailable && createUseWorktree;

  return (
    <DialogContent
      onEscapeKeyDown={(e) => {
        swallowEscapeFromCombobox(e);
        if (e.defaultPrevented) return;
        if (typeDropdownOpen) {
          e.preventDefault();
        }
        if (step === "context") {
          e.preventDefault();
          setStep("config");
        }
      }}
    >
      {step === "config" ? (
        <>
          <DialogHeader>
            <DialogTitle>Create Agent</DialogTitle>
            <DialogDescription>
              Name, type, and working directory for a new agent session.
            </DialogDescription>
          </DialogHeader>

          <form
            data-testid="create-agent-form"
            className="flex min-h-0 flex-col"
            onSubmit={(event) => void handleSubmit(event)}
          >
            <div className="min-h-0 flex-1 overflow-y-auto px-1">
              <div className="space-y-3">
                <div className="relative space-y-1" ref={typeCmdRef}>
                  <label className="text-sm text-muted-foreground">Type</label>
                  <button
                    ref={typeTriggerRef}
                    type="button"
                    role="combobox"
                    tabIndex={0}
                    aria-expanded={typeDropdownOpen}
                    onClick={() => setTypeDropdownOpen((prev) => !prev)}
                    onKeyDown={(e) => {
                      if (
                        e.key === "ArrowDown" ||
                        e.key === "Enter" ||
                        e.key === " "
                      ) {
                        e.preventDefault();
                        if (!typeDropdownOpen) setTypeDropdownOpen(true);
                      }
                    }}
                    className={cn(
                      "flex h-9 w-full items-center justify-between rounded-md border border-white/[0.12] bg-white/[0.04] px-3 py-2 text-sm shadow-[inset_0_2px_6px_rgba(0,0,0,0.3)] backdrop-blur-md",
                      "ring-offset-background focus:outline-none focus:ring-1 focus:ring-ring"
                    )}
                  >
                    {AGENT_TYPE_LABELS[createType]}
                    <ChevronDown
                      className={cn(
                        "h-4 w-4 text-muted-foreground transition-transform",
                        typeDropdownOpen && "rotate-180"
                      )}
                    />
                  </button>
                  {typeDropdownOpen ? (
                    <div className="absolute left-0 right-0 z-[80] mt-1 rounded-md border border-white/[0.2] bg-[hsl(var(--card))] shadow-[0_16px_64px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.15)] backdrop-blur-2xl">
                      <Command
                        shouldFilter={false}
                        ref={(el) => {
                          if (el) requestAnimationFrame(() => el.focus());
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") {
                            e.preventDefault();
                            setTypeDropdownOpen(false);
                            requestAnimationFrame(() =>
                              typeTriggerRef.current?.focus()
                            );
                          }
                        }}
                      >
                        <CommandList>
                          <CommandGroup>
                            {sortAgentTypes(enabledAgentTypes).map(
                              (agentType) => (
                                <CommandItem
                                  key={agentType}
                                  value={agentType}
                                  onSelect={() => {
                                    setCreateType(agentType);
                                    setTypeDropdownOpen(false);
                                    requestAnimationFrame(() =>
                                      typeTriggerRef.current?.focus()
                                    );
                                  }}
                                >
                                  <Check
                                    className={cn(
                                      "mr-2 h-3 w-3 shrink-0",
                                      agentType === createType
                                        ? "opacity-100"
                                        : "opacity-0"
                                    )}
                                  />
                                  {AGENT_TYPE_LABELS[agentType]}
                                </CommandItem>
                              )
                            )}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </div>
                  ) : null}
                </div>

                <div className="space-y-1">
                  <label className="text-sm text-muted-foreground">Name</label>
                  <Input
                    autoFocus
                    value={createName}
                    onChange={(event) => setCreateName(event.target.value)}
                    placeholder="agent name"
                    data-testid="create-agent-name"
                  />
                  <p className="text-xs text-muted-foreground">
                    Leave blank and the agent will set its own name based on the
                    task.
                  </p>
                </div>

                <PathInput
                  value={createCwd}
                  onChange={setCreateCwd}
                  label="Working directory"
                  history={cwdHistory}
                  onRemoveHistory={handleRemoveCwdHistory}
                  onPathInfoChange={handlePathInfoChange}
                  data-testid="create-agent-cwd"
                  historyItemTestId="create-agent-cwd-history-option"
                />

                <WorktreeSection
                  cwd={createCwd}
                  worktreeAvailable={worktreeAvailable}
                  worktreeChecked={worktreeChecked}
                  useWorktree={createUseWorktree}
                  onUseWorktreeChange={setCreateUseWorktree}
                  baseBranch={createBaseBranch}
                  onBaseBranchChange={setCreateBaseBranch}
                  worktreeBranch={createWorktreeBranch}
                  onWorktreeBranchChange={setCreateWorktreeBranch}
                  createNewBranch={createNewBranch}
                  onCreateNewBranchChange={setCreateNewBranch}
                />

                {createType !== "terminal" ? (
                  <>
                    <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-3">
                      <Checkbox
                        checked={createFullAccess}
                        onCheckedChange={() =>
                          setCreateFullAccess((current) => !current)
                        }
                        className="mt-0.5"
                        title="Toggle full access"
                      />
                      <span className="space-y-1">
                        <span className="block text-sm font-medium text-foreground">
                          Start in full access mode
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          Starts the selected agent with its most permissive
                          supported execution mode.
                        </span>
                      </span>
                    </label>

                    <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-3">
                      <Checkbox
                        checked={createAutoReview}
                        onCheckedChange={() =>
                          setCreateAutoReview((current) => !current)
                        }
                        className="mt-0.5"
                        title="Toggle autonomous review"
                        data-testid="create-agent-auto-review"
                      />
                      <span className="space-y-1">
                        <span className="block text-sm font-medium text-foreground">
                          Autonomous Review
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          Agent will launch one review agent and address
                          feedback before completing.
                        </span>
                      </span>
                    </label>
                  </>
                ) : null}
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-3">
              <Button
                type="button"
                variant="ghost"
                tabIndex={0}
                onClick={() => setOpen(false)}
                data-testid="create-agent-cancel"
              >
                Cancel
              </Button>
              {createType !== "terminal" ? (
                <Button
                  type="button"
                  variant="default"
                  tabIndex={0}
                  disabled={creating || !createCwd.trim()}
                  data-testid="create-agent-with-context"
                  onClick={enterContextStep}
                >
                  Create with context
                </Button>
              ) : null}
              <Button
                type="submit"
                variant="primary"
                tabIndex={0}
                disabled={creating}
                data-testid="create-agent-submit"
              >
                {creating ? (
                  <ActivityBars size={16} className="mr-1.5" />
                ) : null}
                Create
              </Button>
            </div>
          </form>
        </>
      ) : (
        <>
          <DialogHeader>
            <DialogTitle>Create with context</DialogTitle>
            <DialogDescription>
              Add startup instructions, files, and links for the agent to use
              when the session starts.
            </DialogDescription>
          </DialogHeader>

          <form
            data-testid="create-agent-context-form"
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(event) => void handleSubmit(event)}
            onDragOver={(event) => {
              if (event.dataTransfer.types.includes("Files")) {
                event.preventDefault();
                setDraggingFiles(true);
              }
            }}
            onDragLeave={(event) => {
              if (
                event.currentTarget.contains(event.relatedTarget as Node | null)
              ) {
                return;
              }
              setDraggingFiles(false);
            }}
            onDrop={handleStartupDrop}
          >
            <div
              className={cn(
                "min-h-0 flex-1 overflow-y-auto rounded-lg px-1 pb-1"
              )}
            >
              <div className="space-y-3">
                <div className="space-y-1">
                  <label
                    htmlFor={CONTEXT_PROMPT_ID}
                    className="text-sm text-muted-foreground"
                  >
                    Instructions
                  </label>
                  <textarea
                    id={CONTEXT_PROMPT_ID}
                    ref={promptTextareaRef}
                    value={initialPrompt}
                    onChange={(event) => setInitialPrompt(event.target.value)}
                    onPaste={handleStartupPaste}
                    placeholder="Enter instructions for the agent..."
                    data-testid="create-agent-initial-prompt"
                    className={cn(
                      "flex min-h-[180px] w-full resize-y rounded-md border border-white/[0.12] bg-white/[0.04] px-3 py-2 text-sm shadow-[inset_0_2px_6px_rgba(0,0,0,0.3)] backdrop-blur-md",
                      "ring-offset-background placeholder:text-muted-foreground",
                      "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    )}
                  />
                </div>

                <ContextPicker
                  files={startupFiles}
                  links={startupLinks}
                  draggingFiles={draggingFiles}
                  filePreviewsRef={startupFilePreviewsRef}
                  onAppendFiles={appendStartupFiles}
                  onRemoveFile={handleRemoveStartupFile}
                  onAddLink={handleAddLink}
                  onRemoveLink={handleRemoveStartupLink}
                  onClipboardText={handleClipboardText}
                  onDraftInvalid={setContextDraftInvalid}
                  testIdPrefix="create-agent-context"
                />
              </div>
            </div>

            <div className="flex justify-between gap-2 border-t border-white/[0.08] pt-3">
              <Button
                type="button"
                variant="ghost"
                tabIndex={0}
                className="min-h-11 px-3"
                onClick={() => setStep("config")}
                data-testid="create-agent-context-back"
              >
                <ChevronLeft className="mr-1 h-4 w-4" />
                Back
              </Button>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  tabIndex={0}
                  className="min-h-11 px-3"
                  onClick={() => setOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  tabIndex={0}
                  className="min-h-11 px-3"
                  disabled={creating || contextDraftInvalid}
                  data-testid="create-agent-context-submit"
                >
                  {creating ? (
                    <ActivityBars size={16} className="mr-1.5" />
                  ) : null}
                  Create
                </Button>
              </div>
            </div>
          </form>
        </>
      )}
    </DialogContent>
  );
}
