import {
  type FormEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Check,
  ChevronDown,
  GitBranch,
  Loader2,
  ChevronLeft,
} from "lucide-react";

import { PathInput } from "@/components/app/path-input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandLoading,
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
import {
  AGENT_TYPE_LABELS,
  type AgentType,
  isAgentType,
} from "@/lib/agent-types";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

const LAST_USED_CWD_KEY = "dispatch:lastUsedAgentCwd";
const LAST_USED_TYPE_KEY = "dispatch:lastUsedAgentType";
const CWD_HISTORY_KEY = "dispatch:cwdHistory";
const CWD_HISTORY_MAX = 20;
const FULL_ACCESS_PREFIX = "dispatch:fullAccess:";
const AUTO_REVIEW_PREFIX = "dispatch:autoReview:";
const BASE_BRANCH_PREFIX = "dispatch:baseBranch:";

function useClickOutside(
  ref: React.RefObject<HTMLElement | null>,
  isOpen: boolean,
  onClose: () => void
): void {
  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [ref, isOpen, onClose]);
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
  const [step, setStep] = useState<"config" | "prompt">("config");
  const promptTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [createName, setCreateName] = useState("");
  const [createType, setCreateType] = useState<AgentType>(
    initialAgentType && enabledAgentTypes.includes(initialAgentType)
      ? initialAgentType
      : (enabledAgentTypes[0] ?? "codex")
  );
  const [createCwd, setCreateCwd] = useState(() => readLastUsedCwd());
  const [createCwdInitialized, setCreateCwdInitialized] = useState(
    () => readLastUsedCwd().trim().length > 0
  );
  const [createUseWorktree, setCreateUseWorktree] = useState(true);
  const [createWorktreeBranch, setCreateWorktreeBranch] = useState("");
  const [initialPrompt, setInitialPrompt] = useState("");
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
  } = useCreateAgentPrefs(createCwd);

  useLayoutEffect(() => {
    if (!open) {
      setStep("config");
      return;
    }

    setCreateName("");
    setCreateUseWorktree(true);
    setCreateWorktreeBranch("");
    setInitialPrompt("");
    setCwdHistory(readCwdHistory());

    const resolvedCwd = resolveDefaultCwd().trim();
    const storedCwd = readLastUsedCwd();
    const nextCwd = resolvedCwd || storedCwd;
    setCreateCwd(nextCwd);
    setCreateCwdInitialized(nextCwd.length > 0);

    const preferredType = initialAgentType ?? readLastUsedAgentType();
    setCreateType(
      preferredType && enabledAgentTypes.includes(preferredType)
        ? preferredType
        : (enabledAgentTypes[0] ?? "codex")
    );
  }, [enabledAgentTypes, initialAgentType, open, resolveDefaultCwd]);

  useEffect(() => {
    if (!open || createCwdInitialized) return;
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
  }, [createCwdInitialized, open]);

  useEffect(() => {
    if (enabledAgentTypes.includes(createType)) return;
    setCreateType(enabledAgentTypes[0] ?? "codex");
  }, [createType, enabledAgentTypes]);

  useEffect(() => {
    if (step === "prompt") {
      requestAnimationFrame(() => promptTextareaRef.current?.focus());
    }
  }, [step]);

  const [typeDropdownOpen, setTypeDropdownOpen] = useState(false);
  const typeCmdRef = useRef<HTMLDivElement>(null);
  const typeTriggerRef = useRef<HTMLButtonElement>(null);
  const closeTypeDropdown = useCallback(() => setTypeDropdownOpen(false), []);
  useClickOutside(typeCmdRef, typeDropdownOpen, closeTypeDropdown);

  const [branchDropdownOpen, setBranchDropdownOpen] = useState(false);
  const [remoteBranches, setRemoteBranches] = useState<string[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchesFetchedForCwd, setBranchesFetchedForCwd] = useState<
    string | null
  >(null);
  const branchCmdRef = useRef<HTMLDivElement>(null);
  const branchTriggerRef = useRef<HTMLButtonElement>(null);
  const branchInputRef = useRef<HTMLInputElement>(null);
  const closeBranchDropdown = useCallback(
    () => setBranchDropdownOpen(false),
    []
  );
  useClickOutside(branchCmdRef, branchDropdownOpen, closeBranchDropdown);

  const fetchBranches = useCallback(async () => {
    const cwd = createCwd.trim();
    if (!cwd) return;
    setBranchesLoading(true);
    setRemoteBranches([]);
    try {
      const result = await api<{ branches: string[] }>(
        `/api/v1/git/branches?cwd=${encodeURIComponent(cwd)}`
      );
      setRemoteBranches(result.branches);
      if (!result.branches.includes(createBaseBranch)) {
        setCreateBaseBranch(result.branches[0] ?? "main");
      }
    } catch {
      setRemoteBranches([]);
    } finally {
      setBranchesLoading(false);
      setBranchesFetchedForCwd(cwd);
    }
  }, [createBaseBranch, createCwd, setCreateBaseBranch]);

  const openBranchDropdown = useCallback(() => {
    setBranchDropdownOpen(true);
    if (branchesFetchedForCwd !== createCwd.trim()) {
      void fetchBranches();
    }
    requestAnimationFrame(() => branchInputRef.current?.focus());
  }, [branchesFetchedForCwd, createCwd, fetchBranches]);

  const allBranches = useMemo(
    () =>
      remoteBranches.includes("main")
        ? remoteBranches
        : ["main", ...remoteBranches],
    [remoteBranches]
  );

  const handleRemoveCwdHistory = useCallback((cwd: string) => {
    setCwdHistory(removeCwdFromHistory(cwd));
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const cwd = createCwd.trim();
      if (!cwd) return;

      setCreating(true);
      try {
        const payload = await api<{ agent: Agent }>("/api/v1/agents", {
          method: "POST",
          body: JSON.stringify({
            name: createName.trim(),
            cwd,
            type: createType,
            fullAccess: createFullAccess,
            autoReview: createAutoReview,
            useWorktree: createUseWorktree,
            worktreeBranch: createWorktreeBranch.trim() || undefined,
            baseBranch:
              createBaseBranch !== "main" ? createBaseBranch : undefined,
            initialPrompt: initialPrompt.trim() || undefined,
          }),
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
      createType,
      createUseWorktree,
      createWorktreeBranch,
      initialPrompt,
      onCreated,
    ]
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        onEscapeKeyDown={(e) => {
          if (typeDropdownOpen || branchDropdownOpen) {
            e.preventDefault();
          }
          if (step === "prompt") {
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
                    <label className="text-sm text-muted-foreground">
                      Type
                    </label>
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
                    <label className="text-sm text-muted-foreground">
                      Name
                    </label>
                    <Input
                      autoFocus
                      value={createName}
                      onChange={(event) => setCreateName(event.target.value)}
                      placeholder="agent name"
                      data-testid="create-agent-name"
                    />
                    <p className="text-xs text-muted-foreground">
                      Leave blank and the agent will set its own name based on
                      the task.
                    </p>
                  </div>

                  <PathInput
                    value={createCwd}
                    onChange={setCreateCwd}
                    label="Working directory"
                    history={cwdHistory}
                    onRemoveHistory={handleRemoveCwdHistory}
                    data-testid="create-agent-cwd"
                    historyItemTestId="create-agent-cwd-history-option"
                  />

                  <div className="space-y-2 rounded-md border border-border/70 bg-muted/20 px-3 py-3">
                    <label className="flex cursor-pointer items-start gap-3">
                      <Checkbox
                        checked={createUseWorktree}
                        onCheckedChange={() =>
                          setCreateUseWorktree((current) => !current)
                        }
                        className="mt-0.5"
                        title="Toggle git worktree"
                        data-testid="create-agent-worktree"
                      />
                      <span className="space-y-1">
                        <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                          <GitBranch className="h-3.5 w-3.5" />
                          Create git worktree
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          Creates an isolated worktree and branch for this
                          agent.
                        </span>
                      </span>
                    </label>
                    {createUseWorktree ? (
                      <div className="ml-8 w-[calc(100%-2rem)] space-y-2">
                        <div className="relative" ref={branchCmdRef}>
                          <label className="mb-1 block text-xs text-muted-foreground">
                            Base branch
                          </label>
                          <button
                            ref={branchTriggerRef}
                            type="button"
                            role="combobox"
                            tabIndex={0}
                            aria-expanded={branchDropdownOpen}
                            data-testid="create-agent-base-branch"
                            onClick={() =>
                              branchDropdownOpen
                                ? setBranchDropdownOpen(false)
                                : openBranchDropdown()
                            }
                            onKeyDown={(e) => {
                              if (
                                e.key === "ArrowDown" ||
                                e.key === "Enter" ||
                                e.key === " "
                              ) {
                                e.preventDefault();
                                if (!branchDropdownOpen) openBranchDropdown();
                              }
                            }}
                            className={cn(
                              "flex h-9 w-full items-center justify-between rounded-md border border-white/[0.12] bg-white/[0.04] px-3 py-2 font-mono text-xs shadow-[inset_0_2px_6px_rgba(0,0,0,0.3)] backdrop-blur-md",
                              "ring-offset-background focus:outline-none focus:ring-1 focus:ring-ring"
                            )}
                          >
                            {createBaseBranch}
                            {branchesLoading ? (
                              <Loader2 className="ml-2 h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                            ) : (
                              <ChevronDown
                                className={cn(
                                  "ml-2 h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                                  branchDropdownOpen && "rotate-180"
                                )}
                              />
                            )}
                          </button>
                          {branchDropdownOpen ? (
                            <div className="absolute left-0 right-0 z-[80] mt-1 rounded-md border border-white/[0.2] bg-[hsl(var(--card))] shadow-[0_16px_64px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.15)] backdrop-blur-2xl">
                              <Command
                                onKeyDown={(e) => {
                                  if (e.key === "Escape") {
                                    e.preventDefault();
                                    setBranchDropdownOpen(false);
                                    requestAnimationFrame(() =>
                                      branchTriggerRef.current?.focus()
                                    );
                                  }
                                }}
                              >
                                <CommandInput
                                  ref={branchInputRef}
                                  placeholder="Search branches..."
                                  className="font-mono text-xs"
                                />
                                <CommandList>
                                  {branchesLoading ? (
                                    <CommandLoading>
                                      <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
                                        <Loader2 className="h-3 w-3 animate-spin" />
                                        Loading branches...
                                      </div>
                                    </CommandLoading>
                                  ) : null}
                                  <CommandEmpty>
                                    No matching branches.
                                  </CommandEmpty>
                                  <CommandGroup>
                                    {allBranches.map((branch) => (
                                      <CommandItem
                                        key={branch}
                                        value={branch}
                                        data-testid="create-agent-base-branch-option"
                                        className="font-mono"
                                        onSelect={() => {
                                          setCreateBaseBranch(branch);
                                          setBranchDropdownOpen(false);
                                          requestAnimationFrame(() =>
                                            branchTriggerRef.current?.focus()
                                          );
                                        }}
                                      >
                                        <Check
                                          className={cn(
                                            "mr-2 h-3 w-3 shrink-0",
                                            branch === createBaseBranch
                                              ? "opacity-100"
                                              : "opacity-0"
                                          )}
                                        />
                                        {branch}
                                      </CommandItem>
                                    ))}
                                  </CommandGroup>
                                </CommandList>
                              </Command>
                            </div>
                          ) : null}
                        </div>
                        <Input
                          value={createWorktreeBranch}
                          onChange={(event) =>
                            setCreateWorktreeBranch(event.target.value)
                          }
                          placeholder="branch name (auto-generated if empty)"
                          data-testid="create-agent-worktree-branch"
                        />
                      </div>
                    ) : null}
                  </div>

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
                        Agent will launch one review agent and address feedback
                        before completing.
                      </span>
                    </span>
                  </label>
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
                <Button
                  type="button"
                  variant="default"
                  tabIndex={0}
                  disabled={creating || !createCwd.trim()}
                  data-testid="create-agent-with-prompt"
                  onClick={() => setStep("prompt")}
                >
                  Create with prompt
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  tabIndex={0}
                  disabled={creating}
                  data-testid="create-agent-submit"
                >
                  {creating ? (
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  ) : null}
                  Create
                </Button>
              </div>
            </form>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Initial Prompt</DialogTitle>
              <DialogDescription>
                This prompt will be sent as the agent&apos;s first message.
              </DialogDescription>
            </DialogHeader>

            <form
              data-testid="create-agent-prompt-form"
              className="space-y-3"
              onSubmit={(event) => void handleSubmit(event)}
            >
              <textarea
                ref={promptTextareaRef}
                value={initialPrompt}
                onChange={(event) => setInitialPrompt(event.target.value)}
                placeholder="Enter instructions for the agent..."
                data-testid="create-agent-initial-prompt"
                className={cn(
                  "flex min-h-[200px] w-full resize-y rounded-md border border-white/[0.12] bg-white/[0.04] px-3 py-2 text-sm shadow-[inset_0_2px_6px_rgba(0,0,0,0.3)] backdrop-blur-md",
                  "ring-offset-background placeholder:text-muted-foreground",
                  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                )}
              />

              <div className="flex justify-between pt-1">
                <Button
                  type="button"
                  variant="ghost"
                  tabIndex={0}
                  onClick={() => setStep("config")}
                  data-testid="create-agent-prompt-back"
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
                    data-testid="create-agent-prompt-submit"
                  >
                    {creating ? (
                      <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                    ) : null}
                    Create
                  </Button>
                </div>
              </div>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
