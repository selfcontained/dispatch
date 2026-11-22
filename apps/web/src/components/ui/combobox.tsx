import * as React from "react";
import { Check, ChevronDown } from "lucide-react";
import { defaultFilter } from "cmdk";

import { cn } from "@/lib/utils";
import { Button, type ButtonProps } from "./button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./command";
import { FieldContext, useFieldControl } from "./field-context";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { Spinner } from "./spinner";

type ComboboxState = {
  open: boolean;
  setOpen: (open: boolean) => void;
  search: string;
  setSearch: (search: string) => void;
};
const ComboboxContext = React.createContext<ComboboxState | null>(null);

function useCombobox(): ComboboxState {
  const state = React.useContext(ComboboxContext);
  if (!state) throw new Error("Combobox parts go inside Combobox.");
  return state;
}

/** How every searchable list matches: the rank, or 0 for no match. */
export function searchRank(text: string, search: string): number {
  const query = search.trim();
  return query ? defaultFilter(text, query) : 1;
}

/**
 * The searchable or async picker. A short fixed list uses Select.
 *
 * Arrows or Enter open it, and typing on the closed trigger opens it
 * searching. Inside, arrows move, Enter picks and Esc closes only the picker.
 */
export function Combobox({
  open: controlledOpen,
  onOpenChange,
  search: controlledSearch,
  onSearchChange,
  children,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  search?: string;
  onSearchChange?: (search: string) => void;
  children: React.ReactNode;
}): JSX.Element {
  const [ownOpen, setOwnOpen] = React.useState(false);
  const [ownSearch, setOwnSearch] = React.useState("");
  const open = controlledOpen ?? ownOpen;
  const search = controlledSearch ?? ownSearch;
  const setSearch = React.useCallback(
    (next: string) => {
      setOwnSearch(next);
      onSearchChange?.(next);
    },
    [onSearchChange]
  );
  const setOpen = React.useCallback(
    (next: boolean) => {
      setOwnOpen(next);
      onOpenChange?.(next);
      if (!next) setSearch("");
    },
    [onOpenChange, setSearch]
  );
  const state = React.useMemo(
    () => ({ open, setOpen, search, setSearch }),
    [open, setOpen, search, setSearch]
  );
  return (
    <ComboboxContext.Provider value={state}>
      {/* Modal, so its list scrolls and Esc stays with it inside a dialog. */}
      <Popover modal open={open} onOpenChange={setOpen}>
        {children}
      </Popover>
    </ComboboxContext.Provider>
  );
}

/** A field-style button, or with `asChild` the element given. */
export const ComboboxTrigger = React.forwardRef<
  HTMLButtonElement,
  ButtonProps & { loading?: boolean }
>(
  (
    { asChild, loading, children, className, onKeyDown, ...props },
    forwardedRef
  ) => {
    const { open, setOpen, search, setSearch } = useCombobox();
    const control = useFieldControl(props);
    const handlers = {
      role: "combobox",
      "aria-haspopup": "listbox" as const,
      onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => {
        onKeyDown?.(event);
        if (event.defaultPrevented) return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          setOpen(true);
        } else if (
          event.key.length === 1 &&
          event.key !== " " &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey
        ) {
          event.preventDefault();
          setSearch(open ? search + event.key : event.key);
          setOpen(true);
        }
      },
    };
    if (asChild) {
      return (
        <PopoverTrigger
          asChild
          ref={forwardedRef}
          className={className}
          {...control}
          {...handlers}
        >
          {children}
        </PopoverTrigger>
      );
    }
    return (
      <PopoverTrigger asChild>
        <Button
          ref={forwardedRef}
          type="button"
          variant="field"
          className={cn("w-full min-w-0", className)}
          {...control}
          {...handlers}
        >
          <span className="min-w-0 truncate">{children}</span>
          {loading ? (
            <Spinner />
          ) : (
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "text-muted-foreground transition-transform",
                open && "rotate-180"
              )}
            />
          )}
        </Button>
      </PopoverTrigger>
    );
  }
);
ComboboxTrigger.displayName = "ComboboxTrigger";

export function ComboboxContent({
  label,
  placeholder = "Search…",
  emptyMessage = "No matches.",
  status,
  value,
  shouldFilter = true,
  inputProps,
  panel,
  footer,
  className,
  children,
}: {
  /** Names the search box. */
  label: string;
  placeholder?: string;
  emptyMessage?: React.ReactNode;
  /** Replaces the empty message: loading, or why there are no choices. */
  status?: React.ReactNode;
  /** The current value, highlighted on opening. */
  value?: string;
  shouldFilter?: boolean;
  inputProps?: Omit<
    React.ComponentPropsWithoutRef<typeof CommandInput>,
    "value" | "onValueChange"
  >;
  /** Replaces the search and list while set. */
  panel?: React.ReactNode;
  /** Sits under the list, outside it, so Enter reaches its own buttons. */
  footer?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}): JSX.Element {
  const { search, setSearch } = useCombobox();
  const content = React.useRef<HTMLDivElement>(null);
  return (
    <PopoverContent
      ref={content}
      align="start"
      collisionPadding={8}
      className={cn(
        "flex w-[max(var(--radix-popover-trigger-width),14rem)] max-w-[calc(100vw-1rem)] flex-col overflow-hidden p-0",
        className
      )}
      onOpenAutoFocus={(event) => {
        const input = content.current?.querySelector("input");
        if (!input) return;
        event.preventDefault();
        input.focus();
        // Not select-all: the key that opened it is the first letter typed.
        input.setSelectionRange(input.value.length, input.value.length);
        content.current
          ?.querySelector('[cmdk-item][aria-selected="true"]')
          ?.scrollIntoView?.({ block: "nearest" });
      }}
    >
      {/* Portalled, so a control in here is not the surrounding Field's. */}
      <FieldContext.Provider value={null}>
        {panel ?? (
          <Command
            label={label}
            shouldFilter={shouldFilter}
            filter={searchRank}
            defaultValue={search ? undefined : value}
            className="h-auto min-h-0 flex-auto border-0 bg-transparent shadow-none backdrop-blur-none"
          >
            <CommandInput
              value={search}
              onValueChange={setSearch}
              placeholder={placeholder}
              aria-label={label}
              {...inputProps}
            />
            <CommandList className="max-h-64 min-h-0 flex-auto">
              {status ? (
                <div
                  role="status"
                  className="flex items-center gap-2 px-2 py-3 text-body-sm text-muted-foreground"
                >
                  {status}
                </div>
              ) : (
                emptyMessage && <CommandEmpty>{emptyMessage}</CommandEmpty>
              )}
              <CommandGroup>{children}</CommandGroup>
            </CommandList>
          </Command>
        )}
        {footer}
      </FieldContext.Provider>
    </PopoverContent>
  );
}

/** Picking closes the list unless `keepOpen`, as where several can be picked. */
export function ComboboxItem({
  selected = false,
  keepOpen = false,
  onSelect,
  children,
  className,
  ...props
}: Omit<React.ComponentPropsWithoutRef<typeof CommandItem>, "onSelect"> & {
  selected?: boolean;
  keepOpen?: boolean;
  onSelect: () => void;
}): JSX.Element {
  const { setOpen } = useCombobox();
  return (
    <CommandItem
      aria-checked={selected}
      onSelect={() => {
        onSelect();
        if (!keepOpen) setOpen(false);
      }}
      className={className}
      {...props}
    >
      <Check
        aria-hidden="true"
        className={cn(
          "size-icon-md shrink-0",
          selected ? "opacity-100" : "opacity-0"
        )}
      />
      {children}
    </CommandItem>
  );
}
