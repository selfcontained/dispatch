import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  GitBranch,
  X,
} from "lucide-react";

import { ActivityBars } from "@/components/ui/activity-bars";
import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
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
  const sortedHistory = useMemo(
    () => [...history].sort((left, right) => left.localeCompare(right)),
    [history]
  );

  // --- Path validation state ---
  const [pathValidation, setPathValidation] = useState<PathInfo | null>(null);
  const [validating, setValidating] = useState(false);

  // --- Inline ghost autocomplete ---
  const [ghostSuffix, setGhostSuffix] = useState("");

  // Debounced path validation
  useEffect(() => {
    const trimmed = value.trim();
    if (!trimmed) {
      setPathValidation(null);
      onPathInfoChange?.(null);
      return;
    }
    if (!showValidation) return;
    // Treat the path as unknown until the new validation lands so callers
    // don't act on stale info from the previous value during the debounce.
    setPathValidation(null);
    onPathInfoChange?.(null);
    setValidating(true);
    const timer = setTimeout(() => {
      api<PathInfo & { resolvedPath: string }>(
        `/api/v1/system/path-info?path=${encodeURIComponent(trimmed)}`
      )
        .then((result) => {
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
          setPathValidation(null);
          onPathInfoChange?.(null);
        })
        .finally(() => setValidating(false));
    }, 400);
    return () => {
      clearTimeout(timer);
      setValidating(false);
    };
  }, [value, showValidation, onPathInfoChange]);

  // Debounced inline ghost completion
  useEffect(() => {
    const trimmed = value.trim();
    if (!trimmed || (!trimmed.startsWith("/") && !trimmed.startsWith("~"))) {
      setGhostSuffix("");
      return;
    }
    const timer = setTimeout(() => {
      api<{ completions: string[]; privacyRestricted?: boolean }>(
        `/api/v1/system/path-completions?prefix=${encodeURIComponent(trimmed)}`
      )
        .then((result) => {
          if (result.privacyRestricted) {
            setGhostSuffix("");
            return;
          }
          if (result.completions.length > 0) {
            const best = result.completions[0];
            if (best.startsWith(trimmed.replace(/\/$/, ""))) {
              let suffix = best.slice(trimmed.replace(/\/$/, "").length);
              if (trimmed.endsWith("/") && suffix.startsWith("/")) {
                suffix = suffix.slice(1);
              }
              setGhostSuffix(suffix);
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
            onChange={(event) => {
              onChange(event.target.value);
              if (history.length > 0) {
                setDropdownOpen(true);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape" && dropdownOpen) {
                e.preventDefault();
                e.stopPropagation();
                setDropdownOpen(false);
              }
              if (
                (e.key === "Enter" || e.key === "ArrowDown") &&
                !dropdownOpen &&
                history.length > 0
              ) {
                e.preventDefault();
                setDropdownOpen(true);
              }
              if (e.key === "Tab" && ghostSuffix) {
                e.preventDefault();
                e.stopPropagation();
                const accepted = value.replace(/\/$/, "") + ghostSuffix + "/";
                onChange(accepted);
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
        {dropdownOpen && sortedHistory.length > 0 ? (
          <div className="absolute left-0 right-0 z-[60] mt-1.5 rounded-md border border-white/[0.2] bg-[hsl(var(--card))] backdrop-blur-2xl p-1 shadow-[0_16px_64px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.15)]">
            <Command
              shouldFilter={false}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setDropdownOpen(false);
                  inputRef.current?.focus();
                }
              }}
            >
              <CommandList>
                <CommandGroup heading="Recent">
                  {sortedHistory.map((dir) => (
                    <CommandItem
                      key={dir}
                      value={dir}
                      data-testid={historyItemTestId}
                      className="group font-mono text-xs"
                      onSelect={() => {
                        onChange(dir);
                        setDropdownOpen(false);
                        inputRef.current?.focus();
                      }}
                    >
                      <span className="truncate">{dir}</span>
                      {onRemoveHistory ? (
                        <button
                          type="button"
                          className="ml-auto shrink-0 p-0.5 text-muted-foreground opacity-0 hover:text-foreground group-data-[selected=true]:opacity-100"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            onRemoveHistory(dir);
                          }}
                          title="Remove from history"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      ) : null}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
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
