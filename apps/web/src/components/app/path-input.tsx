import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  FolderGit2,
  GitBranch,
  X,
} from "lucide-react";

import { Spinner } from "@/components/ui/spinner";
import { CountBubble } from "@/components/ui/count-bubble";
import { IconButton } from "@/components/ui/icon-button";
import { Hint } from "@/components/ui/tooltip";
import {
  acceptGhostCompletion,
  filterHistoryOptions,
  getHistoryOptions,
  ghostCompletionSuffix,
  mergeHistoryOptions,
  type HistoryOption,
  type PathHistoryMetadata,
} from "@/components/app/path-input-utils";
import { useClickOutside } from "@/hooks/use-click-outside";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Field } from "@/components/ui/field";
import { useFieldControl } from "@/components/ui/field-context";
import { pickerItem } from "@/components/ui/picker-styles";

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
  // filteredHistoryOptions (local cwd history + a capped, usage-ranked
  // server snapshot fetched once by the parent) and projectSuggestionOptions
  // (this component's own live, search-scoped fetch) frequently describe the
  // same project — merge rather than dedup-by-first-source so a stale/
  // rank-capped entry with no iconUrl can't shadow a fresher one that has it.
  const options = useMemo<HistoryOption[]>(
    () => mergeHistoryOptions(filteredHistoryOptions, projectSuggestionOptions),
    [filteredHistoryOptions, projectSuggestionOptions]
  );
  const [selectedIndex, setSelectedIndex] = useState(0);
  const projectSuggestionsRequestRef = useRef(0);
  const listboxRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const listOpen = dropdownOpen && options.length > 0;

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
    <PathField label={label} id={id} className={className}>
      <div className="relative" ref={cmdRef}>
        <div className="relative rounded-md surface-inset">
          {/* Ghost autocomplete overlay */}
          {ghostSuffix && value.trim() ? (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 flex items-center overflow-hidden rounded-md border border-transparent px-3 py-2 font-mono text-body-sm"
            >
              <span className="invisible whitespace-pre">{value}</span>
              <span className="whitespace-pre text-faint">{ghostSuffix}</span>
            </div>
          ) : null}
          <PathTextInput
            ref={inputRef}
            id={id}
            value={value}
            role="combobox"
            aria-autocomplete="list"
            aria-controls={listOpen ? listId : undefined}
            aria-expanded={listOpen}
            aria-haspopup="listbox"
            aria-activedescendant={
              listOpen && options[selectedIndex]
                ? `${listId}-option-${selectedIndex}`
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
              if (e.key === "Escape" && listOpen) {
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
              if (e.key === "Tab" && !ghostSuffix) setDropdownOpen(false);
              if (e.key === "Tab" && ghostSuffix) {
                e.preventDefault();
                e.stopPropagation();
                onChange(acceptGhostCompletion(value, ghostSuffix));
                setGhostSuffix("");
              }
            }}
            placeholder={placeholder}
            data-testid={testId}
            className="flex h-9 w-full rounded-md bg-transparent pr-8 px-3 py-1 font-mono text-body-sm text-foreground placeholder:text-muted-foreground focus-ring pointer-coarse:h-11"
          />
          {history.length > 0 ? (
            <IconButton
              size="icon-xs"
              label="Show suggestions"
              tabIndex={-1}
              className="absolute right-1.5 top-1/2 -translate-y-1/2"
              onClick={() => {
                setDropdownOpen((prev) => !prev);
                inputRef.current?.focus();
              }}
              onMouseDown={(event) => event.preventDefault()}
            >
              <ChevronDown
                className={cn(
                  "transition-transform",
                  dropdownOpen && "rotate-180"
                )}
              />
            </IconButton>
          ) : null}
        </div>
        {dropdownOpen && options.length > 0 ? (
          <div className="absolute left-0 right-0 z-drawer-panel mt-1.5 rounded-md surface-overlay p-1">
            <div className="px-2 py-1.5 text-label-sm font-medium text-muted-foreground">
              Suggestions
            </div>
            <div
              ref={listboxRef}
              id={listId}
              role="listbox"
              aria-label="Suggestions"
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
                    id={`${listId}-option-${index}`}
                    role="option"
                    aria-selected={selected}
                    data-testid={historyItemTestId}
                    data-selected={selected}
                    className={cn(
                      pickerItem,
                      "group gap-2 px-2 py-2 text-body-sm",
                      selected && "bg-surface-hover"
                    )}
                    onClick={() => selectOption(option)}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseMove={() => setSelectedIndex(index)}
                  >
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm border border-border-subtle bg-surface-subtle">
                      <PathOptionIcon iconUrl={option.iconUrl} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body-md font-medium leading-4">
                        {option.label}
                      </span>
                      <span className="block truncate font-mono text-label-xs text-muted-foreground">
                        {option.path}
                      </span>
                    </span>
                    {option.usageCount > 0 ? (
                      <Hint label={`${option.usageCount} uses`}>
                        <CountBubble count={option.usageCount} />
                      </Hint>
                    ) : null}
                    {onRemoveHistory && isRemovableOption ? (
                      <IconButton
                        size="icon-xs"
                        label="Remove from history"
                        className="ml-auto opacity-0 focus-visible:opacity-100 group-data-[selected=true]:opacity-100 pointer-coarse:opacity-100"
                        onClick={(e) => {
                          e.stopPropagation();
                          onRemoveHistory(option.path);
                        }}
                      >
                        <X />
                      </IconButton>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>

      {showValidation ? (
        <div className="flex h-5 items-center justify-end gap-1.5 text-body-sm">
          {validating ? (
            <Spinner label="Checking the folder" />
          ) : pathValidation ? (
            pathValidation.isDirectory ? (
              <>
                <CheckCircle2 className="h-3 w-3 text-success" />
                {pathValidation.isGitRepo ? (
                  <>
                    <GitBranch className="h-3 w-3 text-success" />
                    <span className="text-success-ink">Git repository</span>
                  </>
                ) : (
                  <span className="text-success-ink">Valid directory</span>
                )}
              </>
            ) : pathValidation.exists ? (
              <>
                <AlertCircle className="h-3 w-3 text-warning" />
                <span className="text-warning-ink">Not a directory</span>
              </>
            ) : (
              <>
                <AlertCircle className="h-3 w-3 text-warning" />
                <span className="text-warning-ink">Directory not found</span>
              </>
            )
          ) : null}
        </div>
      ) : null}
    </PathField>
  );
}

function PathField({
  label,
  id,
  className,
  children,
}: {
  label?: string;
  id?: string;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return label ? (
    <Field label={label} id={id} className={cn("relative", className)}>
      {children}
    </Field>
  ) : (
    <div className={cn("relative", className)}>{children}</div>
  );
}

const PathTextInput = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>((rest, ref) => {
  const props = useFieldControl(rest);
  return (
    <input
      ref={ref}
      {...props}
      // Named by its Field, or else as what it is.
      aria-label={props["aria-label"] ?? (props.id ? undefined : "Folder path")}
    />
  );
});
PathTextInput.displayName = "PathTextInput";

function PathOptionIcon({ iconUrl }: { iconUrl?: string }): JSX.Element {
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => setImageFailed(false), [iconUrl]);

  if (iconUrl && !imageFailed) {
    return (
      <img
        src={iconUrl}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setImageFailed(true)}
        className="h-4 w-4 object-contain"
      />
    );
  }

  return <FolderGit2 className="h-3.5 w-3.5 text-muted-foreground" />;
}
