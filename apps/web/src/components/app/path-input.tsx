import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  FolderGit2,
  GitBranch,
  X,
} from "lucide-react";

import { ActivityBars } from "@/components/ui/activity-bars";
import {
  acceptGhostCompletion,
  filterHistoryOptions,
  getHistoryOptions,
  ghostCompletionSuffix,
  type HistoryOption,
  type PathHistoryMetadata,
} from "@/components/app/path-input-utils";
import { useClickOutside } from "@/hooks/use-click-outside";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

type PathInfo = {
  exists: boolean;
  isDirectory: boolean;
  isGitRepo: boolean;
  privacyRestricted?: boolean;
};

type PathInputProps = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Show path validation status (exists, is directory, is git repo) */
  showValidation?: boolean;
  /** Recent directory history for dropdown */
  history?: string[];
  /** History entries that can be removed from this client. Defaults to history. */
  removableHistory?: string[];
  /** Extra presentation data for history entries, keyed by full path. */
  historyMetadata?: Record<string, PathHistoryMetadata>;
  /** Called when a history entry is removed */
  onRemoveHistory?: (dir: string) => void;
  /**
   * Called whenever the validated path info changes (null while unknown).
   * Memoize with `useCallback` — the prop is in the path-validation effect's
   * dependency array, so a fresh function on every parent render would
   * re-fire validation and kick off duplicate API calls.
   */
  onPathInfoChange?: (info: PathInfo | null) => void;
  /** Label text above the input */
  label?: string;
  /** HTML id for the input */
  id?: string;
  /** data-testid for the input */
  "data-testid"?: string;
  /** data-testid for each history dropdown item */
  historyItemTestId?: string;
  className?: string;
};

