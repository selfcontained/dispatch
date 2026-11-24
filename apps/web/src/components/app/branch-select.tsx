import { useCallback, useMemo, useRef, useState } from "react";

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

export type BranchSelectProps = {
  cwd: string;
  sourceUrl?: string;
  defaultBaseBranch?: string;
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
  sourceUrl,
  defaultBaseBranch = "main",
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
  const source =
    sourceUrl ??
    (cwd.trim()
      ? `/api/v1/git/branches?cwd=${encodeURIComponent(cwd.trim())}`
      : "");
  const activeSource = useRef(source);
  activeSource.current = source;
  const [reportedDefault, setReportedDefault] = useState("");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [remoteBranches, setRemoteBranches] = useState<string[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [fetchedForCwd, setFetchedForCwd] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  if (disabled && dropdownOpen) setDropdownOpen(false);

  const fetchBranches = useCallback(async () => {
    const trimmed = source;
    if (!trimmed || disabled) return;
    setBranchesLoading(true);
    setFetchError(null);
    try {
      const result = await api<{ branches: string[]; defaultBranch?: string }>(
        source
      );
      if (activeSource.current !== trimmed) return;
      setRemoteBranches(result.branches);
      setReportedDefault(result.defaultBranch ?? "");
    } catch (error) {
      if (activeSource.current !== trimmed) return;
      setRemoteBranches([]);
      setFetchError(
        error instanceof Error ? error.message : "Couldn’t load branches."
      );
    } finally {
      if (activeSource.current === trimmed) {
        setBranchesLoading(false);
        setFetchedForCwd(trimmed);
      }
    }
  }, [source, disabled]);

  const changeOpen = useCallback(
    (open: boolean) => {
      if (disabled) return;
      setDropdownOpen(open);
      if (open && fetchedForCwd !== source) void fetchBranches();
    },
    [disabled, fetchBranches, fetchedForCwd, source]
  );

  // Keep the saved baseBranch selectable even if the fetched list doesn't
  // include it (branch renamed/deleted upstream). We flag it visually in
  // the dropdown rather than silently overwrite it.
  const allBranches = useMemo(() => {
    const listed = fetchedForCwd === source ? remoteBranches : [];
    const base = listed.includes(defaultBaseBranch)
      ? listed
      : [
          defaultBaseBranch,
          ...listed.filter(
            (branch) => defaultBaseBranch || branch !== reportedDefault
          ),
        ];
    if (baseBranch && !base.includes(baseBranch)) return [baseBranch, ...base];
    return base;
  }, [
    remoteBranches,
    baseBranch,
    defaultBaseBranch,
    fetchedForCwd,
    source,
    reportedDefault,
  ]);

  const savedBranchMissing =
    !branchesLoading &&
    !!baseBranch &&
    !!fetchedForCwd &&
    remoteBranches.length > 0 &&
    !remoteBranches.includes(baseBranch);

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
                onClick={() => void fetchBranches()}
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
        <Combobox open={dropdownOpen} onOpenChange={changeOpen}>
          <ComboboxTrigger
            disabled={disabled}
            loading={branchesLoading}
            data-testid={`${testIdPrefix}-base-branch`}
            className="font-mono text-body-sm"
          >
            {baseBranch ||
              (fetchedForCwd === source ? reportedDefault : "") ||
              defaultBaseBranch ||
              "Repository default"}
          </ComboboxTrigger>
          <ComboboxContent
            label="Search branches"
            placeholder="Search branches…"
            value={baseBranch}
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
            {allBranches.map((branch) => {
              const isMissing =
                !!branch &&
                branch === baseBranch &&
                remoteBranches.length > 0 &&
                !remoteBranches.includes(branch);
              return (
                <ComboboxItem
                  key={branch || reportedDefault || "Repository default"}
                  value={branch || reportedDefault || "Repository default"}
                  selected={branch === baseBranch}
                  data-testid={`${testIdPrefix}-base-branch-option`}
                  className="font-mono"
                  onSelect={() => onBaseBranchChange(branch)}
                >
                  <span className="min-w-0 break-all">
                    {branch ||
                      reportedDefault ||
                      defaultBaseBranch ||
                      "Repository default"}
                  </span>
                  {isMissing ? (
                    <span className="ml-auto text-label-xs uppercase tracking-wide text-warning-ink">
                      not found
                    </span>
                  ) : null}
                </ComboboxItem>
              );
            })}
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
