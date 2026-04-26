import {
  type ChangeEvent,
  type ClipboardEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAtom } from "jotai";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  FileText,
  GitBranch,
  Link2,
  Plus,
  X,
} from "lucide-react";

import { BranchSelect } from "@/components/app/branch-select";
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
import {
  AGENT_TYPE_LABELS,
  type AgentType,
  isAgentType,
} from "@/lib/agent-types";
import { api } from "@/lib/api";
import { swallowEscapeFromCombobox } from "@/lib/dialog-escape";
import { createNewBranchPrefAtom } from "@/lib/store";
import { cn } from "@/lib/utils";

const LAST_USED_CWD_KEY = "dispatch:lastUsedAgentCwd";
const LAST_USED_TYPE_KEY = "dispatch:lastUsedAgentType";
const CWD_HISTORY_KEY = "dispatch:cwdHistory";
const CWD_HISTORY_MAX = 20;
const FULL_ACCESS_PREFIX = "dispatch:fullAccess:";
const AUTO_REVIEW_PREFIX = "dispatch:autoReview:";
const BASE_BRANCH_PREFIX = "dispatch:baseBranch:";
const STARTUP_FILE_ACCEPT =
  ".png,.jpg,.jpeg,.gif,.webp,.mp4,.pdf,.txt,.md,.json,.yaml,.yml,.toml,.csv,.log,.xml,.html,.css,.js,.jsx,.ts,.tsx,.py,.go,.rs,.sh,.sql,.diff,.patch,.env,.ini,.cfg,.conf,.swift,.kt,.java,.c,.cpp,.h,.hpp,.rb,.php,.lua,.zig,.nim,.r,.m,.ex,.exs,.erl,.hs";

function startupFileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function startupFileExt(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1
    ? "FILE"
    : name
        .slice(dot + 1)
        .toUpperCase()
        .slice(0, 4);
}

function readStoredString(key: string): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(key)?.trim() ?? "";
}

function readStoredBoolean(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  const value = window.localStorage.getItem(key);
  if (value === null) return fallback;
  return value === "true";
}

function readLastUsedCwd(): string {
  return readStoredString(LAST_USED_CWD_KEY) || "~/";
}

function readLastUsedAgentType(): AgentType | null {
  const stored = readStoredString(LAST_USED_TYPE_KEY);
  return stored && isAgentType(stored) ? stored : null;
}

function readCwdHistory(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(CWD_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string" && v.length > 0)
      : [];
  } catch {
    return [];
  }
}

