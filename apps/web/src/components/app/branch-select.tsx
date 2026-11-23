import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  Combobox,
  ComboboxContent,
  ComboboxItem,
  ComboboxTrigger,
} from "@/components/ui/combobox";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";

const EMPTY_BRANCHES: string[] = [];

const PULL_REQUEST_URL =
  /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/[1-9]\d*\/?$/;

export type BranchSelectProps = {
  cwd: string;
  /** Lists a runner repository's branches instead of the local folder's. */
  runner?: { id: string; repository: string };
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
  return runner.repository
    ? `/api/v1/git/branches?runnerId=${encodeURIComponent(runner.id)}&repository=${encodeURIComponent(runner.repository)}`
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
      if (!runner && !localResult) void fetchLocalBranches();
    }
    setDropdownOpen(next);
  };

  const rows = useMemo(() => {
    if (!runner) {
      const base = listedBranches.includes("main")
        ? listedBranches
        : ["main", ...listedBranches];
      const localRows =
        baseBranch && !base.includes(baseBranch) ? [baseBranch, ...base] : base;
      return localRows.map((branch) => ({
        value: branch,
        label: branch,
        selected: branch === baseBranch,
        missing:
          branch === baseBranch &&
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
  };

  return (
    <div className="space-y-2">
      <Field
        label={baseBranchLabel}
        error={
          fetchError ? (
            <>
              Couldn’t load branches.{" "}
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
            </>
          ) : null
        }
        hint={
          fetchError ? null : savedBranchMissing ? (
            <span className="text-warning-ink">
              Saved branch <span className="font-mono">{baseBranch}</span> no
              longer exists on the remote — pick a new one.
            </span>
          ) : (
            baseBranchHelper
          )
        }
      >
        <Combobox
          open={dropdownOpen}
          onOpenChange={changeOpen}
          search={runner ? typed : undefined}
          onSearchChange={runner ? setTyped : undefined}
        >
          <ComboboxTrigger
            disabled={disabled}
            loading={branchesLoading}
            data-testid={`${testIdPrefix}-base-branch`}
            className="font-mono text-body-sm"
          >
            {runner
              ? baseBranch || defaultBranch || "Repository default"
              : baseBranch}
          </ComboboxTrigger>
          <ComboboxContent
            label="Search branches"
            placeholder={
              allowPullRequest
                ? "Branch name or GitHub PR URL"
                : runner
                  ? "Search or enter a branch"
                  : "Search branches…"
            }
            value={
              runner ? rows.find((row) => row.selected)?.label : baseBranch
            }
            emptyMessage="No matching branches."
            status={
              branchesLoading ? (
                <>
                  <Spinner />
                  Loading branches…
                </>
              ) : undefined
            }
          >
            {rows.map((row) => (
              <ComboboxItem
                key={row.value || "\0default"}
                value={row.label}
                keywords={row.value ? undefined : ["default"]}
                selected={row.selected}
                data-testid={`${testIdPrefix}-base-branch-option`}
                className="font-mono"
                onSelect={() => choose(row.value)}
              >
                <span className="min-w-0 break-all">{row.label}</span>
                {row.missing ? (
                  <span className="ml-auto text-label-xs uppercase tracking-wide text-warning-ink">
                    not found
                  </span>
                ) : null}
              </ComboboxItem>
            ))}
          </ComboboxContent>
        </Combobox>
      </Field>
      {showNewBranchInput ? (
        <Input
          aria-label="New branch name"
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
