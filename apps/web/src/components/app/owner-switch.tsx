import { type SubAgentRef } from "@/components/app/types";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type OwnerSwitchEntry = {
  agent: SubAgentRef;
  /** How many items this owner contributes (pins, files). */
  count: number;
  /** Items the user has not looked at yet; shown as a red badge when > 0. */
  unseen?: number;
};

// Radix Select values are strings, so the selected agent's own items get a
// sentinel that cannot collide with an agent id.
const OWN = "__own__";

/**
 * Whose items a sidebar tab shows: the selected agent by default, or one of
 * its sub agents. A dropdown rather than a chip row or per-child groups
 * because it stays one control high no matter how many sub agents there
 * are, and sits in a fixed spot above the list. Callers render it only when
 * there are sub agents to pick from.
 */
export function OwnerSwitch({
  testIdPrefix,
  ariaLabel,
  itemNoun,
  selectedAgentId,
  selectedAgentName,
  own,
  subAgents,
  viewOwnerId,
  onChange,
}: {
  /** `<prefix>-switch` on the trigger, `<prefix>-option-<agentId>` per item. */
  testIdPrefix: string;
  ariaLabel: string;
  /** What the counts count, for screen readers: ["pin", "pins"]. */
  itemNoun: [singular: string, plural: string];
  selectedAgentId: string | null;
  selectedAgentName: string | null;
  own: { count: number; unseen?: number };
  subAgents: OwnerSwitchEntry[];
  viewOwnerId: string | null;
  onChange: (ownerId: string | null) => void;
}): JSX.Element {
  const options = [
    {
      value: OWN,
      testId: `${testIdPrefix}-option-${selectedAgentId ?? "self"}`,
      label: selectedAgentName ?? "This agent",
      count: own.count,
      unseen: own.unseen ?? 0,
    },
    ...subAgents.map(({ agent, count, unseen }) => ({
      value: agent.id,
      testId: `${testIdPrefix}-option-${agent.id}`,
      label: agent.name,
      count,
      unseen: unseen ?? 0,
    })),
  ];
  const current = options.find(
    (option) => option.value === (viewOwnerId ?? OWN)
  );
  // The digits are decorative; the sentence is what assistive tech reads.
  const counts = (option: { count: number; unseen: number }) => (
    <>
      {option.unseen > 0 ? (
        <span
          aria-hidden
          className="shrink-0 rounded-full bg-destructive px-1.5 text-[10px] font-semibold tabular-nums text-destructive-foreground"
        >
          {option.unseen}
        </span>
      ) : null}
      <span
        aria-hidden
        className="shrink-0 rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground"
      >
        {option.count}
      </span>
      <span className="sr-only">
        {option.unseen > 0 ? `${option.unseen} unseen, ` : ""}
        {option.count} {option.count === 1 ? itemNoun[0] : itemNoun[1]}
      </span>
    </>
  );
  return (
    <div className="border-b border-border px-3 py-2">
      <Select
        value={viewOwnerId ?? OWN}
        onValueChange={(value) => onChange(value === OWN ? null : value)}
      >
        <SelectTrigger
          aria-label={ariaLabel}
          data-testid={`${testIdPrefix}-switch`}
          data-owner={viewOwnerId ?? selectedAgentId ?? undefined}
          // Taller on touch layouts so the primary switch is a real target.
          // The badges sit beside Radix's value wrapper rather than inside
          // it, and the wrapper is forced back to a plain truncating block:
          // the base trigger line-clamps it, which centres the text once the
          // span is stretched to fill the row.
          className="h-11 gap-2 text-xs md:h-8 [&>span:first-child]:!block [&>span:first-child]:min-w-0 [&>span:first-child]:flex-1 [&>span:first-child]:truncate [&>span:first-child]:text-left"
        >
          <SelectValue>{current?.label}</SelectValue>
          {current ? counts(current) : null}
        </SelectTrigger>
        {/* Sized to the trigger, not to the longest agent name: names are
            user-supplied and a long one would otherwise push the listbox
            past a narrow viewport. */}
        <SelectContent className="w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-1.5rem)]">
          {options.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              data-testid={option.testId}
              textValue={option.label}
              // Same for Radix's ItemText wrapper, the row's last child.
              className="min-w-0 py-3 md:py-1.5 [&>span:last-child]:flex [&>span:last-child]:min-w-0 [&>span:last-child]:flex-1"
            >
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {counts(option)}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
