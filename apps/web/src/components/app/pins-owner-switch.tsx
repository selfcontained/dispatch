import { type SubAgentPins } from "@/components/app/types";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Whose pins the tab shows: the selected agent by default, or one of its
 * sub agents. A dropdown rather than a chip row because it stays one control
 * high no matter how many sub agents there are, and it sits in a fixed spot
 * above the list instead of somewhere below the agent's own pins.
 */
export function PinsOwnerSwitch({
  selectedAgentId,
  selectedAgentName,
  ownPinCount,
  subAgentPins,
  viewOwnerId,
  onChange,
}: {
  selectedAgentId: string | null;
  selectedAgentName: string | null;
  ownPinCount: number;
  subAgentPins: SubAgentPins[];
  viewOwnerId: string | null;
  onChange: (ownerId: string | null) => void;
}): JSX.Element {
  // Radix Select values are strings, so the agent's own pins get a sentinel
  // that cannot collide with an agent id.
  const OWN = "__own__";
  const options = [
    {
      value: OWN,
      testId: `pins-owner-option-${selectedAgentId ?? "self"}`,
      label: selectedAgentName ?? "This agent",
      count: ownPinCount,
    },
    ...subAgentPins.map(({ agent, pins }) => ({
      value: agent.id,
      testId: `pins-owner-option-${agent.id}`,
      label: agent.name,
      count: pins.length,
    })),
  ];
  const current = options.find(
    (option) => option.value === (viewOwnerId ?? OWN)
  );
  return (
    <div className="border-b border-border px-3 py-2">
      <Select
        value={viewOwnerId ?? OWN}
        onValueChange={(value) => onChange(value === OWN ? null : value)}
      >
        <SelectTrigger
          aria-label="Whose pins to show"
          data-testid="pins-owner-switch"
          data-pins-owner={viewOwnerId ?? selectedAgentId ?? undefined}
          className="h-8 text-xs"
        >
          <SelectValue>
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate">{current?.label}</span>
              <span className="shrink-0 rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground">
                {current?.count ?? 0}
              </span>
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              data-testid={option.testId}
              textValue={option.label}
            >
              <span className="flex items-center gap-2">
                <span className="truncate">{option.label}</span>
                <span className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground">
                  {option.count}
                </span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
