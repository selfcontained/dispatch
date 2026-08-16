import { ChevronRight } from "lucide-react";
import { useAtom } from "jotai";
import { useId, useState } from "react";

import { PinItem } from "@/components/app/pin-item";
import { type AgentPin } from "@/components/app/types";
import { pinGroupCollapsedAtomFamily } from "@/lib/store";
import { cn } from "@/lib/utils";

/**
 * Lays pins out into render order, collapsing every pin that shares a `group`
 * name into a single block. The group is anchored where its *first* member
 * sits, so a later member being re-pinned can never relocate the block.
 */
export type PinRow =
  | { kind: "pin"; pin: AgentPin }
  | { kind: "group"; name: string; pins: AgentPin[] };

export function layoutPins(pins: AgentPin[]): PinRow[] {
  const rows: PinRow[] = [];
  const groupRows = new Map<string, Extract<PinRow, { kind: "group" }>>();

  for (const pin of pins) {
    const name = pin.group?.trim();
    if (!name) {
      rows.push({ kind: "pin", pin });
      continue;
    }

    const key = name.toLowerCase();
    const existing = groupRows.get(key);
    if (existing) {
      existing.pins.push(pin);
      continue;
    }

    const row = { kind: "group" as const, name, pins: [pin] };
    groupRows.set(key, row);
    rows.push(row);
  }

  return rows;
}

/**
 * Groups past this size start collapsed. A sidebar full of one agent's pins
 * pushes every other group off screen, and a long group is exactly the case
 * where the heading and count are more useful than the members.
 */
const AUTO_COLLAPSE_THRESHOLD = 8;

type PinGroupProps = {
  name: string;
  pins: AgentPin[];
  collapseScope: string | null;
  workspaceRoot: string | null;
  agentIsRunning?: boolean;
  onRunShortcut?: (pin: AgentPin, pointerType?: string) => void;
  agentName?: string | null;
  pendingPinId?: string | null;
  buttonRef?: (pin: AgentPin, element: HTMLButtonElement | null) => void;
};

type PinGroupViewProps = Omit<PinGroupProps, "collapseScope"> & {
  collapsed: boolean;
  onToggle: () => void;
};

function PinGroupView({
  name,
  pins,
  collapsed,
  onToggle,
  workspaceRoot,
  agentIsRunning,
  onRunShortcut,
  agentName = null,
  pendingPinId = null,
  buttonRef,
}: PinGroupViewProps): JSX.Element {
  // Ids must be unique per document, not per list: the desktop and mobile
  // sidebars are both always mounted, so a name-derived id would appear twice
  // and `aria-controls` would resolve to the other instance's region.
  const uid = useId();
  const headingId = `pin-group-${uid}`;
  const regionId = `pin-group-members-${uid}`;

  return (
    <div
      className="px-4 py-4 border-b border-border last:border-b-0"
      data-testid="pin-group"
      data-pin-group={name}
      data-pin-group-collapsed={collapsed ? "true" : "false"}
      // The heading is often the question these shortcuts answer, so it
      // has to be announced with them rather than as loose text above.
      role="group"
      // Points at the name span, not the button: the group's accessible name
      // is the heading text, not "collapse Ready to build, 12".
      aria-labelledby={headingId}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        aria-controls={regionId}
        data-testid="pin-group-toggle"
        className={cn(
          "flex w-full items-center gap-1.5 text-left text-base font-semibold leading-snug text-foreground",
          !collapsed && "mb-4"
        )}
      >
        <ChevronRight
          className={cn(
            "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
            !collapsed && "rotate-90"
          )}
          aria-hidden
        />
        <span id={headingId} className="min-w-0 flex-1 truncate">
          {name}
        </span>
        <span
          className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground"
          data-testid="pin-group-count"
        >
          {pins.length}
        </span>
      </button>
      {/* The region stays in the tree so `aria-controls` always resolves and
          `hidden` carries the state; its members unmount while collapsed. */}
      <div
        id={regionId}
        hidden={collapsed}
        className="flex flex-col gap-1"
        data-testid="pin-group-members"
      >
        {collapsed
          ? null
          : pins.map((pin) => (
              <PinItem
                key={pin.id ?? pin.label.toLowerCase()}
                pin={pin}
                workspaceRoot={workspaceRoot}
                agentIsRunning={agentIsRunning}
                onRunShortcut={onRunShortcut}
                inGroup
                agentName={agentName}
                pendingPinId={pendingPinId}
                buttonRef={buttonRef}
              />
            ))}
      </div>
    </div>
  );
}

/** An explicit choice always beats the size-based default. */
function resolveCollapsed(choice: boolean | null, count: number): boolean {
  return choice ?? count > AUTO_COLLAPSE_THRESHOLD;
}

function PersistedPinGroup(
  props: PinGroupProps & { collapseScope: string }
): JSX.Element {
  const [choice, setChoice] = useAtom(
    pinGroupCollapsedAtomFamily(
      `${props.collapseScope}::${props.name.toLowerCase()}`
    )
  );
  const collapsed = resolveCollapsed(choice, props.pins.length);
  return (
    <PinGroupView
      {...props}
      collapsed={collapsed}
      onToggle={() => setChoice(!collapsed)}
    />
  );
}

function EphemeralPinGroup(props: PinGroupProps): JSX.Element {
  const [choice, setChoice] = useState<boolean | null>(null);
  const collapsed = resolveCollapsed(choice, props.pins.length);
  return (
    <PinGroupView
      {...props}
      collapsed={collapsed}
      onToggle={() => setChoice(!collapsed)}
    />
  );
}

/**
 * Branch above the hooks rather than calling both: with no scope there is
 * nothing to namespace by, and persisting to a shared fallback key would leak
 * one list's collapse choices onto every other unscoped list. `collapseScope`
 * is stable per mount site, so this never swaps a component mid-life.
 */
export function PinGroup(props: PinGroupProps): JSX.Element {
  return props.collapseScope === null ? (
    <EphemeralPinGroup {...props} />
  ) : (
    <PersistedPinGroup {...props} collapseScope={props.collapseScope} />
  );
}
