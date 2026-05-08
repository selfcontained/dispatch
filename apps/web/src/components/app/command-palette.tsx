import { useCallback, useEffect, useRef, useState } from "react";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { CornerDownLeft, Search, type LucideIcon } from "lucide-react";
import { Command as CommandPrimitive } from "cmdk";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
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
  const [pendingAction, setPendingAction] = useState<CommandAction | null>(
    null
  );

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) setPendingAction(null);
      onOpenChange(next);
    },
    [onOpenChange]
  );

  const handleSelect = useCallback(
    (action: CommandAction) => {
      if (action.confirm) {
        setPendingAction(action);
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
    setPendingAction(null);
    handleOpenChange(false);
    action.run();
  }, [pendingAction, handleOpenChange]);

  const handleBack = useCallback(() => setPendingAction(null), []);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content
          className={cn(
            "fixed left-1/2 top-[18%] z-[70] flex w-[min(600px,calc(100vw-2rem))] -translate-x-1/2 flex-col overflow-hidden rounded-2xl",
            glassOverlay,
            "shadow-[0_24px_80px_-12px_rgba(0,0,0,0.6),0_0_60px_-12px_hsl(var(--primary)/0.35)]",
            "ring-1 ring-primary/20"
          )}
        >
          <DialogTitle className="sr-only">Command palette</DialogTitle>
          <DialogDescription className="sr-only">
            Search for a command or pick one from the list.
          </DialogDescription>

          {/* Subtle gradient hairline on top — picks up the active theme primary */}
          <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/60 to-transparent" />

          {pendingAction ? (
            <ConfirmActionPane
              action={pendingAction}
              onConfirm={handleConfirm}
              onBack={handleBack}
            />
          ) : (
            <Command
              label="Command palette"
              className="bg-transparent"
              filter={(value, search) => {
                const words = value.toLowerCase().split(/\s+/);
                const term = search.toLowerCase();
                return words.some((w) => w.startsWith(term)) ? 1 : 0;
              }}
            >
              <div className="flex items-center gap-2 border-b border-primary/15 px-4">
                <Search
                  className="h-4 w-4 shrink-0 text-primary/80"
                  aria-hidden
                />
                <CommandPrimitive.Input
                  autoFocus
                  placeholder="Type a command…"
                  className={cn(
                    "flex h-12 w-full bg-transparent py-3 text-sm outline-none",
                    "placeholder:text-muted-foreground/70"
                  )}
                />
              </div>

              <CommandList className="max-h-[360px] p-1">
                <CommandEmpty>No commands found.</CommandEmpty>
                <CommandGroup heading="Commands" className="text-foreground">
                  {actions.map((action) => (
                    <CommandPaletteItem
                      key={action.id}
                      action={action}
                      onSelect={() => handleSelect(action)}
                    />
                  ))}
                </CommandGroup>
                {groups?.map(
                  (group) =>
                    group.actions.length > 0 && (
                      <CommandGroup
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
                      </CommandGroup>
                    )
                )}
              </CommandList>
            </Command>
          )}
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
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

function ConfirmActionPane({
  action,
  onConfirm,
  onBack,
}: {
  action: CommandAction;
  onConfirm: () => void;
  onBack: () => void;
}): JSX.Element {
  const paneRef = useRef<HTMLDivElement>(null);
  const Icon = action.icon;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        onConfirm();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onBack();
      }
    };
    const el = paneRef.current;
    el?.addEventListener("keydown", handler);
    return () => el?.removeEventListener("keydown", handler);
  }, [onConfirm, onBack]);

  useEffect(() => {
    paneRef.current?.focus();
  }, []);

  return (
    <div
      ref={paneRef}
      tabIndex={-1}
      className="flex flex-col gap-4 px-5 py-5 outline-none"
    >
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

      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" onClick={onConfirm}>
          Launch
          <CornerDownLeft className="ml-1.5 h-3 w-3 opacity-60" />
        </Button>
      </div>
    </div>
  );
}

function CommandPaletteItem({
  action,
  onSelect,
}: {
  action: CommandAction;
  onSelect: () => void;
}): JSX.Element {
  const Icon = action.icon;
  const value = [action.title, ...(action.keywords ?? [])].join(" ");

  return (
    <CommandPrimitive.Item
      value={value}
      onSelect={onSelect}
      disabled={action.disabled}
      className={cn(
        "group relative flex cursor-default select-none items-center gap-3 rounded-lg px-2 py-2 text-sm outline-none",
        "transition-colors duration-100",
        "data-[selected=true]:bg-primary/10",
        "data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50"
      )}
    >
      {/* Left accent strip — only shows on selected */}
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-1 left-0 w-[3px] rounded-full bg-primary opacity-0 transition-opacity",
          "group-data-[selected=true]:opacity-100"
        )}
      />

      {Icon ? (
        <span
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-md",
            "border border-primary/20 bg-primary/[0.08] text-primary/80",
            "transition-colors duration-100",
            "group-data-[selected=true]:border-primary/50 group-data-[selected=true]:bg-primary/20 group-data-[selected=true]:text-primary",
            "group-data-[selected=true]:shadow-[0_0_18px_-2px_hsl(var(--primary)/0.45)]"
          )}
        >
          <Icon className="h-4 w-4" aria-hidden />
        </span>
      ) : null}

      <span className="flex-1 truncate text-foreground/90 group-data-[selected=true]:text-foreground">
        {action.title}
      </span>

      {action.hotkey ? <HotkeyBadge id={action.hotkey} /> : null}
    </CommandPrimitive.Item>
  );
}
