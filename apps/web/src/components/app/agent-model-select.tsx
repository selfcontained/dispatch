import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type AgentModelOption = { id: string; label: string; group?: string };

/** Options in first-seen group order; ungrouped ones under no header. */
export function groupModelOptions(
  options: readonly AgentModelOption[]
): { group: string | null; options: AgentModelOption[] }[] {
  const out: { group: string | null; options: AgentModelOption[] }[] = [];
  for (const option of options) {
    const group = option.group ?? null;
    let bucket = out.find((b) => b.group === group);
    if (!bucket) {
      bucket = { group, options: [] };
      out.push(bucket);
    }
    bucket.options.push(option);
  }
  return out;
}

type AgentModelSelectProps = {
  value: string | null;
  options: readonly AgentModelOption[];
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
  onChange,
  loading = false,
  id = "create-agent-model",
  testId = "create-agent-model",
}: AgentModelSelectProps): JSX.Element {
  // Radix renders an empty trigger whenever the selected value has no matching
  // item, so anything unrecognized (a retired model id, a stray empty string)
  // falls back to Default — which is what an unset model means anyway.
  const selectedValue =
    value && options.some((option) => option.id === value)
      ? value
      : DEFAULT_VALUE;

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
          onChange(nextValue === DEFAULT_VALUE ? null : nextValue);
        }}
      >
        <SelectTrigger id={id} data-testid={testId} disabled={loading}>
          <SelectValue>{loading ? "Loading models…" : undefined}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={DEFAULT_VALUE}>
            Default{" "}
            <span className="text-xs text-muted-foreground">(CLI setting)</span>
          </SelectItem>
          {groupModelOptions(options).map((bucket) =>
            bucket.group ? (
              <SelectGroup key={bucket.group}>
                <SelectLabel>{bucket.group}</SelectLabel>
                {bucket.options.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            ) : (
              bucket.options.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.label}
                </SelectItem>
              ))
            )
          )}
        </SelectContent>
      </Select>
    </div>
  );
}
