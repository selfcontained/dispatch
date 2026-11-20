import { useCallback, useMemo, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { ActivityBars } from "@/components/ui/activity-bars";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandLoading,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { useClickOutside } from "@/hooks/use-click-outside";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

const EMPTY_BRANCHES: string[] = [];

export type BranchSelectProps = {
  cwd: string;
  runner?: { id: string; repository: string; browse: boolean };
  allowPullRequest?: boolean;
  baseBranch: string;
  /**
   * Fired when the user picks a branch. The component never overwrites
   * `baseBranch` on its own — if a saved branch is missing from the
   * fetched list we keep it in the dropdown with a visible flag and let
   * the user choose a replacement.
   */
  onBaseBranchChange: (value: string) => void;
  worktreeBranch: string;
  onWorktreeBranchChange: (value: string) => void;
  testIdPrefix?: string;
  worktreeBranchPlaceholder?: string;
  /** Label rendered above the base branch combobox. Defaults to "Base branch". */
  baseBranchLabel?: string;
  /** Optional helper text rendered below the base branch combobox. */
  baseBranchHelper?: string;
  /** When false, hide the "new branch name" text input. Defaults to true. */
  showNewBranchInput?: boolean;
  /** Disable branch controls while preserving their layout. */
  disabled?: boolean;
};

export function BranchSelect({
  cwd,
  runner,
  allowPullRequest = false,
  baseBranch,
  onBaseBranchChange,
  worktreeBranch,
  onWorktreeBranchChange,
  testIdPrefix = "branch-select",
  worktreeBranchPlaceholder = "branch name (auto-generated if empty)",
  baseBranchLabel = "Base branch",
  baseBranchHelper,
  showNewBranchInput = true,
  disabled = false,
}: BranchSelectProps): JSX.Element {
  const [typed, setTyped] = useState("");
  const githubRepo =
    runner?.browse &&
    /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(
      runner.repository
    );
  const endpoint = runner
    ? githubRepo
      ? `/api/v1/runners/${encodeURIComponent(runner.id)}/repositories/${githubRepo[1]}/${githubRepo[2]}/branches`
      : ""
    : cwd.trim()
      ? `/api/v1/git/branches?cwd=${encodeURIComponent(cwd.trim())}`
      : "";
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const cmdRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const closeDropdown = useCallback(() => setDropdownOpen(false), []);
  if (disabled && dropdownOpen) setDropdownOpen(false);
  useClickOutside(cmdRef, dropdownOpen, closeDropdown);

  // Load the runner's default for the closed control. Local branches are
  // only needed when the menu opens.
  const branches = useQuery({
    queryKey: ["branch-select", endpoint],
    queryFn: ({ signal }) =>
      api<{ branches: string[]; defaultBranch?: string }>(endpoint, { signal }),
    enabled:
      !disabled && Boolean(endpoint) && (Boolean(runner) || dropdownOpen),
    staleTime: 30_000,
    retry: false,
  });
  const remoteBranches = branches.data?.branches ?? EMPTY_BRANCHES;
  const defaultBranch = branches.data?.defaultBranch ?? "";
  const branchesLoading = branches.isFetching;
  const fetchError = branches.error?.message ?? null;

  const openDropdown = useCallback(() => {
    if (disabled) return;
    setTyped("");
    setDropdownOpen(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [disabled]);

  // Keep the saved baseBranch selectable even if the fetched list doesn't
  // include it (branch renamed/deleted upstream). We flag it visually in
  // the dropdown rather than silently overwrite it.
  const allBranches = useMemo(() => {
    // The default has its own row when starting a new branch; when opening
    // an existing branch it leads the list, even past the list's cap.
    const others = remoteBranches.filter((branch) => branch !== defaultBranch);
    const base = runner
      ? allowPullRequest && defaultBranch
        ? [defaultBranch, ...others]
        : others
      : remoteBranches.includes("main")
        ? remoteBranches
        : ["main", ...remoteBranches];
    const hasDefaultRow =
      runner && !allowPullRequest && baseBranch === defaultBranch;
    if (baseBranch && !hasDefaultRow && !base.includes(baseBranch))
      return [baseBranch, ...base];
    return base;
  }, [remoteBranches, baseBranch, runner, defaultBranch, allowPullRequest]);

  const savedBranchMissing =
    !runner &&
    !branchesLoading &&
    !!baseBranch &&
    branches.isSuccess &&
    remoteBranches.length > 0 &&
    !remoteBranches.includes(baseBranch);

  return (
    <div className="space-y-2">
      <div className="relative" ref={cmdRef}>
        <label className="mb-1 block text-xs text-muted-foreground">
          {baseBranchLabel}
        </label>
        <button
          ref={triggerRef}
          type="button"
          role="combobox"
          tabIndex={0}
          disabled={disabled}
          aria-label={baseBranchLabel}
          aria-expanded={dropdownOpen}
          data-testid={`${testIdPrefix}-base-branch`}
          onClick={() =>
            dropdownOpen ? setDropdownOpen(false) : openDropdown()
          }
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              if (!dropdownOpen) openDropdown();
            }
          }}
          className={cn(
            "flex h-9 w-full items-center justify-between rounded-md border border-white/[0.12] bg-white/[0.04] px-3 py-2 font-mono text-xs shadow-[inset_0_2px_6px_rgba(0,0,0,0.3)] backdrop-blur-md",
            "ring-offset-background focus:outline-none focus:ring-1 focus:ring-ring",
            disabled && "cursor-not-allowed opacity-60"
          )}
        >
          <span className="truncate">
            {baseBranch ||
              (allowPullRequest
                ? "Choose a branch or PR"
                : defaultBranch || "Repository default")}
          </span>
          {branchesLoading ? (
            <ActivityBars size={14} className="ml-2 shrink-0" />
          ) : (
            <ChevronDown
              className={cn(
                "ml-2 h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                dropdownOpen && "rotate-180"
              )}
            />
          )}
        </button>
        {dropdownOpen ? (
          <div className="absolute left-0 right-0 z-[80] mt-1 rounded-md border border-white/[0.2] bg-[hsl(var(--card))] shadow-[0_16px_64px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.15)] backdrop-blur-2xl">
            <Command
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setDropdownOpen(false);
                  requestAnimationFrame(() => triggerRef.current?.focus());
                }
              }}
            >
              <CommandInput
                ref={inputRef}
                value={typed}
                onValueChange={setTyped}
                placeholder={
                  runner && allowPullRequest
                    ? "Branch name or GitHub PR URL"
                    : "Search branches..."
                }
                className="font-mono text-xs"
              />
              <CommandList>
                {branchesLoading ? (
                  <CommandLoading>
                    <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
                      <ActivityBars size={12} />
                      Loading branches...
                    </div>
                  </CommandLoading>
                ) : null}
                <CommandEmpty>No matching branches.</CommandEmpty>
                <CommandGroup>
                  {runner && !allowPullRequest && (
                    <CommandItem
                      value={defaultBranch || "Repository default"}
                      keywords={["default"]}
                      data-testid={`${testIdPrefix}-base-branch-option`}
                      className="font-mono"
                      onSelect={() => {
                        onBaseBranchChange("");
                        closeDropdown();
                        triggerRef.current?.focus();
                      }}
                    >
                      <Check
                        className={cn(
                          "mr-2 h-3 w-3 shrink-0",
                          !baseBranch || baseBranch === defaultBranch
                            ? "opacity-100"
                            : "opacity-0"
                        )}
                      />
                      {defaultBranch || "Repository default"}
                    </CommandItem>
                  )}
                  {runner &&
                    typed.trim() &&
                    (allowPullRequest || typed.trim() !== defaultBranch) &&
                    !allBranches.includes(typed.trim()) && (
                      <CommandItem
                        value={typed.trim()}
                        onSelect={() => {
                          onBaseBranchChange(typed.trim());
                          closeDropdown();
                          triggerRef.current?.focus();
                        }}
                      >
                        <Check className="mr-2 h-3 w-3 shrink-0 opacity-0" />
                        {typed.trim()}
                      </CommandItem>
                    )}
                  {allBranches.map((branch) => {
                    const isMissing =
                      !runner &&
                      branch === baseBranch &&
                      remoteBranches.length > 0 &&
                      !remoteBranches.includes(branch);
                    return (
                      <CommandItem
                        key={branch}
                        value={branch}
                        data-testid={`${testIdPrefix}-base-branch-option`}
                        className="font-mono"
                        onSelect={() => {
                          onBaseBranchChange(branch);
                          setDropdownOpen(false);
                          requestAnimationFrame(() =>
                            triggerRef.current?.focus()
                          );
                        }}
                      >
                        <Check
                          className={cn(
                            "mr-2 h-3 w-3 shrink-0",
                            branch === baseBranch ? "opacity-100" : "opacity-0"
                          )}
                        />
                        {branch}
                        {isMissing ? (
                          <span className="ml-2 text-[10px] uppercase tracking-wide text-status-waiting">
                            not found
                          </span>
                        ) : null}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </CommandList>
            </Command>
          </div>
        ) : null}
      </div>
      {fetchError ? (
        <div className="flex items-center gap-2 text-xs text-status-blocked">
          <span className="truncate">Couldn't load branches.</span>
          <button
            type="button"
            onClick={() => void branches.refetch()}
            disabled={disabled}
            className="underline underline-offset-2 hover:no-underline"
          >
            Retry
          </button>
        </div>
      ) : savedBranchMissing ? (
        <div className="text-xs text-status-waiting">
          Saved branch <span className="font-mono">{baseBranch}</span> no longer
          exists on the remote — pick a new one.
        </div>
      ) : baseBranchHelper ? (
        <p className="text-xs text-muted-foreground">{baseBranchHelper}</p>
      ) : null}
      {showNewBranchInput ? (
        <Input
          value={worktreeBranch}
          onChange={(event) => onWorktreeBranchChange(event.target.value)}
          placeholder={worktreeBranchPlaceholder}
          data-testid={`${testIdPrefix}-worktree-branch`}
          disabled={disabled}
        />
      ) : null}
    </div>
  );
}
