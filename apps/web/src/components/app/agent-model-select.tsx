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
  id = "create-agent-model",
  testId = "create-agent-model",
}: AgentModelSelectProps): JSX.Element {
  const fallback = catalogDefault ?? DEFAULT_VALUE;
  const selected =
    options.find((option) => option.id === value) ??
    options.find((option) => option.id === fallback);

  return (
    <div className="space-y-1">
      <label className="text-sm text-muted-foreground" htmlFor={id}>
        Model
      </label>
      <Select
        value={selected?.id ?? fallback}
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
          aria-busy={loading || undefined}
          disabled={!loading && options.length === 0}
        >
          <SelectValue>{selected?.label ?? "Default"}</SelectValue>
        </SelectTrigger>
        <SelectContent className="max-h-[clamp(4rem,var(--radix-select-content-available-height),24rem)]">
          {!catalogDefault && (
            <SelectItem value={DEFAULT_VALUE}>Default</SelectItem>
          )}
          {loading && (
            <SelectItem value="__loading__" disabled>
              Loading models…
            </SelectItem>
          )}
          {options.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
