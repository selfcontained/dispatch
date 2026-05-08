import { useCallback, useMemo, useRef, useState } from "react";

import * as Dialog from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import { CornerDownLeft, Search, type LucideIcon } from "lucide-react";
import { glassOverlay } from "@/lib/glass";
import { formatHotkeyForKbd } from "@/lib/hotkeys/format";
import { type HotkeyId } from "@/lib/hotkeys/keymap";
import { cn } from "@/lib/utils";

export type CommandAction = {
  id: string;
  title: string;
  keywords?: string[];
  hotkey?: HotkeyId;
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
  const inputRef = useRef<HTMLInputElement>(null);
  const page = pages[pages.length - 1];

  const popPage = useCallback(() => {
    setPages((prev) => prev.slice(0, -1));
    setPendingAction(null);
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
        setPendingAction(action);
        setPages(["confirm"]);
        setSearch("");
      } else {
        handleOpenChange(false);
        action.run();
      }
    },
    [handleOpenChange]
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
    return (value, search) => {
      const words = value.toLowerCase().split(/\s+/);
      const term = search.toLowerCase();
      return words.some((w) => w.startsWith(term)) ? 1 : 0;
    };
  }, [page]);

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[65] bg-black/60" />
        <Dialog.Content
          aria-label="Command palette"
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
            loop={page === "confirm"}
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

            <Command.List className="max-h-[360px] p-1">
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
                  <Command.Group heading="Commands" className="text-foreground">
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
                          className="text-foreground"
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
  const Icon = action.icon;

  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      <div className="flex items-center gap-3">
        {Icon && (
          <span
            className={cn(
              "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
              "border border-primary/30 bg-primary/[0.12] text-primary"
            )}
          >
            <Icon className="h-4 w-4" aria-hidden />
          </span>
        )}
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-foreground">
            {action.title}
          </span>
          <span className="text-xs text-muted-foreground">
            {action.confirm?.description}
          </span>
        </div>
      </div>

      <Command.Group forceMount className="text-foreground">
        <Command.Item
          value="confirm-launch"
          keywords={["launch", "confirm", "run"]}
          onSelect={onConfirm}
          forceMount
          className={cn(itemClassName, "data-[selected=true]:bg-primary/10")}
        >
          <span aria-hidden className={accentClassName} />
          <span className={cn(iconWrapClassName, iconWrapSelectedClassName)}>
            <CornerDownLeft className="h-4 w-4" aria-hidden />
          </span>
          <span className="flex-1 truncate text-foreground/90 data-[selected=true]:text-foreground">
            Launch
          </span>
        </Command.Item>
        <Command.Item
          value="confirm-cancel"
          keywords={["cancel", "back"]}
          onSelect={onBack}
          forceMount
          className={cn(itemClassName, "data-[selected=true]:bg-primary/10")}
        >
          <span aria-hidden className={accentClassName} />
          <span className="flex-1 truncate pl-11 text-muted-foreground group-data-[selected=true]:text-foreground">
            Cancel
          </span>
        </Command.Item>
      </Command.Group>
    </div>
  );
}

function HotkeyBadge({ id }: { id: HotkeyId }): JSX.Element {
  const { modifiers, key } = formatHotkeyForKbd(id);
  return (
    <kbd
      className={cn(
        "ml-2 inline-flex h-6 items-center justify-center rounded-md px-2",
        "border border-white/[0.14] bg-white/[0.06]",
        "font-mono text-xs font-semibold leading-none tracking-wide text-muted-foreground",
        "transition-colors duration-100",
        "group-data-[selected=true]:border-primary/40 group-data-[selected=true]:bg-primary/15 group-data-[selected=true]:text-primary"
      )}
    >
      {modifiers ? (
        <>
          <span>{modifiers}</span>
          <span className="mx-1.5 text-muted-foreground/60 group-data-[selected=true]:text-primary/70">
            +
          </span>
        </>
      ) : null}
      <span>{key}</span>
    </kbd>
  );
}

const itemClassName =
  "group relative flex cursor-default select-none items-center gap-3 rounded-lg px-2 py-2 text-sm outline-none transition-colors duration-100";

const accentClassName =
  "absolute inset-y-1 left-0 w-[3px] rounded-full bg-primary opacity-0 transition-opacity group-data-[selected=true]:opacity-100";

const iconWrapClassName =
  "flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-primary/20 bg-primary/[0.08] text-primary/80 transition-colors duration-100";

const iconWrapSelectedClassName =
  "group-data-[selected=true]:border-primary/50 group-data-[selected=true]:bg-primary/20 group-data-[selected=true]:text-primary group-data-[selected=true]:shadow-[0_0_18px_-2px_hsl(var(--primary)/0.45)]";

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
        "data-[selected=true]:bg-primary/10",
        "data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50"
      )}
    >
      <span aria-hidden className={accentClassName} />

      {Icon ? (
        <span className={cn(iconWrapClassName, iconWrapSelectedClassName)}>
          <Icon className="h-4 w-4" aria-hidden />
        </span>
      ) : null}

      <span className="flex-1 truncate text-foreground/90 group-data-[selected=true]:text-foreground">
        {action.title}
      </span>

      {action.hotkey ? <HotkeyBadge id={action.hotkey} /> : null}
    </Command.Item>
  );
}
