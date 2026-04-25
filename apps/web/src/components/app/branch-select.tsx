import { useCallback, useMemo, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

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

export type BranchSelectProps = {
  cwd: string;
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
};

export function BranchSelect({
  cwd,
  baseBranch,
  onBaseBranchChange,
  worktreeBranch,
  onWorktreeBranchChange,
  testIdPrefix = "branch-select",
  worktreeBranchPlaceholder = "branch name (auto-generated if empty)",
  baseBranchLabel = "Base branch",
  baseBranchHelper,
  showNewBranchInput = true,
}: BranchSelectProps): JSX.Element {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [remoteBranches, setRemoteBranches] = useState<string[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [fetchedForCwd, setFetchedForCwd] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const cmdRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const closeDropdown = useCallback(() => setDropdownOpen(false), []);
  useClickOutside(cmdRef, dropdownOpen, closeDropdown);

  const fetchBranches = useCallback(async () => {
    const trimmed = cwd.trim();
    if (!trimmed) return;
    setBranchesLoading(true);
    setFetchError(null);
    try {
      const result = await api<{ branches: string[] }>(
        `/api/v1/git/branches?cwd=${encodeURIComponent(trimmed)}`
      );
      setRemoteBranches(result.branches);
    } catch (error) {
      setRemoteBranches([]);
      setFetchError(
        error instanceof Error ? error.message : "Couldn't load branches."
      );
    } finally {
      setBranchesLoading(false);
      setFetchedForCwd(trimmed);
    }
  }, [cwd]);

  const openDropdown = useCallback(() => {
    setDropdownOpen(true);
    if (fetchedForCwd !== cwd.trim()) {
      void fetchBranches();
    }
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [fetchBranches, fetchedForCwd, cwd, setDropdownOpen]);

  // Keep the saved baseBranch selectable even if the fetched list doesn't
  // include it (branch renamed/deleted upstream). We flag it visually in
  // the dropdown rather than silently overwrite it.
  const allBranches = useMemo(() => {
    const base = remoteBranches.includes("main")
      ? remoteBranches
      : ["main", ...remoteBranches];
    if (baseBranch && !base.includes(baseBranch)) return [baseBranch, ...base];
    return base;
  }, [remoteBranches, baseBranch]);

  const savedBranchMissing =
    !branchesLoading &&
    !!baseBranch &&
    !!fetchedForCwd &&
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
            "ring-offset-background focus:outline-none focus:ring-1 focus:ring-ring"
          )}
        >
          {baseBranch}
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
                placeholder="Search branches..."
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
                  {allBranches.map((branch) => {
                    const isMissing =
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
            onClick={() => void fetchBranches()}
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
        />
      ) : null}
    </div>
  );
}
