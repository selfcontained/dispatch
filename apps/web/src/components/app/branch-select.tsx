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

const PULL_REQUEST_URL =
  /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/[1-9]\d*\/?$/;

export type BranchSelectProps = {
  cwd: string;
  /** Lists a runner repository's branches instead of the local folder's. */
  runner?: { id: string; repository: string; browse: boolean };
  /** Accept a GitHub pull request URL as the branch to open. */
  allowPullRequest?: boolean;
  baseBranch: string;
  /**
   * Fired when the user picks a branch; "" selects the repository default.
   * The component never overwrites `baseBranch` on its own — a saved branch
   * missing from the fetched list stays selectable with a visible flag.
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

/** The branches endpoint for either source; both return one shape. */
export function branchListEndpoint(
  cwd: string,
  runner: BranchSelectProps["runner"]
): string {
  if (!runner)
    return cwd.trim()
      ? `/api/v1/git/branches?cwd=${encodeURIComponent(cwd.trim())}`
      : "";
  // Runners list GitHub branches only when they can browse repositories.
  const repo =
    runner.browse &&
    /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(
      runner.repository
    );
  return repo
    ? `/api/v1/runners/${encodeURIComponent(runner.id)}/repositories/${repo[1]}/${repo[2]}/branches`
    : "";
}

export type BranchRow = {
  /** "" is the repository default. */
  value: string;
  label: string;
  selected: boolean;
  missing: boolean;
};

/**
 * One row model for every source: the repository default, then a typed
 * branch or PR URL, then a saved branch that is no longer listed, then the
 * rest of the list.
 */
export function branchRows({
  branches,
  defaultBranch,
  baseBranch,
  typed,
  allowPullRequest,
  listed,
  entered,
}: {
  branches: string[];
  defaultBranch: string;
  baseBranch: string;
  typed: string;
  allowPullRequest: boolean;
  /** The list loaded, so an unlisted saved branch can be flagged. */
  listed: boolean;
  /** A branch entered by hand here; it is not flagged as missing. */
  entered?: string;
}): BranchRow[] {
  const isDefault = (branch: string) =>
    !branch || (Boolean(defaultBranch) && branch === defaultBranch);
  const rows: BranchRow[] = [
    {
      value: "",
      label: defaultBranch || "Repository default",
      selected: isDefault(baseBranch),
      missing: false,
    },
  ];
  const others = branches.filter((branch) => !isDefault(branch));
  const entry = typed.trim();
  const isPullRequest = PULL_REQUEST_URL.test(entry);
  if (
    entry &&
    !isDefault(entry) &&
    entry !== baseBranch &&
    !others.includes(entry) &&
    (isPullRequest ? allowPullRequest : true)
  )
    rows.push({ value: entry, label: entry, selected: false, missing: false });
  if (!isDefault(baseBranch) && !others.includes(baseBranch))
    rows.push({
      value: baseBranch,
      label: baseBranch,
      selected: true,
      missing:
        listed &&
        branches.length > 0 &&
        baseBranch !== entered &&
        !PULL_REQUEST_URL.test(baseBranch),
    });
  for (const branch of others)
    rows.push({
      value: branch,
      label: branch,
      selected: branch === baseBranch,
      missing: false,
    });
  return rows;
}

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
  const [entered, setEntered] = useState<string>();
  const endpoint = branchListEndpoint(cwd, runner);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const cmdRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const closeDropdown = useCallback(() => setDropdownOpen(false), []);
  if (disabled && dropdownOpen) setDropdownOpen(false);
  useClickOutside(cmdRef, dropdownOpen, closeDropdown);

  // Load eagerly so the closed control names the repository default.
  const branches = useQuery({
    queryKey: ["branch-select", endpoint],
    queryFn: ({ signal }) =>
      api<{ branches: string[]; defaultBranch?: string }>(endpoint, { signal }),
    enabled: !disabled && Boolean(endpoint),
    staleTime: 30_000,
    retry: false,
  });
  const listedBranches = branches.data?.branches ?? EMPTY_BRANCHES;
  const defaultBranch = branches.data?.defaultBranch ?? "";
  const branchesLoading = branches.isFetching;
  const fetchError = branches.error?.message ?? null;

  const openDropdown = useCallback(() => {
    if (disabled) return;
    setTyped("");
    setDropdownOpen(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [disabled]);

  const rows = useMemo(
    () =>
      branchRows({
        branches: listedBranches,
        defaultBranch,
        baseBranch,
        typed,
        allowPullRequest,
        listed: branches.isSuccess && !branchesLoading,
        entered,
      }),
    [
      listedBranches,
      defaultBranch,
      baseBranch,
      typed,
      allowPullRequest,
      branches.isSuccess,
      branchesLoading,
      entered,
    ]
  );
  const savedBranchMissing = rows.some((row) => row.missing);
  const choose = (value: string) => {
    if (value && value === typed.trim()) setEntered(value);
    onBaseBranchChange(value);
    setDropdownOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

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
            {baseBranch || defaultBranch || "Repository default"}
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
                  allowPullRequest
                    ? "Branch name or GitHub PR URL"
                    : "Search or enter a branch"
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
                  {rows.map((row) => (
                    <CommandItem
                      key={row.value || "\0default"}
                      value={row.label}
                      keywords={row.value ? undefined : ["default"]}
                      data-testid={`${testIdPrefix}-base-branch-option`}
                      className="font-mono"
                      onSelect={() => choose(row.value)}
                    >
                      <Check
                        className={cn(
                          "mr-2 h-3 w-3 shrink-0",
                          row.selected ? "opacity-100" : "opacity-0"
                        )}
                      />
                      <span className="truncate">{row.label}</span>
                      {row.missing ? (
                        <span className="ml-2 text-[10px] uppercase tracking-wide text-status-waiting">
                          not found
                        </span>
                      ) : null}
                    </CommandItem>
                  ))}
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