export function PathInput({
  value,
  onChange,
  placeholder = "~/path/to/project",
  showValidation = true,
  history = [],
  removableHistory,
  historyMetadata = {},
  onRemoveHistory,
  onPathInfoChange,
  label,
  id,
  "data-testid": testId,
  historyItemTestId,
  className,
}: PathInputProps): JSX.Element {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const cmdRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const closeDropdown = useCallback(() => setDropdownOpen(false), []);
  useClickOutside(cmdRef, dropdownOpen, closeDropdown);
  const [historyFilter, setHistoryFilter] = useState("");
  const historyOptions = useMemo<HistoryOption[]>(
    () => getHistoryOptions(history, historyMetadata),
    [history, historyMetadata]
  );
  const filteredHistoryOptions = useMemo<HistoryOption[]>(
    () => filterHistoryOptions(historyOptions, historyFilter),
    [historyOptions, historyFilter]
  );
  const [projectSuggestionOptions, setProjectSuggestionOptions] = useState<
    HistoryOption[]
  >([]);
  const removableHistoryPathSet = useMemo(
    () => new Set(removableHistory ?? history),
    [history, removableHistory]
  );
  const options = useMemo<HistoryOption[]>(() => {
    const seen = new Set<string>();
    return [...filteredHistoryOptions, ...projectSuggestionOptions].filter(
      (option) => {
        if (seen.has(option.path)) return false;
        seen.add(option.path);
        return true;
      }
    );
  }, [filteredHistoryOptions, projectSuggestionOptions]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const projectSuggestionsRequestRef = useRef(0);
  const listboxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!dropdownOpen) return;
    setSelectedIndex(0);
  }, [dropdownOpen, options.length, historyFilter]);

  useEffect(() => {
    if (!dropdownOpen) return;
    listboxRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [dropdownOpen, selectedIndex]);

  const selectOption = useCallback(
    (option: HistoryOption) => {
      onChange(option.path);
      setDropdownOpen(false);
      inputRef.current?.focus();
    },
    [onChange]
  );

  // --- Path validation state ---
  const [pathValidation, setPathValidation] = useState<PathInfo | null>(null);
  const [validating, setValidating] = useState(false);
  const validationRequestRef = useRef(0);

  // --- Inline ghost autocomplete ---
  const [ghostSuffix, setGhostSuffix] = useState("");
  const completionRequestRef = useRef(0);

  // Debounced project suggestions from agent history. This is intentionally
  // separate from filesystem path completions: the dropdown shows known
  // projects, while arbitrary full paths still validate and can use Tab.
  useEffect(() => {
    if (!dropdownOpen) {
      projectSuggestionsRequestRef.current += 1;
      setProjectSuggestionOptions([]);
      return;
    }

    const requestId = ++projectSuggestionsRequestRef.current;
    const query = historyFilter.trim();
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ limit: "20" });
      if (query) params.set("search", query);

      api<{
        projectOptions?: Array<{
          path: string;
          usageCount: number;
          iconUrl?: string;
        }>;
        projects: string[];
      }>(`/api/v1/history/projects?${params.toString()}`)
        .then((payload) => {
          if (requestId !== projectSuggestionsRequestRef.current) return;
          const metadata = Object.fromEntries(
            (payload.projectOptions ?? []).map((option) => [
              option.path,
              {
                usageCount: option.usageCount,
                iconUrl: option.iconUrl,
              },
            ])
          );
          setProjectSuggestionOptions(
            getHistoryOptions(payload.projects, metadata)
          );
        })
        .catch(() => {
          if (requestId === projectSuggestionsRequestRef.current) {
            setProjectSuggestionOptions([]);
          }
        });
    }, 120);

    return () => {
      clearTimeout(timer);
    };
  }, [dropdownOpen, historyFilter]);

  // Debounced path validation
  useEffect(() => {
    const trimmed = value.trim();
    if (!trimmed) {
      validationRequestRef.current += 1;
      setPathValidation(null);
      onPathInfoChange?.(null);
      return;
    }
    if (!showValidation) return;
    const requestId = ++validationRequestRef.current;
    // Treat the path as unknown until the new validation lands so callers
    // don't act on stale info from the previous value during the debounce.
    setPathValidation(null);
    onPathInfoChange?.(null);
    setValidating(true);
    const timer = setTimeout(() => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      api<PathInfo & { resolvedPath: string }>(
        `/api/v1/system/path-info?path=${encodeURIComponent(trimmed)}`,
        { signal: controller.signal }
      )
        .then((result) => {
          if (requestId !== validationRequestRef.current) return;
          if (result.privacyRestricted) {
            setPathValidation(null);
            onPathInfoChange?.(null);
            return;
          }
          const info: PathInfo = {
            exists: result.exists,
            isDirectory: result.isDirectory,
            isGitRepo: result.isGitRepo,
          };
          setPathValidation(info);
          onPathInfoChange?.(info);
        })
        .catch(() => {
          if (requestId !== validationRequestRef.current) return;
          setPathValidation(null);
          onPathInfoChange?.(null);
        })
        .finally(() => {
          clearTimeout(timeout);
          if (requestId === validationRequestRef.current) {
            setValidating(false);
          }
        });
    }, 400);
    return () => {
      clearTimeout(timer);
      validationRequestRef.current += 1;
      setValidating(false);
    };
  }, [value, showValidation, onPathInfoChange]);

  // Debounced inline ghost completion
  useEffect(() => {
    const trimmed = value.trim();
    if (!trimmed || (!trimmed.startsWith("/") && !trimmed.startsWith("~"))) {
      completionRequestRef.current += 1;
      setGhostSuffix("");
      return;
    }
    const requestId = ++completionRequestRef.current;
    setGhostSuffix("");
    const timer = setTimeout(() => {
      api<{ completions: string[]; privacyRestricted?: boolean }>(
        `/api/v1/system/path-completions?prefix=${encodeURIComponent(trimmed)}`
      )
        .then((result) => {
          if (requestId !== completionRequestRef.current) return;
          if (result.privacyRestricted) {
            setGhostSuffix("");
            return;
          }
          if (result.completions.length > 0) {
            setGhostSuffix(
              ghostCompletionSuffix(trimmed, result.completions[0])
            );
          } else {
            setGhostSuffix("");
          }
        })
        .catch(() => {
          if (requestId === completionRequestRef.current) {
            setGhostSuffix("");
          }
        });
    }, 150);
    return () => {
      clearTimeout(timer);
    };
  }, [value]);

  return (
    <div className={cn("relative", className)}>
      {label ? (
        <label
          className="mb-1.5 block text-xs font-medium text-muted-foreground"
          htmlFor={id}
        >
          {label}
        </label>
      ) : null}

      <div className="relative" ref={cmdRef}>
        <div className="relative rounded-md border border-white/[0.12] bg-white/[0.04] backdrop-blur-md shadow-[inset_0_2px_6px_rgba(0,0,0,0.3)]">
          {/* Ghost autocomplete overlay */}
          {ghostSuffix && value.trim() ? (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 flex h-9 items-center overflow-hidden rounded-md border border-transparent px-3 py-2 font-mono text-xs"
            >
              <span className="invisible whitespace-pre">{value}</span>
              <span className="whitespace-pre text-muted-foreground/40">
                {ghostSuffix}
              </span>
            </div>
          ) : null}
          <input
            ref={inputRef}
            id={id}
            value={value}
            aria-expanded={dropdownOpen}
            aria-haspopup="listbox"
            aria-activedescendant={
              dropdownOpen && options[selectedIndex]
                ? `${id ?? testId ?? "path-input"}-option-${selectedIndex}`
                : undefined
            }
            onChange={(event) => {
              const nextValue = event.target.value;
              onChange(nextValue);
              setHistoryFilter(nextValue);
              setDropdownOpen(true);
            }}
            onFocus={() => {
              setHistoryFilter("");
              setDropdownOpen(true);
            }}
            onKeyDown={(e) => {
              const selectedOption = options[selectedIndex];
              if (e.key === "Escape" && dropdownOpen) {
                e.preventDefault();
                e.stopPropagation();
                setDropdownOpen(false);
              }
              if (e.key === "ArrowDown" && options.length > 0) {
                e.preventDefault();
                if (!dropdownOpen) {
                  setDropdownOpen(true);
                  return;
                }
                setSelectedIndex((index) =>
                  Math.min(index + 1, options.length - 1)
                );
              }
              if (e.key === "ArrowUp" && options.length > 0) {
                e.preventDefault();
                if (!dropdownOpen) {
                  setDropdownOpen(true);
                  setSelectedIndex(options.length - 1);
                  return;
                }
                setSelectedIndex((index) => Math.max(index - 1, 0));
              }
              if (e.key === "Enter" && dropdownOpen && selectedOption) {
                e.preventDefault();
                e.stopPropagation();
                selectOption(selectedOption);
              }
              if (e.key === "Tab" && ghostSuffix) {
                e.preventDefault();
                e.stopPropagation();
                onChange(acceptGhostCompletion(value, ghostSuffix));
                setGhostSuffix("");
              }
            }}
            placeholder={placeholder}
            data-testid={testId}
            className="flex h-9 w-full bg-transparent pr-8 px-3 py-1 font-mono text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none"
          />
          {history.length > 0 ? (
            <button
              type="button"
              tabIndex={-1}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground"
              onMouseDown={(event) => {
                event.preventDefault();
                setDropdownOpen((prev) => !prev);
                inputRef.current?.focus();
              }}
            >
              <ChevronDown
                className={cn(
                  "h-4 w-4 transition-transform",
                  dropdownOpen && "rotate-180"
                )}
              />
            </button>
          ) : null}
        </div>
        {dropdownOpen && options.length > 0 ? (
          <div className="absolute left-0 right-0 z-[60] mt-1.5 rounded-md border border-white/[0.2] bg-[hsl(var(--card))] p-1 shadow-[0_16px_64px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.15)] backdrop-blur-2xl">
            <div className="px-2 py-1.5 text-[11px] font-medium text-muted-foreground">
              Suggestions
            </div>
            <div
              ref={listboxRef}
              role="listbox"
              className="max-h-[240px] overflow-y-auto overflow-x-hidden"
            >
              {options.map((option, index) => {
                const selected = index === selectedIndex;
                const isRemovableOption = removableHistoryPathSet.has(
                  option.path
                );
                return (
                  <div
                    key={option.path}
                    id={`${id ?? testId ?? "path-input"}-option-${index}`}
                    role="option"
                    aria-selected={selected}
                    data-testid={historyItemTestId}
                    data-selected={selected}
                    className={cn(
                      "group flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-2 text-xs outline-none",
                      selected && "bg-primary/20 text-foreground"
                    )}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      selectOption(option);
                    }}
                    onMouseMove={() => setSelectedIndex(index)}
                  >
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-border/70 bg-muted/40">
                      <PathOptionIcon iconUrl={option.iconUrl} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium leading-4">
                        {option.label}
                      </span>
                      <span className="block truncate font-mono text-[10px] text-muted-foreground">
                        {option.path}
                      </span>
                    </span>
                    {option.usageCount > 0 ? (
                      <span
                        className="shrink-0 rounded border border-border/70 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                        title={`${option.usageCount} uses`}
                      >
                        {option.usageCount}
                      </span>
                    ) : null}
                    {onRemoveHistory && isRemovableOption ? (
                      <button
                        type="button"
                        className="ml-auto shrink-0 p-0.5 text-muted-foreground opacity-0 hover:text-foreground group-data-[selected=true]:opacity-100"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          onRemoveHistory(option.path);
                        }}
                        title="Remove from history"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>

      {showValidation ? (
        <div className="flex h-5 items-center justify-end gap-1.5 text-xs">
          {validating ? (
            <ActivityBars size={12} />
          ) : pathValidation ? (
            pathValidation.isDirectory ? (
              <>
                <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                {pathValidation.isGitRepo ? (
                  <>
                    <GitBranch className="h-3 w-3 text-emerald-500" />
                    <span className="text-emerald-600 dark:text-emerald-400">
                      Git repository
                    </span>
                  </>
                ) : (
                  <span className="text-emerald-600 dark:text-emerald-400">
                    Valid directory
                  </span>
                )}
              </>
            ) : pathValidation.exists ? (
              <>
                <AlertCircle className="h-3 w-3 text-amber-500" />
                <span className="text-amber-600 dark:text-amber-400">
                  Not a directory
                </span>
              </>
            ) : (
              <>
                <AlertCircle className="h-3 w-3 text-amber-500" />
                <span className="text-amber-600 dark:text-amber-400">
                  Directory not found
                </span>
              </>
            )
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function PathOptionIcon({ iconUrl }: { iconUrl?: string }): JSX.Element {
  const [imageFailed, setImageFailed] = useState(false);

  if (iconUrl && !imageFailed) {
    return (
      <img
        src={iconUrl}
        alt=""
        onError={() => setImageFailed(true)}
        className="h-4 w-4 object-contain"
      />
    );
  }

  return <FolderGit2 className="h-3.5 w-3.5 text-muted-foreground" />;
}
