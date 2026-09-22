import { createPortal } from "react-dom";

import type { SlashCommand } from "./slash-commands";
import { cn } from "@/lib/utils";

export function SlashPicker({
  candidates,
  activeIndex,
  onPick,
  onHover,
  anchor,
}: {
  candidates: readonly SlashCommand[];
  activeIndex: number;
  onPick: (command: SlashCommand) => void;
  onHover: (index: number) => void;
  anchor: HTMLElement | null;
}): JSX.Element | null {
  if (candidates.length === 0) return null;
  const rect = anchor?.getBoundingClientRect();
  return createPortal(
    <div
      className="fixed z-50 w-80 max-w-[calc(100vw-16px)] overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md"
      style={
        rect
          ? {
              left: Math.max(8, rect.left),
              bottom: Math.max(8, window.innerHeight - rect.top + 4),
            }
          : { left: 8, bottom: 8 }
      }
      role="listbox"
      aria-label="Slash commands"
      data-testid="slash-picker"
    >
      {candidates.map((command, index) => (
        <button
          key={`${command.source}:${command.name}`}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          className={cn(
            "flex w-full items-start gap-2 px-2 py-1.5 text-left text-sm",
            index === activeIndex ? "bg-muted" : "hover:bg-muted/60"
          )}
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => onHover(index)}
          onClick={() => onPick(command)}
          data-testid="slash-option"
        >
          <span className="shrink-0 font-mono">/{command.name}</span>
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {command.description}
            {command.inputHint ? ` · ${command.inputHint}` : ""}
          </span>
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {command.source === "dispatch" ? "Dispatch" : "Agent"}
          </span>
        </button>
      ))}
    </div>,
    document.body
  );
}
