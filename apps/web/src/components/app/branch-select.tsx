import { useMemo, useRef, useState } from "react";
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
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
   * Fired when the user picks a branch; runners use "" for the repository default.
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
 * Runner rows: the repository default, then a typed
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
  allowPullRequest: allowPullRequestInput = false,
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
  const allowPullRequest = Boolean(runner) && allowPullRequestInput;
  const typedBranch = runner ? typed : "";
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [localList, setLocalList] = useState<{
    endpoint: string;
    branches?: string[];
    error?: string;
  }>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  if (disabled && dropdownOpen) setDropdownOpen(false);

  // Runners load eagerly so the closed control names the repository default.
  const branches = useQuery({
    queryKey: ["branch-select", endpoint],
    queryFn: ({ signal }) =>
      api<{ branches: string[]; defaultBranch?: string }>(endpoint, { signal }),
    enabled: Boolean(runner && !disabled && endpoint),
    staleTime: 30_000,
    retry: false,
  });
  const localResult = localList?.endpoint === endpoint ? localList : undefined;
  const listedBranches =
    (runner ? branches.data?.branches : localResult?.branches) ??
    EMPTY_BRANCHES;
  const defaultBranch = runner ? (branches.data?.defaultBranch ?? "") : "";
  const branchesLoading = runner
    ? branches.isFetching
    : Boolean(localResult && !localResult.branches && !localResult.error);
  const fetchError = runner ? branches.error?.message : localResult?.error;

  const fetchLocalBranches = async () => {
    if (!endpoint || disabled) return;
    const pending = { endpoint };
    setLocalList(pending);
    try {
      const result = await api<{ branches: string[] }>(endpoint);
      setLocalList((current) =>
        current === pending ? { endpoint, branches: result.branches } : current
      );
    } catch (error) {
      setLocalList((current) =>
        current === pending
          ? {
              endpoint,
              error:
                error instanceof Error
                  ? error.message
                  : "Couldn't load branches.",
            }
          : current
      );
    }
  };

  const changeOpen = (next: boolean) => {
    if (next && disabled) return;
    if (next) {
      setTyped("");
      if (!runner && !localResult) void fetchLocalBranches();
    }
    setDropdownOpen(next);
  };

  const localBase = baseBranch || "main";
  const rows = useMemo(() => {
    if (!runner) {
      const others = listedBranches.filter(
        (branch) => branch && branch !== "main"
      );
      if (localBase !== "main" && !others.includes(localBase)) {
        others.unshift(localBase);
      }
      return ["main", ...others].map((branch) => ({
        value: branch,
        label: branch,
        selected: branch === localBase,
        missing:
          branch === localBase &&
          listedBranches.length > 0 &&
          !listedBranches.includes(branch),
      }));
    }
    return branchRows({
      branches: listedBranches,
      defaultBranch,
      baseBranch,
      typed: typedBranch,
      allowPullRequest,
      listed: branches.isSuccess && !branchesLoading,
      entered,
    });
  }, [
    runner,
    localBase,
    listedBranches,
    defaultBranch,
    baseBranch,
    typedBranch,
    allowPullRequest,
    branches.isSuccess,
    branchesLoading,
    entered,
  ]);
  const savedBranchMissing = rows.some((row) => row.missing);
  const choose = (value: string) => {
    if (value && value === typedBranch.trim()) setEntered(value);
    onBaseBranchChange(value);
    setDropdownOpen(false);
  };
  // Keep the list inside the dialog's scroll lock, above its scrolling body.
  const dialog = triggerRef.current?.closest<HTMLElement>('[role="dialog"]');

  return (
    <div className="space-y-2">
      <div>
        <label className="mb-1 block text-body-sm text-muted-foreground">
          {baseBranchLabel}
        </label>
        <Popover open={dropdownOpen} onOpenChange={changeOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="field"
              ref={triggerRef}
              type="button"
              role="combobox"
              disabled={disabled}
              aria-label={baseBranchLabel}
              aria-expanded={dropdownOpen}
              data-testid={`${testIdPrefix}-base-branch`}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" && !dropdownOpen) {
                  e.preventDefault();
                  changeOpen(true);
                }
              }}
              className="w-full font-mono text-body-sm"
            >
              <span className="truncate">
                {runner
                  ? baseBranch || defaultBranch || "Repository default"
                  : localBase}
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
            </Button>
          </PopoverTrigger>
          <PopoverContent
            container={dialog}
            collisionBoundary={dialog}
            align="start"
            aria-label={baseBranchLabel}
            onOpenAutoFocus={(e) => {
              e.preventDefault();
              inputRef.current?.focus();
            }}
            className="flex w-[var(--radix-popover-trigger-width)] flex-col overflow-hidden p-0"
          >
            <Command className="min-h-0 border-0 bg-transparent shadow-none">
              <CommandInput
                ref={inputRef}
                value={typed}
                onValueChange={setTyped}
                placeholder={
                  allowPullRequest
                    ? "Branch name or GitHub PR URL"
                    : runner
                      ? "Search or enter a branch"
                      : "Search branches..."
                }
                className="font-mono text-body-sm"
              />
              <CommandList className="max-h-[min(200px,calc(var(--radix-popover-content-available-height)-2.75rem))] touch-pan-y overscroll-contain">
                {branchesLoading ? (
                  <CommandLoading>
                    <div className="flex items-center gap-2 px-2 py-3 text-body-sm text-muted-foreground">
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
                        <span className="ml-2 text-label-xs uppercase tracking-wide text-warning">
                          not found
                        </span>
                      ) : null}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>
      {fetchError ? (
        <div className="flex items-center gap-2 text-body-sm text-danger">
          <span className="truncate">Couldn't load branches.</span>
          <Button
            type="button"
            variant="link"
            size="inline"
            onClick={() =>
              void (runner ? branches.refetch() : fetchLocalBranches())
            }
            disabled={disabled}
          >
            Retry
          </Button>
        </div>
      ) : savedBranchMissing ? (
        <div className="text-body-sm text-warning">
          Saved branch{" "}
          <span className="font-mono">{runner ? baseBranch : localBase}</span>{" "}
          no longer exists on the remote — pick a new one.
        </div>
      ) : baseBranchHelper ? (
        <p className="text-body-sm text-muted-foreground">{baseBranchHelper}</p>
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
