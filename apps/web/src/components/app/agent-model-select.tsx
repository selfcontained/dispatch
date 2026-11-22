import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type AgentModelOption = { id: string; label: string };

type AgentModelSelectProps = {
  value: string | null;
  options: readonly AgentModelOption[];
  catalogDefault?: string | null;
  onChange: (model: string | null) => void;
  loading?: boolean;
  /** The saved value when it has been turned off in settings. */
  offOption?: AgentModelOption | null;
  /** Overridden by dialogs other than Create Agent so ids stay unique. */
  id?: string;
  testId?: string;
};

const DEFAULT_VALUE = "__default__";

export function AgentModelSelect({
  value,
  options,
  catalogDefault,
  onChange,
  loading = false,
  offOption = null,
  id = "create-agent-model",
  testId = "create-agent-model",
}: AgentModelSelectProps): JSX.Element {
  const fallback = catalogDefault ?? DEFAULT_VALUE;
  const selectedValue =
    value &&
    (value === offOption?.id || options.some((option) => option.id === value))
      ? value
      : fallback;

  return (
    <div className="space-y-1">
      <label className="text-sm text-muted-foreground" htmlFor={id}>
        Model
      </label>
      <Select
        value={selectedValue}
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
          aria-describedby={offOption ? `${id}-off` : undefined}
        >
          <SelectValue>{loading ? "Loading models…" : undefined}</SelectValue>
        </SelectTrigger>
        <SelectContent className="max-h-[clamp(4rem,var(--radix-select-content-available-height),24rem)]">
          {!catalogDefault && (
            <SelectItem value={DEFAULT_VALUE}>
              {catalogDefault === null && options.length > 0
                ? "Use engine setting"
                : "Default"}
            </SelectItem>
          )}
          {offOption ? (
            <SelectItem value={offOption.id} disabled>
              {offOption.label} (off)
            </SelectItem>
          ) : null}
          {options.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {offOption ? (
        <p
          id={`${id}-off`}
          role="status"
          className="text-xs text-status-waiting"
        >
          Turned off. Choose another.
        </p>
      ) : null}
    </div>
  );
}
