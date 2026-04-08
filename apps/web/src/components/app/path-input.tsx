import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Check, CheckCircle2, ChevronDown, GitBranch, Loader2, X } from "lucide-react";

import { Command, CommandGroup, CommandItem, CommandList } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
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

type PathInfo = { exists: boolean; isDirectory: boolean; isGitRepo: boolean };

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
  /** Label text above the input */
  label?: string;
  /** HTML id for the input */
  id?: string;
  /** data-testid for the input */
  "data-testid"?: string;
  className?: string;
};

export function PathInput({
  value,
  onChange,
  placeholder = "~/path/to/project",
  showValidation = true,
  history = [],
  onRemoveHistory,
  label,
  id,
  "data-testid": testId,
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
      return;
    }
    if (!showValidation) return;
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
  }, [value, showValidation]);

  // Debounced inline ghost completion
  useEffect(() => {
    const trimmed = value.trim();
    if (!trimmed || (!trimmed.startsWith("/") && !trimmed.startsWith("~"))) {
      setGhostSuffix("");
      return;
    }
    const timer = setTimeout(() => {
      api<{ completions: string[] }>(`/api/v1/system/path-completions?prefix=${encodeURIComponent(trimmed)}`)
        .then((result) => {
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
        <label className="mb-1.5 block text-xs font-medium text-muted-foreground" htmlFor={id}>
          {label}
        </label>
      ) : null}

      {showValidation ? (
        <div className="mb-1.5 flex items-center gap-1.5 text-xs">
          {validating ? (
            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
          ) : pathValidation ? (
            pathValidation.isDirectory ? (
              <>
                <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                {pathValidation.isGitRepo ? (
                  <>
                    <GitBranch className="h-3 w-3 text-emerald-500" />
                    <span className="text-emerald-600 dark:text-emerald-400">Git repository</span>
                  </>
                ) : (
                  <span className="text-emerald-600 dark:text-emerald-400">Valid directory</span>
                )}
              </>
            ) : pathValidation.exists ? (
              <>
                <AlertCircle className="h-3 w-3 text-amber-500" />
                <span className="text-amber-600 dark:text-amber-400">Not a directory</span>
              </>
            ) : (
              <>
                <AlertCircle className="h-3 w-3 text-amber-500" />
                <span className="text-amber-600 dark:text-amber-400">Directory not found</span>
              </>
            )
          ) : null}
        </div>
      ) : null}

      <div className="relative" ref={cmdRef}>
        <div className="relative">
          {/* Ghost autocomplete overlay */}
          {ghostSuffix && value.trim() ? (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 flex h-9 items-center overflow-hidden rounded-md border border-transparent px-3 py-2 font-mono text-xs"
            >
              <span className="invisible whitespace-pre">{value}</span>
              <span className="whitespace-pre text-muted-foreground/40">{ghostSuffix}</span>
            </div>
          ) : null}
          <Input
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
              if ((e.key === "Enter" || e.key === "ArrowDown") && !dropdownOpen && history.length > 0) {
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
            className="bg-transparent pr-8 font-mono text-xs"
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
              <ChevronDown className={cn("h-4 w-4 transition-transform", dropdownOpen && "rotate-180")} />
            </button>
          ) : null}
        </div>
        {dropdownOpen && sortedHistory.length > 0 ? (
          <div className="absolute left-0 right-0 z-[60] mt-1.5 rounded-md border border-border bg-background p-1 shadow-md">
            <Command shouldFilter={false} onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setDropdownOpen(false);
                inputRef.current?.focus();
              }
            }}>
              <CommandList>
                <CommandGroup heading="Recent">
                  {sortedHistory.map((dir) => (
                    <CommandItem
                      key={dir}
                      value={dir}
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
    </div>
  );
}
