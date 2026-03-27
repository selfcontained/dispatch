import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Check, CheckCircle2, ChevronDown, GitBranch, Loader2, Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandLoading } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { AGENT_TYPE_LABELS, type AgentType } from "@/lib/agent-types";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

function useClickOutside(ref: React.RefObject<HTMLElement | null>, isOpen: boolean, onClose: () => void): void {
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

type CreateAgentDialogProps = {
  open: boolean;
  createName: string;
  createType: AgentType;
  createCwd: string;
  createFullAccess: boolean;
  createUseWorktree: boolean;
  createWorktreeBranch: string;
  createBaseBranch: string;
  creating: boolean;
  cwdHistory: string[];
  enabledAgentTypes: AgentType[];
  setOpen: (open: boolean) => void;
  setCreateName: (name: string) => void;
  setCreateType: (value: AgentType) => void;
  setCreateCwd: (cwd: string) => void;
  setCreateFullAccess: (value: boolean | ((current: boolean) => boolean)) => void;
  setCreateUseWorktree: (value: boolean | ((current: boolean) => boolean)) => void;
  setCreateWorktreeBranch: (value: string) => void;
  setCreateBaseBranch: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onRemoveCwdHistory: (dir: string) => void;
};

export function CreateAgentDialog({
  open,
  createName,
  createType,
  createCwd,
  createFullAccess,
  createUseWorktree,
  createWorktreeBranch,
  createBaseBranch,
  creating,
  cwdHistory,
  enabledAgentTypes,
  setOpen,
  setCreateName,
  setCreateType,
  setCreateCwd,
  setCreateFullAccess,
  setCreateUseWorktree,
  setCreateWorktreeBranch,
  setCreateBaseBranch,
  onSubmit,
  onRemoveCwdHistory
}: CreateAgentDialogProps): JSX.Element {
  const [cwdDropdownOpen, setCwdDropdownOpen] = useState(false);
  const cwdCmdRef = useRef<HTMLDivElement>(null);
  const cwdInputRef = useRef<HTMLInputElement>(null);
  const closeCwdDropdown = useCallback(() => setCwdDropdownOpen(false), []);
  useClickOutside(cwdCmdRef, cwdDropdownOpen, closeCwdDropdown);
  const sortedCwdHistory = useMemo(
    () => [...cwdHistory].sort((left, right) => left.localeCompare(right)),
    [cwdHistory]
  );

  // --- Path validation state ---
  type PathInfo = { exists: boolean; isDirectory: boolean; isGitRepo: boolean };
  const [pathValidation, setPathValidation] = useState<PathInfo | null>(null);
  const [validating, setValidating] = useState(false);

  // --- Inline ghost autocomplete ---
  const [ghostSuffix, setGhostSuffix] = useState("");

  // Debounced path validation
  useEffect(() => {
    const trimmed = createCwd.trim();
    if (!trimmed) {
      setPathValidation(null);
      return;
    }
    setValidating(true);
    const timer = setTimeout(() => {
      api<PathInfo & { resolvedPath: string }>(`/api/v1/system/path-info?path=${encodeURIComponent(trimmed)}`)
        .then((result) => {
          setPathValidation({ exists: result.exists, isDirectory: result.isDirectory, isGitRepo: result.isGitRepo });
        })
        .catch(() => setPathValidation(null))
        .finally(() => setValidating(false));
    }, 400);
    return () => { clearTimeout(timer); setValidating(false); };
  }, [createCwd]);

  // Debounced inline ghost completion
  useEffect(() => {
    const trimmed = createCwd.trim();
    if (!trimmed || (!trimmed.startsWith("/") && !trimmed.startsWith("~"))) {
      setGhostSuffix("");
      return;
    }
    const timer = setTimeout(() => {
      api<{ completions: string[] }>(`/api/v1/system/path-completions?prefix=${encodeURIComponent(trimmed)}`)
        .then((result) => {
          if (result.completions.length > 0) {
            const best = result.completions[0];
            // Show only the part after what the user already typed
            if (best.startsWith(trimmed.replace(/\/$/, ""))) {
              setGhostSuffix(best.slice(trimmed.replace(/\/$/, "").length));
            } else {
              setGhostSuffix("");
            }
          } else {
            setGhostSuffix("");
          }
        })
        .catch(() => setGhostSuffix(""));
    }, 150);
    return () => clearTimeout(timer);
  }, [createCwd]);

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setPathValidation(null);
      setGhostSuffix("");
      setCwdDropdownOpen(false);
    }
  }, [open]);

  // --- Agent type dropdown state ---
  const [typeDropdownOpen, setTypeDropdownOpen] = useState(false);
  const typeCmdRef = useRef<HTMLDivElement>(null);
  const typeTriggerRef = useRef<HTMLButtonElement>(null);
  const closeTypeDropdown = useCallback(() => setTypeDropdownOpen(false), []);
  useClickOutside(typeCmdRef, typeDropdownOpen, closeTypeDropdown);

  // --- Base branch combobox state ---
  const [branchDropdownOpen, setBranchDropdownOpen] = useState(false);
  const [remoteBranches, setRemoteBranches] = useState<string[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchesFetchedForCwd, setBranchesFetchedForCwd] = useState<string | null>(null);
  const branchCmdRef = useRef<HTMLDivElement>(null);
  const branchTriggerRef = useRef<HTMLButtonElement>(null);
  const branchInputRef = useRef<HTMLInputElement>(null);
  const closeBranchDropdown = useCallback(() => setBranchDropdownOpen(false), []);
  useClickOutside(branchCmdRef, branchDropdownOpen, closeBranchDropdown);

  const fetchBranches = useCallback(async () => {
    const cwd = createCwd.trim();
    if (!cwd) return;
    setBranchesLoading(true);
    setRemoteBranches([]);
    try {
      const result = await api<{ branches: string[] }>(`/api/v1/git/branches?cwd=${encodeURIComponent(cwd)}`);
      setRemoteBranches(result.branches);
    } catch {
      setRemoteBranches([]);
    } finally {
      setBranchesLoading(false);
      setBranchesFetchedForCwd(cwd);
    }
  }, [createCwd]);

  const openBranchDropdown = useCallback(() => {
    setBranchDropdownOpen(true);
    if (branchesFetchedForCwd !== createCwd.trim()) {
      void fetchBranches();
    }
    requestAnimationFrame(() => branchInputRef.current?.focus());
  }, [fetchBranches, branchesFetchedForCwd, createCwd]);

  const allBranches = useMemo(
    () => remoteBranches.includes("main") ? remoteBranches : ["main", ...remoteBranches],
    [remoteBranches]
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        onEscapeKeyDown={(e) => {
          if (cwdDropdownOpen || typeDropdownOpen || branchDropdownOpen) {
            e.preventDefault();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Create Agent</DialogTitle>
          <DialogDescription>Name, type, and working directory for a new agent session.</DialogDescription>
        </DialogHeader>

        <form data-testid="create-agent-form" className="space-y-3" onSubmit={(event) => void onSubmit(event)}>
          <div className="space-y-1">
            <label className="text-sm text-muted-foreground">Name</label>
            <Input
              value={createName}
              onChange={(event) => setCreateName(event.target.value)}
              placeholder="agent name (optional)"
              data-testid="create-agent-name"
            />
          </div>

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
                if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  if (!typeDropdownOpen) setTypeDropdownOpen(true);
                }
              }}
              className={cn(
                "flex h-9 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm",
                "ring-offset-background focus:outline-none focus:ring-1 focus:ring-ring"
              )}
            >
              {AGENT_TYPE_LABELS[createType]}
              <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", typeDropdownOpen && "rotate-180")} />
            </button>
            {typeDropdownOpen ? (
              <div className="absolute left-0 right-0 z-[80] mt-1 rounded-md border border-border bg-background shadow-md">
                <Command shouldFilter={false} ref={(el) => { if (el) requestAnimationFrame(() => el.focus()); }} onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); setTypeDropdownOpen(false); requestAnimationFrame(() => typeTriggerRef.current?.focus()); } }}>
                  <CommandList>
                    <CommandGroup>
                      {enabledAgentTypes.map((agentType) => (
                        <CommandItem
                          key={agentType}
                          value={agentType}
                          onSelect={() => {
                            setCreateType(agentType);
                            setTypeDropdownOpen(false);
                            requestAnimationFrame(() => typeTriggerRef.current?.focus());
                          }}
                        >
                          <Check className={cn("mr-2 h-3 w-3 shrink-0", agentType === createType ? "opacity-100" : "opacity-0")} />
                          {AGENT_TYPE_LABELS[agentType]}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </div>
            ) : null}
          </div>

          <div className="relative" ref={cwdCmdRef}>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-sm text-muted-foreground">Working directory</label>
              <div className="flex items-center gap-1 text-xs">
                {validating ? (
                  <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                ) : pathValidation && createCwd.trim() ? (
                  pathValidation.isDirectory && pathValidation.isGitRepo ? (
                    <>
                      <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                      <GitBranch className="h-3 w-3 text-emerald-500" />
                      <span className="text-emerald-600 dark:text-emerald-400">Git repository</span>
                    </>
                  ) : pathValidation.isDirectory ? (
                    <>
                      <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                      <span className="text-emerald-600 dark:text-emerald-400">Valid directory</span>
                    </>
                  ) : (
                    <>
                      <AlertCircle className="h-3 w-3 text-amber-500" />
                      <span className="text-amber-600 dark:text-amber-400">Directory not found</span>
                    </>
                  )
                ) : null}
              </div>
            </div>
            <div className="relative">
              {/* Ghost autocomplete overlay */}
              {ghostSuffix && createCwd.trim() ? (
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-0 flex h-9 items-center overflow-hidden rounded-md border border-transparent px-3 py-2 font-mono text-xs"
                >
                  <span className="invisible whitespace-pre">{createCwd}</span>
                  <span className="whitespace-pre text-muted-foreground/40">{ghostSuffix}</span>
                </div>
              ) : null}
              <Input
                ref={cwdInputRef}
                value={createCwd}
                onChange={(event) => {
                  setCreateCwd(event.target.value);
                  if (cwdHistory.length > 0) {
                    setCwdDropdownOpen(true);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape" && cwdDropdownOpen) {
                    e.preventDefault();
                    e.stopPropagation();
                    setCwdDropdownOpen(false);
                  }
                  if ((e.key === "Enter" || e.key === "ArrowDown") && !cwdDropdownOpen && cwdHistory.length > 0) {
                    e.preventDefault();
                    setCwdDropdownOpen(true);
                  }
                  if (e.key === "Tab" && ghostSuffix) {
                    e.preventDefault();
                    e.stopPropagation();
                    const accepted = createCwd.replace(/\/$/, "") + ghostSuffix + "/";
                    setCreateCwd(accepted);
                    setGhostSuffix("");
                  }
                }}
                placeholder="~/path/to/project"
                required
                data-testid="create-agent-cwd"
                className="bg-transparent pr-8 font-mono text-xs"
              />
              {cwdHistory.length > 0 ? (
                <button
                  type="button"
                  tabIndex={-1}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    setCwdDropdownOpen((prev) => !prev);
                    cwdInputRef.current?.focus();
                  }}
                >
                  <ChevronDown className={cn("h-4 w-4 transition-transform", cwdDropdownOpen && "rotate-180")} />
                </button>
              ) : null}
            </div>
            {cwdDropdownOpen && sortedCwdHistory.length > 0 ? (
              <div className="absolute left-0 right-0 z-[60] mt-1.5 rounded-md border border-border bg-background p-1 shadow-md" data-testid="create-agent-cwd-history">
                <Command shouldFilter={false} onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setCwdDropdownOpen(false);
                    cwdInputRef.current?.focus();
                  }
                }}>
                  <CommandList>
                    <CommandGroup heading="Recent">
                      {sortedCwdHistory.map((dir) => (
                        <CommandItem
                          key={dir}
                          value={dir}
                          data-testid="create-agent-cwd-history-option"
                          className="group font-mono text-xs"
                          onSelect={() => {
                            setCreateCwd(dir);
                            setCwdDropdownOpen(false);
                            cwdInputRef.current?.focus();
                          }}
                        >
                          <span className="truncate">{dir}</span>
                          <button
                            type="button"
                            className="ml-auto shrink-0 p-0.5 text-muted-foreground opacity-0 hover:text-foreground group-data-[selected=true]:opacity-100"
                            onMouseDown={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              onRemoveCwdHistory(dir);
                            }}
                            title="Remove from history"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </div>
            ) : null}
          </div>

          <div className="space-y-2 rounded-md border border-border/70 bg-muted/20 px-3 py-3">
            <div className="flex cursor-pointer items-start gap-3" onClick={() => setCreateUseWorktree((current) => !current)}>
              <button
                type="button"
                role="checkbox"
                tabIndex={0}
                aria-checked={createUseWorktree}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); setCreateUseWorktree((current) => !current); } }}
                className={cn(
                  "mt-0.5 inline-flex h-5 w-5 items-center justify-center border text-foreground transition-colors",
                  createUseWorktree ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background"
                )}
                title="Toggle git worktree"
                data-testid="create-agent-worktree"
              >
                {createUseWorktree ? <Check className="h-3.5 w-3.5" /> : null}
              </button>
              <span className="space-y-1">
                <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                  <GitBranch className="h-3.5 w-3.5" />
                  Create git worktree
                </span>
                <span className="block text-xs text-muted-foreground">
                  Creates an isolated worktree and branch for this agent.
                </span>
              </span>
            </div>
            {createUseWorktree ? (
              <div className="ml-8 w-[calc(100%-2rem)] space-y-2">
                <div className="relative" ref={branchCmdRef}>
                  <label className="mb-1 block text-xs text-muted-foreground">Base branch</label>
                  <button
                    ref={branchTriggerRef}
                    type="button"
                    role="combobox"
                    tabIndex={0}
                    aria-expanded={branchDropdownOpen}
                    data-testid="create-agent-base-branch"
                    onClick={() => branchDropdownOpen ? setBranchDropdownOpen(false) : openBranchDropdown()}
                    onKeyDown={(e) => {
                      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        if (!branchDropdownOpen) openBranchDropdown();
                      }
                    }}
                    className={cn(
                      "flex h-9 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 font-mono text-xs",
                      "ring-offset-background focus:outline-none focus:ring-1 focus:ring-ring"
                    )}
                  >
                    {createBaseBranch}
                    {branchesLoading ? (
                      <Loader2 className="ml-2 h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                    ) : (
                      <ChevronDown className={cn("ml-2 h-4 w-4 shrink-0 text-muted-foreground transition-transform", branchDropdownOpen && "rotate-180")} />
                    )}
                  </button>
                  {branchDropdownOpen ? (
                    <div className="absolute left-0 right-0 z-[80] mt-1 rounded-md border border-border bg-background shadow-md">
                      <Command
                        onKeyDown={(e) => {
                          if (e.key === "Escape") {
                            e.preventDefault();
                            setBranchDropdownOpen(false);
                            requestAnimationFrame(() => branchTriggerRef.current?.focus());
                          }
                        }}
                      >
                        <CommandInput ref={branchInputRef} placeholder="Search branches..." className="font-mono text-xs" />
                        <CommandList>
                          {branchesLoading ? (
                            <CommandLoading>
                              <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
                                <Loader2 className="h-3 w-3 animate-spin" />
                                Loading branches...
                              </div>
                            </CommandLoading>
                          ) : null}
                          <CommandEmpty>No matching branches.</CommandEmpty>
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
                                  requestAnimationFrame(() => branchTriggerRef.current?.focus());
                                }}
                              >
                                <Check className={cn("mr-2 h-3 w-3 shrink-0", branch === createBaseBranch ? "opacity-100" : "opacity-0")} />
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
                  onChange={(event) => setCreateWorktreeBranch(event.target.value)}
                  placeholder="branch name (auto-generated if empty)"
                  data-testid="create-agent-worktree-branch"
                />
              </div>
            ) : null}
          </div>

          <div className="flex cursor-pointer items-start gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-3" onClick={() => setCreateFullAccess((current) => !current)}>
            <button
              type="button"
              role="checkbox"
              tabIndex={0}
              aria-checked={createFullAccess}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); setCreateFullAccess((current) => !current); } }}
              className={cn(
                "mt-0.5 inline-flex h-5 w-5 items-center justify-center border text-foreground transition-colors",
                createFullAccess ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background"
              )}
              title="Toggle full access"
            >
              {createFullAccess ? <Check className="h-3.5 w-3.5" /> : null}
            </button>
            <span className="space-y-1">
              <span className="block text-sm font-medium text-foreground">Start in full access mode</span>
              <span className="block text-xs text-muted-foreground">
                Starts the selected agent with its most permissive supported execution mode.
              </span>
            </span>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" tabIndex={0} onClick={() => setOpen(false)} data-testid="create-agent-cancel">
              Cancel
            </Button>
            <Button type="submit" variant="primary" tabIndex={0} disabled={creating} data-testid="create-agent-submit">
              {creating ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Plus className="mr-1.5 h-4 w-4" />}
              Create
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
