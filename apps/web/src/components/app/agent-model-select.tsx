import { useSetAtom } from "jotai";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { seenModelsAtom } from "@/lib/model-availability-preview";

type AgentModelOption = { id: string; label: string; isNew?: boolean };

type AgentModelSelectProps = {
  value: string | null;
  options: readonly AgentModelOption[];
  /** What is saved now: still shown if turned off, but not offered again. */
  savedOption?: AgentModelOption | null;
  onChange: (model: string | null) => void;
  loading?: boolean;
  /** Overridden by dialogs other than Create Agent so ids stay unique. */
  id?: string;
  testId?: string;
};

const DEFAULT_VALUE = "__default__";

export function AgentModelSelect({
  value,
  options,
  savedOption,
  onChange,
  loading = false,
  id = "create-agent-model",
  testId = "create-agent-model",
}: AgentModelSelectProps): JSX.Element {
  const markSeen = useSetAtom(seenModelsAtom);
  const selected =
    (value &&
      (options.find((option) => option.id === value) ??
        (savedOption?.id === value ? savedOption : null))) ||
    null;
  const selectedValue = selected?.id ?? DEFAULT_VALUE;

  return (
    <div className="space-y-1">
      <label className="text-sm text-muted-foreground" htmlFor={id}>
        Model
      </label>
      <Select
        value={selectedValue}
        onOpenChange={(open) => {
          const unseen = options.filter((option) => option.isNew);
          if (open || unseen.length === 0) return;
          markSeen((seen) => [...seen, ...unseen.map((option) => option.id)]);
        }}
        onValueChange={(nextValue) => {
          // Radix's hidden form input echoes an empty value back through
          // onValueChange when its native <option> set lags the rendered items.
          // Persisting that would leave the trigger permanently blank.
          if (!nextValue) return;
          onChange(nextValue === DEFAULT_VALUE ? null : nextValue);
        }}
      >
        <SelectTrigger
          id={id}
          data-testid={testId}
          disabled={loading || options.length === 0}
        >
          <SelectValue>
            {loading ? "Loading models…" : (selected?.label ?? "Default")}
          </SelectValue>
        </SelectTrigger>
        <SelectContent className="max-h-[clamp(4rem,var(--radix-select-content-available-height),24rem)]">
          <SelectItem value={DEFAULT_VALUE}>Default</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.label}
              {option.isNew ? (
                <span className="ml-2 text-xs text-primary">New</span>
              ) : null}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
