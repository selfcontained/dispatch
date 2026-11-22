import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type AgentModelOption = {
  id: string;
  label: string;
  isNew?: boolean;
  markSeen?: () => void;
};

type AgentModelSelectProps = {
  value: string | null;
  options: readonly AgentModelOption[];
  catalogDefault?: string | null;
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
  catalogDefault,
  savedOption,
  onChange,
  loading = false,
  id = "create-agent-model",
  testId = "create-agent-model",
}: AgentModelSelectProps): JSX.Element {
  const fallback = catalogDefault ?? DEFAULT_VALUE;
  const selectedValue =
    value &&
    (value === savedOption?.id || options.some((option) => option.id === value))
      ? value
      : fallback;
  const fallbackLabel =
    catalogDefault === null && options.length > 0
      ? "Use engine setting"
      : "Default";
  const selectedLabel =
    options.find((option) => option.id === selectedValue)?.label ??
    (savedOption?.id === selectedValue ? savedOption.label : fallbackLabel);

  return (
    <div className="space-y-1">
      <label className="text-body-md text-muted-foreground" htmlFor={id}>
        Model
      </label>
      <Select
        value={selectedValue}
        onOpenChange={(open) => {
          // On close, so New is still there to read while the list is open.
          if (!open) options.forEach((option) => option.markSeen?.());
        }}
        onValueChange={(nextValue) => {
          // Radix's hidden form input echoes an empty value back through
          // onValueChange when its native <option> set lags the rendered items.
          // Persisting that would leave the trigger permanently blank.
          if (!nextValue) return;
          onChange(nextValue === fallback ? null : nextValue);
        }}
      >
        <SelectTrigger
          id={id}
          data-testid={testId}
          disabled={loading || options.length === 0}
        >
          <SelectValue>
            {loading ? "Loading models…" : selectedLabel}
          </SelectValue>
        </SelectTrigger>
        <SelectContent className="max-h-[clamp(4rem,var(--radix-select-content-available-height),24rem)]">
          {!catalogDefault && (
            <SelectItem value={DEFAULT_VALUE}>{fallbackLabel}</SelectItem>
          )}
          {options.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.label}
              {option.isNew ? (
                <span className="ml-2 text-body-sm text-primary">New</span>
              ) : null}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
