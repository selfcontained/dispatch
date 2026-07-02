import { useCallback, useMemo, useRef, useState } from "react";

import * as Dialog from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import { Play, Search, type LucideIcon } from "lucide-react";
import { glassOverlay } from "@/lib/glass";
import { cn } from "@/lib/utils";

export type CommandAction = {
  id: string;
  title: string;
  keywords?: string[];
  icon?: LucideIcon;
  disabled?: boolean;
  confirm?: { description: string };
  run: () => void;
};

export type CommandGroup = {
  label: string;
  actions: CommandAction[];
};

type CommandPaletteProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions: CommandAction[];
  groups?: CommandGroup[];
};

export function CommandPalette({
  open,
  onOpenChange,
  actions,
  groups,
}: CommandPaletteProps): JSX.Element {
  const [search, setSearch] = useState("");
  const [pages, setPages] = useState<string[]>([]);
  const [pendingAction, setPendingAction] = useState<CommandAction | null>(
    null
  );
  const [selectedValue, setSelectedValue] = useState("");
  const savedSearchRef = useRef("");
  const savedSelectionRef = useRef("");
  const inputRef = useRef<HTMLInputElement>(null);
  const page = pages[pages.length - 1];

  const popPage = useCallback(() => {
    setPages((prev) => prev.slice(0, -1));
    setPendingAction(null);
    setSearch(savedSearchRef.current);
    setSelectedValue(savedSelectionRef.current);
  }, []);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        setPages([]);
        setPendingAction(null);
        setSearch("");
      }
      onOpenChange(next);
    },
    [onOpenChange]
  );

  const handleSelect = useCallback(
    (action: CommandAction) => {
      if (action.confirm) {
        savedSearchRef.current = search;
        savedSelectionRef.current = action.title;
        setPendingAction(action);
        setPages(["confirm"]);
        setSearch("");
        setSelectedValue("confirm-launch");
      } else {
        handleOpenChange(false);
        action.run();
      }
    },
    [handleOpenChange, search]
  );

  const handleConfirm = useCallback(() => {
    if (!pendingAction) return;
    const action = pendingAction;
    handleOpenChange(false);
    action.run();
  }, [pendingAction, handleOpenChange]);

  const filter = useMemo<
    ((value: string, search: string, keywords?: string[]) => number) | undefined
  >(() => {
    if (page === "confirm") return () => 1;
    return (value, search, keywords) => {
      const term = search.toLowerCase();
      const words = value.toLowerCase().split(/\s+/);
      if (keywords) {
        for (const kw of keywords) words.push(kw.toLowerCase());
      }
      return words.some((w) => w.startsWith(term)) ? 1 : 0;
    };
  }, [page]);

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[65] bg-black/60" />
        <Dialog.Content
          aria-label="Command palette"
          data-hotkey-disable="true"
          onEscapeKeyDown={(e) => {
            if (pages.length > 0) {
              e.preventDefault();
              popPage();
            }
          }}
          className={cn(
            "fixed left-1/2 top-[18%] z-[70] flex w-[min(600px,calc(100vw-2rem))] -translate-x-1/2 flex-col overflow-hidden rounded-2xl",
            glassOverlay,
            "shadow-[0_24px_80px_-12px_rgba(0,0,0,0.6),0_0_60px_-12px_hsl(var(--primary)/0.35)]",
            "ring-1 ring-primary/20"
          )}
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <Command
            filter={filter}
            loop
            value={selectedValue}
            onValueChange={setSelectedValue}
            className="bg-transparent"
            onKeyDown={(e) => {
              if (pages.length > 0 && e.key === "Backspace" && !search) {
                e.preventDefault();
                popPage();
              }
            }}
          >
            <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/60 to-transparent" />

            <div
              className={cn(
                "flex items-center gap-2 border-b border-primary/15 px-4",
                page === "confirm" && "sr-only"
              )}
            >
              <Search
                className="h-4 w-4 shrink-0 text-primary/80"
                aria-hidden
              />
              <Command.Input
                ref={inputRef}
                autoFocus
                value={search}
                onValueChange={setSearch}
                placeholder="Type a command…"
                className={cn(
                  "flex h-12 w-full bg-transparent py-3 text-sm outline-none",
                  "placeholder:text-muted-foreground/70"
                )}
              />
            </div>

            <Command.List className="max-h-[300px] overflow-y-auto overflow-x-hidden">
              {page === "confirm" && pendingAction ? (
                <ConfirmPage
                  action={pendingAction}
                  onConfirm={handleConfirm}
                  onBack={popPage}
                />
              ) : (
                <>
                  <Command.Empty className="px-2 py-4 text-center text-xs text-muted-foreground">
                    No commands found.
                  </Command.Empty>
                  <Command.Group heading="Commands" className={groupClassName}>
                    {actions.map((action) => (
                      <CommandPaletteItem
                        key={action.id}
                        action={action}
                        onSelect={() => handleSelect(action)}
                      />
                    ))}
                  </Command.Group>
                  {groups?.map(
                    (group) =>
                      group.actions.length > 0 && (
                        <Command.Group
                          key={group.label}
                          heading={group.label}
                          className={groupClassName}
                        >
                          {group.actions.map((action) => (
                            <CommandPaletteItem
                              key={action.id}
                              action={action}
                              onSelect={() => handleSelect(action)}
                            />
                          ))}
                        </Command.Group>
                      )
                  )}
                </>
              )}
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ConfirmPage({
  action,
  onConfirm,
  onBack,
}: {
  action: CommandAction;
  onConfirm: () => void;
  onBack: () => void;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-foreground">
          {action.title}
        </span>
        <span className="text-xs text-muted-foreground">
          {action.confirm?.description}
        </span>
      </div>

      <Command.Group
        forceMount
        className="flex flex-col gap-1 overflow-hidden p-0"
      >
        <Command.Item
          value="confirm-launch"
          keywords={["launch", "confirm", "run"]}
          onSelect={onConfirm}
          forceMount
          className={cn(
            "group flex cursor-default select-none items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium outline-none",
            "text-primary/70",
            "data-[selected=true]:bg-primary/20 data-[selected=true]:text-primary"
          )}
        >
          <Play className="h-3.5 w-3.5 fill-current" aria-hidden />
          Launch
        </Command.Item>
        <Command.Item
          value="confirm-cancel"
          keywords={["cancel", "back"]}
          onSelect={onBack}
          forceMount
          className={cn(
            "group flex cursor-default select-none items-center justify-center gap-2 rounded-md px-3 py-2 text-sm outline-none",
            "text-muted-foreground",
            "data-[selected=true]:bg-white/[0.06] data-[selected=true]:text-foreground"
          )}
        >
          Cancel
        </Command.Item>
      </Command.Group>
    </div>
  );
}

const groupClassName = cn(
  "overflow-hidden p-1 text-foreground",
  "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground",
  "[&+[cmdk-group]]:border-t [&+[cmdk-group]]:border-border"
);

const itemClassName =
  "group relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none";

const iconClassName = "h-4 w-4 shrink-0 text-muted-foreground";

function CommandPaletteItem({
  action,
  onSelect,
}: {
  action: CommandAction;
  onSelect: () => void;
}): JSX.Element {
  const Icon = action.icon;

  return (
    <Command.Item
      value={action.title}
      keywords={action.keywords}
      onSelect={onSelect}
      disabled={action.disabled}
      className={cn(
        itemClassName,
        "data-[selected=true]:bg-white/[0.08] data-[selected=true]:text-foreground",
        "data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50"
      )}
    >
      {Icon ? <Icon className={iconClassName} aria-hidden /> : null}

      <span className="flex-1 truncate">{action.title}</span>
    </Command.Item>
  );
}