function writeCwdHistory(nextHistory: string[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(CWD_HISTORY_KEY, JSON.stringify(nextHistory));
}

function addToCwdHistory(cwd: string): string[] {
  const trimmed = cwd.trim();
  if (!trimmed) return readCwdHistory();
  const existing = readCwdHistory().filter((entry) => entry !== trimmed);
  const updated = [trimmed, ...existing].slice(0, CWD_HISTORY_MAX);
  writeCwdHistory(updated);
  return updated;
}

function removeCwdFromHistory(cwd: string): string[] {
  const next = readCwdHistory().filter((entry) => entry !== cwd);
  writeCwdHistory(next);
  return next;
}

function useCreateAgentPrefs(cwd: string) {
  const trimmedCwd = cwd.trim();
  const [fullAccess, setFullAccess] = useState(false);
  const [autoReview, setAutoReview] = useState(false);
  const [baseBranch, setBaseBranch] = useState("main");

  // createNewBranch is per-cwd persisted via a jotai atomFamily — the atom's
  // identity changes with cwd, so reads/writes route to the correct
  // localStorage entry without manual load/write effects.
  const createNewBranchAtom = useMemo(
    () => createNewBranchPrefAtom(trimmedCwd),
    [trimmedCwd]
  );
  const [createNewBranch, setCreateNewBranch] = useAtom(createNewBranchAtom);

  useEffect(() => {
    if (!trimmedCwd) {
      setFullAccess(false);
      setAutoReview(false);
      setBaseBranch("main");
      return;
    }
    setFullAccess(
      readStoredBoolean(`${FULL_ACCESS_PREFIX}${trimmedCwd}`, false)
    );
    setAutoReview(
      readStoredBoolean(`${AUTO_REVIEW_PREFIX}${trimmedCwd}`, false)
    );
    setBaseBranch(
      readStoredString(`${BASE_BRANCH_PREFIX}${trimmedCwd}`) || "main"
    );
  }, [trimmedCwd]);

  useEffect(() => {
    if (!trimmedCwd || typeof window === "undefined") return;
    window.localStorage.setItem(
      `${FULL_ACCESS_PREFIX}${trimmedCwd}`,
      String(fullAccess)
    );
  }, [fullAccess, trimmedCwd]);

  useEffect(() => {
    if (!trimmedCwd || typeof window === "undefined") return;
    window.localStorage.setItem(
      `${AUTO_REVIEW_PREFIX}${trimmedCwd}`,
      String(autoReview)
    );
  }, [autoReview, trimmedCwd]);

  useEffect(() => {
    if (!trimmedCwd || typeof window === "undefined") return;
    window.localStorage.setItem(
      `${BASE_BRANCH_PREFIX}${trimmedCwd}`,
      baseBranch
    );
  }, [baseBranch, trimmedCwd]);

  return {
    fullAccess,
    setFullAccess,
    autoReview,
    setAutoReview,
    baseBranch,
    setBaseBranch,
    createNewBranch,
    setCreateNewBranch,
  };
}

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
  const startupFileInputRef = useRef<HTMLInputElement>(null);
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
  const [initialPrompt, setInitialPrompt] = useState("");
  const [startupFiles, setStartupFiles] = useState<File[]>([]);
  const [startupLinks, setStartupLinks] = useState<string[]>([]);
  const [linkDraft, setLinkDraft] = useState("");
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

  const handleStartupPaste = useCallback(
    (event: ClipboardEvent<HTMLElement>) => {
      const pastedFiles = Array.from(event.clipboardData.items)
        .filter((item) => item.kind === "file")
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null);
      if (pastedFiles.length === 0) return;
      event.preventDefault();
      appendStartupFiles(pastedFiles);
    },
    [appendStartupFiles]
  );

  const handleStartupFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const selected = Array.from(event.target.files ?? []);
      appendStartupFiles(selected);
      event.target.value = "";
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

  const addStartupLink = useCallback(() => {
    const trimmed = linkDraft.trim();
    if (!trimmed) return;
    setStartupLinks((current) =>
      current.includes(trimmed) ? current : [...current, trimmed]
    );
    setLinkDraft("");
  }, [linkDraft]);

  const handleRemoveStartupLink = useCallback((linkToRemove: string) => {
    setStartupLinks((current) =>
      current.filter((link) => link !== linkToRemove)
    );
  }, []);

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
        const submitUseWorktree =
          cwdIsGitRepo === false ? false : createUseWorktree;
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
          initialPrompt: initialPrompt.trim() || undefined,
        };
        const resolvedStartupLinks =
          step === "context" && linkDraft.trim()
            ? Array.from(new Set([...startupLinks, linkDraft.trim()]))
            : startupLinks;
        const useStartupContext =
          step === "context" &&
          (payloadBase.initialPrompt ||
            startupFiles.length > 0 ||
            resolvedStartupLinks.length > 0);
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
      cwdIsGitRepo,
      initialPrompt,
      onCreated,
      linkDraft,
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
                            {enabledAgentTypes.map((agentType) => (
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
                            ))}
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

                <div
                  className={cn(
                    "space-y-2 rounded-md border border-border/70 bg-muted/20 px-3 py-3 transition-opacity duration-200",
                    !worktreeAvailable && "opacity-60"
                  )}
                  data-testid="create-agent-worktree-section"
                >
                  <label
                    className={cn(
                      "flex items-start gap-3",
                      worktreeAvailable
                        ? "cursor-pointer"
                        : "cursor-not-allowed"
                    )}
                  >
                    <Checkbox
                      checked={worktreeChecked}
                      onCheckedChange={() =>
                        setCreateUseWorktree((current) => !current)
                      }
                      disabled={!worktreeAvailable}
                      className="mt-0.5"
                      title={
                        worktreeAvailable
                          ? "Toggle managed git worktree"
                          : "Not a git repository"
                      }
                      data-testid="create-agent-worktree"
                    />
                    <span className="space-y-1">
                      <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                        <GitBranch className="h-3.5 w-3.5" />
                        Create managed git worktree
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {worktreeAvailable
                          ? "Creates an isolated worktree for this agent. Dispatch tracks and cleans it up when the agent is archived."
                          : "Working directory isn't a git repository, so a managed worktree isn't available here."}
                      </span>
                    </span>
                  </label>
                  <div
                    className={cn(
                      "grid transition-[grid-template-rows,opacity] duration-200 ease-out",
                      worktreeChecked
                        ? "grid-rows-[1fr] opacity-100"
                        : "grid-rows-[0fr] opacity-0"
                    )}
                    aria-hidden={!worktreeChecked}
                    // Keep collapsed controls out of focus and pointer
                    // interaction. Cast for React 18 type defs.
                    {...(!worktreeChecked
                      ? ({ inert: "" } as Record<string, string>)
                      : {})}
                  >
                    <div className="min-h-0 overflow-hidden">
                      <div className="ml-8 w-[calc(100%-2rem)] space-y-3 pt-1">
                        <BranchSelect
                          cwd={createCwd}
                          baseBranch={createBaseBranch}
                          onBaseBranchChange={setCreateBaseBranch}
                          worktreeBranch={createWorktreeBranch}
                          onWorktreeBranchChange={setCreateWorktreeBranch}
                          baseBranchLabel="Starting branch"
                          baseBranchHelper="The branch to check out in the worktree."
                          showNewBranchInput={false}
                          testIdPrefix="create-agent"
                        />
                        <div className="space-y-2 rounded-md border border-border/60 bg-background/40 px-3 py-3">
                          <label className="flex cursor-pointer items-start gap-3">
                            <Checkbox
                              checked={createNewBranch}
                              onCheckedChange={() =>
                                setCreateNewBranch((current) => !current)
                              }
                              className="mt-0.5"
                              title="Toggle new branch creation"
                              data-testid="create-agent-new-branch"
                            />
                            <span className="space-y-1">
                              <span className="block text-sm font-medium text-foreground">
                                Create a new branch in this worktree
                              </span>
                              <span className="block text-xs text-muted-foreground">
                                Creates a new working branch from the starting
                                branch so the agent can make isolated changes
                                for later submission.
                              </span>
                            </span>
                          </label>
                          <div
                            className={cn(
                              "grid transition-[grid-template-rows,opacity] duration-200 ease-out",
                              createNewBranch
                                ? "grid-rows-[1fr] opacity-100"
                                : "grid-rows-[0fr] opacity-0"
                            )}
                            aria-hidden={!createNewBranch}
                            {...(!createNewBranch
                              ? ({ inert: "" } as Record<string, string>)
                              : {})}
                          >
                            <div className="min-h-0 overflow-hidden">
                              <div className="space-y-1 pt-2">
                                <label className="block text-xs text-muted-foreground">
                                  New branch name
                                </label>
                                <Input
                                  value={createWorktreeBranch}
                                  onChange={(event) =>
                                    setCreateWorktreeBranch(event.target.value)
                                  }
                                  placeholder="auto-generated if empty"
                                  data-testid="create-agent-worktree-branch"
                                />
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

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
                  onClick={() => setStep("context")}
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
            className="space-y-3"
            onSubmit={(event) => void handleSubmit(event)}
            onPaste={handleStartupPaste}
          >
            <div className="space-y-1">
              <label className="text-sm text-muted-foreground">
                Instructions
              </label>
              <textarea
                ref={promptTextareaRef}
                value={initialPrompt}
                onChange={(event) => setInitialPrompt(event.target.value)}
                placeholder="Enter instructions for the agent..."
                data-testid="create-agent-initial-prompt"
                className={cn(
                  "flex min-h-[180px] w-full resize-y rounded-md border border-white/[0.12] bg-white/[0.04] px-3 py-2 text-sm shadow-[inset_0_2px_6px_rgba(0,0,0,0.3)] backdrop-blur-md",
                  "ring-offset-background placeholder:text-muted-foreground",
                  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                )}
              />
            </div>

            <div className="space-y-3 rounded-md border border-border/70 bg-muted/20 px-3 py-3">
              <div>
                <div className="text-sm font-medium text-foreground">Files</div>
                <p className="text-xs text-muted-foreground">
                  Attach images or documents.
                </p>
              </div>
              <input
                ref={startupFileInputRef}
                type="file"
                multiple
                accept={STARTUP_FILE_ACCEPT}
                className="hidden"
                onChange={handleStartupFileChange}
                data-testid="create-agent-context-files-input"
              />
              {startupFiles.length === 0 ? (
                <button
                  type="button"
                  onClick={() => startupFileInputRef.current?.click()}
                  data-testid="create-agent-context-files-button"
                  className="flex w-full flex-col items-center justify-center gap-1.5 rounded-md border border-dashed border-border/70 bg-background/40 px-4 py-6 text-sm text-muted-foreground transition-colors hover:border-border hover:bg-background/70 hover:text-foreground"
                >
                  <Plus className="h-5 w-5" />
                  <span>Add images or documents</span>
                </button>
              ) : (
                <div className="flex flex-wrap gap-3">
                  {startupFiles.map((file) => {
                    const key = startupFileKey(file);
                    const preview = startupFilePreviewsRef.current.get(key);
                    return (
                      <div
                        key={key}
                        className="group flex w-[88px] flex-col gap-1.5"
                      >
                        <div className="relative h-[72px] w-[72px] overflow-hidden rounded-md border border-border/70 bg-muted/40">
                          {preview ? (
                            <img
                              src={preview}
                              alt=""
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-muted-foreground">
                              <FileText className="h-6 w-6" />
                              <span className="text-[10px] font-medium tracking-wide">
                                {startupFileExt(file.name)}
                              </span>
                            </div>
                          )}
                          <button
                            type="button"
                            className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-background/80 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus:opacity-100 group-hover:opacity-100"
                            onClick={() => handleRemoveStartupFile(file)}
                            aria-label={`Remove ${file.name}`}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                        <span
                          className="w-[72px] truncate text-[11px] text-muted-foreground"
                          title={file.name}
                        >
                          {file.name}
                        </span>
                      </div>
                    );
                  })}
                  <button
                    type="button"
                    onClick={() => startupFileInputRef.current?.click()}
                    data-testid="create-agent-context-files-button"
                    aria-label="Add more files"
                    className="flex h-[72px] w-[72px] flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border/70 bg-background/40 text-[11px] text-muted-foreground transition-colors hover:border-border hover:bg-background/70 hover:text-foreground"
                  >
                    <Plus className="h-5 w-5" />
                    <span>Add</span>
                  </button>
                </div>
              )}
            </div>

            <div className="space-y-2 rounded-md border border-border/70 bg-muted/20 px-3 py-3">
              <div>
                <div className="text-sm font-medium text-foreground">Links</div>
                <p className="text-xs text-muted-foreground">
                  Add one or more URLs to pin into the new session.
                </p>
              </div>
              <div className="flex gap-2">
                <Input
                  value={linkDraft}
                  onChange={(event) => setLinkDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addStartupLink();
                    }
                  }}
                  placeholder="https://..."
                  data-testid="create-agent-context-link-input"
                />
                <Button
                  type="button"
                  variant="default"
                  onClick={addStartupLink}
                  data-testid="create-agent-context-link-add"
                >
                  <Plus className="mr-1.5 h-3.5 w-3.5" />
                  Add
                </Button>
              </div>
              {startupLinks.length > 0 ? (
                <div className="space-y-2">
                  {startupLinks.map((link) => (
                    <div
                      key={link}
                      className="flex items-center gap-2 rounded-md border border-border/70 bg-background/70 px-3 py-2 text-xs text-foreground"
                    >
                      <Link2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{link}</span>
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground"
                        onClick={() => handleRemoveStartupLink(link)}
                        aria-label={`Remove ${link}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No links added yet.
                </p>
              )}
            </div>

            <div className="flex justify-between pt-1">
              <Button
                type="button"
                variant="ghost"
                tabIndex={0}
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
                  onClick={() => setOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  tabIndex={0}
                  disabled={creating}
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
